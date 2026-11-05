import "server-only";
import { getDb } from "./db";
import { assignEventPlayer, backfillChatEvents, deleteBackfilledEvents, deleteEvents, ensureLoaded, loadAllSessions, getState, insertPastEvents, type StoredSession } from "./store";
import { loadAfkSpans } from "./analytics";
import { AFK_MS, UNKNOWN_DEATH_GRACE_MS } from "./tracker";
import { trackedSecondsOf } from "./playtime";
import type { EventType, TrackerEvent } from "./types";

/** Eine Phase, die bis kurz vor „jetzt“ reicht und deren Spieler online ist, läuft noch – die übernimmt der Live-Tracker. */
const RUNNING_SLACK_MS = 90_000;

const FARM_TYPES: EventType[] = ["afk_mobs_start", "afk_mobs_end", "afk_blocks_start", "afk_blocks_end"];
const AFK_TYPES: EventType[] = ["afk_start", "afk_end", ...FARM_TYPES];

/**
 * Bei Änderungen der AFK-Erkennung erhöhen, damit bestehende Ereignisse aus dem Verlauf neu aufgebaut werden.
 * 2 = AFK-Zähler des Servers, stillstehend farmen zählt als AFK-Farm, Farm-Fenster 3 Min, keine doppelten Phasen
 */
const AFK_HISTORY_VERSION = 2;

/**
 * Bestehende Phasen je Spieler aus Start-/Ende-Ereignissen: Ende mit `meta.since` ergibt [since, Ende], ein Start
 * ohne passendes Ende gilt als bis jetzt laufend. Eine nachzutragende Phase, die eine davon überlappt, gibt es schon –
 * so entstehen keine Doppelten, wenn Live-Tracker und Verlauf eine Phase etwas anders schneiden.
 */
async function existingPhases(startType: EventType, endType: EventType, now: number): Promise<Map<string, [number, number][]>> {
  const db = await getDb();
  const rows = (
    await db.query<{ player: string; type: string; at: Date; since: string | null }>(
      `SELECT player, type, at, meta->>'since' AS since FROM events WHERE type = ANY($1::text[]) AND player IS NOT NULL ORDER BY player, at`,
      [[startType, endType]],
    )
  ).rows;
  const out = new Map<string, [number, number][]>();
  let open: { player: string; at: number } | null = null;
  const add = (player: string, a: number, b: number) => {
    const l = out.get(player) ?? [];
    l.push([a, b]);
    out.set(player, l);
  };
  for (const r of rows) {
    const at = new Date(r.at).getTime();
    if (open && open.player !== r.player) {
      add(open.player, open.at, now);
      open = null;
    }
    if (r.type === startType) {
      if (open) add(open.player, open.at, at);
      open = { player: r.player, at };
    } else {
      const since = r.since ? Date.parse(r.since) : open?.at ?? at;
      add(r.player, Math.min(since, at), at);
      open = null;
    }
  }
  if (open) add(open.player, open.at, now);
  return out;
}

const overlaps = (phases: Map<string, [number, number][]>, player: string, a: number, b: number) =>
  (phases.get(player) ?? []).some(([x, y]) => x < b && y > a);

/**
 * Aktuelle Stufe der einmaligen Verlaufs-Korrekturen (tracker_meta.history_fix):
 * 1 = Zähler ohne ext und Spielzeit korrigiert, 2 = AFK-Farm-Ereignisse nach Minuten-Rate neu bewertet,
 * 3 = alle AFK-Ereignisse mit der aktuellen AFK-Schwelle aus dem Verlauf neu aufgebaut
 */
const HISTORY_FIX_LEVEL = 3;

/** Alle Nachträge beim Prozessstart, in der richtigen Reihenfolge. */
export async function runBackfills(): Promise<void> {
  await fixHistoryOnce();
  await rebuildAfkEventsIfNeeded();
  const afk = await backfillAfkEvents();
  if (afk > 0) console.log(`[tracker] ${afk} AFK-Ereignisse rückwirkend neu aufgebaut`);
  const n = await backfillAfkFarmEvents();
  if (n > 0) console.log(`[tracker] ${n} AFK-Farm-Ereignisse rückwirkend nachgetragen`);
  const d = await assignUnknownDeaths();
  if (d > 0) console.log(`[tracker] ${d} unbekannte Tode per Ausschluss nachträglich zugeordnet`);
  const c = await backfillChatEvents();
  if (c > 0) console.log(`[tracker] ${c} Chat-Nachrichten als Ereignisse nachgetragen`);
}

/** Entfernt veraltete AFK-Ereignisse einmal pro Version der Erkennungslogik. */
async function rebuildAfkEventsIfNeeded(): Promise<void> {
  await ensureLoaded();
  const db = await getDb();
  const version = (await db.query<{ afk_history_version: number }>(`SELECT afk_history_version FROM tracker_meta WHERE id = 1`)).rows[0]?.afk_history_version ?? 0;
  if (version >= AFK_HISTORY_VERSION) return;
  const gone = await deleteEvents(AFK_TYPES);
  await db.query(`UPDATE tracker_meta SET afk_history_version = $1 WHERE id = 1`, [AFK_HISTORY_VERSION]);
  console.log(`[tracker] ${gone} AFK-Ereignisse für Neubewertung entfernt (Version ${AFK_HISTORY_VERSION})`);
}

/**
 * Alte „unbekannte“ Tode per Ausschluss zuordnen (wie der Live-Tracker seit der Ausschluss-Logik, nur rückwirkend):
 * War im Zeitfenster vor der Meldung genau ein Spieler online, der keine Einzelstatistik (/api/ext) hat und nicht
 * in der Tode-Top-10 stand, bekommt er die Tode. Online-Zeit kommt aus den Join/Leave-Sessions, die Top-10-
 * Zugehörigkeit aus dem Spielerverlauf (dort steht ein Tode-Wert nur, wenn die API ihn geliefert hat).
 */
async function assignUnknownDeaths(): Promise<number> {
  await ensureLoaded();
  const db = await getDb();
  const unknowns = (
    await db.query<{ id: string; at: Date }>(
      `SELECT id, at FROM events WHERE type = 'death' AND player IS NULL AND meta->>'unknown' = 'true' ORDER BY at`,
    )
  ).rows;
  if (unknowns.length === 0) return 0;
  const [state, sessions] = await Promise.all([getState(), loadAllSessions()]);
  const now = Date.now();
  const noExt = Object.values(state.players).filter((p) => !p.twitchLogin);
  // Wer im Zeitfenster ein eigenes Tod-Ereignis hat, stand in der Tode-Top-10: sein Tod war erklärt, der unbekannte ist nicht seiner
  const explained = (
    await db.query<{ player: string; at: Date }>(`SELECT player, at FROM events WHERE type = 'death' AND player = ANY($1::text[])`, [
      noExt.map((p) => p.id),
    ])
  ).rows.map((r) => ({ player: r.player, at: new Date(r.at).getTime() }));
  // Die Meldung kommt erst nach der Wartezeit; der Tod lag also bis zu Wartezeit + ein Poll davor
  const WINDOW_MS = UNKNOWN_DEATH_GRACE_MS + 60_000;
  let assigned = 0;
  for (const u of unknowns) {
    const t = new Date(u.at).getTime();
    const from = t - WINDOW_MS;
    const candidates = noExt.filter(
      (p) => onlineBetween(sessions, p.id, from, t, now) > 0 && !explained.some((e) => e.player === p.id && e.at >= from && e.at <= t + 60_000),
    );
    if (candidates.length !== 1) continue;
    const only = candidates[0];
    await assignEventPlayer(u.id, { id: only.id, name: only.name, uuid: only.uuid }, { inferred: true, backfilled: true });
    assigned++;
  }
  return assigned;
}

/** Online-Sekunden eines Spielers laut Sessions innerhalb [from, to] */
function onlineBetween(sessions: StoredSession[], player: string, from: number, to: number, now: number): number {
  let sum = 0;
  for (const s of sessions) {
    if (s.player !== player) continue;
    const a = Math.max(from, Date.parse(s.start));
    const b = Math.min(to, s.end ? Date.parse(s.end) : now);
    if (b > a) sum += (b - a) / 1000;
  }
  return sum;
}

/**
 * Einmalige Korrektur alter Verlaufsdaten (vor den entsprechenden Tracker-Fixes aufgezeichnet):
 * 1. Spieler ohne /api/ext (kein Twitch-Login bekannt) bekommen Strecke, Mobs und Blöcke nur aus den Top 10.
 *    Außerhalb davon stand der alte Wert einfach weiter da und sah wie Stillstand (AFK) aus. Ein gegenüber dem
 *    vorigen Punkt unveränderter Wert gilt für diese Spieler deshalb rückwirkend als unbekannt (NULL).
 * 2. Spielzeit gibt es nur für die Top 10. Stehende Spielzeitwerte werden durch „letzter frischer Wert plus
 *    seitdem laut Join/Leave gemessene Online-Zeit“ ersetzt und der Bezugspunkt je Spieler gesetzt.
 * Danach werden bereits nachgetragene AFK-Farm-Ereignisse verworfen (sie beruhten auf den alten Daten).
 */
async function fixHistoryOnce(): Promise<void> {
  await ensureLoaded();
  const db = await getDb();
  const meta = (await db.query<{ history_fix: number }>(`SELECT history_fix FROM tracker_meta WHERE id = 1`)).rows[0];
  const level = meta?.history_fix ?? 0;
  if (level >= HISTORY_FIX_LEVEL) return;
  if (level < 1) await fixCountersAndPlaytime();
  if (level < 2) {
    const gone = await deleteFarmEventsForRescan();
    console.log(`[tracker] ${gone} AFK-Farm-Ereignisse verworfen, sie werden nach Minuten-Rate neu nachgetragen`);
  }
  if (level < 3) {
    const state = await getState();
    for (const p of Object.values(state.players)) {
      p.afkFarm = null;
      p.afkCheck = null;
      if (p.online && p.afkSince && p.lastMoveAt && Date.now() - Date.parse(p.lastMoveAt) < AFK_MS) {
        p.afkSince = null;
        p.afkMobsAt = null;
        p.afkBlocksAt = null;
      }
    }
    const gone = await deleteEvents(AFK_TYPES);
    console.log(`[tracker] ${gone} alte AFK-Ereignisse zur Neubewertung entfernt`);
  }
  await db.query(`UPDATE tracker_meta SET history_fix = $1 WHERE id = 1`, [HISTORY_FIX_LEVEL]);
}

/**
 * Bis 12.10.2026 galt eine ganze AFK-Phase als Farm, sobald darin insgesamt zehn Mobs bzw. Blöcke anfielen.
 * Alle Farm-Ereignisse (live und nachgetragen) werden deshalb verworfen und vom Nachtrag minutengenau aus dem
 * Verlauf neu erzeugt. Laufende AFK-Phasen bewertet der Live-Tracker ab jetzt neu (Farm-Status zurückgesetzt).
 */
async function deleteFarmEventsForRescan(): Promise<number> {
  const state = await getState();
  for (const p of Object.values(state.players)) {
    p.afkFarm = null;
    p.afkCheck = null;
  }
  return deleteEvents(FARM_TYPES);
}

async function fixCountersAndPlaytime(): Promise<void> {
  const db = await getDb();

  // 1) Zähler von Spielern ohne ext
  const nulled = (
    await db.query<{ player: string }>(
      `UPDATE player_history h
          SET distance      = CASE WHEN h.distance      = s.pd THEN NULL ELSE h.distance      END,
              mobs_killed   = CASE WHEN h.mobs_killed   = s.pm THEN NULL ELSE h.mobs_killed   END,
              blocks_broken = CASE WHEN h.blocks_broken = s.pb THEN NULL ELSE h.blocks_broken END
         FROM (SELECT player, at,
                      lag(distance)      OVER w AS pd,
                      lag(mobs_killed)   OVER w AS pm,
                      lag(blocks_broken) OVER w AS pb
                 FROM player_history
                WHERE player IN (SELECT id FROM players WHERE twitch_login IS NULL)
               WINDOW w AS (PARTITION BY player ORDER BY at)) s
        WHERE h.player = s.player AND h.at = s.at
          AND (h.distance = s.pd OR h.mobs_killed = s.pm OR h.blocks_broken = s.pb)
        RETURNING h.player`,
    )
  ).rows.length;

  // 2) Spielzeit
  const [state, sessions] = await Promise.all([getState(), loadAllSessions()]);
  const now = Date.now();
  const rows = (
    await db.query<{ player: string; at: Date; playtime_seconds: number | string }>(
      `SELECT player, at, playtime_seconds FROM player_history WHERE playtime_seconds IS NOT NULL ORDER BY player, at`,
    )
  ).rows;
  let fixed = 0;
  let cur: string | null = null;
  let lastFresh: { value: number; at: number } | null = null;
  let prevValue: number | null = null;
  const finishPlayer = (id: string) => {
    const p = state.players[id];
    if (!p || p.playtimeTracked !== null || p.stats.playtimeSeconds === undefined || !lastFresh) return;
    // Bezugspunkt: gemessene Online-Zeit zum Zeitpunkt des letzten frischen API-Werts
    const since = lastFresh.value === p.stats.playtimeSeconds ? onlineBetween(sessions, id, lastFresh.at, now, now) : 0;
    p.playtimeTracked = Math.max(0, trackedSecondsOf(p, now) - since);
  };
  for (const r of rows) {
    const t = new Date(r.at).getTime();
    const value = Number(r.playtime_seconds);
    if (r.player !== cur) {
      if (cur) finishPlayer(cur);
      cur = r.player;
      lastFresh = { value, at: t };
      prevValue = value;
      continue;
    }
    if (value !== prevValue || !lastFresh) {
      // Wert hat sich geändert: frisch aus der API
      lastFresh = { value, at: t };
      prevValue = value;
      continue;
    }
    // Stehender Wert: schätzen
    const est = Math.round(lastFresh.value + onlineBetween(sessions, cur, lastFresh.at, t, now));
    if (est !== value) {
      await db.query(`UPDATE player_history SET playtime_seconds = $3 WHERE player = $1 AND at = $2`, [cur, new Date(t), est]);
      fixed++;
    }
  }
  if (cur) finishPlayer(cur);
  for (const p of Object.values(state.players)) {
    // Spieler mit API-Wert, aber ohne Verlaufspunkt: Bezugspunkt ist jetzt
    if (p.playtimeTracked === null && p.stats.playtimeSeconds !== undefined) p.playtimeTracked = trackedSecondsOf(p, now);
  }

  const gone = await deleteBackfilledEvents();
  console.log(`[tracker] Verlauf korrigiert: ${nulled} Punkte ohne ext-Daten bereinigt, ${fixed} Spielzeitwerte geschätzt, ${gone} alte Nachträge verworfen`);
}

/**
 * Trägt für abgeschlossene AFK-Farm-Phasen aus dem Spielerverlauf die Ereignisse Start/Ende (Mob- bzw. Block-Farm)
 * nach, wo der Live-Tracker noch keine erzeugt hat – z. B. für die Zeit vor Einführung der Farm-Erkennung oder für
 * alte „afk_farm“-Ereignisse ohne Ende. Idempotent über feste IDs; läuft einmal beim Prozessstart.
 */
async function backfillAfkFarmEvents(): Promise<number> {
  await ensureLoaded();
  const state = await getState();
  const now = Date.now();
  const spans = await loadAfkSpans(0, now, now);

  const existing = {
    mobs: await existingPhases("afk_mobs_start", "afk_mobs_end", now),
    blocks: await existingPhases("afk_blocks_start", "afk_blocks_end", now),
  };

  const events: TrackerEvent[] = [];
  for (const [id, list] of spans) {
    const p = state.players[id];
    for (const [a, b, kind, farm] of list) {
      if (!kind || !farm) continue;
      // Läuft noch: Start/Ende meldet der Live-Tracker
      if (p?.online && b >= now - RUNNING_SLACK_MS) continue;
      // Phase gibt es schon (live erkannt oder früher nachgetragen)
      if (overlaps(existing[kind], id, a, b)) continue;
      const startType: EventType = kind === "mobs" ? "afk_mobs_start" : "afk_blocks_start";
      const endType: EventType = kind === "mobs" ? "afk_mobs_end" : "afk_blocks_end";
      const base = { player: id, playerName: p?.name ?? id, uuid: p?.uuid ?? "", where: "server" as const };
      const since = new Date(a).toISOString();
      const afkSince = new Date(farm.afkSince).toISOString();
      const key = `${id}-${a.toString(36)}`;
      events.push({
        id: `bf-${kind}-start-${key}`,
        at: new Date(farm.at).toISOString(),
        type: startType,
        ...base,
        value: farm.atValue,
        meta: { kind, since, afkSince, windowSeconds: farm.windowSeconds, [kind]: farm.atValue, backfilled: true },
      });
      events.push({
        id: `bf-${kind}-end-${key}`,
        at: new Date(b).toISOString(),
        type: endType,
        ...base,
        value: farm.value,
        meta: {
          kind,
          afkSeconds: Math.round((b - a) / 1000),
          since,
          afkSince,
          byLeave: farm.byLeave,
          ...(farm.stillAfk ? { stillAfk: true } : {}),
          [kind]: farm.value,
          backfilled: true,
        },
      });
    }
  }
  return insertPastEvents(events);
}

/** Baut die allgemeinen AFK-Start-/Ende-Ereignisse aus den mit der aktuellen Schwelle erkannten Phasen neu auf. */
async function backfillAfkEvents(): Promise<number> {
  await ensureLoaded();
  const [state, sessions] = await Promise.all([getState(), loadAllSessions()]);
  const now = Date.now();
  const spans = await loadAfkSpans(0, now, now);
  const existing = await existingPhases("afk_start", "afk_end", now);
  const events: TrackerEvent[] = [];

  for (const [id, list] of spans) {
    const p = state.players[id];
    let start: number | null = null;
    let end = 0;
    const flush = () => {
      if (start === null) return;
      const startAt = start;
      const key = `${id}-${start.toString(36)}`;
      const base = { player: id, playerName: p?.name ?? id, uuid: p?.uuid ?? "", where: "server" as const };
      const running = p?.online && end >= now - RUNNING_SLACK_MS;
      // Phase gibt es schon (live erkannt oder früher nachgetragen): weder Start noch Ende nachtragen
      if (overlaps(existing, id, startAt, running ? now : end)) {
        start = null;
        return;
      }
      events.push({
        id: `bf-afk-start-${key}`,
        at: new Date(startAt).toISOString(),
        type: "afk_start",
        ...base,
        meta: { since: new Date(start).toISOString(), backfilled: true },
      });
      if (!running) {
        const byLeave = sessions.some((s) => s.player === id && s.end && Math.abs(Date.parse(s.end) - end) < 1_000);
        events.push({
          id: `bf-afk-end-${key}`,
          at: new Date(end).toISOString(),
          type: "afk_end",
          ...base,
          meta: { afkSeconds: Math.round((end - start) / 1000), since: new Date(start).toISOString(), ...(byLeave ? { byLeave: true } : {}), backfilled: true },
        });
      }
      start = null;
    };

    for (const [a, b] of list) {
      if (start !== null && a > end) flush();
      if (start === null) start = a;
      end = b;
    }
    flush();
  }
  return insertPastEvents(events);
}
