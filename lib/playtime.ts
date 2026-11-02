import type { PlayerState } from "./types";

/** Vom Tracker gemessene Online-Zeit in Sekunden, inklusive der laufenden Session */
export function trackedSecondsOf(p: Pick<PlayerState, "trackedSeconds" | "online" | "sessionStart">, nowMs: number): number {
  return p.trackedSeconds + (p.online && p.sessionStart ? Math.max(0, nowMs - Date.parse(p.sessionStart)) / 1000 : 0);
}

export type PlaytimeSource = "api" | "estimate" | "tracker";

/**
 * Spielzeit eines Spielers. Die Top 10 liefert die API jede Minute, alle anderen über /api/player höchstens alle
 * 15 Minuten. Zwischen zwei API-Werten wird die seitdem vom Tracker gemessene Online-Zeit (Join/Leave) addiert („estimate“).
 * Ohne jeden API-Wert bleibt nur die vom Tracker gemessene Online-Zeit („tracker“).
 */
export function playtimeOf(p: PlayerState, nowMs: number): { seconds: number; source: PlaytimeSource } {
  const tracked = trackedSecondsOf(p, nowMs);
  const api = p.stats.playtimeSeconds;
  if (api === undefined) return { seconds: tracked, source: "tracker" };
  const base = p.playtimeTracked;
  if (base === null || base === undefined) return { seconds: api, source: "api" };
  const since = Math.max(0, tracked - base);
  return since > 0 ? { seconds: api + since, source: "estimate" } : { seconds: api, source: "api" };
}
