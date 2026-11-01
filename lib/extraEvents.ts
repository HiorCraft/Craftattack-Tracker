import "server-only";
import { getDb } from "./db";
import { insertPastEvents } from "./store";
import { EXTRA_HISTORY_KEYS, EXTRA_STATS, type ExtraStatKey } from "./playerStats";
import type { TrackerEvent } from "./types";

/**
 * Ereignisse für die Zusatzwerte aus /api/player (platzierte Blöcke, Handel, Verzaubern, Angeln, …). Die Werte
 * kommen höchstens alle 5 Minuten je Spieler in `player_history.extra_stats`; dieser Job (nur Tracker, alle 10 Min)
 * vergleicht aufeinanderfolgende Stände und legt daraus Ereignisse an, auch rückwirkend ab dem ersten Stand.
 * - Zuwachs ab EXTRA_EVENT_MIN in einem Abschnitt → Ereignis „stat“ (seltene Werte schon ab 1)
 * - Überschreiten einer Marke aus EXTRA_MILESTONES → Meilenstein
 * Schwellen nach der Verteilung der Zuwächse (seltene ~1 %); sonst würden Sprünge oder Aufheben alles füllen.
 */

export const EXTRA_EVENT_MIN: Partial<Record<ExtraStatKey, number>> = {
  raidsWon: 1,
  itemsEnchanted: 1,
  bellsRung: 1,
  fishCaught: 1,
  animalsBred: 5,
  animalsKilled: 20,
  tradedWithVillagers: 256,
  blocksPlaced: 1000,
  itemsCrafted: 3000,
  damageTaken: 800, // 40 Herzen (Rohwert ÷ 20)
};

export const EXTRA_MILESTONES: Partial<Record<ExtraStatKey, number[]>> = {
  blocksPlaced: [1000, 5000, 10000, 50000, 100000, 250000, 500000],
  jumps: [1000, 10000, 50000, 100000, 250000],
  distanceFallen: [1000, 5000, 10000],
  sneakSeconds: [3600, 5 * 3600, 10 * 3600, 24 * 3600],
  itemsCrafted: [1000, 10000, 50000, 100000],
  itemsPickedUp: [10000, 50000, 100000, 500000],
  itemsEnchanted: [1, 10, 50, 100],
  chestsOpened: [100, 1000, 5000, 10000],
  tradedWithVillagers: [1, 100, 500, 1000, 5000],
  animalsKilled: [10, 100, 500, 1000],
  animalsBred: [10, 100, 500, 1000],
  fishCaught: [1, 10, 50, 100, 500],
  bellsRung: [1, 10, 100],
  raidsWon: [1, 5, 10, 25, 50],
  damageTaken: [2000, 20000, 100000],
};

/** Längere Abstände zwischen zwei Ständen (Tracker aus, Spieler lange weg): kein Zuwachs-Ereignis, nur Meilensteine */
const MAX_STEP_MS = 30 * 60_000;
const RUN_MS = 10 * 60_000;

export async function buildExtraEvents(): Promise<number> {
  const db = await getDb();
  const meta = (await db.query<{ extra_events_until: Date | null }>(`SELECT extra_events_until FROM tracker_meta WHERE id = 1`)).rows[0];
  const cursor = meta?.extra_events_until?.getTime() ?? 0;
  const players = new Map((await db.query<{ id: string; name: string; uuid: string }>(`SELECT id, name, uuid FROM players`)).rows.map((p) => [p.id, p]));
  // Ein Stand vor dem Cursor je Spieler als Vergleich, dann alles danach
  const rows = (
    await db.query<{ player: string; at: Date; extra_stats: (number | null)[] }>(
      `SELECT player, at, extra_stats FROM (
         SELECT DISTINCT ON (player) player, at, extra_stats FROM player_history WHERE extra_stats IS NOT NULL AND at <= $1 ORDER BY player, at DESC
       ) prev
       UNION ALL
       SELECT player, at, extra_stats FROM player_history WHERE extra_stats IS NOT NULL AND at > $1
       ORDER BY player, at`,
      [new Date(cursor)],
    )
  ).rows;
  const out: TrackerEvent[] = [];
  let until = cursor;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.player !== cur.player || cur.at.getTime() <= cursor) continue;
    until = Math.max(until, cur.at.getTime());
    const p = players.get(cur.player);
    if (!p) continue;
    const step = cur.at.getTime() - prev.at.getTime();
    EXTRA_HISTORY_KEYS.forEach((key, x) => {
      const a = prev.extra_stats[x];
      const b = cur.extra_stats[x];
      if (a === null || a === undefined || b === null || b === undefined || b <= a) return;
      const base = { player: p.id, playerName: p.name, uuid: p.uuid, where: "server" as const, at: cur.at.toISOString() };
      const atMs = cur.at.getTime().toString(36);
      for (const m of EXTRA_MILESTONES[key] ?? []) {
        if (a < m && b >= m) out.push({ ...base, id: `xmile-${p.id}-${key}-${m}`, type: "milestone", value: m, meta: { board: key, label: EXTRA_STATS[key].label } });
      }
      const min = EXTRA_EVENT_MIN[key];
      if (min !== undefined && b - a >= min && step <= MAX_STEP_MS) out.push({ ...base, id: `xstat-${p.id}-${key}-${atMs}`, type: "stat", delta: b - a, value: b, meta: { key } });
    });
  }
  // In Paketen eintragen (rückwirkend beim ersten Lauf viele)
  let added = 0;
  for (let i = 0; i < out.length; i += 2000) added += await insertPastEvents(out.slice(i, i + 2000));
  if (until > cursor) await db.query(`UPDATE tracker_meta SET extra_events_until = $1 WHERE id = 1`, [new Date(until)]);
  return added;
}

export function startExtraEvents() {
  const gl = globalThis as typeof globalThis & { __acExtraEvents?: boolean };
  if (gl.__acExtraEvents) return;
  gl.__acExtraEvents = true;
  const run = () =>
    void buildExtraEvents()
      .then((n) => n && console.log(`[tracker] ${n} Ereignisse aus Zusatzwerten`))
      .catch((err: unknown) => console.warn("[tracker] Zusatzwert-Ereignisse fehlgeschlagen:", err instanceof Error ? err.message : err));
  setTimeout(run, 2 * 60_000).unref();
  setInterval(run, RUN_MS).unref();
}
