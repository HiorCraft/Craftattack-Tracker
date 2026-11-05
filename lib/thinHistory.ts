import type { PlayerPoint } from "./types";

/**
 * Verdünnt einen Spielerverlauf für Sparklines im Browser: höchstens `max` Punkte, gleichmäßig über die Zeit.
 * Je Zeitabschnitt bleibt ein Punkt mit dem jeweils letzten Nicht-NULL-Wert jedes Felds, damit Kurven ihre Form
 * behalten. Ränge und Zusatzwerte braucht keine Sparkline; sie werden weggelassen (spart viel Seitengewicht).
 */
export function thinHistory(points: PlayerPoint[], max = 300): PlayerPoint[] {
  const strip = (p: PlayerPoint): PlayerPoint => ({ ...p, ranks: {}, extra: undefined });
  if (points.length <= max) return points.map(strip);
  const t0 = Date.parse(points[0].at);
  const span = Math.max(1, Date.parse(points[points.length - 1].at) - t0);
  const out: PlayerPoint[] = [];
  let slot = -1;
  let cur: PlayerPoint | null = null;
  for (const p of points) {
    const s = Math.min(max - 1, Math.floor(((Date.parse(p.at) - t0) / span) * max));
    if (s !== slot || !cur) {
      if (cur) out.push(cur);
      slot = s;
      cur = strip(p);
      continue;
    }
    // Gleicher Abschnitt: neuere Nicht-NULL-Werte übernehmen, Zeitpunkt nachziehen
    const merged: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(p)) {
      if (k === "ranks" || k === "extra") continue;
      if (v !== null && v !== undefined) merged[k] = v;
    }
    cur = merged as unknown as PlayerPoint;
  }
  if (cur) out.push(cur);
  return out;
}
