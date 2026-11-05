import type { StoredSession } from "./store";

interface Overlap {
  player: string;
  /** Gemeinsame Online-Zeit in Sekunden */
  seconds: number;
  /** Anzahl Sessions, in denen man sich überschnitten hat */
  sessions: number;
  /** Gerade gleichzeitig online */
  now: boolean;
}

interface Interval {
  player: string;
  s: number;
  e: number;
  open: boolean;
}

function toIntervals(sessions: StoredSession[], now: number): Interval[] {
  return sessions
    .map((x) => ({ player: x.player, s: Date.parse(x.start), e: x.end ? Date.parse(x.end) : now, open: x.end === null }))
    .filter((x) => x.e > x.s);
}

/** Mit wem war `id` wie lange gleichzeitig online? Absteigend nach gemeinsamer Zeit. */
export function overlapsFor(id: string, sessions: StoredSession[], now = Date.now()): Overlap[] {
  const all = toIntervals(sessions, now);
  const mine = all.filter((x) => x.player === id);
  const acc = new Map<string, Overlap>();
  for (const m of mine) {
    const seen = new Set<string>();
    for (const o of all) {
      if (o.player === id) continue;
      const s = Math.max(m.s, o.s);
      const e = Math.min(m.e, o.e);
      if (e <= s) continue;
      let v = acc.get(o.player);
      if (!v) acc.set(o.player, (v = { player: o.player, seconds: 0, sessions: 0, now: false }));
      v.seconds += (e - s) / 1000;
      if (!seen.has(o.player)) {
        seen.add(o.player);
        v.sessions += 1;
      }
      if (m.open && o.open) v.now = true;
    }
  }
  return [...acc.values()].sort((a, b) => b.seconds - a.seconds);
}

/** Wer war während einer konkreten Session (start–end) mit dabei? Sortiert nach gemeinsamer Zeit. */
export function companionsOf(
  id: string,
  start: string,
  end: string | null,
  sessions: StoredSession[],
  now = Date.now(),
): { player: string; seconds: number }[] {
  const s0 = Date.parse(start);
  const e0 = end ? Date.parse(end) : now;
  const acc = new Map<string, number>();
  for (const o of toIntervals(sessions, now)) {
    if (o.player === id) continue;
    const s = Math.max(s0, o.s);
    const e = Math.min(e0, o.e);
    if (e <= s) continue;
    acc.set(o.player, (acc.get(o.player) ?? 0) + (e - s) / 1000);
  }
  return [...acc].map(([player, seconds]) => ({ player, seconds })).sort((a, b) => b.seconds - a.seconds);
}
