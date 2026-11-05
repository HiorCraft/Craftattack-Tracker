import "server-only";
import { berlinDay } from "./berlin";
import { getDb } from "./db";
import { FEED_MIN_DELTA, isShownEvent } from "./events";
import type { TrackerEvent } from "./types";

/**
 * Feed-Schwellen relativ zum jeweiligen Tag: Am Anfang der Staffel sind 2.000 Blöcke am Stück kaum möglich, später
 * Alltag. Je Ereignistyp und Tag (deutsche Zeit) zählen deshalb die auffälligsten DAY_SHARE der Zuwächse dieses Tages,
 * höchstens aber die feste Schwelle aus FEED_MIN_DELTA. So hat jeder Tag seine Höhepunkte, ohne dass der Feed
 * überläuft. Nachträgliche Sammel-Sprünge (meta.catchUp, siehe lib/eventQuality.ts) zählen nicht mit.
 */
const DAY_SHARE = 0.03;
const CACHE_MS = 30 * 60_000;

let cache: { at: number; map: Map<string, number> } | null = null;
let loading: Promise<Map<string, number>> | null = null;

const dayOf = (iso: string) => berlinDay(Date.parse(iso));

async function load(): Promise<Map<string, number>> {
  const db = await getDb();
  const types = Object.keys(FEED_MIN_DELTA);
  const rows = (
    await db.query<{ type: string; d: string; p: number }>(
      `SELECT type, to_char(at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS d,
              percentile_cont($2) WITHIN GROUP (ORDER BY CASE WHEN type = 'subscription' THEN value ELSE delta END) AS p
         FROM events
        WHERE type = ANY($1) AND coalesce(meta->>'catchUp', '') <> 'true'
          AND (type <> 'subscription' OR meta->>'serverOnline' = 'true')
        GROUP BY 1, 2`,
      [types, 1 - DAY_SHARE],
    )
  ).rows;
  return new Map(rows.map((r) => [`${r.type}|${r.d}`, Number(r.p)]));
}

/** Filter für Feeds: Sammel-Sprünge raus, Zähler ab der Tages-Schwelle */
export async function getFeedFilter(): Promise<(e: TrackerEvent) => boolean> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    loading ??= load()
      .then((map) => {
        cache = { at: Date.now(), map };
        return map;
      })
      .finally(() => {
        loading = null;
      });
    // Erstes Laden abwarten, danach im Hintergrund erneuern
    if (!cache) await loading;
  }
  const map = cache!.map;
  return (e) => {
    if (e.meta?.catchUp === true) return false;
    const fixed = FEED_MIN_DELTA[e.type];
    if (fixed === undefined) return isShownEvent(e);
    const day = map.get(`${e.type}|${dayOf(e.at)}`);
    const min = day === undefined ? fixed : Math.min(fixed, Math.max(1, day));
    return (e.type === "subscription" ? (e.value ?? e.delta ?? 0) : (e.delta ?? 0)) >= min;
  };
}
