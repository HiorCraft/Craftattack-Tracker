/**
 * Gewichtung der Verbindungen auf /verbindungen. Ohne `server-only`: Die Seite liefert nur die Zählwerte,
 * Punkte und Farbe rechnet der Browser mit den Faktoren, die der Besucher einstellt.
 */

export type LinkKind = "raid" | "shared" | "title" | "msgs";
export type Weights = Record<LinkKind, number>;

/** Zählwerte einer Verbindung zweier Spieler, ohne Gewicht */
export interface LinkCounts {
  /** IDs, alphabetisch sortiert (a < b) */
  a: string;
  b: string;
  /** Raids von a nach b */
  raidsAB: number;
  /** Raids von b nach a */
  raidsBA: number;
  /** Geteilte Chats (Stream Together), an denen beide beteiligt waren */
  chats: number;
  /** Gemeinsame Zeit im geteilten Chat in Sekunden */
  chatSeconds: number;
  /** Nachrichten von a im Chat von b */
  msgsAB: number;
  /** Nachrichten von b im Chat von a */
  msgsBA: number;
  /** Stream-Zeit in Sekunden, in der a im Titel b nannte („WG mit @b“), höchstens 8 Std je Tag */
  titleAB: number;
  /** Stream-Zeit in Sekunden, in der b im Titel a nannte */
  titleBA: number;
  /** Gerade im geteilten Chat verbunden */
  now: boolean;
}

/**
 * Punkte bei Faktor 1: je Raid, je Stunde im geteilten Chat, je Stunde Stream mit Namen im Titel und je
 * Chat-Nachricht (10 Nachrichten = 1 Punkt). Geteilter Chat und Titel zählen nach Zeit, nicht nach Anzahl.
 */
export const BASE_POINTS: Weights = { raid: 1, shared: 0.5, title: 0.25, msgs: 0.1 };
export const DEFAULT_WEIGHTS: Weights = { raid: 1, shared: 1, title: 1, msgs: 1 };
export const LINK_KINDS: LinkKind[] = ["raid", "shared", "title", "msgs"];

/** Leere Zählwerte für ein Paar */
export function emptyLink(a: string, b: string): LinkCounts {
  return { a, b, raidsAB: 0, raidsBA: 0, chats: 0, chatSeconds: 0, titleAB: 0, titleBA: 0, msgsAB: 0, msgsBA: 0, now: false };
}

/** Punkte je Richtung (a → b, b → a); geteilter Chat zählt für beide Seiten gleich */
export function directedPoints(e: LinkCounts, w: Weights): { ab: Weights; ba: Weights } {
  const shared = (e.chatSeconds / 3600) * BASE_POINTS.shared * w.shared;
  const side = (raids: number, title: number, msgs: number): Weights => ({
    raid: raids * BASE_POINTS.raid * w.raid,
    shared,
    title: (title / 3600) * BASE_POINTS.title * w.title,
    msgs: msgs * BASE_POINTS.msgs * w.msgs,
  });
  return { ab: side(e.raidsAB, e.titleAB, e.msgsAB), ba: side(e.raidsBA, e.titleBA, e.msgsBA) };
}

/** Punkte einer Verbindung je Art, mit den Faktoren `w` */
export function linkPoints(e: LinkCounts, w: Weights): Weights {
  const { ab, ba } = directedPoints(e, w);
  return { raid: ab.raid + ba.raid, shared: ab.shared, title: ab.title + ba.title, msgs: ab.msgs + ba.msgs };
}

/** Gesamtgewicht und die Art, die am meisten beiträgt (bestimmt die Linienfarbe) */
export function weigh(e: LinkCounts, w: Weights): { weight: number; kind: LinkKind } {
  const p = linkPoints(e, w);
  const kind = LINK_KINDS.reduce((best, k) => (p[k] > p[best] ? k : best), "raid" as LinkKind);
  return { weight: p.raid + p.shared + p.title + p.msgs, kind };
}

const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
/** So viele Nachrichten ergeben bei Faktor 1 einen Punkt */
const MSGS_PER_POINT = Math.round(1 / BASE_POINTS.msgs);

/** Name, Farbe und Punkte-Erklärung je Art (Regler auf /verbindungen und den Gruppen-Seiten) */
export const KIND_INFO: Record<LinkKind, { label: string; color: string; hint: string; unit: (w: number) => string }> = {
  raid: { label: "Raids", color: "var(--twitch)", hint: "Wer wen raidet", unit: (w) => `1 Raid = ${dec.format(BASE_POINTS.raid * w)} P.` },
  shared: {
    label: "Geteilter Chat",
    color: "var(--diamond)",
    hint: "Gemeinsame Zeit im geteilten Chat (Stream Together), zählt für beide",
    unit: (w) => `1 Std geteilter Chat = ${dec.format(BASE_POINTS.shared * w)} P.`,
  },
  title: {
    label: "Im Stream-Titel",
    color: "var(--grass)",
    hint: "Stream-Zeit, in der jemand den anderen im Titel nennt („WG mit @…“), höchstens 8 Std je Tag",
    unit: (w) => `1 Std Stream mit Namen im Titel = ${dec.format(BASE_POINTS.title * w)} P.`,
  },
  msgs: {
    label: "Chat-Nachrichten",
    color: "var(--gold)",
    hint: "Nachrichten im Chat des anderen",
    unit: (w) => `${MSGS_PER_POINT} Nachrichten = ${dec.format(MSGS_PER_POINT * BASE_POINTS.msgs * w)} P.`,
  },
};

export const WEIGHT_PRESETS: { label: string; w: Weights }[] = [
  { label: "Ausgewogen", w: DEFAULT_WEIGHTS },
  { label: "Nur Raids", w: { raid: 1, shared: 0, title: 0, msgs: 0 } },
  { label: "Nur geteilter Chat", w: { raid: 0, shared: 1, title: 0, msgs: 0 } },
  { label: "Nur Titel", w: { raid: 0, shared: 0, title: 1, msgs: 0 } },
  { label: "Nur Chat", w: { raid: 0, shared: 0, title: 0, msgs: 1 } },
];
