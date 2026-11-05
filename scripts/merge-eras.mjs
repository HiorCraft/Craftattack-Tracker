#!/usr/bin/env node
/**
 * Führt die Datenbanken aller Tracker-Epochen in eine zusammen.
 *
 *   node scripts/merge-eras.mjs --target <postgres-url> --source <alt> --source <mittel> --source <neu> [--dry-run]
 *
 * - Quellen in zeitlicher Reihenfolge angeben, die älteste zuerst. Eine Quelle ist eine Postgres-URL oder
 *   `pglite:/pfad/zu/data/pglite` (dafür vorher `npm i --no-save @electric-sql/pglite@0.5` ausführen).
 * - Das Ziel muss mit dem aktuellen Schema angelegt sein (die App einmal mit dieser DATABASE_URL starten, `migrate()`
 *   in lib/db.ts legt alles an) und leer sein. So ist jeder Lauf reproduzierbar: bei Bedarf Ziel neu anlegen, erneut laufen.
 * - `--dry-run` macht alles in einer Transaktion und rollt sie am Ende zurück: gleiche Zahlen, nichts geschrieben.
 *
 * Regeln (siehe Plan): Verlaufstabellen und Chat werden vereinigt, Ereignisse mit kollidierender ID bekommen ein
 * Epochen-Präfix, an Epochengrenzen werden fehlende Leave/Join-Ereignisse ergänzt, Spieler-Summen über die Epochen
 * addiert, Spitzenwerte als Maximum, aktuelle Felder aus der neuesten Epoche.
 */
import pg from "pg";
import { readFileSync } from "node:fs";

/**
 * Reihenfolge der Zusatzwerte in player_history.extra_stats, direkt aus lib/playerStats.ts gelesen,
 * damit sie immer zum Code passt. Gebraucht, um die alte jsonb-Spalte `extra` (20./21.10.) umzuwandeln.
 */
const EXTRA_HISTORY_KEYS = (() => {
  const src = readFileSync(new URL("../lib/playerStats.ts", import.meta.url), "utf8");
  const block = src.match(/EXTRA_HISTORY_KEYS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("EXTRA_HISTORY_KEYS in lib/playerStats.ts nicht gefunden");
  return [...block[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
})();

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const target = opt("target")[0];
const sources = opt("source");
const dryRun = args.includes("--dry-run");
if (!target || sources.length === 0) {
  console.error("Aufruf: node scripts/merge-eras.mjs --target <url> --source <url|pglite:pfad> ... [--dry-run]");
  process.exit(2);
}

/* ---------- Verbindungen ---------- */

const sslFor = (url) => (/sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false });

async function openSource(spec) {
  if (spec.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = await PGlite.create(spec.slice("pglite:".length));
    return { name: spec, query: (sql, params) => db.query(sql, params), close: () => db.close() };
  }
  const client = new pg.Client({ connectionString: spec, ssl: sslFor(spec) });
  await client.connect();
  return { name: spec.replace(/:[^:@/]+@/, ":***@"), query: (sql, params) => client.query(sql, params), close: () => client.end() };
}

const dst = new pg.Client({ connectionString: target, ssl: sslFor(target) });
await dst.connect();

async function columns(q, table) {
  const r = await q(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return new Map(r.rows.map((c) => [c.column_name, c.data_type]));
}

/** Werte für pg: json/jsonb als Text, alles andere unverändert */
function encode(row, cols, types) {
  return cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return null;
    return types.get(c) === "jsonb" || types.get(c) === "json" ? JSON.stringify(v) : v;
  });
}

async function insertRows(table, cols, types, rows, conflict = "ON CONFLICT DO NOTHING", returning = "") {
  if (rows.length === 0) return [];
  const per = cols.length;
  const out = [];
  const chunk = Math.max(1, Math.floor(60000 / per));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = part.map((_, r) => `(${cols.map((__, c) => `$${r * per + c + 1}`).join(", ")})`).join(", ");
    const res = await dst.query(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES ${values} ${conflict} ${returning}`,
      part.flatMap((row) => encode(row, cols, types)),
    );
    out.push(...res.rows);
  }
  return out;
}

/** Liest eine Tabelle seitenweise über den Primärschlüssel (große Verlaufstabellen passen nicht in den Speicher) */
async function* readPaged(src, table, cols, keyCols, pageSize = 5000) {
  let last = null;
  for (;;) {
    const where = last ? `WHERE (${keyCols.join(", ")}) > (${keyCols.map((_, i) => `$${i + 1}`).join(", ")})` : "";
    const r = await src.query(
      `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table} ${where} ORDER BY ${keyCols.join(", ")} LIMIT ${pageSize}`,
      last ?? [],
    );
    if (r.rows.length === 0) return;
    yield r.rows;
    const end = r.rows[r.rows.length - 1];
    last = keyCols.map((k) => end[k]);
    if (r.rows.length < pageSize) return;
  }
}

/* ---------- Ablauf ---------- */

const report = [];
const eras = [];
for (const spec of sources) eras.push(await openSource(spec));

const targetCounts = await dst.query(`SELECT (SELECT count(*) FROM events) e, (SELECT count(*) FROM players) p, (SELECT count(*) FROM player_history) h`);
if (Object.values(targetCounts.rows[0]).some((n) => Number(n) > 0)) {
  console.error("Das Ziel ist nicht leer. Bitte eine frisch angelegte Datenbank verwenden (Schema per App-Start anlegen).");
  process.exit(1);
}

await dst.query("BEGIN");
try {
  /* 1) Zeiträume je Epoche */
  for (const [i, era] of eras.entries()) {
    const r = await era.query(`SELECT min(at) AS first, max(at) AS last, count(*)::int AS n FROM events`);
    const m = (await era.query(`SELECT started_at, last_poll, last_ok FROM tracker_meta WHERE id = 1`)).rows[0] ?? {};
    // Ende einer Epoche = letzte erfolgreiche Abfrage. Ein Tracker kann danach weiter (erfolglos) abfragen,
    // z. B. nach einer Sperre (HTTP 403); sein Stand im Speicher bleibt dann beim letzten Erfolg stehen.
    era.range = { first: r.rows[0].first, last: r.rows[0].last, events: r.rows[0].n, startedAt: m.started_at, lastPoll: m.last_ok ?? m.last_poll };
    report.push(`Epoche ${i + 1} (${era.name}): Ereignisse ${r.rows[0].n}, ${r.rows[0].first?.toISOString?.() ?? r.rows[0].first} bis ${r.rows[0].last?.toISOString?.() ?? r.rows[0].last}`);
  }
  for (let i = 1; i < eras.length; i++) {
    if (eras[i - 1].range.last && eras[i].range.first && new Date(eras[i - 1].range.last) > new Date(eras[i].range.first)) {
      report.push(`WARNUNG: Epoche ${i} und ${i + 1} überschneiden sich zeitlich – mögliche doppelte Ereignisse.`);
    }
  }

  /* 2) Tabellen, die einfach vereinigt werden (Schlüssel eindeutig oder inhaltsbasiert) */
  const union = [
    ["history", ["at"]],
    ["player_history", ["player", "at"]],
    ["player_top_history", ["player", "at"]],
    ["feed_items", ["id"]],
    ["twitch_chat_messages", ["id"]],
    ["shared_chat_sessions", ["key"]],
  ];
  for (const [table, key] of union) {
    const dstCols = await columns((s, p) => dst.query(s, p), table);
    if (dstCols.size === 0) continue;
    let read = 0;
    let written = 0;
    let converted = 0;
    for (const era of eras) {
      const srcCols = await columns(era.query, table);
      if (srcCols.size === 0) continue;
      const cols = [...dstCols.keys()].filter((c) => srcCols.has(c));
      // Alte jsonb-Spalte `extra` (kurzzeitig am 20./21.10.) in das heutige integer[] `extra_stats` umwandeln
      const convertExtra = table === "player_history" && srcCols.has("extra") && dstCols.has("extra_stats") && !dstCols.has("extra");
      const readCols = convertExtra ? [...cols, "extra"] : cols;
      const writeCols = convertExtra && !cols.includes("extra_stats") ? [...cols, "extra_stats"] : cols;
      for await (const rows of readPaged(era, table, readCols, key)) {
        read += rows.length;
        if (convertExtra) {
          for (const r of rows) {
            if (r.extra && !r.extra_stats) {
              const values = EXTRA_HISTORY_KEYS.map((k) => (typeof r.extra[k] === "number" ? Math.round(r.extra[k]) : null));
              if (values.some((v) => v !== null)) {
                r.extra_stats = values;
                converted += 1;
              }
            }
          }
        }
        written += (await insertRows(table, writeCols, dstCols, rows, "ON CONFLICT DO NOTHING", "RETURNING 1")).length;
      }
    }
    if (converted) report.push(`${table}: ${converted} Zeilen von der alten Spalte extra (jsonb) nach extra_stats umgewandelt`);
    report.push(`${table}: ${read} gelesen, ${written} übernommen, ${read - written} doppelt`);
  }

  /* 3) Ereignisse: Kollisionen umbenennen, Epochengrenzen ergänzen */
  const evCols = await columns((s, p) => dst.query(s, p), "events");
  let evRead = 0;
  let evRenamed = 0;
  let evSame = 0;
  for (const [i, era] of eras.entries()) {
    const srcCols = await columns(era.query, "events");
    const cols = [...evCols.keys()].filter((c) => srcCols.has(c));
    for await (const rows of readPaged(era, "events", cols, ["id"])) {
      evRead += rows.length;
      const inserted = new Set((await insertRows("events", cols, evCols, rows, "ON CONFLICT (id) DO NOTHING", "RETURNING id")).map((r) => r.id));
      const clashes = rows.filter((r) => !inserted.has(r.id));
      for (const row of clashes) {
        const ex = (await dst.query(`SELECT type, at, player FROM events WHERE id = $1`, [row.id])).rows[0];
        if (ex && ex.type === row.type && new Date(ex.at).getTime() === new Date(row.at).getTime() && ex.player === row.player) {
          evSame += 1; // wirklich dasselbe Ereignis
          continue;
        }
        await insertRows("events", cols, evCols, [{ ...row, id: `e${i + 1}-${row.id}` }]);
        evRenamed += 1;
      }
    }
  }
  report.push(`events: ${evRead} gelesen, ${evRenamed} mit Epochen-Präfix umbenannt (ID-Kollision), ${evSame} identisch doppelt`);

  // Grenzen: Wer am Ende einer Epoche online war, bekommt dort ein Leave; wer in der nächsten Epoche ohne Join
  // beginnt (erstes Session-Ereignis ist ein Leave), bekommt am Epochenstart ein Join.
  let synthetic = 0;
  for (let i = 0; i < eras.length - 1; i++) {
    const end = eras[i].range.lastPoll ?? eras[i].range.last;
    if (end) {
      const online = (await eras[i].query(`SELECT id, name, uuid, session_start FROM players WHERE online`)).rows;
      for (const p of online) {
        const secs = p.session_start ? Math.max(0, Math.round((new Date(end) - new Date(p.session_start)) / 1000)) : 0;
        synthetic += (await insertRows("events", ["id", "at", "type", "player", "player_name", "uuid", "where", "meta"], evCols, [
          { id: `merge-leave-${new Date(end).getTime().toString(36)}-${p.id}`, at: end, type: "leave", player: p.id, player_name: p.name, uuid: p.uuid, where: "server", meta: { sessionSeconds: secs, synthetic: true, reason: "Ende der Tracker-Epoche" } },
        ], "ON CONFLICT DO NOTHING", "RETURNING 1")).length;
      }
    }
    const start = eras[i + 1].range.startedAt ?? eras[i + 1].range.first;
    if (start) {
      const firsts = (
        await eras[i + 1].query(
          `SELECT DISTINCT ON (player) player, type, at, player_name, uuid FROM events
            WHERE type IN ('join', 'first_join', 'leave') AND player IS NOT NULL ORDER BY player, at`,
        )
      ).rows.filter((r) => r.type === "leave");
      for (const r of firsts) {
        synthetic += (await insertRows("events", ["id", "at", "type", "player", "player_name", "uuid", "where", "meta"], evCols, [
          { id: `merge-join-${new Date(start).getTime().toString(36)}-${r.player}`, at: start, type: "join", player: r.player, player_name: r.player_name, uuid: r.uuid, where: "server", meta: { synthetic: true, reason: "Beginn der Tracker-Epoche" } },
        ], "ON CONFLICT DO NOTHING", "RETURNING 1")).length;
      }
    }
  }
  report.push(`events: ${synthetic} Leave/Join an Epochengrenzen ergänzt (tatsächlich geschrieben)`);

  // Tode aus dem Feed bzw. den `events` von /api/player (ID „feed-…“) gegen die Zähler-Tode abgleichen.
  // Ein späterer Tracker legt Tode aus der Zeit vor seinem ersten Stand eines Spielers als eigene Feed-Ereignisse an;
  // eine frühere Epoche hat dieselben Tode oft schon über den Todeszähler erfasst. Wie im Live-Tracker
  // (enrichDeathEvents) gilt ein Feed-Tod als derselbe, wenn ein Zähler-Tod desselben Spielers 2 Min davor bis
  // 20 Min danach liegt (die Neon-Epoche fragte Einzelwerte nur alle 15 Min ab). Ein Zähler-Tod mit delta n nimmt
  // höchstens n Feed-Tode auf. Der Feed-Tod entfällt, seine Angaben (Nachricht, Mörder) wandern in den Zähler-Tod.
  // Feed-Tode ohne Gegenstück bleiben: diese Tode hat keine frühere Epoche gesehen.
  {
    const feedDeaths = (
      await dst.query(`SELECT id, player, at, meta FROM events WHERE type = 'death' AND id LIKE 'feed-%' AND player IS NOT NULL ORDER BY at`)
    ).rows;
    const counter = (
      await dst.query(
        `SELECT id, player, at, COALESCE(delta, 1) AS delta FROM events WHERE type = 'death' AND id NOT LIKE 'feed-%' AND player IS NOT NULL ORDER BY at`,
      )
    ).rows;
    const byPlayer = new Map();
    for (const c of counter) (byPlayer.get(c.player) ?? byPlayer.set(c.player, []).get(c.player)).push({ ...c, left: Math.max(1, Math.round(Number(c.delta))) });
    let absorbed = 0;
    for (const f of feedDeaths) {
      const t = new Date(f.at).getTime();
      // Nächster passender Zähler-Tod mit freier Kapazität
      const match = (byPlayer.get(f.player) ?? [])
        .filter((c) => c.left > 0 && new Date(c.at).getTime() >= t - 2 * 60_000 && new Date(c.at).getTime() <= t + 20 * 60_000)
        .sort((a, b) => Math.abs(new Date(a.at).getTime() - t) - Math.abs(new Date(b.at).getTime() - t))[0];
      if (!match) continue;
      match.left -= 1;
      // Vorhandene Angaben des Zähler-Tods haben Vorrang. `beforeTracking` nicht übernehmen: der Zähler-Tod wurde live
      // erfasst; mit der Markierung fiele er aus den Statistiken (lib/analytics.ts zählt solche Tode nicht).
      const { beforeTracking: _ignored, ...feedMeta } = f.meta ?? {};
      void _ignored;
      await dst.query(`UPDATE events SET meta = $2::jsonb || COALESCE(meta, '{}'::jsonb) WHERE id = $1`, [match.id, JSON.stringify(feedMeta)]);
      await dst.query(`DELETE FROM events WHERE id = $1`, [f.id]);
      absorbed += 1;
    }
    report.push(`events: ${feedDeaths.length} Feed-Tode geprüft, ${absorbed} als Doppelung eines Zähler-Tods zusammengeführt, ${feedDeaths.length - absorbed} behalten`);
  }

  /* 4) Spieler zusammenführen */
  const SUM = ["tracked_seconds", "sessions", "afk_seconds", "stream_on_server_seconds", "stream_off_server_seconds", "followers_on_server"];
  const MAX = ["peak_viewers", "peak_viewers_on_server", "longest_session"];
  const plCols = await columns((s, p) => dst.query(s, p), "players");
  const merged = new Map();
  for (const era of eras) {
    const srcCols = await columns(era.query, "players");
    const rows = (await era.query(`SELECT * FROM players`)).rows;
    for (const row of rows) {
      const prev = merged.get(row.id);
      if (!prev) {
        merged.set(row.id, { ...row });
        continue;
      }
      // Neuere Epoche liefert die aktuellen Felder, Summen und Spitzen werden kombiniert
      const next = { ...prev, ...Object.fromEntries([...srcCols.keys()].map((c) => [c, row[c]])) };
      for (const c of SUM) if (plCols.has(c)) next[c] = Number(prev[c] ?? 0) + Number(row[c] ?? 0);
      for (const c of MAX) if (plCols.has(c)) next[c] = Math.max(Number(prev[c] ?? 0), Number(row[c] ?? 0));
      next.first_seen = prev.first_seen && row.first_seen ? (new Date(prev.first_seen) < new Date(row.first_seen) ? prev.first_seen : row.first_seen) : prev.first_seen ?? row.first_seen;
      merged.set(row.id, next);
    }
  }
  const pCols = [...plCols.keys()];
  const playerRows = [...merged.values()].map((r) => Object.fromEntries(pCols.map((c) => [c, r[c] ?? null])));
  // Pflichtspalten ohne Wert aus alten Epochen: Standardwerte der Tabelle greifen nicht bei explizitem NULL
  const defaults = { online: false, stats: {}, tracked_seconds: 0, sessions: 0, peak_viewers: 0, longest_session: 0, peak_viewers_on_server: 0, stream_on_server_seconds: 0, stream_off_server_seconds: 0, afk_seconds: 0, followers_online_at_sample: false, followers_on_server: 0, followers_on_live_stream: 0, live_peak_viewers: 0, uuid: "" };
  for (const r of playerRows) for (const [k, v] of Object.entries(defaults)) if (r[k] === null && plCols.has(k)) r[k] = v;
  await insertRows("players", pCols, plCols, playerRows, "ON CONFLICT (id) DO NOTHING");
  report.push(`players: ${playerRows.length} Spieler zusammengeführt`);

  /* 5) tracker_meta */
  const metas = [];
  for (const era of eras) {
    const m = (await era.query(`SELECT * FROM tracker_meta WHERE id = 1`)).rows[0];
    if (m) metas.push(m);
  }
  if (metas.length) {
    const newest = metas[metas.length - 1];
    const records = {};
    for (const m of metas) {
      for (const [k, v] of Object.entries(m.records ?? {})) {
        if (v && (!records[k] || Number(v.value) > Number(records[k].value))) records[k] = v;
      }
    }
    const total = Number((await dst.query(`SELECT count(*)::int AS n FROM events`)).rows[0].n);
    const meta = {
      ...newest,
      started_at: metas.map((m) => m.started_at).sort((a, b) => new Date(a) - new Date(b))[0],
      polls: metas.reduce((s, m) => s + Number(m.polls ?? 0), 0),
      records,
      event_count: total,
    };
    const mCols = await columns((s, p) => dst.query(s, p), "tracker_meta");
    const cols = [...mCols.keys()].filter((c) => c in meta);
    await insertRows("tracker_meta", cols, mCols, [meta], "ON CONFLICT (id) DO NOTHING");
    report.push(`tracker_meta: Start ${new Date(meta.started_at).toISOString()}, ${meta.polls} Abfragen, ${total} Ereignisse, Rekorde: ${Object.keys(records).join(", ") || "–"}`);
  }

  if (dryRun) {
    await dst.query("ROLLBACK");
    report.push("PROBELAUF: nichts geschrieben (Transaktion zurückgerollt).");
  } else {
    await dst.query("COMMIT");
    report.push("Fertig: alles übernommen.");
  }
} catch (err) {
  await dst.query("ROLLBACK");
  console.error("Abgebrochen, nichts geschrieben:", err);
  process.exitCode = 1;
} finally {
  for (const era of eras) await era.close();
  await dst.end();
}
console.log(report.join("\n"));
