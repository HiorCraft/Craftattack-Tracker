import "server-only";
import { getDb } from "./db";
import { createSwrCache } from "./swrCache";
import { vodsBetween } from "./twitch";
import { computeFlows, type FlowResult } from "./viewerFlowCore";
import { loadChatMoves } from "./chatMoves";
import { getNetwork } from "./connections";
import { adjacency } from "./network";
import { DEFAULT_WEIGHTS } from "./connectionWeights";

/**
 * Zuschauer: Basisdaten (Zuschauerverlauf je Streamer, Starts, Raids, Titel, geteilte Chats, Server-Termine), die
 * Wanderung (lib/viewerFlowCore.ts), Raid-Bindung, Tagesverteilung und der Verlauf eines Streamers an einem Tag.
 * Startzeit ist die von Twitch (`meta.startedAt`), nicht der Zeitpunkt, an dem der Tracker den Start bemerkte.
 * Twitch-Zuschauerzahlen sind gerundet und kommen mit ~3 Min Verzug.
 */

/** A zählt nur mit mindestens so vielen Zuschauern vorher (kleinere Zahlen schwanken zu stark) */
const MIN_VIEWERS = 20;
/** A muss so lange live sein (die eigene Aufwärmphase verzerrt sonst alles) */
const MIN_AGE_MIN = 30;
/** Lücke zwischen zwei Messpunkten, ab der eine neue Stream-Sitzung beginnt */
const SESSION_GAP_MIN = 15;
const BASE_CACHE_MS = 10 * 60_000;
const ANALYSIS_CACHE_MS = 30 * 60_000;

interface Series {
  /** Minuten seit 1970 */
  t: Float64Array;
  v: Float64Array;
  /** Präfixsummen, cum[i] = Summe v[0..i-1] */
  cum: Float64Array;
  /** Beginn / Ende der Sitzung je Punkt (Minuten) */
  sess: Float64Array;
  send: Float64Array;
}

interface StartEv {
  b: string;
  /** Minuten */
  t0: number;
  login: string | null;
}

interface RaidEv {
  from: string;
  to: string;
  t: number;
  viewers: number;
}

interface MarkerEv {
  type: "title" | "shared_start" | "shared_end" | "server_event";
  t: number;
  players: string[];
  text: string;
}

interface Base {
  series: Map<string, Series>;
  /** Minuten, in denen der Tracker irgendeinen Zuschauerwert schrieb */
  cover: Set<number>;
  starts: StartEv[];
  /** Echte Startzeiten (Twitch) je Spieler, sortiert, Minuten */
  startsBy: Map<string, Float64Array>;
  raids: RaidEv[];
  markers: MarkerEv[];
  logins: Map<string, string>;
  from: number;
  to: number;
}

/* ------------------------------------------------------------------ Hilfen */

function lowerBound(t: Float64Array, x: number) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function avg(s: Series, a: number, b: number): number | null {
  const i = lowerBound(s.t, a);
  const j = lowerBound(s.t, b + 1e-9);
  return j - i >= 2 ? (s.cum[j] - s.cum[i]) / (j - i) : null;
}

/** Index des Punkts, zu dem x gehört (Sitzung läuft), sonst −1 */
function pointAt(s: Series, x: number) {
  const k = lowerBound(s.t, x + 1e-9) - 1;
  return k >= 0 && x - s.t[k] <= SESSION_GAP_MIN ? k : -1;
}

const mean = (l: number[]) => (l.length ? l.reduce((x, y) => x + y, 0) / l.length : 0);
const berlinHour = new Intl.DateTimeFormat("de-DE", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Berlin" });
const berlinDay = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin" });
const hourCache = new Map<number, number>();
function hourBlock(min: number) {
  const h = Math.floor(min / 60);
  let v = hourCache.get(h);
  if (v === undefined) {
    v = Math.floor(Number(berlinHour.format(new Date(h * 3_600_000))) / 4);
    hourCache.set(h, v);
  }
  return v;
}
/** Berliner Kalendertag „YYYY-MM-DD“ */
export const dayOf = (ms: number) => berlinDay.format(new Date(ms));

/** Mitternacht (Berlin) eines Tages und des Folgetags in ms */
export function dayBounds(day: string): [number, number] {
  const [y, m, d] = day.split("-").map(Number);
  // Berlin ist UTC+1 oder +2: Kandidaten prüfen, welcher Zeitpunkt dort 00:00 ist
  const at = (yy: number, mm: number, dd: number) => {
    for (const off of [1, 2]) {
      const ms = Date.UTC(yy, mm - 1, dd, -off);
      if (dayOf(ms) === `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}` && dayOf(ms - 60_000) !== dayOf(ms)) return ms;
    }
    return Date.UTC(yy, mm - 1, dd, -1);
  };
  const start = at(y, m, d);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return [start, at(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())];
}

/* ------------------------------------------------------------------ Basisdaten */

async function loadBase(): Promise<Base> {
  const db = await getDb();
  const [rows, ev, players, official] = await Promise.all([
    // Je Spieler eine Zeile mit Zeit- und Zuschauerreihe: ~100 Zeilen statt ~800.000 Objekte
    db.query<{ player: string; ts: number[]; vs: number[] }>(
      `SELECT player, array_agg((extract(epoch FROM at) / 60)::int ORDER BY at) AS ts, array_agg(viewers ORDER BY at) AS vs
         FROM player_history WHERE viewers IS NOT NULL GROUP BY player`,
    ),
    db.query<{ type: string; player: string | null; m: number; value: number | null; meta: Record<string, unknown> | null }>(
      `SELECT type, player, (extract(epoch FROM at) / 60)::float8 AS m, value, meta FROM events
        WHERE type IN ('stream_start', 'raid', 'stream_title', 'shared_chat_start', 'shared_chat_end') ORDER BY at`,
    ),
    db.query<{ id: string; twitch_login: string | null }>(`SELECT id, twitch_login FROM players`),
    // Offizielle Termine (vom Tracker gespeichert): z. B. „Das End öffnet“ erklärt einen Zuschauer-Anstieg bei allen
    db.query<{ events: { title: string; date: string; time: string | null }[] }>(`SELECT events FROM official_events WHERE id = 1`).catch(() => ({ rows: [] })),
  ]);
  const series = new Map<string, Series>();
  const cover = new Set<number>();
  let from = Infinity;
  let to = -Infinity;
  for (const r of rows.rows) {
    const n = r.ts.length;
    const t = Float64Array.from(r.ts);
    const v = Float64Array.from(r.vs);
    const cum = new Float64Array(n + 1);
    const sess = new Float64Array(n);
    const send = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      cum[i + 1] = cum[i] + v[i];
      sess[i] = i > 0 && t[i] - t[i - 1] <= SESSION_GAP_MIN ? sess[i - 1] : t[i];
      cover.add(t[i]);
    }
    for (let i = n - 1; i >= 0; i--) send[i] = i < n - 1 && t[i + 1] - t[i] <= SESSION_GAP_MIN ? send[i + 1] : t[i];
    if (n) {
      from = Math.min(from, t[0]);
      to = Math.max(to, t[n - 1]);
    }
    series.set(r.player, { t, v, cum, sess, send });
  }
  const logins = new Map<string, string>();
  for (const p of players.rows) if (p.twitch_login) logins.set(p.id, p.twitch_login);
  const starts: StartEv[] = [];
  const raids: RaidEv[] = [];
  const markers: MarkerEv[] = [];
  for (const e of ev.rows) {
    const meta = e.meta ?? {};
    if (e.type === "stream_start" && e.player) {
      const started = typeof meta.startedAt === "string" ? Date.parse(meta.startedAt) / 60_000 : NaN;
      const login = typeof meta.login === "string" ? meta.login : null;
      starts.push({ b: e.player, t0: Number.isFinite(started) ? started : e.m, login });
      if (login && !logins.has(e.player)) logins.set(e.player, login);
    } else if (e.type === "raid" && e.player && typeof meta.raidTargetPlayerId === "string") {
      raids.push({ from: e.player, to: meta.raidTargetPlayerId, t: e.m, viewers: e.value ?? 0 });
    } else if (e.type === "stream_title" && e.player) {
      markers.push({ type: "title", t: e.m, players: [e.player], text: typeof meta.title === "string" ? meta.title : "" });
    } else if (e.type === "shared_chat_start" || e.type === "shared_chat_end") {
      const ids = typeof meta.sharedChatPlayers === "string" ? meta.sharedChatPlayers.split(",").filter(Boolean) : e.player ? [e.player] : [];
      markers.push({ type: e.type === "shared_chat_start" ? "shared_start" : "shared_end", t: e.m, players: ids, text: typeof meta.sharedChatNames === "string" ? meta.sharedChatNames : "" });
    }
  }
  for (const o of official.rows[0]?.events ?? []) {
    if (!o.time || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) continue;
    const [h, mi] = o.time.split(":").map(Number);
    const t = dayBounds(o.date)[0] / 60_000 + h * 60 + mi;
    // Gilt für alle Streams; `players` leer = jeder
    markers.push({ type: "server_event", t, players: [], text: o.title });
  }
  markers.sort((x, y) => x.t - y.t);
  const startsBy = new Map<string, Float64Array>();
  for (const [p, l] of group(starts, (x) => x.b)) startsBy.set(p, Float64Array.from(l.map((x) => x.t0)).sort());
  return { series, cover, starts, startsBy, raids, markers, logins, from, to };
}

/** Lief der Tracker in [a, b] durchgehend (höchstens 3 Minuten ohne irgendeinen Wert)? */
function covered(base: Base, a: number, b: number) {
  for (let x = Math.floor(a); x <= b; x += 3) {
    if (!base.cover.has(x) && !base.cover.has(x + 1) && !base.cover.has(x + 2)) return false;
  }
  return true;
}


/* ------------------------------------------------------------------ Auswertung */

/** Ein Raid mit Bindung: Anteil der Raid-Zuschauer, die nach m Minuten noch da sind */
export interface RaidStay {
  from: string;
  to: string;
  /** ms */
  at: number;
  /** Raid-Größe laut Twitch */
  viewers: number;
  /** Zuschauer von B vor dem Raid (Median 6–1 Min davor) */
  before: number;
  /** angekommen: höchster Stand in 8 Min nach dem Raid, als Anteil der Raid-Größe */
  arrived: number;
  r10: number | null;
  r30: number | null;
  r60: number | null;
}

export interface RaidRetention {
  /** Je Minute nach dem Raid: Median und mittlere Hälfte (25–75 %) des Anteils, der noch da ist */
  curve: { m: number; median: number; p25: number; p75: number; n: number }[];
  /** Median „angekommen“ */
  arrived: number;
  raids: RaidStay[];
  /** Je Raid-Ziel (mind. 3 Raids): Median nach 30 Min */
  byTarget: { to: string; n: number; r30: number; arrived: number }[];
  skipped: number;
}

function group<T, K>(list: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of list) {
    const k = key(x);
    const l = m.get(k);
    if (l) l.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/* ------------------------------------------------------------------ Raid-Bindung */

/** Raids zählen ab so vielen Zuschauern (kleinere gehen im Rauschen unter) */
const RAID_MIN_VIEWERS = 50;
const RAID_HORIZON = 60;

/**
 * Wie viele Raid-Zuschauer bleiben? Je Raid A → B: Stand von B vorher (Median 6–1 Min davor), dann je Minute der
 * Median ±2 Min abzüglich B's eigenem Trend der 15 Min davor, als Anteil der Raid-Größe laut Twitch. Twitch-Zahlen
 * kommen in Stufen von ~3 Min und zeigen den Raid 1–3 Min nach der Meldung, daher „angekommen“ als Höchststand in
 * 8 Min. Nur Raids, bei denen B von 20 Min davor bis 60 Min danach durchgehend live ist und keinen weiteren Raid
 * in dieser Stunde bekommt.
 */
function computeRaidRetention(base: Base): RaidRetention {
  const liveThrough = (s: Series, a: number, b: number) => {
    const i = lowerBound(s.t, a);
    const j = lowerBound(s.t, b + 1e-9) - 1;
    if (i >= s.t.length || j < i || s.t[i] > a + 5 || s.t[j] < b - 5) return false;
    for (let k = i + 1; k <= j; k++) if (s.t[k] - s.t[k - 1] > 10) return false;
    return true;
  };
  const maxIn = (s: Series, a: number, b: number) => {
    let m: number | null = null;
    for (let i = lowerBound(s.t, a); i < s.t.length && s.t[i] <= b; i++) m = Math.max(m ?? 0, s.v[i]);
    return m;
  };
  const raids: RaidStay[] = [];
  const perMinute: number[][] = Array.from({ length: RAID_HORIZON + 1 }, () => []);
  let skipped = 0;
  for (const r of base.raids) {
    const s = base.series.get(r.to);
    if (!s || r.viewers < RAID_MIN_VIEWERS) continue;
    const t = r.t;
    if (!liveThrough(s, t - 20, t + RAID_HORIZON) || base.raids.some((o) => o !== r && o.to === r.to && Math.abs(o.t - t) < RAID_HORIZON)) {
      skipped++;
      continue;
    }
    const before = medianIn(s, t - 6, t - 1);
    const pre = medianIn(s, t - 21, t - 16);
    const peak = maxIn(s, t, t + 8);
    if (before === null || peak === null) {
      skipped++;
      continue;
    }
    const trend = pre !== null ? (before - pre) / 15 : 0;
    const stay = (m: number) => {
      const v = medianIn(s, t + m - 2, t + m + 2);
      return v === null ? null : (v - before - trend * m) / r.viewers;
    };
    for (let m = 0; m <= RAID_HORIZON; m++) {
      const x = stay(m);
      if (x !== null) perMinute[m].push(x);
    }
    raids.push({ from: r.from, to: r.to, at: t * 60_000, viewers: r.viewers, before, arrived: (peak - before) / r.viewers, r10: stay(10), r30: stay(30), r60: stay(60) });
  }
  const q = (l: number[], p: number) => {
    const v = [...l].sort((x, y) => x - y);
    return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : 0;
  };
  const curve = perMinute.map((l, m) => ({ m, median: l.length ? median(l) : 0, p25: q(l, 0.25), p75: q(l, 0.75), n: l.length }));
  const byTarget = [...group(raids, (r) => r.to)]
    .filter(([, l]) => l.length >= 3)
    .map(([to, l]) => ({ to, n: l.length, r30: median(l.map((r) => r.r30 ?? 0)), arrived: median(l.map((r) => r.arrived)) }))
    .sort((x, y) => y.r30 - x.r30);
  return { curve, arrived: raids.length ? median(raids.map((r) => r.arrived)) : 0, raids: raids.sort((x, y) => y.at - x.at), byTarget, skipped };
}

/* ------------------------------------------------------------------ Tagesverlauf */

export interface DayStack {
  day: string;
  /** Beginn der 5-Minuten-Abschnitte (ms) */
  times: number[];
  /** Hatte der Tracker in diesem Abschnitt Daten? Sonst ist er eine Lücke, nicht „0 Zuschauer“ */
  covered: boolean[];
  /** feste Reihenfolge: die größten Streams der Staffel, zuletzt „Andere“ (id = "") */
  series: { id: string; values: number[] }[];
  /** Zuschauerstunden und Spitze je Streamer an diesem Tag, absteigend */
  table: { id: string; hours: number; peak: number }[];
}

const BIN_MIN = 5;
/** So viele Streams bekommen eine eigene Farbe (Rest = „Andere“); die Palette prüft 8 Plätze, einer bleibt grau */
const STACK_SLOTS = 7;

/** Die Streams mit den meisten Zuschauerminuten der Staffel – feste Farbe je Streamer, egal welcher Tag */
function seasonTop(base: Base): string[] {
  return [...base.series]
    .map(([id, s]) => ({ id, total: s.cum[s.cum.length - 1] }))
    .sort((x, y) => y.total - x.total)
    .slice(0, STACK_SLOTS)
    .map((x) => x.id);
}

export async function getDayStack(day: string): Promise<DayStack> {
  const base = await getBase();
  const [a, b] = dayBounds(day);
  const t0 = a / 60_000;
  const t1 = b / 60_000;
  const bins = Math.round((t1 - t0) / BIN_MIN);
  const times = Array.from({ length: bins }, (_, i) => (t0 + i * BIN_MIN) * 60_000);
  const coveredBins = Array.from({ length: bins }, (_, i) => {
    for (let x = t0 + i * BIN_MIN; x < t0 + (i + 1) * BIN_MIN; x++) if (base.cover.has(x)) return true;
    return false;
  });
  const top = seasonTop(base);
  const others = new Array<number>(bins).fill(0);
  const series: DayStack["series"] = top.map((id) => ({ id, values: new Array<number>(bins).fill(0) }));
  const table: DayStack["table"] = [];
  for (const [id, s] of base.series) {
    const vals = new Array<number>(bins).fill(0);
    let minutes = 0;
    let peak = 0;
    for (let i = 0; i < bins; i++) {
      const m = avg(s, t0 + i * BIN_MIN, t0 + (i + 1) * BIN_MIN - 1e-6);
      // Ein einzelner Punkt im Abschnitt reicht hier (Durchschnitt braucht sonst zwei)
      const k = lowerBound(s.t, t0 + i * BIN_MIN);
      const single = k < s.t.length && s.t[k] < t0 + (i + 1) * BIN_MIN ? s.v[k] : 0;
      vals[i] = Math.round(m ?? single);
      minutes += vals[i] * BIN_MIN;
      peak = Math.max(peak, vals[i]);
    }
    if (minutes === 0) continue;
    table.push({ id, hours: minutes / 60, peak });
    const slot = top.indexOf(id);
    if (slot >= 0) series[slot].values = vals;
    else for (let i = 0; i < bins; i++) others[i] += vals[i];
  }
  table.sort((x, y) => y.hours - x.hours);
  return { day, times, covered: coveredBins, series: [...series, { id: "", values: others }], table };
}

/** Streamer mit Zuschauerdaten, nach Zuschauerminuten der Staffel absteigend */
export async function getStreamers(): Promise<string[]> {
  const base = await getBase();
  return [...base.series].sort((x, y) => y[1].cum[y[1].cum.length - 1] - x[1].cum[x[1].cum.length - 1]).map(([id]) => id);
}

/** Tage mit Zuschauerdaten, neueste zuerst */
export async function getDays(): Promise<string[]> {
  const base = await getBase();
  const days = new Set<string>();
  for (const m of base.cover) days.add(dayOf(m * 60_000));
  return [...days].sort().reverse();
}

/* ------------------------------------------------------------------ Spieleransicht */

export interface ChartMarker {
  /** ms */
  at: number;
  kind: "own_start" | "own_end" | "own_drop" | "title" | "raid_in" | "raid_out" | "shared_start" | "shared_end" | "server_event" | "flow_in" | "start_loss";
  /** beteiligter anderer Spieler */
  other?: string;
  /** Zuschauer: Raid-Größe bzw. zusätzliche Änderung durch fremden Start/Ende */
  viewers?: number;
  text?: string;
}

export interface Anomaly {
  /** ms */
  from: number;
  to: number;
  /** tatsächliche Änderung in Zuschauern über den Abschnitt */
  change: number;
  /** erwartete Änderung in Zuschauern (übliches Muster dieses Streams + was alle anderen gleichzeitig tun) */
  expected: number;
  /** gleichzeitige Änderung aller anderen Streams (Anteil, Median) */
  market: number;
  kind: "dip" | "hype";
  /** mögliche Erklärungen (leer = ungeklärt, vermutlich der Stream selbst) */
  reasons: { kind: ChartMarker["kind"] | "competition"; other?: string; viewers?: number; text?: string }[];
}

export interface Competition {
  /** ms */
  at: number;
  /** andere CraftAttack-Streams live */
  n: number;
  /** deren Zuschauer zusammen */
  viewers: number;
}

export interface VodSpan {
  /** ms: Sitzung, für die das VOD gilt */
  from: number;
  to: number;
  vodId: string;
  /** ms: Zeitpunkt, der im VOD bei 0:00 liegt */
  vodStart: number;
}

export interface PlayerDay {
  id: string;
  day: string;
  /** [ms, Zuschauer] */
  points: [number, number][];
  /** Trend je Punkt (gleitender Median), null = nicht bestimmbar */
  trend: (number | null)[];
  /** übliche Abweichung vom Trend an diesem Tag (robust) */
  noise: number;
  competition: Competition[];
  markers: ChartMarker[];
  anomalies: Anomaly[];
  vods: VodSpan[];
  /** Tage, an denen der Spieler live war, neueste zuerst */
  days: string[];
}

/** Zugewanderte Zuschauer erscheinen im Verlauf ab so vielen */
const CAUSE_MIN_ABS = 30;
const ANOMALY_WIN = 10;
/** Trend: gleitender Median über ± so viele Minuten */
const TREND_HALF = 12;
/** Hype/Absturz: Niveau 30–45 Min danach gegen 15 Min davor; bleibt es 60–80 Min danach? */
const SHIFT_AFTER = [30, 45] as const;
const SHIFT_LATER = [60, 80] as const;
/** übliche Änderung je ~7,5 Min auf ~37,5 Min hochgerechnet */
const SHIFT_SCALE = 5;
const SHIFT_MIN_REL = 0.1;
const SHIFT_Z = 2.5;

/** Verlauf eines Spielers an einem Tag; ohne (gültigen) Tag der letzte Tag, an dem er live war */
function medianIn(s: Series, a: number, b: number): number | null {
  const vals: number[] = [];
  for (let j = lowerBound(s.t, a); j < s.t.length && s.t[j] <= b; j++) vals.push(s.v[j]);
  if (vals.length < 2) return null;
  vals.sort((x, y) => x - y);
  const h = vals.length >> 1;
  return vals.length % 2 ? vals[h] : (vals[h - 1] + vals[h]) / 2;
}

/**
 * Anhaltende Änderung um t: Median der 5 Min davor gegen 5–10 Min danach, innerhalb einer Sitzung. Twitch-Zahlen
 * kommen in Stufen von ~3 Min und haben Nadeln von 1–2 Min; der Median übergeht beides.
 */
function medianStep(s: Series, t: number, starts: Float64Array | undefined): { before: number; after: number; age: number; end: number } | null {
  const k = pointAt(s, t);
  const k2 = pointAt(s, t + ANOMALY_WIN);
  if (k < 0 || k2 < 0 || s.sess[k2] !== s.sess[k]) return null;
  const before = medianIn(s, t - 5, t);
  const after = medianIn(s, t + 5, t + ANOMALY_WIN);
  if (before === null || after === null || before < MIN_VIEWERS) return null;
  return { before, after, age: streamAge(s, k, t, starts), end: s.t[k2] };
}

/**
 * Minuten seit dem echten Streamstart (Twitch). Lücken im Verlauf kommen meist von Tracker-Ausfällen, nicht von
 * Streamstarts; ohne Start in dieser Sitzung (Tracker kam mitten im Stream zurück) gilt der Stream als lange live.
 */
function streamAge(s: Series, k: number, t: number, starts: Float64Array | undefined): number {
  if (starts) {
    const j = lowerBound(starts, t + 1e-9) - 1;
    if (j >= 0 && starts[j] >= s.sess[k] - 60) return t - starts[j];
  }
  return Number.POSITIVE_INFINITY;
}

/** Feinere Streamalter-Stufen, damit die Aufwärmphase ihr eigenes übliches Muster hat; −1 = zu früh zum Bewerten */
const fineAge = (m: number) => (m < 10 ? -1 : m < 20 ? 0 : m < 30 ? 1 : m < 60 ? 2 : m < 120 ? 3 : m < 240 ? 4 : 5);

const median = (l: number[]) => {
  const v = [...l].sort((x, y) => x - y);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
};

/**
 * Übliche Änderung aller Streams je (Streamalter, Tageszeit) bzw. Streamalter – Ersatz für Streamer mit wenigen
 * eigenen Daten (die Aufwärmphase nach dem Start sieht bei allen ähnlich aus). Einmal je Basisdaten berechnet.
 */
const globalUsualCache = new WeakMap<Base, Map<string, number>>();
function globalUsual(base: Base): Map<string, number> {
  const hit = globalUsualCache.get(base);
  if (hit) return hit;
  const lists = new Map<string, number[]>();
  for (const [p, sp] of base.series) {
    for (let i = 0; i < sp.t.length; i += 4) {
      const st = medianStep(sp, sp.t[i], base.startsBy.get(p));
      if (!st || fineAge(st.age) < 0) continue;
      const rel = (st.after - st.before) / st.before;
      for (const k of [`${fineAge(st.age)}|${hourBlock(sp.t[i])}`, `${fineAge(st.age)}`]) {
        const l = lists.get(k);
        if (l) l.push(rel);
        else lists.set(k, [rel]);
      }
    }
  }
  const out = new Map<string, number>();
  for (const [k, l] of lists) if (l.length >= 30) out.set(k, median(l));
  globalUsualCache.set(base, out);
  return out;
}

/**
 * Was alle Streams gleichzeitig tun: Median ihrer Änderung um t (ohne Raid-Beteiligte und Aufwärmphase), je
 * 5-Minuten-Abschnitt einmal je Basisdaten vorberechnet. Der Stream selbst ist einer von vielen und verschiebt den
 * Median kaum; ihn je Anfrage herauszurechnen kostete eine Minute Rechenzeit.
 */
const marketCache = new WeakMap<Base, Map<number, number>>();
function marketAt(base: Base, t: number): number | null {
  let m = marketCache.get(base);
  if (!m) {
    m = new Map();
    const raidSet = new Set<string>();
    for (const r of base.raids) for (let k = Math.ceil((r.t - 15) / 5); k <= Math.floor((r.t + 10) / 5); k++) raidSet.add(`${r.from}|${k}`).add(`${r.to}|${k}`);
    const k0 = Math.floor(base.from / 5);
    const k1 = Math.floor(base.to / 5);
    for (let k = k0; k <= k1; k++) {
      const x = k * 5;
      if (!base.cover.has(x) && !base.cover.has(x + 1) && !base.cover.has(x + 2)) continue;
      const rels: number[] = [];
      for (const [p, sp] of base.series) {
        if (pointAt(sp, x) < 0) continue;
        const st = medianStep(sp, x, base.startsBy.get(p));
        if (!st || st.age < MIN_AGE_MIN || raidSet.has(`${p}|${k}`)) continue;
        rels.push((st.after - st.before) / st.before);
      }
      if (rels.length >= 3) m.set(k, median(rels));
    }
    marketCache.set(base, m);
  }
  return m.get(Math.floor(t / 5)) ?? null;
}

export async function getPlayerDay(id: string, wanted?: string): Promise<PlayerDay | null> {
  const [base, flows] = await Promise.all([getBase(), getFlows()]);
  const s = base.series.get(id);
  if (!s || s.t.length === 0) return null;
  const daySet = new Set<string>();
  for (let i = 0; i < s.t.length; i += 10) daySet.add(dayOf(s.t[i] * 60_000));
  daySet.add(dayOf(s.t[s.t.length - 1] * 60_000));
  const days = [...daySet].sort().reverse();
  const day = wanted && daySet.has(wanted) ? wanted : days[0];
  const [a, b] = dayBounds(day);
  const t0 = a / 60_000;
  const t1 = b / 60_000;
  const points: [number, number][] = [];
  for (let i = lowerBound(s.t, t0); i < s.t.length && s.t[i] < t1; i++) points.push([s.t[i] * 60_000, s.v[i]]);

  // Ereignisse auch 30 Min vor/nach dem Tag sammeln: Sie erklären Änderungen kurz vor Mitternacht; angezeigt
  // werden am Ende nur die des Tages
  const markers: ChartMarker[] = [];
  const inDay = (x: number) => x >= t0 - 30 && x < t1 + 30;
  for (const st of base.starts) if (st.b === id && inDay(st.t0)) markers.push({ at: st.t0 * 60_000, kind: "own_start" });
  for (let i = lowerBound(s.t, t0); i < s.t.length && s.t[i] < t1; i++) {
    if (s.send[i] === s.t[i] && covered(base, s.t[i], s.t[i] + 15)) markers.push({ at: s.t[i] * 60_000, kind: "own_end" });
  }
  for (const r of base.raids) {
    if (!inDay(r.t)) continue;
    if (r.to === id) markers.push({ at: r.t * 60_000, kind: "raid_in", other: r.from, viewers: r.viewers });
    if (r.from === id) markers.push({ at: r.t * 60_000, kind: "raid_out", other: r.to, viewers: r.viewers });
  }
  for (const m of base.markers) {
    if (!inDay(m.t) || (m.players.length > 0 && !m.players.includes(id))) continue;
    // Server-Event nur, wenn der Spieler um diese Zeit live war
    if (m.type === "server_event" && pointAt(s, m.t) < 0 && pointAt(s, m.t + 30) < 0) continue;
    markers.push({ at: m.t * 60_000, kind: m.type, text: m.text });
  }
  // Wanderung (lib/viewerFlowCore.ts): eigene Einbrüche und Zuschauer, die von anderen hierher kamen
  for (const e of flows.events) {
    const t = e.at / 60_000;
    if (!inDay(t)) continue;
    if (e.from === id && e.kind === "einbruch") markers.push({ at: e.at, kind: "own_drop", viewers: -e.pool });
    if (e.kind === "start" && e.from !== id) {
      const sh = e.shares.find((x) => x.to === id);
      if (sh && sh.viewers >= CAUSE_MIN_ABS) markers.push({ at: e.at, kind: "start_loss", other: e.from, viewers: -sh.viewers });
    }
    if (e.from !== id && e.kind !== "raid" && e.kind !== "start") {
      const sh = e.shares.find((x) => x.to === id);
      if (sh && sh.viewers >= CAUSE_MIN_ABS) markers.push({ at: e.at, kind: "flow_in", other: e.from, viewers: sh.viewers, text: e.kind });
    }
  }
  markers.sort((x, y) => x.at - y.at);
  // Gleiche Ereignisse zur gleichen Zeit nur einmal (doppelte Messpunkte mit gleichem Zeitstempel)
  const seen = new Set<string>();
  for (let i = markers.length - 1; i >= 0; i--) {
    const k = `${markers[i].kind}|${markers[i].at}|${markers[i].other ?? ""}`;
    if (seen.has(k)) markers.splice(i, 1);
    else seen.add(k);
  }

  // Erwartete Änderung: was dieser Stream sonst bei diesem Streamalter (inkl. Anlauf) und dieser Tageszeit tut, plus
  // was gleichzeitig mit allen anderen Streams passiert (Abendandrang, Einschlafen, Server-Event)
  const myStarts = base.startsBy.get(id);
  const usualMap = new Map<string, number[]>();
  for (let i = 0; i < s.t.length; i += 2) {
    const st = medianStep(s, s.t[i], myStarts);
    if (!st || fineAge(st.age) < 0) continue;
    const rel = (st.after - st.before) / st.before;
    for (const k of [`${fineAge(st.age)}|${hourBlock(s.t[i])}`, `${fineAge(st.age)}`]) {
      const l = usualMap.get(k);
      if (l) l.push(rel);
      else usualMap.set(k, [rel]);
    }
  }
  const everyone = globalUsual(base);
  // Mediane einmal bilden (je Aufruf sortieren dauerte bei langen Streams über eine Minute)
  const usualMed = new Map([...usualMap].filter(([, l]) => l.length >= 20).map(([k, l]) => [k, median(l)]));
  const usualAt = (age: number, t: number) => {
    for (const k of [`${fineAge(age)}|${hourBlock(t)}`, `${fineAge(age)}`]) {
      const own = usualMed.get(k);
      if (own !== undefined) return own;
      const g = everyone.get(k);
      if (g !== undefined) return g;
    }
    return 0;
  };

  // Trend: gleitender Median über ±12 Min derselben Sitzung. Was nur kurz davon abweicht, ist ein Ausschlag.
  const trend: (number | null)[] = points.map(([ms]) => {
    const t = ms / 60_000;
    const k = pointAt(s, t);
    if (k < 0) return null;
    const m = medianIn(s, Math.max(s.sess[k], t - TREND_HALF), Math.min(s.send[k], t + TREND_HALF));
    return m === null ? null : Math.round(m);
  });
  const devs = points.map(([, v], i) => (trend[i] === null ? null : Math.abs(v - trend[i]!))).filter((x): x is number => x !== null);
  const noise = devs.length ? median(devs) * 1.4826 : 0;

  // Konkurrenz je 5 Min: andere CraftAttack-Streams live und ihre Zuschauer zusammen
  const competition: Competition[] = [];
  for (let t = t0; t < t1; t += 5) {
    let n = 0;
    let viewers = 0;
    for (const [p, sp] of base.series) {
      if (p === id) continue;
      const k = pointAt(sp, t);
      if (k < 0 || t - sp.t[k] > 6) continue;
      n++;
      viewers += sp.v[k];
    }
    competition.push({ at: t * 60_000, n, viewers: Math.round(viewers) });
  }
  const compAt = (t: number) => competition[Math.max(0, Math.min(competition.length - 1, Math.round((t - t0) / 5)))]?.n ?? 0;

  // Hype / Absturz: anhaltende Änderung des Niveaus (Median der 15 Min davor gegen 30–45 Min danach), deutlich über
  // dem Erwarteten, und eine Stunde später nicht wieder weg (sonst war es nur ein Ausschlag)
  const shiftAt = (t: number) => {
    const k = pointAt(s, t);
    if (k < 0 || s.send[k] < t + SHIFT_AFTER[1]) return null;
    const before = medianIn(s, Math.max(s.sess[k], t - 15), t);
    const after = medianIn(s, t + SHIFT_AFTER[0], t + SHIFT_AFTER[1]);
    if (before === null || after === null || before < MIN_VIEWERS) return null;
    const age = streamAge(s, k, t, myStarts);
    if (fineAge(age) < 0) return null;
    const expectedRel = (usualAt(age, t) + (marketAt(base, t) ?? 0)) * SHIFT_SCALE;
    const later = s.send[k] >= t + SHIFT_LATER[1] ? medianIn(s, t + SHIFT_LATER[0], t + SHIFT_LATER[1]) : null;
    return { before, after, later, age, expectedRel, excess: (after - before) / before - expectedRel };
  };
  // Übliche Streuung dieser Abweichung über die Staffel (jede halbe Stunde eine Probe)
  const ex: number[] = [];
  for (let i = 0; i < s.t.length; i += 30) {
    const sh = shiftAt(s.t[i]);
    if (sh) ex.push(sh.excess);
  }
  const exMid = ex.length ? median(ex) : 0;
  const exSd = ex.length ? median(ex.map((x) => Math.abs(x - exMid))) * 1.4826 || 0.05 : 0.05;
  const anomalies: Anomaly[] = [];
  for (let t = Math.ceil(t0 / 5) * 5; t < t1; t += 5) {
    const sh = shiftAt(t);
    if (!sh) continue;
    const ch = sh.after - sh.before;
    const exAbs = sh.excess * sh.before;
    if (Math.abs(sh.excess - exMid) < Math.max(SHIFT_MIN_REL, SHIFT_Z * exSd) || Math.abs(exAbs) < CAUSE_MIN_ABS) continue;
    const kind = sh.excess > exMid ? "hype" : "dip";
    // In der Anlaufphase schwankt das Wachstum stark von Start zu Start: dort weder Hype noch Absturz
    if (sh.age < 45) continue;
    // Bleibt es? Eine Stunde später muss noch mindestens die Hälfte der Änderung da sein
    if (sh.later !== null) {
      const kept = (sh.later - sh.before) / sh.before - sh.expectedRel * (SHIFT_LATER[1] / SHIFT_AFTER[1]);
      if (Math.sign(kept) !== Math.sign(sh.excess) || Math.abs(kept) < Math.abs(sh.excess) / 2) continue;
    }
    const from = t * 60_000;
    const to = (t + SHIFT_AFTER[1]) * 60_000;
    const last = anomalies[anomalies.length - 1];
    if (last && last.kind === kind && from <= last.to) {
      last.to = Math.max(last.to, to);
      if (Math.abs(ch) > Math.abs(last.change)) {
        last.change = Math.round(ch);
        last.expected = Math.round(sh.expectedRel * sh.before);
      }
      continue;
    }
    anomalies.push({ from, to, change: Math.round(ch), expected: Math.round(sh.expectedRel * sh.before), market: marketAt(base, t) ?? 0, kind, reasons: [] });
  }
  // Erklärungen: Ereignisse im Zeitraum, Konkurrenz, die dazukam oder wegfiel
  for (const an of anomalies) {
    const a0 = an.from - 10 * 60_000;
    const a1 = an.to;
    for (const m of markers) {
      if (m.at < a0 || m.at > a1 || m.kind === "own_start") continue;
      const fits =
        an.kind === "hype"
          ? ["raid_in", "flow_in", "title", "shared_start", "server_event"].includes(m.kind)
          : ["raid_out", "start_loss", "own_drop", "title", "shared_end", "own_end", "server_event"].includes(m.kind);
      if (fits) an.reasons.push({ kind: m.kind, other: m.other, viewers: m.viewers, text: m.text });
    }
    const dn = compAt(an.to / 60_000) - compAt(an.from / 60_000);
    if ((an.kind === "dip" && dn >= 2) || (an.kind === "hype" && dn <= -2)) an.reasons.push({ kind: "competition", viewers: dn });
  }

  // Alle VODs des Tages mit echtem Beginn und Ende (Twitch-API): Ein Klick nimmt das VOD, das seinen Zeitpunkt abdeckt
  const login = base.logins.get(id);
  const vods: VodSpan[] = login
    ? (await Promise.race([vodsBetween(login, a, b).catch(() => []), new Promise<[]>((r) => setTimeout(() => r([]), 4000))])).map((v) => ({ from: v.start, to: v.end, vodId: v.id, vodStart: v.start }))
    : [];
  const shown = markers.filter((m) => m.at >= a && m.at < b);
  return { id, day, points, trend, noise: Math.round(noise), competition, markers: shown, anomalies, vods, days };
}

/* ------------------------------------------------------------------ Zwischenspeicher */

const swr = createSwrCache();
const getBase = () => swr("viewer-base", BASE_CACHE_MS, loadBase);

const berlinHourParts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin" });
const hourOfCache = new Map<number, number>();
/** Stunde (Berlin, 0–23) einer Minute */
function berlinHourOf(min: number) {
  const h = Math.floor(min / 60);
  let v = hourOfCache.get(h);
  if (v === undefined) {
    v = Number(berlinHourParts.formatToParts(new Date(h * 3_600_000)).find((p) => p.type === "hour")?.value ?? 0) % 24;
    hourOfCache.set(h, v);
  }
  return v;
}

async function computeAll(): Promise<FlowAnalysis> {
  const [base, chatMoves, net] = await Promise.all([getBase(), loadChatMoves(), getNetwork(null).catch(() => null)]);
  // Nähe im Netz (beide Richtungen zusammen), je Streamer auf Summe 1
  const affinity = new Map<string, Map<string, number>>();
  if (net) {
    const out = adjacency(net.edges, DEFAULT_WEIGHTS);
    for (const [a, m] of out) {
      for (const [b, w] of m) {
        for (const [x, y] of [
          [a, b],
          [b, a],
        ]) {
          const row = affinity.get(x) ?? affinity.set(x, new Map()).get(x)!;
          row.set(y, (row.get(y) ?? 0) + w);
        }
      }
    }
    for (const row of affinity.values()) {
      const sum = [...row.values()].reduce((p, q) => p + q, 0);
      if (sum > 0) for (const [k, v] of row) row.set(k, v / sum);
    }
  }
  const flows = computeFlows({ series: base.series, cover: base.cover, startsBy: base.startsBy, raids: base.raids, hourOf: berlinHourOf, chatMoves, affinity });
  return {
    ...flows,
    raidRetention: computeRaidRetention(base),
    from: Number.isFinite(base.from) ? base.from * 60_000 : null,
    to: Number.isFinite(base.to) ? base.to * 60_000 : null,
  };
}

export interface FlowAnalysis extends FlowResult {
  raidRetention: RaidRetention;
  from: number | null;
  to: number | null;
}

/** Wanderung über die ganze Staffel, eine halbe Stunde zwischengespeichert (Rechnung ~6 s) */
export function getFlows(): Promise<FlowAnalysis> {
  return swr("viewer-flows", ANALYSIS_CACHE_MS, computeAll);
}

/* ------------------------------------------------------------------ Staffel je Streamer */

/** Zuschauer aller CraftAttack-Streams zusammen je 5-Minuten-Abschnitt (Abschnitt = Minute / 5), einmal je Basisdaten */
const totalCache = new WeakMap<Base, Map<number, number>>();
function totals(base: Base): Map<number, number> {
  let m = totalCache.get(base);
  if (m) return m;
  m = new Map();
  for (const sp of base.series) {
    const s = sp[1];
    const sum = new Map<number, { v: number; n: number }>();
    for (let i = 0; i < s.t.length; i++) {
      const k = Math.floor(s.t[i] / 5);
      const c = sum.get(k) ?? { v: 0, n: 0 };
      c.v += s.v[i];
      c.n++;
      sum.set(k, c);
    }
    for (const [k, c] of sum) m.set(k, (m.get(k) ?? 0) + c.v / c.n);
  }
  totalCache.set(base, m);
  return m;
}

export interface SeasonDay {
  day: string;
  /** Ø Zuschauer, solange live (ohne die erste halbe Stunde) */
  avg: number;
  hours: number;
  /** Ø Zuschauer aller CraftAttack-Streams zusammen am Abend (18–23 Uhr) */
  market: number;
  /** Anteil am gesamten CraftAttack-Publikum, solange er live war */
  share: number;
  /** Ø andere CraftAttack-Streams live, solange er live war */
  others: number;
  /** Raid-Zuschauer, die an diesem Tag kamen */
  raidsIn: number;
  /** Ausreißer gegenüber den Tagen davor und danach (gemessen am Anteil, also unabhängig vom allgemeinen Rückgang) */
  outlier: "hype" | "dip" | null;
  reasons: string[];
}

export interface StreamerSeason {
  days: SeasonDay[];
  /** Wie stark das ganze CraftAttack seit den ersten drei Tagen geschrumpft ist (Anteil, z. B. −0,4) */
  marketChange: number | null;
  /** und dieser Streamer im selben Zeitraum */
  ownChange: number | null;
  /** Mehr Zuschauer bei halb so viel Konkurrenz (Anteil), aus dem Vergleich der Tage; null = zu wenige Tage */
  lessCompetition: number | null;
}

const hourFmtSeason = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin" });

export async function getStreamerSeason(id: string): Promise<StreamerSeason | null> {
  const base = await getBase();
  const s = base.series.get(id);
  if (!s || !s.t.length) return null;
  const tot = totals(base);
  // Markt je Tag: Ø Zuschauer aller Streams 18–23 Uhr
  const marketDay = new Map<string, { sum: number; n: number }>();
  for (const [k, v] of tot) {
    const ms = k * 5 * 60_000;
    const h = Number(hourFmtSeason.formatToParts(ms).find((p) => p.type === "hour")?.value ?? 0);
    if (h < 18 || h > 22) continue;
    const d = dayOf(ms);
    const c = marketDay.get(d) ?? { sum: 0, n: 0 };
    c.sum += v;
    c.n++;
    marketDay.set(d, c);
  }
  const raidsIn = new Map<string, number>();
  for (const r of base.raids) if (r.to === id) raidsIn.set(dayOf(r.t * 60_000), (raidsIn.get(dayOf(r.t * 60_000)) ?? 0) + r.viewers);
  const serverDays = new Set(base.markers.filter((m) => m.type === "server_event").map((m) => dayOf(m.t * 60_000)));
  const per = new Map<string, { v: number; n: number; share: number; others: number; first: number; last: number }>();
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] - s.sess[i] < 30) continue;
    const d = dayOf(s.t[i] * 60_000);
    const k = Math.floor(s.t[i] / 5);
    const total = tot.get(k) ?? 0;
    const c = per.get(d) ?? { v: 0, n: 0, share: 0, others: 0, first: s.t[i], last: s.t[i] };
    c.v += s.v[i];
    c.n++;
    c.share += total > 0 ? s.v[i] / total : 0;
    c.last = s.t[i];
    per.set(d, c);
  }
  // Andere live: je Tag einmal je 5 Min aus der Gesamtzahl der Streams mit Punkt im Abschnitt
  const liveCount = new Map<number, number>();
  for (const sp of base.series.values()) {
    let lastK = -1;
    for (let i = 0; i < sp.t.length; i++) {
      const k = Math.floor(sp.t[i] / 5);
      if (k !== lastK) liveCount.set(k, (liveCount.get(k) ?? 0) + 1);
      lastK = k;
    }
  }
  for (const [d, c] of per) {
    let sum = 0;
    let n = 0;
    for (let k = Math.floor(c.first / 5); k <= Math.floor(c.last / 5); k++) {
      const x = liveCount.get(k);
      if (x !== undefined) {
        sum += x - 1;
        n++;
      }
    }
    c.others = n ? sum / n : 0;
    per.set(d, c);
  }
  const days: SeasonDay[] = [...per]
    .filter(([, c]) => c.n >= 20)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, c]) => {
      const m = marketDay.get(day);
      return {
        day,
        avg: Math.round(c.v / c.n),
        hours: Math.round(((c.last - c.first) / 60) * 10) / 10,
        market: m ? Math.round(m.sum / m.n) : 0,
        share: c.share / c.n,
        others: Math.round(c.others * 10) / 10,
        raidsIn: raidsIn.get(day) ?? 0,
        outlier: null,
        reasons: [],
      };
    });
  // Ausreißer: Anteil am Publikum gegen den Median der Nachbartage (±4 Tage), robust gestreut
  const logs = days.map((d) => Math.log(Math.max(1e-6, d.share)));
  const res = logs.map((x, i) => {
    const nb = logs.filter((_, j) => j !== i && Math.abs(j - i) <= 4);
    return nb.length >= 3 ? x - median(nb) : 0;
  });
  const sd = median(res.map((x) => Math.abs(x))) * 1.4826 || 0.15;
  const medOthers = median(days.map((d) => d.others));
  const medAvg = median(days.map((d) => d.avg));
  days.forEach((d, i) => {
    const z = res[i] / sd;
    if (Math.abs(z) < 2 || Math.abs(res[i]) < 0.15) return;
    d.outlier = z > 0 ? "hype" : "dip";
    if (d.raidsIn > 0.3 * medAvg) d.reasons.push(`Raids brachten ${d.raidsIn.toLocaleString("de-DE")} Zuschauer`);
    if (d.others < medOthers * 0.7) d.reasons.push(`wenig Konkurrenz (Ø ${d.others.toLocaleString("de-DE")} andere live, sonst ${medOthers.toLocaleString("de-DE")})`);
    if (d.others > medOthers * 1.3) d.reasons.push(`viel Konkurrenz (Ø ${d.others.toLocaleString("de-DE")} andere live, sonst ${medOthers.toLocaleString("de-DE")})`);
    if (d.hours < 1.5) d.reasons.push("kurzer Stream");
    if (serverDays.has(d.day)) d.reasons.push("Server-Event an diesem Tag");
  });
  const first = days.slice(0, 3);
  const lastDays = days.slice(-3);
  const mean3 = (l: SeasonDay[], f: (d: SeasonDay) => number) => (l.length ? l.reduce((a, d) => a + f(d), 0) / l.length : 0);
  const mk0 = mean3(first.filter((d) => d.market > 0), (d) => d.market);
  const mk1 = mean3(lastDays.filter((d) => d.market > 0), (d) => d.market);
  const own0 = mean3(first, (d) => d.avg);
  const own1 = mean3(lastDays, (d) => d.avg);
  // Konkurrenz: log(Zuschauer / Markt) gegen log(andere live) über die Tage
  const pts = days.filter((d) => d.market > 0 && d.others > 0).map((d) => [Math.log(d.others), Math.log(d.avg / d.market)] as const);
  let lessCompetition: number | null = null;
  if (pts.length >= 8) {
    const mx = mean(pts.map((p) => p[0]));
    const my = mean(pts.map((p) => p[1]));
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    if (sxx > 0.05) {
      const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx;
      lessCompetition = Math.max(-0.9, Math.min(3, 0.5 ** slope - 1));
    }
  }
  return {
    days,
    marketChange: days.length >= 6 && mk0 > 0 ? mk1 / mk0 - 1 : null,
    ownChange: days.length >= 6 && own0 > 0 ? own1 / own0 - 1 : null,
    lessCompetition,
  };
}
