import "server-only";
import { getFullBoard } from "./store";
import { playtimeOf, type PlaytimeSource } from "./playtime";
import type { BoardKey, TrackerState } from "./types";

export interface BoardRow {
  id: string;
  name: string;
  uuid: string;
  value: number;
  at: string | null;
  online: boolean;
  playtimeSource?: PlaytimeSource;
}

/**
 * Eine Hauptliste, wie sie Übersicht und Bestenlisten zeigen: alle Spieler, nicht nur die Top 10 der API. Eine
 * Quelle für beide Seiten, damit die Top 10 auf der Übersicht genau die ersten zehn der Bestenliste sind.
 */
export async function getBoardRows(key: BoardKey, state: TrackerState, now: number): Promise<BoardRow[]> {
  if (key === "playtimeSeconds") {
    return Object.values(state.players)
      .map((p) => {
        const playtime = playtimeOf(p, now);
        return { id: p.id, name: p.name, uuid: p.uuid, value: playtime.seconds, at: null, online: p.online, playtimeSource: playtime.source };
      })
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "de"));
  }
  return getFullBoard(key);
}

/**
 * Mitspieler für den Graphen hinter einem ▲/▼: wen der Spieler seit dem Vergleichszeitpunkt überholt hat (▲) bzw.
 * wer ihn überholt hat (▼), höchstens `max`. So zeigt der Graph, wie die Linien sich gekreuzt haben.
 */
export function passedPlayers(rows: { id: string }[], index: number, before: Record<string, number>, max = 4): string[] {
  const me = before[rows[index].id];
  if (me === undefined) return [];
  const rank = index + 1;
  if (me > rank) return rows.slice(index + 1).filter((o) => before[o.id] !== undefined && before[o.id] < me).slice(0, max).map((o) => o.id);
  if (me < rank) return rows.slice(0, index).filter((o) => before[o.id] !== undefined && before[o.id] > me).slice(-max).map((o) => o.id);
  return [];
}
