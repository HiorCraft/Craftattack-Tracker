/** Tagesnetz für Zeitreisen (ohne `server-only`: der Browser summiert die Zeitfenster) */
import { emptyLink, type LinkCounts } from "./connectionWeights";

/**
 * Netz je Tag (Berlin) für Zeitreisen im Browser: kompakt als Zahlen-Tupel, der Browser summiert beliebige
 * Zeitfenster daraus. Zeile: [Tag, a, b, raidsAB, raidsBA, chats, chatSeconds, titleAB, titleBA, msgsAB, msgsBA]
 * mit Indizes in `days` und `ids` (a < b alphabetisch). `now`: Paare, die gerade im geteilten Chat sind.
 */
export interface DailyNetwork {
  days: string[];
  ids: string[];
  rows: number[][];
  now: [number, number][];
}

/** Zeitfenster [from, to] (Tag-Indizes, einschließlich) aus dem Tagesnetz zu Verbindungen zusammenfassen */
export function sumDays(daily: DailyNetwork, from: number, to: number): LinkCounts[] {
  const pairs = new Map<string, LinkCounts>();
  for (const r of daily.rows) {
    if (r[0] < from || r[0] > to) continue;
    const a = daily.ids[r[1]];
    const b = daily.ids[r[2]];
    const k = `${a}|${b}`;
    const e = pairs.get(k) ?? pairs.set(k, emptyLink(a, b)).get(k)!;
    e.raidsAB += r[3];
    e.raidsBA += r[4];
    e.chats += r[5];
    e.chatSeconds += r[6];
    e.titleAB += r[7];
    e.titleBA += r[8];
    e.msgsAB += r[9];
    e.msgsBA += r[10];
  }
  if (to === daily.days.length - 1)
    for (const [x, y] of daily.now) {
      const e = pairs.get(`${daily.ids[x]}|${daily.ids[y]}`);
      if (e) e.now = true;
    }
  return [...pairs.values()];
}
