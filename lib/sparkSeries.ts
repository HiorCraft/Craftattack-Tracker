import type { PlayerPoint } from "./types";
import type { SparkPoint } from "@/components/Sparkline";

/** Kennzahlen, die StatSpark zeigen kann */
export type SparkKey =
  | "viewers"
  | "playtimeSeconds"
  | "deaths"
  | "diamonds"
  | "blocksBroken"
  | "mobsKilled"
  | "distance"
  | "damageDealt"
  | "totemsUsed"
  | "foodEaten"
  | "followersOnServer"
  | "twitchSubs"
  | "twitchBits"
  | "twitchEarnings";

/** Die Kacheln sind 320 px breit: mehr Punkte sieht niemand, sie machen nur die Seite schwer */
const MAX_POINTS = 160;

/** Vom Tracker gemessene Online-Zeit als Verlauf: Zeit zwischen zwei Messpunkten zählt, wenn der Spieler beim ersten online war. */
function trackedSeries(points: PlayerPoint[]): SparkPoint[] {
  const out: SparkPoint[] = [];
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i - 1].online) acc += (Date.parse(points[i].at) - Date.parse(points[i - 1].at)) / 1000;
    out.push({ at: points[i].at, v: Math.round(acc) });
  }
  return out;
}

/**
 * Auf höchstens `max` Punkte ausdünnen. Je Zeitabschnitt bleibt der letzte Wert (Zähler) bzw. der höchste
 * (Zuschauer, damit Spitzen sichtbar bleiben); Anfang und Ende bleiben immer erhalten.
 */
export function thinSpark(data: SparkPoint[], peak = false, max = MAX_POINTS): SparkPoint[] {
  if (data.length <= max) return data;
  const t0 = Date.parse(data[0].at);
  const span = Math.max(1, Date.parse(data[data.length - 1].at) - t0);
  const out: SparkPoint[] = [data[0]];
  let slot = -1;
  for (let i = 1; i < data.length - 1; i++) {
    const p = data[i];
    const s = Math.floor(((Date.parse(p.at) - t0) / span) * (max - 2));
    if (s !== slot) {
      out.push(p);
      slot = s;
    } else if (!peak || p.v >= out[out.length - 1].v) out[out.length - 1] = p;
  }
  out.push(data[data.length - 1]);
  return out;
}

/**
 * Nur die eine Kennzahl einer Kachel, fertig ausgedünnt (auf dem Server berechnet). Früher gingen alle Felder
 * jedes Messpunkts an den Browser, das waren pro Kachel rund 50 kB.
 */
export function sparkSeries(points: PlayerPoint[], k: SparkKey): SparkPoint[] {
  // Zuschauer: Messpunkt ohne Stream = 0, sonst verbindet die Kurve zwei Streams mit einer schrägen Linie
  let data: SparkPoint[] =
    k === "viewers"
      ? points.map((p) => ({ at: p.at, v: p.viewers ?? 0 }))
      : points.filter((p) => p[k] !== null && p[k] !== undefined).map((p) => ({ at: p.at, v: p[k] as number }));
  // Noch keine (oder nur eine) API-Spielzeit im Verlauf: die Tracker-Online-Zeit zeigen
  if (k === "playtimeSeconds" && data.length < 2 && points.length >= 2) data = trackedSeries(points);
  return thinSpark(data, k === "viewers");
}

/** Verlauf aus Zeilen (Subs, Bits, Einnahmen) */
export function sparkRows(rows: { at: string; value: number }[]): SparkPoint[] {
  return thinSpark(rows.map((r) => ({ at: r.at, v: r.value })));
}
