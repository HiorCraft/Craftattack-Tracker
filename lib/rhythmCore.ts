/**
 * Spielrhythmus: wann, wie lange und wie regelmäßig jemand spielt, und daraus ein Spielertyp. Nur Rechnen (ohne
 * `server-only`), damit es sich auch außerhalb von Next.js prüfen lässt. Grundlage sind die Sessions (Join/Leave),
 * die Live-Phasen (Stream an/aus) und die AFK-Phasen. Zeiten in Berliner Ortszeit.
 */

export interface SpanLike {
  start: number;
  end: number;
}

export interface Rhythm {
  id: string;
  /** Online-Minuten je Wochentag (0 = Montag) × Stunde */
  grid: number[][];
  /** Online-Minuten je Stunde (Summe über die Woche) */
  hours: number[];
  minutes: number;
  /** Anteile der Online-Zeit: Nacht 0–6, Morgen 6–12, Tag 12–18, Abend 18–24 Uhr */
  parts: { night: number; morning: number; day: number; evening: number };
  /** Anteil Samstag und Sonntag */
  weekend: number;
  /** Sessions nach Zusammenlegen kurzer Unterbrechungen (unter 15 Min) */
  sessions: number;
  /** Median der Session-Länge (Minuten) */
  medianSession: number;
  longestSession: number;
  /** Tage mit mindestens 15 Min online / Tage seit dem ersten Mal */
  activeDays: number;
  spanDays: number;
  activeRatio: number;
  /** Sessions je aktivem Tag */
  perDay: number;
  /** Streuung der ersten Einlog-Uhrzeit des Tages (Stunden, kreisförmig gerechnet), null bei zu wenigen Tagen */
  startSpread: number | null;
  /** Typische erste Einlog-Uhrzeit (Stunde mit Minuten als Dezimalzahl) */
  typicalStart: number | null;
  /** Anteil der Online-Zeit, in der der Spieler live war; null, wenn er nie gestreamt hat */
  liveShare: number | null;
  afkShare: number;
  /** Stunde mit der meisten Online-Zeit */
  peakHour: number;
  /** Einordnung, stärkstes Merkmal zuerst; leer, wenn zu wenig Daten */
  traits: TraitHit[];
}

export type TraitKey =
  | "nachteule"
  | "fruehaufsteher"
  | "tagschicht"
  | "feierabend"
  | "wochenende"
  | "marathon"
  | "kurzbesucher"
  | "dauergast"
  | "gelegenheit"
  | "gewohnheit"
  | "nurlive"
  | "offstream"
  | "afk";

export interface TraitHit {
  key: TraitKey;
  /** Wie deutlich (1 = gerade an der Schwelle) */
  score: number;
}

export interface TraitInfo {
  label: string;
  /** Kurz, für Tooltips und die Typen-Seite */
  hint: string;
  /** Farbe (CSS-Variable) */
  tone: string;
  /** Welche Gruppe: Uhrzeit, Woche, Länge, Regelmäßigkeit, Stream; je Gruppe zählt nur ein Merkmal als Haupttyp */
  group: "zeit" | "woche" | "laenge" | "takt" | "stream";
}

export const TRAITS: Record<TraitKey, TraitInfo> = {
  nachteule: { label: "Nachteule", hint: "Viel Spielzeit zwischen 0 und 6 Uhr", tone: "--ender", group: "zeit" },
  fruehaufsteher: { label: "Frühaufsteher", hint: "Viel Spielzeit zwischen 6 und 12 Uhr", tone: "--gold", group: "zeit" },
  tagschicht: { label: "Tagschicht", hint: "Spielt vor allem am Nachmittag (12–18 Uhr)", tone: "--diamond", group: "zeit" },
  feierabend: { label: "Feierabend-Spieler", hint: "Spielt fast nur abends (18–24 Uhr)", tone: "--redstone", group: "zeit" },
  wochenende: { label: "Wochenend-Spieler", hint: "Ein großer Teil der Spielzeit am Samstag und Sonntag", tone: "--grass", group: "woche" },
  marathon: { label: "Marathon-Spieler", hint: "Lange Sessions am Stück (Median ab 3 Std)", tone: "--amethyst", group: "laenge" },
  kurzbesucher: { label: "Kurz-Reinschauer", hint: "Viele kurze Besuche (Median unter 40 Min, oft mehrmals am Tag)", tone: "--diamond", group: "laenge" },
  dauergast: { label: "Dauergast", hint: "Fast jeden Tag online", tone: "--grass", group: "takt" },
  gelegenheit: { label: "Gelegenheitsspieler", hint: "Nur an wenigen Tagen online", tone: "--line", group: "takt" },
  gewohnheit: { label: "Gewohnheitstier", hint: "Loggt sich fast immer zur selben Uhrzeit ein", tone: "--gold", group: "takt" },
  nurlive: { label: "Nur mit Stream", hint: "Spielt fast nur, während er live ist", tone: "--twitch", group: "stream" },
  offstream: { label: "Auch ohne Stream", hint: "Streamt, spielt aber oft auch ohne Kamera", tone: "--twitch", group: "stream" },
  afk: { label: "AFK-Farmer", hint: "Ein großer Teil der Online-Zeit ist AFK", tone: "--line", group: "stream" },
};

/** Erst ab so viel Online-Zeit und so vielen Tagen wird eingeordnet */
export const MIN_MINUTES = 8 * 60;
export const MIN_DAYS = 4;

/* ---------- Berliner Zeit, schnell: Versatz ändert sich nur zur vollen Stunde, also je UTC-Stunde einmal rechnen ---------- */

const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short", hour: "numeric", day: "numeric", month: "numeric", year: "numeric", hourCycle: "h23" });
const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const slotCache = new Map<number, { dow: number; hour: number; day: string }>();

/** Wochentag (0 = Montag), Stunde und Kalendertag in Berlin */
export function berlinSlotFast(ms: number): { dow: number; hour: number; day: string } {
  const h = Math.floor(ms / 3_600_000);
  let s = slotCache.get(h);
  if (!s) {
    const p = Object.fromEntries(partsFmt.formatToParts(new Date(h * 3_600_000)).map((x) => [x.type, x.value]));
    s = { dow: DOW[p.weekday] ?? 0, hour: Number(p.hour) % 24, day: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}` };
    if (slotCache.size > 100_000) slotCache.clear();
    slotCache.set(h, s);
  }
  return s;
}

/** Abschnitte sortieren und zusammenlegen; Lücken unter `gap` ms gelten als durchgehend */
export function mergeSpans(spans: SpanLike[], gap = 0): SpanLike[] {
  const list = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: SpanLike[] = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + gap) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Überlappung zweier sortierter, überschneidungsfreier Listen (ms) */
function overlap(a: SpanLike[], b: SpanLike[]): number {
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].start, b[j].start);
    const hi = Math.min(a[i].end, b[j].end);
    if (hi > lo) sum += hi - lo;
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return sum;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Kreisförmiger Mittelwert und Streuung von Uhrzeiten (Stunden), damit 23 Uhr und 1 Uhr nah beieinander liegen */
function circular(hours: number[]): { mean: number; spread: number } {
  const ang = hours.map((h) => (h / 24) * Math.PI * 2);
  const x = ang.reduce((s, a) => s + Math.cos(a), 0) / ang.length;
  const y = ang.reduce((s, a) => s + Math.sin(a), 0) / ang.length;
  const r = Math.min(1, Math.hypot(x, y));
  const mean = ((Math.atan2(y, x) / (Math.PI * 2)) * 24 + 24) % 24;
  // Kreisförmige Standardabweichung in Stunden
  const spread = r > 0 ? (Math.sqrt(-2 * Math.log(r)) / (Math.PI * 2)) * 24 : 12;
  return { mean, spread };
}

/** Rhythmus eines Spielers; `online`, `live`, `afk` in ms, beliebig sortiert */
export function rhythmOf(id: string, online: SpanLike[], live: SpanLike[], afk: SpanLike[], now: number): Omit<Rhythm, "traits"> {
  const on = mergeSpans(online);
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const dayMinutes = new Map<string, number>();
  const firstOnDay = new Map<string, number>();
  for (const s of on) {
    let t = s.start;
    while (t < s.end) {
      const next = Math.min(s.end, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
      const { dow, hour, day } = berlinSlotFast(t);
      const m = (next - t) / 60_000;
      grid[dow][hour] += m;
      dayMinutes.set(day, (dayMinutes.get(day) ?? 0) + m);
      t = next;
    }
  }
  // Erste Einlog-Uhrzeit je Tag: aus den zusammengelegten Sessions (kurze Unterbrechungen zählen nicht als neuer Start)
  const sessions = mergeSpans(online, 15 * 60_000);
  for (const s of sessions) {
    const { day, hour } = berlinSlotFast(s.start);
    if (!firstOnDay.has(day)) firstOnDay.set(day, hour + (s.start % 3_600_000) / 3_600_000);
  }
  const hours = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h], 0));
  const minutes = hours.reduce((s, v) => s + v, 0);
  const share = (a: number, b: number) => (minutes ? hours.slice(a, b).reduce((s, v) => s + v, 0) / minutes : 0);
  const weekendMin = grid[5].reduce((s, v) => s + v, 0) + grid[6].reduce((s, v) => s + v, 0);
  const active = [...dayMinutes].filter(([, m]) => m >= 15).map(([d]) => d);
  const firstDay = on.length ? berlinSlotFast(on[0].start).day : null;
  const spanDays = firstDay ? Math.max(1, Math.round((Date.parse(`${berlinSlotFast(now).day}T12:00:00Z`) - Date.parse(`${firstDay}T12:00:00Z`)) / 86_400_000) + 1) : 0;
  const lengths = sessions.map((s) => (s.end - s.start) / 60_000).filter((m) => m >= 2);
  const starts = active.map((d) => firstOnDay.get(d)).filter((h): h is number => h !== undefined);
  const circ = starts.length >= MIN_DAYS ? circular(starts) : null;
  const liveSpans = mergeSpans(live);
  const liveTotal = liveSpans.reduce((s, x) => s + x.end - x.start, 0);
  const onMs = minutes * 60_000;
  return {
    id,
    grid,
    hours,
    minutes,
    parts: { night: share(0, 6), morning: share(6, 12), day: share(12, 18), evening: share(18, 24) },
    weekend: minutes ? weekendMin / minutes : 0,
    sessions: lengths.length,
    medianSession: median(lengths),
    longestSession: lengths.length ? Math.max(...lengths) : 0,
    activeDays: active.length,
    spanDays,
    activeRatio: spanDays ? Math.min(1, active.length / spanDays) : 0,
    perDay: active.length ? lengths.length / active.length : 0,
    startSpread: circ?.spread ?? null,
    typicalStart: circ?.mean ?? null,
    liveShare: liveTotal > 0 && onMs > 0 ? Math.min(1, overlap(on, liveSpans) / onMs) : null,
    afkShare: onMs > 0 ? Math.min(1, overlap(on, mergeSpans(afk)) / onMs) : 0,
    peakHour: hours.indexOf(Math.max(...hours)),
  };
}

/**
 * Merkmale: je ein Wert, eine Richtung und eine Mindestgrenze. Ein Merkmal trifft zu, wenn der Spieler damit zum
 * auffälligsten Fünftel aller eingeordneten Spieler gehört (Perzentil ≥ TOP) und die Mindestgrenze erreicht. So
 * bleiben die Typen unterscheidend, auch wenn auf dem Server z. B. fast alle lange Sessions haben (Streams).
 */
const TOP = 0.8;
const RULES: { key: TraitKey; value: (r: Omit<Rhythm, "traits">) => number | null; at: number; low?: boolean }[] = [
  { key: "nachteule", value: (r) => r.parts.night, at: 0.18 },
  { key: "fruehaufsteher", value: (r) => r.parts.morning, at: 0.15 },
  { key: "tagschicht", value: (r) => r.parts.day, at: 0.42 },
  { key: "feierabend", value: (r) => r.parts.evening, at: 0.58 },
  { key: "wochenende", value: (r) => r.weekend, at: 0.42 },
  { key: "marathon", value: (r) => r.medianSession, at: 300 },
  { key: "kurzbesucher", value: (r) => r.medianSession, at: 90, low: true },
  { key: "dauergast", value: (r) => r.activeRatio, at: 0.75 },
  { key: "gelegenheit", value: (r) => r.activeRatio, at: 0.4, low: true },
  { key: "gewohnheit", value: (r) => (r.activeDays >= 7 ? r.startSpread : null), at: 2.5, low: true },
  { key: "nurlive", value: (r) => r.liveShare, at: 0.95 },
  { key: "offstream", value: (r) => r.liveShare, at: 0.7, low: true },
  { key: "afk", value: (r) => r.afkShare, at: 0.15 },
];

/** Wird eingeordnet (genug Daten)? */
export const classifiable = (r: Omit<Rhythm, "traits">) => r.minutes >= MIN_MINUTES && r.activeDays >= MIN_DAYS;

/**
 * Merkmale aller Spieler auf einmal (Perzentile brauchen alle). `score` = Perzentil in Richtung des Merkmals
 * (0,8 … 1). Je Gruppe nur das deutlichste, damit z. B. nicht Nachteule und Feierabend zugleich gelten; „AFK-Farmer“
 * darf zusätzlich zu einem Stream-Merkmal stehen.
 */
export function classifyAll(list: Omit<Rhythm, "traits">[]): Rhythm[] {
  const pool = list.filter(classifiable);
  const sorted = RULES.map((rule) =>
    pool
      .map((r) => rule.value(r))
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b),
  );
  /** Anteil der anderen mit kleinerem (bzw. bei `low` größerem) Wert, Gleichstände halb */
  const pct = (i: number, v: number) => {
    const xs = sorted[i];
    if (xs.length < 2) return 0;
    let below = 0;
    let same = 0;
    for (const x of xs) {
      if (x < v) below++;
      else if (x === v) same++;
    }
    const p = (below + (same - 1) / 2) / (xs.length - 1);
    return RULES[i].low ? 1 - p : p;
  };
  return list.map((r) => {
    if (!classifiable(r)) return { ...r, traits: [] };
    const hits: TraitHit[] = [];
    RULES.forEach((rule, i) => {
      const v = rule.value(r);
      if (v === null) return;
      const ok = rule.low ? v <= rule.at : v >= rule.at;
      const score = pct(i, v);
      if (ok && score >= TOP) hits.push({ key: rule.key, score });
    });
    const best = new Map<string, TraitHit>();
    for (const h of hits) {
      const g = h.key === "afk" ? "afk" : TRAITS[h.key].group;
      const cur = best.get(g);
      if (!cur || h.score > cur.score) best.set(g, h);
    }
    return { ...r, traits: [...best.values()].sort((a, b) => b.score - a.score) };
  });
}
