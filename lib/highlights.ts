import type { TrackerEvent } from "./types";

/**
 * Tageshighlights eines Spielers: die Momente, die er selbst als Höhepunkte seines Tages nennen würde.
 * Gewichtet wird nach "Würde man davon im Stream erzählen?": schwere Achievements, einen anderen Spieler
 * erledigen, von einem Spieler erledigt werden, Rekorde, Führungen in Bestenlisten, große Diamantenfunde,
 * Raids. Normale Zähler (Blöcke, Strecke, Essen) sind nie Highlights, sie stehen nur in der Tagesbilanz.
 */

export interface Highlight {
  event: TrackerEvent;
  /** "kill": der Spieler hat das Opfer dieses Todes erledigt */
  kind: "own" | "kill";
  score: number;
}

export interface DaySummary {
  deaths: number;
  kills: number;
  diamonds: number;
  blocksBroken: number;
  mobsKilled: number;
  distance: number;
  achievements: number;
  streamSeconds: number;
}

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });
/** Kalendertag in Berlin als YYYY-MM-DD */
export const berlinDay = (at: string | number) => dayFmt.format(new Date(at));

const MAX_HIGHLIGHTS = 6;

/** Gewicht eines eigenen Ereignisses; 0 = kein Highlight */
function weight(e: TrackerEvent): number {
  switch (e.type) {
    case "first_join":
      return 10;
    case "achievement":
      return e.meta?.frame === "challenge" ? 9 : e.meta?.frame === "goal" ? 6 : 3;
    case "rank":
      return e.value === 1 ? 9 : e.value === 2 ? 7 : 6;
    case "record":
      return 8;
    case "milestone":
      return 6;
    case "raid":
    case "follower_burst":
      return 6;
    case "death":
      // Von einem Spieler erledigt zu werden ist eine Geschichte, ein Sturz meist nicht
      if (typeof e.meta?.killerId === "string" && e.meta.killerId) return 5;
      return typeof e.meta?.deathMessage === "string" ? 2 : 1;
    case "diamonds": {
      // Ab 16 Diamanten auf einmal (ein guter Fund) aufwärts, je Verdopplung etwas mehr
      const d = e.delta ?? 0;
      return d >= 16 ? Math.min(7, 3 + Math.log2(d / 16) * 1.5) : 0;
    }
    case "stream_end": {
      const seconds = Number(e.meta?.streamSeconds ?? 0);
      const peak = Number(e.meta?.peakViewers ?? 0);
      return seconds >= 30 * 60 && peak > 0 ? Math.min(7, 3 + Math.log10(peak)) : 0;
    }
    case "subscription_gift":
      return (e.delta ?? 0) >= 5 ? 4 : 0;
    case "cheer": {
      // Ereignis gibt es ab 1.000 Bits; 5.000 und 10.000 sind deutlich seltener
      const bits = e.value ?? 0;
      return bits >= 10_000 ? 6 : bits >= 5_000 ? 5 : 3;
    }
    case "shared_chat_start":
      return 2;
    default:
      return 0;
  }
}

/** Ereignisse, an denen der Spieler beteiligt war: eigene und Tode anderer, die er verursacht hat */
function involving(events: TrackerEvent[], id: string): { event: TrackerEvent; kind: Highlight["kind"] }[] {
  const out: { event: TrackerEvent; kind: Highlight["kind"] }[] = [];
  for (const e of events) {
    if (e.player === id) out.push({ event: e, kind: "own" });
    else if (e.type === "death" && e.meta?.killerId === id) out.push({ event: e, kind: "kill" });
  }
  return out;
}

/** Tage mit Aktivität des Spielers, neuester zuerst */
export function activeDays(events: TrackerEvent[], id: string, limit = 14): string[] {
  const days = new Set<string>();
  for (const { event } of involving(events, id)) days.add(berlinDay(event.at));
  return [...days].sort().reverse().slice(0, limit);
}

/** Highlights (chronologisch) und Bilanz eines Tages */
export function dailyHighlights(events: TrackerEvent[], id: string, day: string): { highlights: Highlight[]; summary: DaySummary } {
  const summary: DaySummary = { deaths: 0, kills: 0, diamonds: 0, blocksBroken: 0, mobsKilled: 0, distance: 0, achievements: 0, streamSeconds: 0 };
  const candidates: Highlight[] = [];
  for (const { event: e, kind } of involving(events, id)) {
    if (berlinDay(e.at) !== day) continue;
    if (kind === "kill") {
      summary.kills += 1;
      candidates.push({ event: e, kind, score: 8 });
      continue;
    }
    const delta = e.delta ?? 0;
    if (e.type === "death") summary.deaths += delta || 1;
    else if (e.type === "diamonds") summary.diamonds += delta;
    else if (e.type === "blocksBroken") summary.blocksBroken += delta;
    else if (e.type === "mobsKilled") summary.mobsKilled += delta;
    else if (e.type === "distance") summary.distance += delta;
    else if (e.type === "achievement") summary.achievements += 1;
    else if (e.type === "stream_end") summary.streamSeconds += Number(e.meta?.streamSeconds ?? 0);
    const score = weight(e);
    if (score > 0) candidates.push({ event: e, kind, score });
  }
  const best = candidates
    .sort((a, b) => b.score - a.score || Date.parse(a.event.at) - Date.parse(b.event.at))
    .slice(0, MAX_HIGHLIGHTS)
    .sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at));
  return { highlights: best, summary };
}
