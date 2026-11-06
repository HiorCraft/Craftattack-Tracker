import "server-only";
import { connection } from "next/server";
import { getAllAfkSpans, getLiveSessions } from "./analytics";
import { getAllSessions } from "./store";
import { createSwrCache } from "./swrCache";
import { classifyAll, rhythmMedians, rhythmOf, type Rhythm, type RhythmMedians, type SpanLike } from "./rhythmCore";

export type { Rhythm } from "./rhythmCore";

const swr = createSwrCache();

/** Laufende Sessions enden „jetzt“ */
const toSpans = (list: { start: string; end: string | null }[], now: number): SpanLike[] =>
  list.map((s) => ({ start: Date.parse(s.start), end: s.end ? Date.parse(s.end) : now })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));

/**
 * Spielrhythmus aller Spieler (lib/rhythmCore.ts), 5 Minuten zwischengespeichert. Die Einordnung in Typen
 * vergleicht die Spieler untereinander, deshalb immer alle auf einmal.
 */
export async function getRhythms(): Promise<Map<string, Rhythm>> {
  await connection();
  return swr("rhythms", 5 * 60_000, async () => {
    const [sessions, live, afk] = await Promise.all([getAllSessions(), getLiveSessions(), getAllAfkSpans()]);
    const now = Date.now();
    const by = <T extends { player: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const s of list) (m.get(s.player) ?? m.set(s.player, []).get(s.player)!).push(s);
      return m;
    };
    const on = by(sessions);
    const lv = by(live);
    const list = [...on].map(([id, s]) =>
      rhythmOf(
        id,
        toSpans(s, now),
        toSpans(lv.get(id) ?? [], now),
        (afk.get(id) ?? []).map(([a, b]) => ({ start: a, end: b })),
        now,
      ),
    );
    return new Map(classifyAll(list).map((r) => [r.id, r]));
  });
}

/** Server-Mittelwerte zum Vergleich (gleicher Zwischenspeicher wie getRhythms) */
export async function getRhythmMedians(): Promise<RhythmMedians> {
  return rhythmMedians([...(await getRhythms()).values()]);
}
