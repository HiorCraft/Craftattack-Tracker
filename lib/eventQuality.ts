import "server-only";
import { getDb } from "./db";

/**
 * Prüft Zähler-Ereignisse auf „unechte“ Sprünge und markiert sie mit `meta.catchUp` (sie bleiben gespeichert, nur
 * Feeds blenden sie aus, siehe isShownEvent). Unecht heißt: Der Zuwachs ist nicht in dieser Minute passiert, sondern
 * hat sich angesammelt und wurde erst jetzt sichtbar:
 * - `gap`: erster Abruf nach einer Tracker-Lücke (Zuwachs über die ganze Lücke)
 * - `stale`: der vorige frische Wert dieses Zählers ist über STALE_MS alt (z. B. lange außerhalb der Top 10 ohne
 *   Einzelabfrage, Wiedereinstieg in eine Liste)
 * - `offline`: zwischen vorigem Wert und jetzt lag ein Join (der Spieler war weg; der Wert enthält Zeit davor)
 * Jedes Ereignis wird einmal geprüft (`meta.qc`). Tode aus dem Todes-Feed haben echte Zeitpunkte und bleiben.
 */
const COUNTER_COLUMN: Record<string, string> = {
  distance: "distance",
  blocksBroken: "blocks_broken",
  mobsKilled: "mobs_killed",
  damageDealt: "damage_dealt",
  foodEaten: "food_eaten",
  totemsUsed: "totems_used",
  diamonds: "diamonds",
  death: "deaths",
};
const STALE_MS = 20 * 60_000;
const GAP_MS = 4 * 60_000;
const RUN_MS = 10 * 60_000;

export async function checkEventQuality(): Promise<number> {
  const db = await getDb();
  let flagged = 0;
  const types = Object.keys(COUNTER_COLUMN);
  // Nach Tracker-Lücken
  const gap = await db.query(
    `WITH gaps AS MATERIALIZED (
       SELECT at AS b FROM (SELECT at, lag(at) OVER (ORDER BY at) AS p FROM history) h WHERE at - p > make_interval(secs => $2)
     )
     UPDATE events e SET meta = COALESCE(e.meta, '{}'::jsonb) || '{"qc": 1, "catchUp": true, "catchUpReason": "gap"}'::jsonb
      WHERE e.type = ANY($1) AND e.player IS NOT NULL AND (e.meta->>'qc') IS NULL
        AND NOT (e.type = 'death' AND (e.meta ? 'deathMessage' OR e.meta ? 'feedAt'))
        AND EXISTS (SELECT 1 FROM gaps g WHERE e.at >= g.b AND e.at <= g.b + interval '3 minutes')
      RETURNING e.id`,
    [types, GAP_MS / 1000],
  );
  flagged += gap.rows.length;
  // Veraltete Vorwerte und Zeit offline
  for (const [type, col] of Object.entries(COUNTER_COLUMN)) {
    const r = await db.query(
      `WITH cand AS (
         SELECT e.id, e.at, e.player FROM events e
          WHERE e.type = $1 AND e.player IS NOT NULL AND (e.meta->>'qc') IS NULL
            AND NOT ($1 = 'death' AND (e.meta ? 'deathMessage' OR e.meta ? 'feedAt'))
       ), prev AS (
         SELECT c.id, c.at, c.player,
                (SELECT max(h.at) FROM player_history h
                  WHERE h.player = c.player AND h.at < c.at - interval '5 seconds' AND h.at > c.at - interval '3 days' AND h.${col} IS NOT NULL) AS p
           FROM cand c
       ), verdict AS (
         SELECT id, CASE
                  WHEN p IS NULL OR at - p > make_interval(secs => $2) THEN 'stale'
                  WHEN EXISTS (SELECT 1 FROM events j WHERE j.player = prev.player AND j.type IN ('join', 'first_join') AND j.at > prev.p AND j.at < prev.at - interval '30 seconds') THEN 'offline'
                END AS reason
           FROM prev
       )
       UPDATE events e SET meta = COALESCE(e.meta, '{}'::jsonb) || jsonb_build_object('qc', 1)
                                 || CASE WHEN v.reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('catchUp', true, 'catchUpReason', v.reason) END
         FROM verdict v
        WHERE e.id = v.id
       RETURNING v.reason`,
      [type, STALE_MS / 1000],
    );
    flagged += r.rows.filter((x) => x.reason).length;
  }
  return flagged;
}

export function startEventQuality() {
  const gl = globalThis as typeof globalThis & { __acEventQuality?: boolean };
  if (gl.__acEventQuality) return;
  gl.__acEventQuality = true;
  const run = () =>
    void checkEventQuality()
      .then((n) => n && console.log(`[tracker] ${n} Zähler-Ereignisse als Sammel-Sprung markiert`))
      .catch((err: unknown) => console.warn("[tracker] Ereignis-Prüfung fehlgeschlagen:", err instanceof Error ? err.message : err));
  setTimeout(run, 4 * 60_000).unref();
  setInterval(run, RUN_MS).unref();
}
