/**
 * Wann war wer auf dem Server? Aus den Sessions (Join/Leave) ein Index für „online zu diesem Zeitpunkt“ und
 * „Abschnitte, in denen mindestens einer von zweien online war“. Ohne `server-only`, nur Rechnen.
 * In Tracker-Lücken gibt es keine Sessions: dort gilt niemand als online.
 */

export interface SessionLike {
  player: string;
  start: string;
  end: string | null;
}

export interface OnlineIndex {
  /** War `id` zum Zeitpunkt `t` (ms) auf dem Server? */
  at(id: string, t: number): boolean;
  /** Abschnitte in [from, to], in denen `a` oder `b` online war (sortiert, ohne Überlappung) */
  either(a: string, b: string, from: number, to: number): [number, number][];
}

/** Sortierte, zusammengelegte Abschnitte */
function merge(spans: [number, number][]): [number, number][] {
  spans.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of spans) {
    if (b <= a) continue;
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function onlineIndex(sessions: SessionLike[], now: number): OnlineIndex {
  const raw = new Map<string, [number, number][]>();
  for (const s of sessions) {
    const a = Date.parse(s.start);
    const b = s.end ? Date.parse(s.end) : now;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    (raw.get(s.player) ?? raw.set(s.player, []).get(s.player)!).push([a, b]);
  }
  const spans = new Map([...raw].map(([id, list]) => [id, merge(list)]));
  const clip = (id: string, from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const [a, b] of spans.get(id) ?? []) {
      if (b <= from) continue;
      if (a >= to) break;
      out.push([Math.max(a, from), Math.min(b, to)]);
    }
    return out;
  };
  return {
    at(id, t) {
      const list = spans.get(id);
      if (!list) return false;
      // Binäre Suche: letzter Abschnitt, der vor oder bei t beginnt
      let lo = 0;
      let hi = list.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid][0] <= t) {
          hit = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return hit >= 0 && t < list[hit][1];
    },
    either(a, b, from, to) {
      return merge([...clip(a, from, to), ...clip(b, from, to)]);
    },
  };
}
