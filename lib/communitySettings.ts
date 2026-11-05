/**
 * Gemeinsame Einstellungen der Verbindungs-Seite (Netz, Nähe, Gruppen): eine Gewichtung, ein Filter, eine
 * Gruppeneinteilung für alle Ansichten. Bleibt im Browser gespeichert; ältere getrennte Einstellungen von Netz
 * und Gruppen werden beim ersten Laden übernommen.
 */
import { DEFAULT_WEIGHTS, LINK_KINDS, type Weights } from "./connectionWeights";
import type { Direction } from "./network";

export type Show = "alle" | "online" | "live";
export type RingScale = "naehe" | "schritte";

export interface CommunitySettings {
  weights: Weights;
  /** Verbindungen unter so vielen Punkten ausblenden (überall, auch für die Gruppen) */
  min: number;
  /** Nur Spieler, die gerade online oder live sind */
  show: Show;
  /** Nur Verbindungen, die in beide Richtungen gehen */
  mutual: boolean;
  /** Richtung für Nähe und Zentralität */
  dir: Direction;
  /** Gewünschte Zahl der Gruppen (die Erkennung kommt so nah wie möglich heran) */
  count: number;
  /** Gruppen einblenden: Flächen im Netz, Farben in der Distanz, Gruppen-Details */
  groups: boolean;
  /** Mit Gruppen ohne gewählten Spieler: ein Kopf je Gruppe statt aller Spieler */
  groupMap: boolean;
  scale: RingScale;
  /** Nähe: so viele Nächste zeigen (0 = alle) */
  maxNodes: number;
  /** Nähe: nicht verbundene Spieler außen zeigen */
  showAll: boolean;
}

export const SETTINGS_DEFAULTS: CommunitySettings = {
  weights: DEFAULT_WEIGHTS,
  min: 0,
  show: "alle",
  mutual: false,
  dir: "von",
  count: 6,
  groups: false,
  groupMap: false,
  scale: "naehe",
  maxNodes: 0,
  showAll: true,
};

const KEY = "ac.verbindungen.v2";
const OLD_NET = "ac.verbindungen.v1";
const OLD_GROUPS = "ac.gruppen.v1";

export const sameWeights = (a: Weights, b: Weights) => LINK_KINDS.every((k) => a[k] === b[k]);

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const range = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && v >= lo && v <= hi ? v : d);

/** Unbekanntes fällt auf die Standardwerte zurück */
export function parseSettings(raw: Record<string, unknown> | null): CommunitySettings {
  const d = SETTINGS_DEFAULTS;
  if (!raw || typeof raw !== "object") return { ...d };
  const w = { ...DEFAULT_WEIGHTS };
  const rw = raw.weights as Partial<Weights> | undefined;
  for (const k of LINK_KINDS) w[k] = range(rw?.[k], 0, 5, w[k]);
  return {
    weights: w,
    min: range(raw.min, 0, 500, d.min),
    show: pick(raw.show, ["alle", "online", "live"] as const, d.show),
    mutual: raw.mutual === true,
    dir: pick(raw.dir, ["von", "zu", "gegenseitig"] as const, d.dir),
    // Früher gab es auch „Feinheit“; wer die nutzte, startet mit der Standard-Anzahl
    count: raw.groupMode === "feinheit" ? d.count : Math.round(range(raw.count, 2, 40, d.count)),
    groups: raw.groups === true,
    groupMap: raw.groupMap === true,
    scale: pick(raw.scale, ["naehe", "schritte"] as const, d.scale),
    maxNodes: Math.round(range(raw.maxNodes, 0, 500, d.maxNodes)),
    showAll: raw.showAll !== false,
  };
}

const read = (k: string) => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null") as Record<string, unknown> | null;
  } catch {
    return null;
  }
};

export function loadSettings(): CommunitySettings | null {
  const now = read(KEY);
  if (now) return parseSettings(now);
  const net = read(OLD_NET);
  const groups = read(OLD_GROUPS);
  if (!net && !groups) return null;
  // Früher getrennt: Gewichtung des Netzes gewinnt, Gruppen-Einteilung und „gegenseitig“ von den Gruppen
  return parseSettings({
    ...(groups ?? {}),
    ...(net ?? {}),
    groupMode: groups?.mode ?? "feinheit",
    mutual: groups?.mutual,
    show: net?.show,
  });
}

export function saveSettings(s: CommunitySettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* Speicher gesperrt: gilt nur bis zum Neuladen */
  }
}

/** Welche Abschnitte der Seitenleiste offen sind */
const OPEN_KEY = "ac.verbindungen.offen";
export function loadOpen(): Record<string, boolean> | null {
  const v = read(OPEN_KEY);
  return v && typeof v === "object" ? (v as Record<string, boolean>) : null;
}
export function saveOpen(v: Record<string, boolean>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(v));
  } catch {
    /* egal */
  }
}
