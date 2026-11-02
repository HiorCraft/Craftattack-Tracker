/**
 * Erwähnungen anderer Spieler im Stream-Titel („CRAFT ATTACK 14 WG MIT @nooreax & @Dimeax“, „… mit Rewinside“).
 * Ohne `server-only`, damit es sich auch einzeln testen lässt.
 *
 * - `@name` zählt immer, wenn er zu Twitch-Login oder Spielername passt.
 * - Ein Name ohne @ zählt nur hinter „mit“ (oder „feat.“/„ft.“/„w/“) und nur, wenn er kein gewöhnliches Wort ist
 *   (Namen wie „Logo“, „Platin“ oder „Veni“ würden sonst überall passen).
 */

export interface MentionPlayer {
  id: string;
  name: string;
  twitchLogin?: string | null;
}

/** Namen, die auch normale Wörter sind: nur mit @ */
const AMBIGUOUS = new Set(["logo", "platin", "veni", "pumi", "zander", "maxim", "petrit", "flocke", "balui", "clym", "fabo", "mooo", "sebo", "kedos", "reeze", "stegi", "filow", "maudado", "faister", "repaz", "benx", "toobad", "niek"]);
const MIN_BARE = 5;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9_]/g, "");

export function mentionMatcher(players: MentionPlayer[]) {
  const byKey = new Map<string, string>();
  for (const p of players) {
    for (const k of [p.name, p.twitchLogin]) {
      const n = k ? norm(k) : "";
      if (n.length >= 3 && !byKey.has(n)) byKey.set(n, p.id);
    }
  }
  /** IDs der im Titel genannten Spieler (ohne den Streamer selbst) */
  return (title: string, self: string): string[] => {
    const found = new Set<string>();
    for (const m of title.matchAll(/@([A-Za-z0-9_]{3,25})/g)) {
      const id = byKey.get(norm(m[1]));
      if (id) found.add(id);
    }
    const lower = title.toLowerCase();
    // „Streit mit X“ ist keine Zusammenarbeit
    const at = lower.replace(/streit mit/g, "streit ___").search(/\b(mit|feat\.?|ft\.|w\/)\s/);
    if (at >= 0) {
      for (const word of title.slice(at).split(/[\s,&+|/()[\]!?.:;"'„“]+/)) {
        if (word.startsWith("@")) continue;
        const n = norm(word);
        if (n.length < MIN_BARE || AMBIGUOUS.has(n)) continue;
        const id = byKey.get(n);
        if (id) found.add(id);
      }
    }
    found.delete(self);
    return [...found];
  };
}

/** Höchstens so viel Stream-Zeit je Tag und Paar zählt (24/7-Streams mit gleichem Titel sollen nicht alles überdecken) */
export const TITLE_MAX_SECONDS_PER_DAY = 8 * 3600;

export interface TitleChange {
  player: string;
  at: number;
  /** null = Stream endet */
  title: string | null;
}

/**
 * Sekunden Stream-Zeit, in denen `src` im Titel `dst` nannte, je Paar `src|dst`, im Zeitraum [since, until].
 * `changes` sind Starts, Titelwechsel und Enden der Streams; je Kalendertag (Berlin) und Paar höchstens
 * TITLE_MAX_SECONDS_PER_DAY. Ein Stream ohne Ende zählt höchstens 12 Stunden über die letzte Meldung hinaus.
 */
export function titleSeconds(
  changes: TitleChange[],
  match: (title: string, self: string) => string[],
  since: number,
  until: number,
  live: Set<string>,
): Map<string, { seconds: number; last: number }> {
  const byPlayer = new Map<string, TitleChange[]>();
  for (const c of changes) (byPlayer.get(c.player) ?? byPlayer.set(c.player, []).get(c.player)!).push(c);
  const perDay = new Map<string, number>();
  const out = new Map<string, { seconds: number; last: number }>();
  const day = (ms: number) => new Date(ms + 3600_000).toISOString().slice(0, 10);
  const add = (key: string, from: number, to: number) => {
    // Tageweise aufteilen, damit die Obergrenze je Tag greift
    let a = from;
    while (a < to) {
      const d = day(a);
      const next = Math.min(to, Date.parse(`${d}T00:00:00Z`) - 3600_000 + 86_400_000);
      const dk = `${key}|${d}`;
      const used = perDay.get(dk) ?? 0;
      const s = Math.min((next - a) / 1000, TITLE_MAX_SECONDS_PER_DAY - used);
      if (s > 0) {
        perDay.set(dk, used + s);
        const o = out.get(key) ?? out.set(key, { seconds: 0, last: 0 }).get(key)!;
        o.seconds += s;
        o.last = Math.max(o.last, next);
      }
      a = next;
    }
  };
  for (const [player, list] of byPlayer) {
    list.sort((x, y) => x.at - y.at);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.title) continue;
      const nextAt = list[i + 1]?.at ?? (live.has(player) ? until : Math.min(until, c.at + 12 * 3600_000));
      const from = Math.max(c.at, since);
      const to = Math.min(nextAt, until, c.at + 72 * 3600_000);
      if (to <= from) continue;
      for (const dst of match(c.title, player)) add(`${player}|${dst}`, from, to);
    }
  }
  for (const v of out.values()) v.seconds = Math.round(v.seconds);
  return out;
}
