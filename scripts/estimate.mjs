#!/usr/bin/env node
/**
 * Schätzung: füllt Datenlücken mit plausiblen Werten und legt sie als eigene Sicht auf die Datenbank an.
 *
 *   DATABASE_URL=… node scripts/estimate.mjs [--dry-run] [--if-changed]
 *
 * Exit-Code 3: Die Lücken haben sich seit dem letzten Lauf geändert; die Schätzungs-Website sollte neu starten,
 * damit sie ältere Ereignisse neu lädt (neue Zeilen danach liest sie ohnehin laufend).
 *
 * Die echten Tabellen bleiben unangetastet. Ergebnis:
 * - Schema `approx_fill`: vollständige Kopien von history, player_history, events und player_top_history bis zum
 *   Stichtag (jetzt − 10 Min), mit gefüllten Lücken, dazu Spieler-Korrekturen, Konfidenzen und Metadaten.
 * - Schema `approx`: Sichten mit denselben Namen wie die echten Tabellen (Kopie bis zum Stichtag + echte Zeilen danach).
 *   Die Schätzungs-Website (CA_ESTIMATE=1) liest mit `search_path=approx,public` und sieht so alles wie gewohnt.
 *
 * Was geschätzt wird:
 * - Zeitlücken (Tracker aus): Sessions je Spieler als Markow-Kette nach seinem Tagesprofil (Online-Wahrscheinlichkeit
 *   je Stunde, typische Session-Länge), so lange, dass die bekannte Spielzeit-Differenz aufgeht; AFK-Phasen, Streams,
 *   Zuschauer (mit Anlauf, Abfall und Rauschen), Ereignisse, globaler Verlauf.
 * - Erst später erfasste Werte (z. B. Spielzeit außerhalb der Top 10, Schaden/Essen/Totems vor dem 18.10.,
 *   Zusatzwerte vor dem 20.10., Follower vor dem 14.10., Top-Listen vor dem 21.10.): Zuwachs zwischen zwei bekannten
 *   Werten (oder ab 0 beim Start) verteilt auf die Online-Minuten, gewichtet mit Aktivität und schubweisem Rauschen.
 * - Twitch: Abos je Minute aus der Abo-Rate je Zuschauerminute des Kanals, Follower aus Zuschauerminuten.
 * - Offtag (Montag, 26.10.): Server zu, niemand spielt; Streams anderer Inhalte bleiben möglich.
 * Chat, Raids, Cheers und Geschenk-Abos werden nicht erfunden (echte Personen und Texte).
 *
 * Alles ist deterministisch (Zufall mit festem Startwert je Spieler und Lücke): ein neuer Lauf ergibt dieselben Werte,
 * solange sich die echten Daten davor nicht ändern.
 */
import pg from "pg";
import { readFileSync } from "node:fs";

/* ---------- Feste Annahmen ---------- */

/** Start von CraftAttack 14: Samstag, 10.10.2026, 12:00 Uhr deutscher Zeit (alle Spielzeiten beginnen hier bei 0) */
const START = Date.parse("2026-10-10T10:00:00Z");
/** Offtage (Server zu): Montag, 26.10.2026, ganzer Tag deutscher Zeit (nach der Zeitumstellung UTC+1) */
// FOMO-Offday: Server zu vom 26.10. 02:00 bis 27.10. 09:00 deutscher Zeit
const OFFDAYS = [[Date.parse("2026-10-26T01:00:00Z"), Date.parse("2026-10-27T08:00:00Z")]];
/** Ab dieser Lücke im globalen Verlauf gilt der Tracker als aus */
const GAP_MS = 4 * 60_000;
/** Neueste Minuten bleiben echt (der Tracker schreibt eventuell noch nach) */
const CUTOFF_LAG_MS = 10 * 60_000;
const MIN = 60_000;
const HOUR = 3600_000;
/** Ab hier gibt es echte Abo-Ereignisse (Tracker-Neustart mit Twitch-IRC) */
const SUB_TRACKING_FALLBACK = Date.parse("2026-10-14T08:40:00Z");
/** Wie in lib/tracker.ts */
const MIN_DELTA = { distance: 500, blocksBroken: 100, mobsKilled: 10, foodEaten: 3, damageDealt: 401 };
const MILESTONES = {
  playtimeSeconds: [6, 12, 24, 48, 100, 200, 500].map((h) => h * 3600),
  deaths: [5, 10, 25, 50, 100],
  diamonds: [64, 128, 256, 512, 1000, 2000, 5000, 10000],
  blocksBroken: [1000, 5000, 10000, 50000, 100000, 500000],
  mobsKilled: [100, 500, 1000, 5000, 10000],
  distance: [10000, 50000, 100000, 500000, 1000000],
  damageDealt: [200, 1000, 2000, 10000, 20000],
  totemsUsed: [1, 5, 10, 25, 50, 100],
  foodEaten: [100, 500, 1000, 5000, 10000],
};
const BOARD_LABEL = {
  playtimeSeconds: "Dauerzocker",
  diamonds: "Diamantenbank",
  deaths: "Friedhof",
  blocksBroken: "Abrissbirne",
  mobsKilled: "Monsterjäger",
  distance: "Weltenbummler",
  damageDealt: "Kampfmaschine",
  totemsUsed: "Unsterblich",
  foodEaten: "Vielfraß",
};

/** Reihenfolge der Zusatzwerte in player_history.extra_stats, direkt aus lib/playerStats.ts */
const EXTRA_KEYS = (() => {
  const src = readFileSync(new URL("../lib/playerStats.ts", import.meta.url), "utf8");
  const block = src.match(/EXTRA_HISTORY_KEYS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("EXTRA_HISTORY_KEYS in lib/playerStats.ts nicht gefunden");
  return [...block[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
})();

/**
 * Zählerwerte und wie sie entstehen: `act` = wovon der Zuwachs abhängt, `sigma` = wie schubweise (Rauschen im
 * Log-Raum), `noise` = gemeinsamer Rauschstrom (verwandte Werte steigen zusammen), `event`/`board` wie im Tracker.
 */
const STATS = [
  { col: "playtime_seconds", board: "playtimeSeconds", act: "active", sigma: 0.12, noise: "play", int: true },
  { col: "deaths", board: "deaths", act: "active", sigma: 0.9, noise: "risk", int: true, event: "death" },
  { col: "diamonds", board: "diamonds", act: "active", sigma: 1.3, noise: "mine", int: true, event: "diamonds" },
  { col: "blocks_broken", board: "blocksBroken", act: "farm", sigma: 1.0, noise: "mine", int: true, event: "blocksBroken" },
  { col: "mobs_killed", board: "mobsKilled", act: "mobfarm", sigma: 1.0, noise: "fight", int: true, event: "mobsKilled" },
  { col: "distance", board: "distance", act: "move", sigma: 0.55, noise: "move", int: false, event: "distance" },
  { col: "damage_dealt", board: "damageDealt", act: "active", sigma: 0.9, noise: "fight", int: false, event: "damageDealt" },
  { col: "totems_used", board: "totemsUsed", act: "active", sigma: 1.0, noise: "risk", int: true, event: "totemsUsed" },
  { col: "food_eaten", board: "foodEaten", act: "active", sigma: 0.45, noise: "play", int: true, event: "foodEaten" },
];
const EXTRA_MODEL = {
  blocksPlaced: { act: "active", sigma: 1.0, noise: "build" },
  damageTaken: { act: "active", sigma: 0.9, noise: "risk" },
  raidsWon: { act: "active", sigma: 1.5, noise: "fight" },
  jumps: { act: "move", sigma: 0.5, noise: "move" },
  distanceFallen: { act: "move", sigma: 0.7, noise: "move" },
  sneakSeconds: { act: "active", sigma: 0.8, noise: "build" },
  itemsCrafted: { act: "active", sigma: 1.0, noise: "build" },
  itemsPickedUp: { act: "farm", sigma: 0.8, noise: "mine" },
  itemsDropped: { act: "active", sigma: 0.9, noise: "build" },
  itemsEnchanted: { act: "active", sigma: 1.4, noise: "build" },
  chestsOpened: { act: "active", sigma: 0.8, noise: "build" },
  tradedWithVillagers: { act: "active", sigma: 1.3, noise: "trade" },
  animalsKilled: { act: "mobfarm", sigma: 1.1, noise: "fight" },
  animalsBred: { act: "active", sigma: 1.3, noise: "farm" },
  fishCaught: { act: "active", sigma: 1.4, noise: "fish" },
  bellsRung: { act: "active", sigma: 1.5, noise: "trade" },
  afkSeconds: { act: "afk", sigma: 0.1, noise: "play" },
};
/** Treiber der Top-Listen (welcher Zähler die Liste wachsen lässt) */
const TOP_DRIVER = { blocksBroken: "blocks_broken", mobsKilled: "mobs_killed", blocksPlaced: "x:blocksPlaced", animalsKilled: "x:animalsKilled" };

const dryRun = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL fehlt");
  process.exit(2);
}
const ssl = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: url, ssl, application_name: "actracker-estimate" });
await db.connect();
const q = (sql, params) => db.query(sql, params);
const t0Run = Date.now();
const log = (...a) => console.log(`[schätzung ${((Date.now() - t0Run) / 1000).toFixed(1)}s]`, ...a);

/* ---------- Zufall, Zeit, Hilfen ---------- */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rngFor(...parts) {
  let a = hash(parts.join("|"));
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  next.exp = (mean) => -Math.log(Math.max(1e-12, next())) * mean;
  next.poisson = (lambda) => {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * next.normal()));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= next();
    } while (p > l);
    return k - 1;
  };
  next.gamma = (shape) => {
    // Marsaglia-Tsang, für shape < 1 per Boost
    if (shape < 1) return next.gamma(shape + 1) * Math.pow(next(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x;
      let v;
      do {
        x = next.normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  return next;
}

const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
const hourMemo = new Map();
/** Stunde (0–23) und Kalendertag (YYYY-MM-DD) in deutscher Zeit */
function berlin(t) {
  const key = Math.floor(t / HOUR);
  let v = hourMemo.get(key);
  if (!v) {
    const parts = Object.fromEntries(hourFmt.formatToParts(new Date(key * HOUR)).map((p) => [p.type, p.value]));
    v = { hour: Number(parts.hour) % 24, day: `${parts.year}-${parts.month}-${parts.day}` };
    hourMemo.set(key, v);
  }
  return v;
}
const dayNumber = (t) => Math.round(Date.parse(`${berlin(t).day}T12:00:00Z`) / 86400_000);
const isOffday = (t) => OFFDAYS.some(([a, b]) => t >= a && t < b);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const iso = (t) => new Date(t).toISOString();
const ms = (d) => (d instanceof Date ? d.getTime() : Date.parse(d));
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
/**
 * Zähler steigen nur. Echte Reihen haben aber Ausreißer: einzelne Einbrüche (Quelle kurz ohne Wert) und
 * Spitzen, auch über mehrere Minuten (falscher Wert aus einer Quelle). Einbrüche fallen weg (werden gefüllt),
 * danach zählt je Punkt das Minimum aller späteren Werte: so verschwinden Spitzen, und die Reihe steigt monoton.
 */
function monotone(vals) {
  const v = vals.map((x) => (x === null || x === undefined || Number.isNaN(x) ? null : Number(x)));
  const idx = [];
  v.forEach((x, k) => x !== null && idx.push(k));
  for (let n = 1; n + 1 < idx.length; n++) {
    const prev = v[idx[n - 1]];
    const cur = v[idx[n]];
    const next = v[idx[n + 1]];
    if (prev !== null && cur < prev * 0.8 && cur < next * 0.8) v[idx[n]] = null;
  }
  let min = Infinity;
  for (let k = v.length - 1; k >= 0; k--) {
    if (v[k] === null) continue;
    min = Math.min(min, v[k]);
    v[k] = min;
  }
  return v;
}
/** Kreisförmig glätten (Stunden 23 und 0 sind Nachbarn) */
const smooth24 = (a) => a.map((_, h) => 0.25 * a[(h + 23) % 24] + 0.5 * a[h] + 0.25 * a[(h + 1) % 24]);
/** Tod aus dem Todes-Feed (echter Zeitpunkt) statt nur aus dem Zählerstand */
const isFeedDeath = (e) => Boolean(e.meta?.deathMessage || e.meta?.feedAt || e.meta?.killerName);
const confGap = (durMs) => clamp(0.95 - 0.1 * Math.log1p(durMs / HOUR), 0.45, 0.95);

/* ---------- Stichtag, globaler Verlauf, Lücken ---------- */

const CUTOFF = Math.floor((Date.now() - CUTOFF_LAG_MS) / MIN) * MIN;
const hist = (await q(`SELECT * FROM history WHERE at <= $1 ORDER BY at`, [new Date(CUTOFF)])).rows.map((r) => ({ ...r, t: ms(r.at) }));
if (hist.length < 10) throw new Error("Zu wenig Verlauf");
log(`Stichtag ${iso(CUTOFF)}, ${hist.length} Verlaufspunkte`);

/** Lücken: [a, b] mit a = letzter Punkt davor, b = erster danach; polls = gedachte Abfragezeitpunkte dazwischen */
const gaps = [];
function makeGap(a, b, pre) {
  const rng = rngFor("polls", a);
  const polls = [];
  let t = a + (pre ? 30_000 : 60_000 + (rng() - 0.5) * 20_000);
  while (t < b - 25_000) {
    polls.push(Math.round(t));
    t += 60_000 + (rng() - 0.5) * 24_000;
  }
  const offMs = OFFDAYS.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const conf = offMs > (b - a) * 0.5 ? clamp(0.9 - 0.1 * Math.log1p((b - a - offMs) / HOUR), 0.5, 0.9) : confGap(b - a);
  gaps.push({ i: gaps.length, a, b, pre, polls, conf, offMs });
}
if (hist[0].t - START > GAP_MS) makeGap(START, hist[0].t, true);
for (let i = 1; i < hist.length; i++) if (hist[i].t - hist[i - 1].t > GAP_MS) makeGap(hist[i - 1].t, hist[i].t, false);
log(`${gaps.length} Lücken, ${gaps.reduce((s, g) => s + g.polls.length, 0)} gedachte Abfragen`);
const genId = hash(JSON.stringify(gaps.map((g) => [g.a, g.b])));
// --if-changed: nur neu rechnen, wenn eine Lücke dazukam oder sich geändert hat, spätestens aber alle 12 Stunden
// (danach liest die Sicht die echten Zeilen ab dem Stichtag direkt, das soll nicht ewig wachsen)
if (process.argv.includes("--if-changed")) {
  const prev = await q(`SELECT gaps_hash, generated_at FROM approx_fill.meta`).then((r) => r.rows[0]).catch(() => null);
  if (prev && Number(prev.gaps_hash) === genId && Date.now() - ms(prev.generated_at) < 12 * HOUR) {
    log("Lücken unverändert, Stand aktuell genug: nichts zu tun");
    await db.end();
    process.exit(0);
  }
}
const gapOf = (t) => gaps.find((g) => t > g.a && t < g.b) ?? null;

/** Erfasste Minuten je absoluter Stunde (für Online-Wahrscheinlichkeiten je Spieler) */
const trackedByHour = new Map();
for (let i = 1; i < hist.length; i++) {
  const dt = hist[i].t - hist[i - 1].t;
  if (dt > GAP_MS) continue;
  const k = Math.floor(hist[i - 1].t / HOUR);
  trackedByHour.set(k, (trackedByHour.get(k) ?? 0) + dt);
}

/* ---------- Globale Werte ---------- */

const firstSub = (await q(`SELECT min(at) AS at FROM events WHERE type = 'subscription'`)).rows[0]?.at;
const SUB_START = firstSub ? ms(firstSub) : SUB_TRACKING_FALLBACK;
/** Minuten mit echten Abo-Meldungen (irgendein Kanal): Twitch-IRC lief auch in manchen Tracker-Lücken weiter */
const subMinutes = (await q(`SELECT DISTINCT (extract(epoch FROM date_trunc('minute', at)) * 1000)::bigint AS t FROM events WHERE type = 'subscription' ORDER BY 1`)).rows.map((r) => Number(r.t));
/** Gibt es echte Abo-Daten in der Nähe? Dann nichts dazuerfinden */
function subsCovered(t) {
  let lo = 0;
  let hi = subMinutes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (subMinutes[mid] < t - 45 * MIN) lo = mid + 1;
    else hi = mid - 1;
  }
  return lo < subMinutes.length && subMinutes[lo] <= t + 45 * MIN;
}
const players = (await q(`SELECT id, name, uuid, first_seen, twitch_login FROM players ORDER BY id`)).rows;
const phCols = (await q(`SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'player_history' ORDER BY ordinal_position`)).rows;
log(`${players.length} Spieler, Abos erfasst ab ${iso(SUB_START)}`);

/* ---------- Sessions und Pausen aus echten Daten (Vorrat zum Ziehen) ---------- */

const overlapsGap = (x, y) => gaps.some((g) => g.a < y && g.b > x);
/**
 * Echte Sessions und Pausen eines Spielers: Join → Leave bzw. Leave → Join, nur vollständig erfasste (keine
 * Tracker-Lücke dazwischen, keine künstlichen Epochen-Grenzen). Kurze Unterbrechungen (unter 5 Min, z. B.
 * Verbindungsabbruch) zählen als eine Session weiter. Je Eintrag die Startstunde (deutsche Zeit) und die Länge.
 */
function buildPools(list) {
  const raw = [];
  let open = null;
  for (const e of list) {
    if (e.id.startsWith("merge-")) {
      open = null;
      continue;
    }
    if (e.type === "join" || e.type === "first_join") open = e.t;
    else if (e.type === "leave" && open !== null) {
      raw.push([open, e.t]);
      open = null;
    }
  }
  const merged = [];
  for (const x of raw) {
    const last = merged[merged.length - 1];
    if (last && x[0] - last[1] < 5 * MIN && !overlapsGap(last[1], x[0])) last[1] = x[1];
    else merged.push([...x]);
  }
  const sessions = [];
  const breaks = [];
  for (let i = 0; i < merged.length; i++) {
    const [a, b] = merged[i];
    if (!overlapsGap(a, b) && b - a < 36 * HOUR) sessions.push({ h: berlin(a).hour, len: b - a });
    const next = merged[i + 1];
    if (next && !overlapsGap(b, next[0]) && !OFFDAYS.some(([x, y]) => x < next[0] && y > b) && next[0] - b < 72 * HOUR) breaks.push({ h: berlin(b).hour, len: next[0] - b });
  }
  return { sessions, breaks };
}
const globalPools = await (async () => {
  const rows = (await q(`SELECT id, player, at, type FROM events WHERE type IN ('join','first_join','leave') AND player IS NOT NULL AND at <= $1 ORDER BY player, at, id`, [new Date(CUTOFF)])).rows;
  const by = new Map();
  for (const r of rows) (by.get(r.player) ?? by.set(r.player, []).get(r.player)).push({ ...r, t: ms(r.at) });
  const all = { sessions: [], breaks: [] };
  for (const list of by.values()) {
    const p = buildPools(list);
    all.sessions.push(...p.sessions.filter((x) => x.len >= 20 * MIN));
    all.breaks.push(...p.breaks.filter((x) => x.len >= 10 * MIN));
  }
  return all;
})();
const hourDist = (a, b) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
/** Eintrag mit ähnlicher Startstunde ziehen, Länge leicht gestreut */
function drawLen(pool, hour, rng, minLen = 0) {
  let cand = [];
  for (const w of [2, 4, 12]) {
    cand = pool.filter((e) => hourDist(e.h, hour) <= w && e.len > minLen);
    if (cand.length >= 4) break;
  }
  if (!cand.length) cand = pool.filter((e) => e.len > minLen);
  if (!cand.length) return Math.max(minLen + 10 * MIN, minLen * (1.1 + rng() * 0.4));
  const e = cand[Math.floor(rng() * cand.length)];
  return Math.max(minLen + MIN, e.len * Math.exp(rng.normal() * 0.18));
}

/** Globale Online-Wahrscheinlichkeit je Stunde (Rückfall für Spieler mit wenig Daten) */
const globalPi = (() => {
  const on = new Array(24).fill(0);
  const tot = new Array(24).fill(0);
  for (let i = 1; i < hist.length; i++) {
    const dt = hist[i].t - hist[i - 1].t;
    if (dt > GAP_MS) continue;
    const h = berlin(hist[i - 1].t).hour;
    on[h] += hist[i - 1].online_count * dt;
    tot[h] += Math.max(1, players.length) * dt;
  }
  return smooth24(on.map((v, h) => (tot[h] ? v / tot[h] : 0.1)));
})();

/* ---------- Ausgabe-Sammler ---------- */

const out = {
  events: [],
  dropIds: new Set(),
  leavePatches: new Map(),
  adjust: [],
  estimates: [],
  tops: [],
  /** je Lücke und gedachter Abfrage: online, live (auf dem Server), Zuschauer (auf dem Server), Spielzeit-Zuwachs, Tode */
  gapAgg: gaps.map((g) => g.polls.map(() => ({ online: 0, live: 0, viewers: 0, play: 0, deaths: 0 }))),
};
let estSeq = 0;
let phWritten = 0;
const estId = (t, player, kind) => `est-${kind}-${Math.round(t).toString(36)}-${player}-${(estSeq++).toString(36)}`;

/* ---------- Zieltabellen (neues Schema, wird am Ende umgeschaltet) ---------- */

const S = "approx_fill_new";
await q(`SET statement_timeout = 0`);
await q(`SET lock_timeout = '30s'`);
await q(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
await q(`CREATE SCHEMA ${S}`);
for (const t of ["history", "player_history", "events", "player_top_history"]) await q(`CREATE TABLE ${S}.${t} (LIKE public.${t} INCLUDING DEFAULTS)`);

async function bulk(table, cols, casts, rows, chunk = 5000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const arrays = cols.map((_, c) => part.map((r) => r[c]));
    const sel = cols.map((c, n) => `u.c${n}${casts[n] ? `::${casts[n]}` : ""}`).join(", ");
    const un = cols.map((_, n) => `$${n + 1}::${casts[n] && casts[n] !== "text" && !casts[n].endsWith("[]") && casts[n] !== "jsonb" ? casts[n] : "text"}[]`).join(", ");
    await q(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) SELECT ${sel} FROM unnest(${un}) AS u(${cols.map((_, n) => `c${n}`).join(", ")})`, arrays);
  }
}

const phColNames = ["player", "at", "online", "viewers", "playtime_seconds", "deaths", "diamonds", "blocks_broken", "mobs_killed", "distance", "damage_dealt", "totems_used", "food_eaten", "followers_on_server", "followers_total", "ranks", "stream_game_id", "stream_game_name", "extra_stats"];
const phCasts = ["text", "timestamptz", "boolean", "integer", "integer", "integer", "integer", "integer", "integer", "double precision", "double precision", "integer", "integer", "integer", "integer", "jsonb", "text", "text", "integer[]"];
const missing = phCols.map((c) => c.column_name).filter((c) => !phColNames.includes(c));
if (missing.length) log(`Hinweis: player_history-Spalten ohne Schätzung (bleiben leer): ${missing.join(", ")}`);

/* ---------- Je Spieler ---------- */

for (const p of players) {
  await estimatePlayer(p);
}
log(`Spieler fertig: ${phWritten} Verlaufszeilen, ${out.events.length} neue Ereignisse, ${out.dropIds.size} ersetzte Grenz-Ereignisse`);

async function estimatePlayer(p) {
  const id = p.id;
  const rows = (await q(`SELECT * FROM player_history WHERE player = $1 AND at <= $2 ORDER BY at`, [id, new Date(CUTOFF)])).rows;
  if (!rows.length) return;
  const evs = (
    await q(
      `SELECT id, at, type, delta, value, meta FROM events
        WHERE player = $1 AND at <= $2 AND type IN ('join','first_join','leave','afk_start','afk_end','afk_mobs_start','afk_mobs_end','afk_blocks_start','afk_blocks_end','stream_start','stream_end','stream_title','milestone','rank','subscription','death','diamonds','blocksBroken','mobsKilled','distance','damageDealt','totemsUsed','foodEaten')
        ORDER BY at, id`,
      [id, new Date(CUTOFF)],
    )
  ).rows.map((e) => ({ ...e, t: ms(e.at) }));
  const R = rows.map((r) => ({ ...r, t: ms(r.at), live: r.viewers !== null }));
  // Echte Stream-Zeiten aus den Archiv-VODs (lib/twitchHistory.ts): in Lücken genau statt geschätzt.
  // Aufeinanderfolgende VODs (Twitch teilt nach 48 h) sind ein Stream.
  const vodStreams = [];
  for (const v of (await q(`SELECT id, created_at, duration_s, title FROM twitch_vods WHERE player = $1 ORDER BY created_at`, [id]).catch(() => ({ rows: [] }))).rows) {
    const start = ms(v.created_at);
    const end = start + v.duration_s * 1000;
    const prev = vodStreams[vodStreams.length - 1];
    if (prev && start - prev.end < 5 * MIN) prev.end = Math.max(prev.end, end);
    else vodStreams.push({ start, end, title: v.title, vodId: v.id });
  }
  const vodAt = (t) => vodStreams.find((v) => t >= v.start && t < v.end) ?? null;
  // Raids mit Zuschauerzahl (live oder aus der Chat-Wiedergabe, scripts/vod-chat.mjs): ausgehende zeigen, wie viele
  // am Stream-Ende noch zuschauten; eingehende bringen dem Ziel Zuschauer
  const raidsOut = (await q(`SELECT at, value FROM events WHERE type = 'raid' AND player = $1 AND value > 0 AND at <= $2`, [id, new Date(CUTOFF)])).rows.map((r) => ({ t: ms(r.at), v: Number(r.value) }));
  const raidsIn = (await q(`SELECT at, value FROM events WHERE type = 'raid' AND meta->>'raidTargetPlayerId' = $1 AND value > 0 AND at <= $2`, [id, new Date(CUTOFF)])).rows.map((r) => ({ t: ms(r.at), v: Number(r.value) }));
  // Erstes Join nur, wenn der Spieler davor nicht schon im Verlauf auftaucht (Tracker-Neustarts melden alte Spieler neu)
  const firstJoin = evs.find((e) => e.type === "first_join" && e.t <= R[0].t + 5 * MIN) ?? null;
  let pStart = firstJoin ? firstJoin.t : START;
  // Erstes Join kurz nach einer Lücke: der Spieler kam wahrscheinlich schon während der Lücke
  const joinGap = firstJoin ? gaps.find((g) => firstJoin.t >= g.b && firstJoin.t <= g.b + 120_000) : null;
  if (joinGap) pStart = joinGap.a;

  /* --- Echte AFK-Phasen --- */
  const afkIv = [];
  {
    let open = null;
    for (const e of evs) {
      if (e.type === "afk_start") open = typeof e.meta?.since === "string" ? Math.min(ms(e.meta.since), e.t) : e.t;
      else if (e.type === "afk_end" && open !== null) {
        afkIv.push([open, e.t]);
        open = null;
      } else if (e.type === "leave" && open !== null) {
        afkIv.push([open, e.t]);
        open = null;
      }
    }
    if (open !== null) afkIv.push([open, CUTOFF]);
  }
  /** Liegt t in einer echten AFK-Phase? (Phasen sind sortiert und überlappen nicht) */
  const afkAt = (t) => {
    let lo = 0;
    let hi = afkIv.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (afkIv[mid][1] <= t) lo = mid + 1;
      else if (afkIv[mid][0] > t) hi = mid - 1;
      else return true;
    }
    return false;
  };

  /* --- Profil aus den echten Daten --- */
  const onMin = new Array(24).fill(0);
  const liveOnMin = new Array(24).fill(0);
  const liveOffMin = new Array(24).fill(0);
  const viewOn = Array.from({ length: 24 }, () => []);
  const viewOff = [];
  let afkMs = 0;
  let onMs = 0;
  let playGain = 0;
  let playOnMs = 0;
  let subCount = 0;
  let viewerMin = 0;
  for (let i = 0; i + 1 < R.length; i++) {
    const r = R[i];
    const n = R[i + 1];
    const dt = n.t - r.t;
    if (dt > 3 * MIN) continue;
    const h = berlin(r.t).hour;
    if (r.online) {
      onMin[h] += dt / MIN;
      onMs += dt;
      if (afkAt(r.t)) afkMs += dt;
      // Spielzeit zählt auf dem Server nur ohne AFK: Zuwachs je aktiver Online-Sekunde
      if (r.playtime_seconds !== null && n.playtime_seconds !== null && n.playtime_seconds >= r.playtime_seconds) {
        playGain += n.playtime_seconds - r.playtime_seconds;
        if (!afkAt(r.t)) playOnMs += dt;
      }
    }
    if (r.live) {
      if (r.online) {
        liveOnMin[h] += dt / MIN;
        viewOn[h].push(r.viewers);
      } else {
        liveOffMin[h] += dt / MIN;
        viewOff.push(r.viewers);
      }
      if (r.t >= SUB_START && !gapOf(r.t)) viewerMin += (r.viewers * dt) / MIN;
    }
  }
  for (const e of evs) if (e.type === "subscription" && e.t >= SUB_START) subCount += Number(e.delta ?? 0);
  const trackedMin = new Array(24).fill(0);
  for (const [k, v] of trackedByHour) if (k * HOUR >= pStart - HOUR) trackedMin[berlin(k * HOUR).hour] += v / MIN;
  const prior = 90;
  const pi = smooth24(onMin.map((v, h) => (v + prior * globalPi[h]) / (trackedMin[h] + prior)));
  const offMinH = trackedMin.map((v, h) => Math.max(1, v - onMin[h]));
  const isStreamer = liveOnMin.reduce((s, v) => s + v, 0) + liveOffMin.reduce((s, v) => s + v, 0) > 30;
  const pLiveOn = smooth24(liveOnMin.map((v, h) => (v + 0.5) / (onMin[h] + 20)));
  const pLiveOff = smooth24(liveOffMin.map((v, h) => (v + 0.2) / (offMinH[h] + 60)));
  const allOnViews = viewOn.flat();
  const medOn = median(allOnViews) ?? median(viewOff) ?? 50;
  const medOff = median(viewOff) ?? medOn * 0.8;
  const hourFactor = smooth24(viewOn.map((v) => (v.length >= 20 ? clamp((median(v) ?? medOn) / Math.max(1, medOn), 0.3, 3) : 1)));
  const sessionLens = [];
  {
    let open = null;
    for (const e of evs) {
      if (e.type === "join" || e.type === "first_join") open = e.t;
      else if (e.type === "leave") {
        const secs = Number(e.meta?.sessionSeconds ?? 0);
        const len = open !== null ? e.t - open : secs * 1000;
        if (len > 2 * MIN && len < 30 * HOUR && !e.id.startsWith("merge-")) sessionLens.push(len);
        open = null;
      }
    }
  }
  const meanOn = clamp(sessionLens.length >= 3 ? sessionLens.reduce((s, v) => s + v, 0) / sessionLens.length / MIN : 110, 15, 900);
  // Vorrat für die Lücken: eigene Sessions und Pausen (ohne Mini-Sessions), sonst die aller Spieler
  const own = buildPools(evs.filter((e) => e.type === "join" || e.type === "first_join" || e.type === "leave"));
  const ownSessions = own.sessions.filter((x) => x.len >= 20 * MIN);
  const ownBreaks = own.breaks.filter((x) => x.len >= 10 * MIN);
  const sessPool = ownSessions.length >= 6 ? ownSessions : [...ownSessions, ...globalPools.sessions];
  const breakPool = ownBreaks.length >= 6 ? ownBreaks : [...ownBreaks, ...globalPools.breaks];
  const streamLens = evs.filter((e) => e.type === "stream_end" && Number(e.meta?.streamSeconds) > 600).map((e) => Number(e.meta.streamSeconds) / 60);
  const meanStream = clamp(streamLens.length ? streamLens.reduce((s, v) => s + v, 0) / streamLens.length : 240, 40, 1200);
  const afkShare = onMs > HOUR ? clamp(afkMs / onMs, 0, 0.9) : 0.2;
  const meanAfk = clamp(afkIv.length ? afkIv.reduce((s, [a, b]) => s + (b - a), 0) / afkIv.length / MIN : 25, 6, 300);
  const meanActive = clamp(afkShare > 0.01 ? (meanAfk * (1 - afkShare)) / afkShare : 400, 8, 600);
  const rho = playOnMs > 2 * HOUR ? clamp(playGain / (playOnMs / 1000), 0.5, 1.4) : 1;
  const subRate = viewerMin > 1000 ? subCount / viewerMin : 0;
  const prng = rngFor("player", id);
  /** Tagesform: Mal spielt jemand mehr, mal weniger als sonst */
  const dayMood = new Map();
  const mood = (t) => {
    const d = berlin(t).day;
    if (!dayMood.has(d)) dayMood.set(d, Math.exp(rngFor("mood", id, d).normal() * 0.35));
    return dayMood.get(d);
  };
  const closeJitter = prng() * 20 * MIN;
  const piAt = (t) => clamp(pi[berlin(t).hour] * mood(t), 0.0005, 0.97);
  const forcedOff = (t) => t < pStart || OFFDAYS.some(([a, b]) => t >= a - closeJitter && t < b);

  /* --- Spielzeit-Anker: wie viel Online-Zeit muss in jede Lücke? --- */
  const playAnchors = [{ t: START, v: 0 }];
  {
    const clean = monotone(R.map((r) => r.playtime_seconds));
    R.forEach((r, k) => clean[k] !== null && playAnchors.push({ t: r.t, v: clean[k] }));
  }
  const spans = gaps
    .filter((g) => g.b > pStart && g.polls.length)
    .map((g) => {
      const before = (() => {
        let lo = 0;
        let hi = R.length - 1;
        let best = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (R[mid].t <= g.a) {
            best = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        return best >= 0 && g.a - R[best].t <= 3 * MIN ? R[best] : null;
      })();
      // Erster Stand nach der Lücke (Spielerzeilen können nach einem Neustart ein paar Minuten später beginnen);
      // ein echtes Join dazwischen heißt: bei Lückenende noch offline
      const first = R.find((r) => r.t >= g.b && r.t <= g.b + 15 * MIN) ?? null;
      const joinedLater = first && evs.some((e) => (e.type === "join" || e.type === "first_join") && e.t > g.b + 120_000 && e.t <= first.t);
      const after = first && !joinedLater ? first : null;
      const polls = g.polls.filter((t) => t >= pStart);
      return {
        g,
        polls,
        startOn: !g.pre && Boolean(before?.online),
        endOn: Boolean(after?.online),
        startLive: !g.pre && Boolean(before?.live),
        endLive: Boolean(after?.live),
        before,
        after,
        sessionStart: (() => {
          let j = null;
          for (const e of evs) {
            if (e.t > g.a) break;
            if (e.type === "join" || e.type === "first_join") j = e.t;
            else if (e.type === "leave") j = null;
          }
          return j;
        })(),
        expected: polls.reduce((s, t, i) => s + (forcedOff(t) ? 0 : piAt(t) * ((polls[i + 1] ?? g.b) - t)), 0),
      };
    })
    .filter((s) => s.polls.length);
  // Echte Online-Zeit je Anker-Intervall und Zielzeit je Lücke
  for (const s of spans) {
    let j = 0;
    while (j + 1 < playAnchors.length && playAnchors[j + 1].t <= s.g.a) j++;
    s.anchor = j;
  }
  const realActiveIn = (a, b) => {
    let sum = 0;
    for (let i = 0; i + 1 < R.length; i++) {
      if (R[i].t < a || R[i].t >= b) continue;
      const dt = R[i + 1].t - R[i].t;
      if (R[i].online && dt <= 3 * MIN && !afkAt(R[i].t)) sum += dt;
    }
    return sum;
  };
  const byAnchor = new Map();
  for (const s of spans) (byAnchor.get(s.anchor) ?? byAnchor.set(s.anchor, []).get(s.anchor)).push(s);
  for (const [j, list] of byAnchor) {
    const A = playAnchors[j];
    const B = playAnchors[j + 1];
    const need = B ? ((B.v - A.v) / rho) * 1000 : null;
    const remaining = need === null ? null : need - realActiveIn(A.t, B.t);
    const sumE = list.reduce((s, x) => s + x.expected * (1 - afkShare), 0) || 1;
    for (const s of list) {
      const dur = (s.polls.length ? s.g.b - s.polls[0] : 0) || 1;
      // Bekannte Spielzeit direkt vor und nach der Lücke: die Differenz ist die aktive Zeit (Spielzeit läuft nur
      // ohne AFK). Sonst liegen echte Minuten mit dazwischen, deren Messung selbst Lücken hat; dann nur als
      // Tendenz zum üblichen Verhalten des Spielers.
      const tight = need !== null && list.length === 1 && A.t >= s.g.a - 5 * MIN && B.t <= s.g.b + 5 * MIN;
      const expActive = s.expected * (1 - afkShare);
      s.tight = tight;
      s.activeTarget = tight ? clamp(need, 0, dur) : remaining === null ? expActive : clamp(expActive * clamp(remaining / sumE, 0.8, 1.25), 0, dur);
      // Online-Zeit: aktive Zeit plus übliche AFK-Zeit. Vor und nach der Lücke online und die Lücke nicht länger als
      // eine typische Session: der Spieler war durchgehend da (ohne Spielzeit-Zuwachs eben AFK).
      const stayed = tight && s.startOn && s.endOn && dur <= Math.max(meanOn, 60) * MIN;
      s.target = stayed ? dur : clamp(s.activeTarget / Math.max(0.1, 1 - afkShare), s.activeTarget, dur);
    }
  }

  /* --- Ketten je Lücke: online, AFK, live, Zuschauer --- */
  for (const s of spans) simulateSpan(s);

  function simulateSpan(s) {
    const { polls, g } = s;
    const n = polls.length;
    const dur = polls.map((t, i) => (polls[i + 1] ?? g.b) - t);
    const forced = polls.map(forcedOff);
    /**
     * Ganze Sessions und Pausen ziehen (aus dem Vorrat des Spielers, passend zur Uhrzeit), statt Minute für Minute
     * zu würfeln: So entstehen Sessions, wie der Spieler sie wirklich spielt, und keine 10-Minuten-Schnipsel.
     * Liefert Sessions [Beginn, Ende] (das Ende kann hinter der Lücke liegen = bei Lückenende noch online).
     */
    const close = OFFDAYS.map(([x, y]) => [x - closeJitter, y]);
    const sampleSchedule = (rng) => {
      const out = [];
      let t = g.a;
      if (s.startOn) {
        const since = s.sessionStart ?? g.a;
        const end = since + drawLen(sessPool, berlin(since).hour, rng, g.a - since + 2 * MIN);
        out.push([g.a, end]);
        t = end;
      }
      for (let guard = 0; guard < 400 && t < g.b; guard++) {
        // Pause
        let next = t + drawLen(breakPool, berlin(t).hour, rng);
        for (const [x, y] of close) if (next >= x && t < y) next = Math.max(next, y + drawLen(breakPool, berlin(y).hour, rng) * rng());
        next = Math.max(next, pStart);
        if (next >= g.b) break;
        let end = next + drawLen(sessPool, berlin(next).hour, rng);
        for (const [x] of close) if (next < x && end > x) end = x;
        if (end - next < 10 * MIN) {
          t = end;
          continue;
        }
        out.push([next, end]);
        t = end;
      }
      // Sessions, die über den Offtag-Beginn liefen, enden dort
      for (const ses of out) for (const [x] of close) if (ses[0] < x && ses[1] > x) ses[1] = Math.max(ses[0] + MIN, x);
      return out;
    };
    const onlineAtB = (sched) => sched.some(([x, y]) => x < g.b && y >= g.b);
    const onlineIn = (sched) => sched.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(y, g.b) - Math.max(x, g.a)), 0);
    /** Zustand am Lückenende erzwingen, falls keine Ziehung passt */
    const fixEnd = (sched, rng) => {
      if (onlineAtB(sched) === s.endOn) return sched;
      if (s.endOn) {
        const lastEnd = sched.length ? sched[sched.length - 1][1] : g.a;
        const len = drawLen(sessPool, berlin(g.b).hour, rng);
        const start = Math.max(lastEnd + 10 * MIN, g.b - len * (0.2 + 0.6 * rng()), g.a, pStart);
        if (start < g.b - MIN) sched.push([start, g.b + len]);
        else if (sched.length) sched[sched.length - 1][1] = g.b + len;
        else sched.push([g.a, g.b + len]);
      } else {
        const last = sched[sched.length - 1];
        const end = g.b - (2 + rng() * 25) * MIN;
        if (end - last[0] >= 15 * MIN) last[1] = end;
        else sched.pop();
      }
      return sched;
    };
    let best = null;
    {
      const rng = rngFor("sessions", id, g.a);
      const stayed = s.target >= dur.reduce((x, y) => x + y, 0) - MIN && s.startOn && s.endOn;
      if (stayed) best = [[g.a, g.b + HOUR]];
      else {
        const cands = [];
        for (let k = 0; k < 300; k++) {
          const sched = sampleSchedule(rng);
          if (onlineAtB(sched) !== s.endOn) continue;
          cands.push({ sched, err: Math.abs(onlineIn(sched) - s.target) });
          if (cands.length >= 120) break;
        }
        if (!cands.length) cands.push({ sched: fixEnd(sampleSchedule(rng), rng), err: 0 });
        // Bei bekannter Spielzeit zählt die Passung stark, sonst nur als Tendenz; unter den guten Ziehungen zufällig
        const tol = s.tight ? Math.max(15 * MIN, 0.1 * s.target) : Math.max(45 * MIN, 0.35 * s.target);
        cands.sort((x, y) => x.err - y.err);
        const good = cands.filter((c) => c.err <= tol);
        best = (good.length ? good[Math.floor(rng() * good.length)] : cands[0]).sched;
      }
    }
    s.sessions = best;
    best = Uint8Array.from(polls, (t, i) => (!forced[i] && s.sessions.some(([x, y]) => t >= x && t < y) ? 1 : 0));
    s.online = best;
    s.dur = dur;

    // AFK innerhalb der Sessions
    const afk = new Uint8Array(n);
    const arng = rngFor("afk", id, g.a);
    let curAfk = s.startOn && s.before ? (afkAt(s.before.t) ? 1 : 0) : 0;
      let sinceJoin = s.startOn ? 99 : 0;
    for (let i = 0; i < n; i++) {
      if (!best[i]) {
        curAfk = 0;
        sinceJoin = 0;
        continue;
      }
      sinceJoin++;
      const dtMin = dur[i] / MIN;
      if (curAfk) {
        if (arng() < dtMin / meanAfk) curAfk = 0;
      } else if (sinceJoin > 4 && arng() < dtMin / meanActive) curAfk = 1;
      afk[i] = curAfk;
    }
    // Bei bekannter Spielzeit: AFK-Anteil so anpassen, dass die aktive Zeit aufgeht
    if (s.tight) {
      const activeMs = () => afk.reduce((sum, v, i) => sum + (best[i] && !v ? dur[i] : 0), 0);
      for (let iter = 0; iter < 800; iter++) {
        const diff = activeMs() - s.activeTarget;
        if (Math.abs(diff) <= Math.max(3 * MIN, 0.05 * s.activeTarget)) break;
        const steps = Math.max(1, Math.ceil((Math.abs(diff) / MIN) * (0.25 + 0.5 * arng())));
        // Zu viel aktiv: neue AFK-Phase oder bestehende verlängern; zu wenig: AFK-Phasen kürzen
        const i0 = Math.floor(arng() * n);
        if (diff > 0) {
          let i = i0;
          while (i < n && !(best[i] && !afk[i])) i++;
          if (i >= n) continue;
          for (let k = i; k < Math.min(n, i + steps) && best[k]; k++) afk[k] = 1;
        } else {
          let i = i0;
          while (i < n && !afk[i]) i++;
          if (i >= n) {
            i = 0;
            while (i < n && !afk[i]) i++;
            if (i >= n) break;
          }
          let j = i;
          while (j < n && afk[j]) j++;
          for (let k = Math.max(i, j - steps); k < j; k++) afk[k] = 0;
        }
      }
    }
    s.afk = afk;

    // Streams: bekannter Beginn des Streams nach der Lücke (Twitch meldet ihn), sonst Kette
    const live = new Uint8Array(n);
    let knownStart = null;
    if (s.endLive) {
      const ev = evs.find((e) => (e.type === "stream_start" || e.type === "stream_title") && e.t >= g.b && e.t <= g.b + 30 * MIN && e.meta?.startedAt);
      const sub = evs.find((e) => e.type === "subscription" && e.t >= g.b && e.t <= g.b + 3 * HOUR && e.meta?.streamStartedAt);
      const st = ev?.meta?.startedAt ?? sub?.meta?.streamStartedAt ?? null;
      if (st) knownStart = ms(st);
    }
    s.knownStreamStart = knownStart;
    const lrng = rngFor("live", id, g.a);
    if (isStreamer || s.startLive || s.endLive) {
      let cur = s.startLive ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const t = polls[i];
        if (knownStart !== null && t >= knownStart) {
          live[i] = 1;
          cur = 1;
          continue;
        }
        if (knownStart !== null && knownStart > g.a && t < knownStart && polls[i + 1] !== undefined && polls[i + 1] >= knownStart && cur && !s.startLive) {
          // Vor dem bekannten Beginn kein anderer Stream im selben Moment
          cur = 0;
        }
        const dtMin = dur[i] / MIN;
        const pEnd = Math.min(1, dtMin / meanStream);
        const qv = clamp(best[i] ? pLiveOn[berlin(t).hour] : pLiveOff[berlin(t).hour], 0.0005, 0.97);
        const pStartLive = Math.min(1, (pEnd * qv) / (1 - qv));
        if (cur ? lrng() < pEnd : lrng() < pStartLive) cur = 1 - cur;
        live[i] = cur;
      }
      if (knownStart !== null && knownStart > g.a) {
        // Der Stream davor muss vor dem bekannten Beginn enden
        for (let i = n - 1; i >= 0; i--) {
          if (polls[i] >= knownStart) continue;
          if (polls[i] >= knownStart - 3 * MIN) live[i] = 0;
          break;
        }
      }
      if (s.endLive && !live[n - 1]) {
        const len = Math.max(1, Math.ceil(lrng.exp(meanStream * 0.5)));
        for (let i = Math.max(0, n - len); i < n; i++) live[i] = 1;
      } else if (!s.endLive && live[n - 1]) {
        let r = n - 1;
        while (r > 0 && live[r - 1]) r--;
        const k = r + Math.floor(lrng() * (n - r));
        for (let i = Math.max(r === 0 && s.startLive ? 1 : r, k); i < n; i++) live[i] = 0;
      }
    }
    // VODs vorhanden: Stream-Zustand in der Lücke ist bekannt (nur, wo der Kanal VODs hat)
    if (vodStreams.length) {
      for (let i = 0; i < n; i++) live[i] = vodAt(polls[i]) ? 1 : 0;
      s.fromVods = true;
    }
    s.live = live;

    // Zuschauer je Stream-Abschnitt
    const viewers = new Int32Array(n);
    const vrng = rngFor("viewers", id, g.a);
    for (let i = 0; i < n; ) {
      if (!live[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && live[j]) j++;
      const fromStart = i === 0 && s.startLive;
      const toEnd = j === n && s.endLive;
      const v0 = fromStart && s.before?.viewers ? s.before.viewers : null;
      // Endet der Stream in der Lücke mit einem Raid, ist die Zuschauerzahl am Ende bekannt (Raid-Größe)
      const endRaid = !toEnd ? raidsOut.find((r) => r.t >= polls[j - 1] - 10 * MIN && r.t <= (polls[j] ?? g.b) + 15 * MIN) : null;
      const v1 = toEnd && s.after?.viewers ? s.after.viewers : endRaid ? endRaid.v : null;
      const level = Math.exp(vrng.normal() * 0.3);
      let z = 0;
      for (let k = i; k < j; k++) {
        const t = polls[k];
        const typical = (best[k] ? medOn * hourFactor[berlin(t).hour] : medOff) * level;
        let base;
        if (v0 !== null && v1 !== null) {
          const f = (k - i + 1) / (j - i + 1);
          base = Math.exp(Math.log(Math.max(1, v0)) * (1 - f) + Math.log(Math.max(1, v1)) * f);
        } else if (v0 !== null) {
          const f = clamp((t - polls[i]) / (90 * MIN), 0, 1);
          base = v0 * (1 - f) + typical * f;
        } else if (v1 !== null) {
          const f = clamp((polls[j - 1] - t) / (90 * MIN), 0, 1);
          base = v1 * (1 - f) + typical * f;
        } else base = typical;
        // Anlauf am Stream-Beginn und Abfall zum Ende
        const sinceStart = (t - polls[i]) / MIN;
        const toEndMin = (polls[j - 1] - t) / MIN;
        if (!fromStart && v1 === null) base *= 0.35 + 0.65 * clamp(sinceStart / 25, 0, 1);
        else if (!fromStart) base *= 0.5 + 0.5 * clamp(sinceStart / 15, 0, 1);
        if (!toEnd && !endRaid) base *= 0.8 + 0.2 * clamp(toEndMin / 15, 0, 1);
        // Eingehende Raids: etwa die Hälfte der Raider bleibt erst, dann wandern sie über eine Stunde ab
        for (const r of raidsIn) if (t >= r.t && t - r.t < 3 * HOUR) base += r.v * 0.5 * Math.exp(-(t - r.t) / HOUR);
        z = 0.93 * z + vrng.normal() * 0.045;
        viewers[k] = Math.max(0, Math.round(base * Math.exp(z)));
      }
      i = j;
    }
    s.viewers = viewers;
  }

  /* --- Gemeinsame Zeitreihe aus echten und geschätzten Punkten --- */
  const P = [];
  for (const r of R) P.push({ t: r.t, on: r.online, live: r.live, viewers: r.viewers, afk: r.online && afkAt(r.t), row: r, synth: false });
  for (const s of spans) {
    for (let i = 0; i < s.polls.length; i++) {
      const on = s.online[i] === 1;
      const live = s.live[i] === 1;
      const changed = i === 0 ? on !== s.startOn || live !== s.startLive : on !== (s.online[i - 1] === 1) || live !== (s.live[i - 1] === 1);
      if (!on && !live && !changed) continue;
      P.push({ t: s.polls[i], on, live, viewers: live ? s.viewers[i] : null, afk: on && s.afk[i] === 1, row: null, synth: true, span: s, k: i });
    }
  }
  P.sort((x, y) => x.t - y.t);
  const N = P.length;

  /* --- Zählerwerte verteilen --- */
  const noiseCache = new Map();
  const noiseFor = (key, sigma) => {
    const ck = `${key}:${sigma}`;
    if (noiseCache.has(ck)) return noiseCache.get(ck);
    const base = noiseCache.get(key) ?? (() => {
      const rng = rngFor("noise", id, key);
      const arr = new Float64Array(N);
      let z = rng.normal();
      for (let k = 0; k < N; k++) {
        const dtMin = k ? clamp((P[k].t - P[k - 1].t) / MIN, 0.2, 30) : 1;
        const phi = Math.pow(0.95, dtMin);
        z = phi * z + Math.sqrt(1 - phi * phi) * rng.normal();
        arr[k] = z;
      }
      noiseCache.set(key, arr);
      return arr;
    })();
    const arr = new Float64Array(N);
    for (let k = 0; k < N; k++) arr[k] = Math.exp(sigma * base[k] - (sigma * sigma) / 2);
    noiseCache.set(ck, arr);
    return arr;
  };
  const activity = (kind, pt) => {
    if (kind === "follow") return pt.live ? Math.max(1, pt.viewers ?? 0) : medOn * 0.02;
    if (kind === "followServer") return pt.live && pt.on ? Math.max(1, pt.viewers ?? 0) : 0;
    if (!pt.on) return 0;
    switch (kind) {
      case "active":
        return pt.afk ? 0.03 : 1;
      case "move":
        return pt.afk ? 0 : 1;
      case "farm":
        return pt.afk ? 0.35 : 1;
      case "mobfarm":
        return pt.afk ? 0.45 : 1;
      case "afk":
        return pt.afk ? 1 : 0.01;
      default:
        return 1;
    }
  };
  /** Kumulierte Gewichte je Punkt (Gewicht des Abschnitts k−1 → k liegt bei k) */
  const cumWeights = (kind, noise) => {
    const W = new Float64Array(N + 1);
    for (let k = 0; k < N; k++) {
      const prevT = k ? P[k - 1].t : START;
      const dt = Math.min(P[k].t - prevT, 5 * MIN);
      const w = k ? activity(kind, P[k - 1]) * dt * noise[k] : 0;
      W[k + 1] = W[k] + Math.max(0, w);
    }
    return W;
  };

  /**
   * Füllt eine Reihe: `vals[k]` = echter Wert oder null. Zwischen zwei bekannten Werten (oder ab 0 beim Start)
   * wird der Zuwachs nach Gewicht verteilt; vor dem ersten bekannten Wert ohne Startwert wird zurückgerechnet.
   * Liefert gefüllte Werte, Herkunft je Punkt (0 echt, 1 Lücke, 2 nachgetragen, 3 zurückgerechnet) und Konfidenz.
   */
  const fillSeries = (vals, W, { zeroStart, int, steps = null }) => {
    const res = new Float64Array(N).fill(NaN);
    const src = new Uint8Array(N);
    const conf = new Float32Array(N);
    // Bekannte Einzelschritte (z. B. Tode mit echtem Zeitpunkt): kumuliert je Punkt; nur der Rest wird verteilt
    const stepCum = new Float64Array(N);
    if (steps?.length) {
      let j = 0;
      let acc = 0;
      for (let k = 0; k < N; k++) {
        while (j < steps.length && steps[j].t <= P[k].t) acc += steps[j++].d;
        stepCum[k] = acc;
      }
    }
    /** Nur der verteilte (geschätzte) Anteil, für Ereignisse */
    const ext = new Float64Array(N);
    let extBase = 0;
    const clean = monotone(vals);
    const anchors = [];
    for (let k = 0; k < N; k++) {
      if (clean[k] === null) continue;
      anchors.push(k);
      res[k] = clean[k];
    }
    if (!anchors.length) return { res, src, conf, ext, any: false };
    const put = (k, v, how, c) => {
      res[k] = int ? Math.round(v) : Math.round(v * 100) / 100;
      src[k] = how;
      conf[k] = c;
    };
    const first = anchors[0];
    /** Wert zwischen zwei Ankern: bekannte Schritte dazwischen plus Rest nach Gewicht */
    const between = (k, va, vb, sa, sb, f) => {
      const S = sb - sa;
      const D = vb - va;
      const scale = S > D && S > 0 ? D / S : 1;
      const extra = Math.max(0, D - S * scale);
      const e = int ? Math.round(extra * f) : extra * f;
      ext[k] = extBase + e;
      return va + (stepCum[k] - sa) * scale + e;
    };
    if (zeroStart) {
      const vb = res[first];
      const wa = W[0];
      const wb = W[first + 1];
      const hours = (P[first].t - START) / HOUR;
      for (let k = 0; k < first; k++) {
        const f = wb > wa ? (W[k + 1] - wa) / (wb - wa) : (P[k].t - START) / Math.max(1, P[first].t - START);
        put(k, between(k, 0, vb, 0, stepCum[first], f), P[k].synth ? 1 : 2, P[k].synth ? P[k].span.g.conf * 0.95 : clamp(0.92 - 0.06 * Math.log1p(hours), 0.5, 0.92));
      }
      extBase = first > 0 ? Math.max(0, vb - stepCum[first]) : 0;
    } else if (anchors.length >= 2) {
      const last = anchors[anchors.length - 1];
      const rate = W[last + 1] > W[first + 1] ? (res[last] - res[first]) / (W[last + 1] - W[first + 1]) : 0;
      for (let k = first - 1; k >= 0; k--) put(k, Math.max(0, res[first] - rate * (W[first + 1] - W[k + 1])), 3, 0.45);
    }
    for (let x = 0; x + 1 < anchors.length; x++) {
      const a = anchors[x];
      const b = anchors[x + 1];
      ext[a] = extBase;
      if (b === a + 1) continue;
      const va = res[a];
      const vb = res[b];
      const wa = W[a + 1];
      const wb = W[b + 1];
      const hours = (P[b].t - P[a].t) / HOUR;
      for (let k = a + 1; k < b; k++) {
        const f = wb > wa ? (W[k + 1] - wa) / (wb - wa) : (P[k].t - P[a].t) / Math.max(1, P[b].t - P[a].t);
        put(k, between(k, va, vb, stepCum[a], stepCum[b], f), P[k].synth ? 1 : 2, P[k].synth ? P[k].span.g.conf : clamp(0.95 - 0.05 * Math.log1p(hours), 0.55, 0.95));
      }
      const S = stepCum[b] - stepCum[a];
      extBase += Math.max(0, vb - va - S);
    }
    for (let k = anchors[anchors.length - 1]; k < N; k++) ext[k] = extBase;
    return { res, src, conf, ext, any: true };
  };

  const filled = {};
  const est = [];
  const note = (stat, f) => {
    let cnt = 0;
    let csum = 0;
    let from = null;
    let to = null;
    for (let k = 0; k < N; k++) {
      if (!f.src[k]) continue;
      cnt++;
      csum += f.conf[k];
      from ??= P[k].t;
      to = P[k].t;
    }
    if (cnt) est.push({ player: id, stat, from, to, points: cnt, share: cnt / N, confidence: csum / cnt });
  };
  const deathSteps = evs.filter((e) => e.type === "death" && isFeedDeath(e) && !out.dropIds.has(e.id)).map((e) => ({ t: e.t, d: Math.max(1, Number(e.delta ?? 1)) }));
  for (const s of STATS) {
    const vals = P.map((pt) => (pt.row ? pt.row[s.col] : null));
    const f = fillSeries(vals, cumWeights(s.act, noiseFor(s.noise, s.sigma)), { zeroStart: true, int: s.int, steps: s.col === "deaths" ? deathSteps : null });
    filled[s.col] = f;
    if (f.any) note(s.board, f);
  }
  const extraFilled = EXTRA_KEYS.map((key, xi) => {
    const m = EXTRA_MODEL[key] ?? { act: "active", sigma: 1, noise: "build" };
    const vals = P.map((pt) => (pt.row?.extra_stats ? (pt.row.extra_stats[xi] ?? null) : null));
    const f = fillSeries(vals, cumWeights(m.act, noiseFor(m.noise, m.sigma)), { zeroStart: true, int: true });
    if (f.any) note(`x:${key}`, f);
    return f;
  });
  const follow = fillSeries(
    P.map((pt) => (pt.row ? pt.row.followers_total : null)),
    cumWeights("follow", noiseFor("follow", 0.4)),
    { zeroStart: false, int: true },
  );
  if (follow.any) note("followers", follow);
  // Follower auf dem Server: Zähler des Trackers, beginnt erst mit der Erfassung bei 0. Davor gewonnene Follower
  // werden aus der Rate je Zuschauerminute geschätzt und allen späteren Werten vorangestellt.
  const fosVals = P.map((pt) => (pt.row ? pt.row.followers_on_server : null));
  const fosW = cumWeights("followServer", noiseFor("follow", 0.4));
  const fosFirst = fosVals.findIndex((v) => v !== null);
  const fosLast = fosVals.findLastIndex((v) => v !== null);
  const fosRate = fosFirst >= 0 && fosW[fosLast + 1] > fosW[fosFirst + 1] ? Math.max(0, fosVals[fosLast] - fosVals[fosFirst]) / (fosW[fosLast + 1] - fosW[fosFirst + 1]) : 0;
  let fosOffset = 0;
  const fos = fillSeries(fosVals, fosW, { zeroStart: false, int: true });
  if (fosFirst > 0 && fosRate > 0) {
    fosOffset = Math.round(fosRate * fosW[fosFirst + 1]);
    for (let k = 0; k < N; k++) {
      if (k < fosFirst) {
        fos.res[k] = Math.round((fosOffset * fosW[k + 1]) / Math.max(1, fosW[fosFirst + 1]));
        fos.src[k] = 3;
        fos.conf[k] = 0.4;
      } else if (!Number.isNaN(fos.res[k])) fos.res[k] += fosOffset;
    }
  }
  if (fos.any || fosOffset) note("followersOnServer", fos);

  /* --- Verlaufszeilen --- */
  const phRows = [];
  let lastExtraAt = -Infinity;
  const firstExtraReal = P.findIndex((pt) => pt.row?.extra_stats);
  for (let k = 0; k < N; k++) {
    const pt = P[k];
    const r = pt.row;
    const val = (col) => {
      const v = filled[col].res[k];
      return Number.isNaN(v) ? null : v;
    };
    let extra = r?.extra_stats ?? null;
    if (!extra && (pt.synth || k < firstExtraReal || firstExtraReal === -1) && pt.on && pt.t - lastExtraAt >= 5 * MIN) {
      const arr = extraFilled.map((f) => (Number.isNaN(f.res[k]) ? null : f.res[k]));
      if (arr.some((v) => v !== null)) {
        extra = arr;
        lastExtraAt = pt.t;
      }
    } else if (extra) lastExtraAt = pt.t;
    const game = pt.live ? (r?.stream_game_id ?? (pt.on ? "27471" : null)) : null;
    phRows.push([
      id,
      iso(pt.t),
      pt.on,
      pt.live ? (pt.viewers ?? 0) : null,
      val("playtime_seconds"),
      val("deaths"),
      val("diamonds"),
      val("blocks_broken"),
      val("mobs_killed"),
      val("distance"),
      val("damage_dealt"),
      val("totems_used"),
      val("food_eaten"),
      Number.isNaN(fos.res[k]) ? null : fos.res[k],
      Number.isNaN(follow.res[k]) ? null : follow.res[k],
      r?.ranks ? JSON.stringify(r.ranks) : null,
      r ? r.stream_game_id : game,
      r ? r.stream_game_name : game ? "Minecraft" : null,
      extra ? `{${extra.map((v) => (v === null || v === undefined ? "NULL" : Math.round(v))).join(",")}}` : null,
    ]);
  }

  {
    // Doppelte Zeitpunkte (echte und geschätzte Zeile in derselben Millisekunde) vermeiden
    const seen = new Set();
    const rowsOut = phRows.filter((r) => !seen.has(r[1]) && seen.add(r[1]));
    await bulk(`${S}.player_history`, phColNames, phCasts, rowsOut);
    phWritten += rowsOut.length;
  }

  /* --- Ereignisse --- */
  const evOut = [];
  const push = (t, type, fields) => evOut.push({ id: estId(t, id, type), at: iso(t), type, player: id, player_name: p.name, uuid: p.uuid, where: "server", delta: null, value: null, meta: null, ...fields });
  // Grenz-Ereignisse nach einer Lücke (Tracker hat Joins/Leaves/Streams erst beim Neustart bemerkt) und die
  // künstlichen Epochen-Grenzen ersetzen; die Kette legt sie an den geschätzten Zeitpunkt
  let droppedJoins = 0;
  let droppedFirstJoin = false;
  const boundaryTypes = new Set(["join", "first_join", "leave", "afk_start", "afk_end", "afk_mobs_start", "afk_mobs_end", "afk_blocks_start", "afk_blocks_end", "stream_start", "stream_end", "milestone", "rank", ...STATS.map((x) => x.event).filter((x) => x && x !== "death")]);
  const replacedStream = new Map();
  for (const e of evs) {
    // Ereignisse in der Lücke und beim ersten Abruf danach (Sammel-Zuwachs über die ganze Lücke). Tode aus dem
    // Todes-Feed haben echte Zeitpunkte und bleiben; Tode nur aus dem Zählerstand werden neu verteilt.
    const s = spans.find((x) => e.t > x.g.a && e.t <= x.g.b + 120_000);
    const merge = e.id.startsWith("merge-");
    const boardDeath = e.type === "death" && !isFeedDeath(e);
    if (!(merge || (s && (boundaryTypes.has(e.type) || boardDeath)))) continue;
    // Ein Stream, der nach der Lücke weiterläuft, behält sein echtes Start-Ereignis, falls es nicht mitten in der Lücke lag
    if (e.type === "stream_start" && s && s.knownStreamStart !== null && s.knownStreamStart <= s.g.a) continue;
    if (e.type === "stream_start" && s) replacedStream.set(s, e);
    out.dropIds.add(e.id);
    if (e.type === "join") droppedJoins++;
    if (e.type === "first_join") {
      droppedJoins++;
      droppedFirstJoin = true;
    }
  }
  // Letztes echtes Join/Stream-Start vor einem Zeitpunkt (Session- und Streamlänge)
  const lastBefore = (t, types) => {
    let found = null;
    for (const e of evs) {
      if (e.t > t) break;
      if (types.includes(e.type) && !out.dropIds.has(e.id)) found = e;
    }
    return found;
  };
  const lastTitle = (t) => {
    const e = lastBefore(t, ["stream_start", "stream_title"]);
    return e?.meta?.title ?? null;
  };
  const shiftTitle = (title, fromT, toT) =>
    title ? title.replace(/(TAG\s*)(\d+)/i, (_, pre, d) => `${pre}${Number(d) + Math.max(0, dayNumber(toT) - dayNumber(fromT))}`) : title;
  let synthOnlineMs = 0;
  let synthJoins = 0;
  let synthAfkS = 0;
  let liveOnS = 0;
  let liveOffS = 0;
  let longest = 0;
  let peak = 0;
  let peakOn = 0;
  let firstSynthOnline = null;
  let countedGapMs = 0;
  let firstJoinUsed = !droppedFirstJoin;
  for (const s of spans) {
    const { polls, online, afk, live, viewers, g, dur } = s;
    const startEv = s.startOn ? lastBefore(g.a, ["join", "first_join"]) : null;
    let sessionStart = s.startOn ? (startEv?.t ?? g.a) : null;
    let afkSince = s.startOn && afk[0] && s.before && afkAt(s.before.t) ? (afkIv.find(([x, y]) => x <= s.before.t && y >= s.before.t)?.[0] ?? g.a) : null;
    const liveEv = s.startLive ? lastBefore(g.a, ["stream_start"]) : null;
    let liveSince = s.startLive ? (liveEv?.meta?.startedAt ? ms(liveEv.meta.startedAt) : (liveEv?.t ?? g.a)) : null;
    let livePeak = 0;
    let livePeakOn = 0;
    let prevOn = s.startOn;
    let prevLive = s.startLive;
    let prevAfk = Boolean(afkSince);
    let afkAnnounced = true;
    if (s.startOn) countedGapMs += g.b - g.a;
    const agg = out.gapAgg[g.i];
    const offset = g.polls.length - polls.length;
    for (let i = 0; i <= polls.length; i++) {
      const end = i === polls.length;
      const t = end ? g.b : polls[i];
      const on = end ? s.endOn : online[i] === 1;
      const isAfk = end ? false : afk[i] === 1;
      const lv = end ? s.endLive : live[i] === 1;
      // AFK-Ende (auch durch Leave)
      if (prevAfk && (!isAfk || !on) && !end) {
        const since = afkSince ?? t;
        const secs = Math.round((t - since) / 1000);
        if (secs >= 300) {
          push(t, "afk_end", { meta: { since: iso(since), afkSeconds: secs, byLeave: !on, farm: null, estimated: true } });
          synthAfkS += secs;
        }
        afkSince = null;
      }
      if (!end && prevOn && !on) {
        const secs = Math.round((t - (sessionStart ?? t)) / 1000);
        push(t, "leave", { meta: { sessionSeconds: secs, estimated: true } });
        longest = Math.max(longest, secs);
        sessionStart = null;
      }
      if (!end && !prevOn && on) {
        const type = !firstJoinUsed && g === (joinGap ?? null) ? "first_join" : "join";
        if (type === "first_join") firstJoinUsed = true;
        push(t, type, { meta: { estimated: true } });
        synthJoins++;
        sessionStart = t;
        firstSynthOnline ??= t;
      }
      if (!end && on && isAfk && !prevAfk) {
        afkSince = t;
        afkAnnounced = false;
      }
      if (!end && on && afkSince && isAfk && !afkAnnounced && t - afkSince >= 5 * MIN) {
        push(t, "afk_start", { meta: { since: iso(afkSince), estimated: true } });
        afkAnnounced = true;
      }
      // Streams
      if (!end && prevLive && !lv) {
        push(t, "stream_end", {
          where: "twitch",
          meta: { login: p.twitch_login ?? id, streamSeconds: Math.round((t - (liveSince ?? t)) / 1000), peakViewers: livePeak, peakViewersOnServer: livePeakOn, startedAt: liveSince ? iso(liveSince) : null, estimated: true },
        });
        liveSince = null;
        livePeak = 0;
        livePeakOn = 0;
      }
      if (!end && !prevLive && lv) {
        const real = replacedStream.get(s);
        const vod = s.fromVods ? vodAt(t) : null;
        const startAt = vod ? vod.start : s.knownStreamStart !== null && Math.abs(s.knownStreamStart - t) < 3 * MIN ? s.knownStreamStart : t;
        const title = vod?.title ?? real?.meta?.title ?? shiftTitle(lastTitle(g.a), lastBefore(g.a, ["stream_start", "stream_title"])?.t ?? t, t);
        // Stream lief laut VOD schon vor der Lücke: sein Beginn steht schon als echtes Ereignis (lib/twitchHistory.ts) da
        if (!(vod && vod.start <= g.a))
          push(startAt, "stream_start", {
            where: "twitch",
            value: viewers[i],
            // Zeit und Titel aus dem VOD sind echt, nur die Zuschauerzahl ist geschätzt
            meta: { title, login: real?.meta?.login ?? p.twitch_login ?? id, onServer: on, startedAt: iso(startAt), estimated: true, ...(vod ? { source: "vod", vodId: vod.vodId, vodUrl: `https://www.twitch.tv/videos/${vod.vodId}` } : {}) },
          });
        liveSince = startAt;
      }
      if (end) {
        if (prevAfk && afkSince && !s.endOn) {
          const secs = Math.round((t - afkSince) / 1000);
          if (secs >= 300) push(t, "afk_end", { meta: { since: iso(afkSince), afkSeconds: secs, byLeave: true, farm: null, estimated: true } });
        }
        break;
      }
      if (on) {
        synthOnlineMs += dur[i];
        agg[offset + i].online++;
      }
      if (lv) {
        livePeak = Math.max(livePeak, viewers[i]);
        peak = Math.max(peak, viewers[i]);
        if (on) {
          livePeakOn = Math.max(livePeakOn, viewers[i]);
          peakOn = Math.max(peakOn, viewers[i]);
          agg[offset + i].live++;
          agg[offset + i].viewers += viewers[i];
          liveOnS += dur[i] / 1000;
        } else liveOffS += dur[i] / 1000;
      }
      prevOn = on;
      prevLive = lv;
      prevAfk = on && isAfk;
    }
  }

  // Zähler-Ereignisse, Meilensteine, Spielzeit- und Tode-Zuwachs für den globalen Verlauf
  const realMilestones = new Set(evs.filter((e) => e.type === "milestone" && !out.dropIds.has(e.id)).map((e) => `${e.meta?.board}:${e.value}`));
  const pointAgg = (k) => {
    const pt = P[k];
    if (!pt.synth) return null;
    return out.gapAgg[pt.span.g.i][pt.span.g.polls.length - pt.span.polls.length + pt.k];
  };
  for (const s of STATS) {
    const f = filled[s.col];
    if (!f.any) continue;
    // Echte Sammel-Ereignisse am ersten bekannten Wert nach einem gefüllten Abschnitt (Zuwachs über den ganzen
    // Abschnitt in einem Ereignis) ersetzen; der Zuwachs wird stattdessen über die Minuten verteilt gemeldet
    const realAt = new Map();
    if (s.event) for (const e of evs) if (e.type === s.event && !out.dropIds.has(e.id) && !(s.event === "death" && isFeedDeath(e))) realAt.set(e.t, e);
    for (let k = 1; k < N; k++) {
      if (!f.src[k] && !f.src[k - 1]) continue;
      if (!f.src[k] && f.src[k - 1]) {
        const real = realAt.get(P[k].t);
        if (real) out.dropIds.add(real.id);
      }
      const a = f.res[k - 1];
      const b = f.res[k];
      if (Number.isNaN(a) || Number.isNaN(b) || b <= a) continue;
      const delta = s.int ? b - a : Math.round((b - a) * 100) / 100;
      const agg = pointAgg(k);
      if (agg && s.col === "playtime_seconds") agg.play += delta;
      if (agg && s.col === "deaths") agg.deaths += delta;
      const t = P[k].t;
      for (const m of MILESTONES[s.board] ?? []) {
        if (a < m && b >= m && !realMilestones.has(`${s.board}:${m}`)) {
          push(t, "milestone", { value: m, meta: { board: s.board, label: BOARD_LABEL[s.board], estimated: true } });
        }
      }
      if (!s.event || delta < (MIN_DELTA[s.board] ?? 1)) continue;
      // Tode: nur der geschätzte Anteil wird ein Ereignis, Tode aus dem Feed gibt es schon
      const evDelta = s.col === "deaths" ? f.ext[k] - f.ext[k - 1] : delta;
      if (evDelta <= 0) continue;
      const live = P[k - 1].live;
      push(t, s.event, {
        delta: evDelta,
        value: b,
        meta: s.event === "death" && live ? { live: true, twitchLogin: p.twitch_login ?? id, estimated: true } : { estimated: true },
      });
    }
  }

  // Abos je Minute: in Lücken und vor Beginn der Abo-Erfassung, aus der Abo-Rate des Kanals je Zuschauerminute
  if (subRate > 0) {
    const srng = rngFor("subs", id);
    let burst = 1;
    let burstUntil = 0;
    let lastStreamStart = null;
    for (let k = 0; k + 1 < N; k++) {
      const pt = P[k];
      if (!pt.live) {
        lastStreamStart = null;
        continue;
      }
      lastStreamStart ??= pt.t;
      if (!(pt.synth || pt.t < SUB_START) || subsCovered(pt.t)) continue;
      if (pt.t >= burstUntil) {
        burst = srng.gamma(0.6) / 0.6;
        burstUntil = pt.t + (5 + srng() * 25) * MIN;
      }
      const dtMin = Math.min(P[k + 1].t - pt.t, 3 * MIN) / MIN;
      const n = srng.poisson(subRate * Math.max(0, pt.viewers ?? 0) * dtMin * burst);
      if (n <= 0) continue;
      const minute = Math.floor(pt.t / MIN) * MIN;
      evOut.push({
        id: `est-subs-${id}-${minute}`,
        at: iso(minute),
        type: "subscription",
        player: id,
        player_name: p.name,
        uuid: p.uuid,
        where: "twitch",
        delta: n,
        value: n,
        meta: { bucket: "minute", channel: id, serverOnline: pt.on, streamStartedAt: iso(lastStreamStart), estimated: true },
      });
    }
    est.push({ player: id, stat: "subs", from: START, to: CUTOFF, points: 0, share: 0, confidence: 0.4 });
  }
  if (isStreamer && spans.some((s) => s.live.some((v) => v))) est.push({ player: id, stat: "viewers", from: spans[0].g.a, to: spans[spans.length - 1].g.b, points: 0, share: 0, confidence: clamp(spans.reduce((s, x) => s + x.g.conf, 0) / spans.length * 0.85, 0.3, 0.9) });
  // Doppelte Abo-Minuten (mehrere Punkte in derselben Minute) zusammenfassen
  const subsByMinute = new Map();
  for (const e of evOut) {
    if (e.type !== "subscription") continue;
    const prev = subsByMinute.get(e.id);
    if (prev) {
      prev.delta += e.delta;
      prev.value += e.value;
      e.drop = true;
    } else subsByMinute.set(e.id, e);
  }
  for (const e of evOut) if (!e.drop) out.events.push(e);

  // Echte Leaves, deren Session jetzt mit einem geschätzten Join beginnt: Session-Länge anpassen
  {
    const all = [...evs.filter((e) => !out.dropIds.has(e.id) && ["join", "first_join", "leave"].includes(e.type)), ...evOut.filter((e) => ["join", "first_join", "leave"].includes(e.type)).map((e) => ({ ...e, t: ms(e.at), est: true }))].sort((x, y) => x.t - y.t);
    let open = null;
    for (const e of all) {
      if (e.type === "leave") {
        if (!e.est && open?.est) {
          const secs = Math.round((e.t - open.t) / 1000);
          out.leavePatches.set(e.id, { ...(e.meta ?? {}), sessionSeconds: secs });
          longest = Math.max(longest, secs);
        }
        open = null;
      } else open = e;
    }
  }

  /* --- Top-Listen vor der ersten Erfassung: aus dem ersten Stand rückwärts mit dem Treiber-Zähler --- */
  const firstTop = (await q(`SELECT at, tops FROM player_top_history WHERE player = $1 AND anchor ORDER BY at LIMIT 1`, [id])).rows[0];
  if (firstTop) {
    const T1 = ms(firstTop.at);
    const driverAt = (key, k) => {
      const d = TOP_DRIVER[key];
      if (!d) return NaN;
      if (d.startsWith("x:")) return extraFilled[EXTRA_KEYS.indexOf(d.slice(2))]?.res[k] ?? NaN;
      return filled[d]?.res[k] ?? NaN;
    };
    const k1 = (() => {
      let best = -1;
      for (let k = 0; k < N; k++) if (P[k].t <= T1) best = k;
      return best;
    })();
    if (k1 > 0) {
      const trng = rngFor("tops", id);
      const alpha = {};
      for (const [list, items] of Object.entries(firstTop.tops)) for (const item of Object.keys(items)) alpha[`${list}:${item}`] = 0.75 + trng() * 0.55;
      let lastHour = -1;
      for (let k = 0; k < k1; k++) {
        const pt = P[k];
        const hourKey = Math.floor(pt.t / HOUR);
        if (!pt.on || hourKey === lastHour) continue;
        lastHour = hourKey;
        const tops = {};
        for (const [list, items] of Object.entries(firstTop.tops)) {
          const d0 = driverAt(list, k);
          const d1 = driverAt(list, k1);
          if (!(d1 > 0) || Number.isNaN(d0)) continue;
          const frac = clamp(d0 / d1, 0, 1);
          const entry = {};
          for (const [item, count] of Object.entries(items)) {
            const v = Math.round(Number(count) * Math.pow(frac, alpha[`${list}:${item}`]));
            if (v > 0) entry[item] = v;
          }
          if (Object.keys(entry).length) tops[list] = entry;
        }
        if (Object.keys(tops).length) out.tops.push([id, iso(pt.t), JSON.stringify(tops), true]);
      }
      est.push({ player: id, stat: "tops", from: P[0].t, to: T1, points: 0, share: 0, confidence: 0.5 });
    }
  }

  /* --- Spieler-Summen --- */
  out.adjust.push({
    id,
    tracked: Math.round((synthOnlineMs - countedGapMs) / 1000),
    sessions: synthJoins - droppedJoins,
    afk: synthAfkS,
    liveOn: Math.round(liveOnS),
    liveOff: Math.round(liveOffS),
    longest,
    peak,
    peakOn,
    fosOffset,
    firstSeen: firstSynthOnline,
  });
  out.estimates.push(...est);
}

/* ---------- Globaler Verlauf in den Lücken ---------- */

const histOut = [];
const histAt = (t) => hist.find((h) => h.t === t);
for (const g of gaps) {
  const A = g.pre ? { online_count: 0, live_count: 0, viewers: 0, playtime_seconds: 0, deaths: 0, player_count: 0 } : histAt(g.a);
  const B = histAt(g.b);
  const agg = out.gapAgg[g.i];
  // Unterschied zwischen echter Zählung und Summe der bekannten Spieler an den Rändern, über die Lücke überblendet
  const offA = { online: 0, live: 0, viewers: 0 };
  const offB = {
    online: B.online_count - (agg.at(-1)?.online ?? 0),
    live: B.live_count - (agg.at(-1)?.live ?? 0),
    viewers: B.viewers - (agg.at(-1)?.viewers ?? 0),
  };
  if (!g.pre && agg.length) {
    offA.online = A.online_count - agg[0].online;
    offA.live = A.live_count - agg[0].live;
    offA.viewers = A.viewers - agg[0].viewers;
  }
  const totalPlay = agg.reduce((s, x) => s + x.play, 0);
  const totalDeaths = agg.reduce((s, x) => s + x.deaths, 0);
  const dPlay = Number(B.playtime_seconds) - Number(A.playtime_seconds);
  const dDeaths = Number(B.deaths) - Number(A.deaths);
  let cumPlay = 0;
  let cumDeaths = 0;
  const rng = rngFor("hist", g.a);
  for (let i = 0; i < g.polls.length; i++) {
    const t = g.polls[i];
    const f = (t - g.a) / (g.b - g.a);
    const off = isOffday(t);
    const x = agg[i];
    cumPlay += x.play;
    cumDeaths += x.deaths;
    const lerpOff = (key) => (off ? 0 : Math.round(offA[key] * (1 - f) + offB[key] * f));
    const online = Math.max(0, x.online + lerpOff("online"));
    histOut.push([
      iso(t),
      online,
      A.player_count === null || B.player_count === null ? null : Math.round(Number(A.player_count) + (Number(B.player_count) - Number(A.player_count)) * f),
      Math.max(0, x.live + lerpOff("live")),
      Math.max(0, x.viewers + (off ? 0 : Math.round((offA.viewers * (1 - f) + offB.viewers * f) * (0.9 + 0.2 * rng())))),
      Math.round(Number(A.playtime_seconds) + (totalPlay > 0 ? (dPlay * cumPlay) / totalPlay : dPlay * f)),
      Math.round(Number(A.deaths) + (totalDeaths > 0 ? (dDeaths * cumDeaths) / totalDeaths : dDeaths * f)),
    ]);
  }
}
log(`${histOut.length} globale Verlaufspunkte geschätzt`);

/* ---------- Schreiben ---------- */


await q(`INSERT INTO ${S}.history SELECT * FROM public.history WHERE at <= $1`, [new Date(CUTOFF)]);
await bulk(`${S}.history`, ["at", "online_count", "player_count", "live_count", "viewers", "playtime_seconds", "deaths"], ["timestamptz", "integer", "integer", "integer", "integer", "bigint", "integer"], histOut);

await q(`CREATE TEMP TABLE est_drop (id text PRIMARY KEY)`);
await bulk("est_drop", ["id"], ["text"], [...out.dropIds].map((x) => [x]));
await q(`INSERT INTO ${S}.events SELECT e.* FROM public.events e WHERE e.at <= $1 AND NOT EXISTS (SELECT 1 FROM est_drop d WHERE d.id = e.id)`, [new Date(CUTOFF)]);
{
  const seen = new Set();
  const rows = [];
  for (const e of out.events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    rows.push([e.id, e.at, e.type, e.player, e.player_name, e.uuid, e.where, e.delta, e.value, e.meta ? JSON.stringify(e.meta) : null]);
  }
  await bulk(`${S}.events`, ["id", "at", "type", "player", "player_name", "uuid", "where", "delta", "value", "meta"], ["text", "timestamptz", "text", "text", "text", "text", "text", "double precision", "double precision", "jsonb"], rows);
}
if (out.leavePatches.size) {
  await q(`CREATE TEMP TABLE est_patch (id text PRIMARY KEY, meta jsonb)`);
  await bulk("est_patch", ["id", "meta"], ["text", "jsonb"], [...out.leavePatches].map(([k, v]) => [k, JSON.stringify(v)]));
  await q(`UPDATE ${S}.events e SET meta = p.meta FROM est_patch p WHERE p.id = e.id`);
}
log(`events geschrieben (+${out.events.length}, −${out.dropIds.size}, ${out.leavePatches.size} Session-Längen angepasst)`);

await q(`INSERT INTO ${S}.player_top_history SELECT * FROM public.player_top_history WHERE at <= $1`, [new Date(CUTOFF)]);
await bulk(`${S}.player_top_history`, ["player", "at", "tops", "anchor"], ["text", "timestamptz", "jsonb", "boolean"], out.tops);

await q(`CREATE TABLE ${S}.player_adjust (id text PRIMARY KEY, tracked_seconds integer, sessions integer, afk_seconds integer, stream_on_server_seconds integer, stream_off_server_seconds integer, longest_session integer, peak_viewers integer, peak_viewers_on_server integer, followers_on_server integer, first_seen timestamptz)`);
await bulk(
  `${S}.player_adjust`,
  ["id", "tracked_seconds", "sessions", "afk_seconds", "stream_on_server_seconds", "stream_off_server_seconds", "longest_session", "peak_viewers", "peak_viewers_on_server", "followers_on_server", "first_seen"],
  ["text", "integer", "integer", "integer", "integer", "integer", "integer", "integer", "integer", "integer", "timestamptz"],
  out.adjust.map((a) => [a.id, a.tracked, a.sessions, a.afk, a.liveOn, a.liveOff, a.longest, a.peak, a.peakOn, a.fosOffset, a.firstSeen ? iso(a.firstSeen) : null]),
);
await q(`CREATE TABLE ${S}.estimates (kind text NOT NULL, player text, stat text, "from" timestamptz NOT NULL, "to" timestamptz NOT NULL, confidence real NOT NULL, share real, points integer, note text)`);
await bulk(
  `${S}.estimates`,
  ["kind", "player", "stat", "from", "to", "confidence", "share", "points", "note"],
  ["text", "text", "text", "timestamptz", "timestamptz", "real", "real", "integer", "text"],
  [
    ...gaps.map((g) => ["gap", null, null, iso(g.a), iso(g.b), g.conf, null, g.polls.length, g.pre ? "vor dem Tracker-Start" : g.offMs > (g.b - g.a) * 0.5 ? "Offtag" : "Tracker aus"]),
    ...out.estimates.map((e) => ["player", e.player, e.stat, iso(e.from), iso(e.to), e.confidence, e.share, e.points, null]),
  ],
);
await q(`CREATE TABLE ${S}.meta (id smallint PRIMARY KEY, cutoff timestamptz NOT NULL, started_at timestamptz NOT NULL, generated_at timestamptz NOT NULL, gaps_hash bigint NOT NULL, event_delta integer NOT NULL, synthetic_polls integer NOT NULL)`);
await q(`INSERT INTO ${S}.meta VALUES (1, $1, $2, now(), $3, $4, $5)`, [new Date(CUTOFF), new Date(START), genId, out.events.length - out.dropIds.size, histOut.length]);

await q(`CREATE INDEX ON ${S}.history (at)`);
await q(`CREATE UNIQUE INDEX ON ${S}.player_history (player, at)`);
await q(`CREATE INDEX ON ${S}.player_history (at)`);
await q(`CREATE INDEX ON ${S}.events (at)`);
await q(`CREATE INDEX ON ${S}.events (player, at)`);
await q(`CREATE INDEX ON ${S}.events (type, at)`);
await q(`CREATE UNIQUE INDEX ON ${S}.events (id)`);
await q(`CREATE INDEX ON ${S}.player_top_history (player, at)`);
for (const t of ["history", "player_history", "events", "player_top_history", "estimates", "player_adjust"]) await q(`ANALYZE ${S}.${t}`);
log("Indizes fertig");

/* ---------- Sichten und Umschalten ---------- */

async function colsOf(table) {
  return (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name);
}
const cutoffLit = `'${iso(CUTOFF)}'::timestamptz`;
const views = [];
for (const t of ["history", "player_history", "events", "player_top_history"]) {
  const cols = (await colsOf(t)).map((c) => `"${c}"`).join(", ");
  views.push(`CREATE VIEW approx.${t} AS SELECT ${cols} FROM approx_fill.${t} UNION ALL SELECT ${cols} FROM public.${t} WHERE at > ${cutoffLit}`);
}
{
  const adj = {
    tracked_seconds: "p.tracked_seconds + COALESCE(a.tracked_seconds, 0)",
    sessions: "GREATEST(0, p.sessions + COALESCE(a.sessions, 0))",
    afk_seconds: "p.afk_seconds + COALESCE(a.afk_seconds, 0)",
    stream_on_server_seconds: "p.stream_on_server_seconds + COALESCE(a.stream_on_server_seconds, 0)",
    stream_off_server_seconds: "p.stream_off_server_seconds + COALESCE(a.stream_off_server_seconds, 0)",
    longest_session: "GREATEST(p.longest_session, COALESCE(a.longest_session, 0))",
    peak_viewers: "GREATEST(p.peak_viewers, COALESCE(a.peak_viewers, 0))",
    peak_viewers_on_server: "GREATEST(p.peak_viewers_on_server, COALESCE(a.peak_viewers_on_server, 0))",
    followers_on_server: "p.followers_on_server + COALESCE(a.followers_on_server, 0)",
    first_seen: "LEAST(p.first_seen, COALESCE(a.first_seen, p.first_seen))",
  };
  const cols = (await colsOf("players")).map((c) => `${adj[c] ?? `p."${c}"`} AS "${c}"`).join(", ");
  views.push(`CREATE VIEW approx.players AS SELECT ${cols} FROM public.players p LEFT JOIN approx_fill.player_adjust a ON a.id = p.id`);
}
{
  const adj = {
    started_at: "LEAST(m.started_at, x.started_at)",
    event_count: "m.event_count + x.event_delta",
    polls: "m.polls + x.synthetic_polls",
  };
  const cols = (await colsOf("tracker_meta")).map((c) => `${adj[c] ?? `m."${c}"`} AS "${c}"`).join(", ");
  views.push(`CREATE VIEW approx.tracker_meta AS SELECT ${cols} FROM public.tracker_meta m CROSS JOIN approx_fill.meta x`);
}
views.push(`CREATE VIEW approx.estimates AS SELECT * FROM approx_fill.estimates`);
views.push(`CREATE VIEW approx.estimate_meta AS SELECT * FROM approx_fill.meta`);

const prevHash = await q(`SELECT gaps_hash FROM approx_fill.meta`).then((r) => Number(r.rows[0]?.gaps_hash ?? -1)).catch(() => -1);
if (dryRun) {
  log("Probelauf: neues Schema bleibt als approx_fill_new liegen, nichts umgeschaltet");
} else {
  await q("BEGIN");
  await q(`DROP SCHEMA IF EXISTS approx CASCADE`);
  await q(`DROP SCHEMA IF EXISTS approx_fill CASCADE`);
  await q(`ALTER SCHEMA ${S} RENAME TO approx_fill`);
  await q(`CREATE SCHEMA approx`);
  for (const v of views) await q(v);
  await q("COMMIT");
  log("umgeschaltet");
}
await db.end();
// Exit-Code 3: Lücken haben sich geändert (die Schätzungs-Website sollte neu laden)
const changed = prevHash !== genId;
log(changed ? "Lücken geändert" : "Lücken unverändert");
process.exit(!dryRun && changed && prevHash !== -1 ? 3 : 0);
