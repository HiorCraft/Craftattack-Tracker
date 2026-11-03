/**
 * Zuschauerwanderung als Fluss: Wer Zuschauer frei werden lässt (Stream-Ende, Einbruch, Raid) und wo sie wieder
 * auftauchen. Reine Rechnung ohne Datenbank und ohne `server-only`, damit sie sich einzeln prüfen lässt.
 *
 * 1. Normalverlauf: Für jeden Stream die übliche Änderung je 5 Minuten, abhängig vom Streamalter (die Anlaufphase
 *    wächst von selbst) und der Tageszeit. Wenig eigene Daten → Muster aller Streams. Alles Weitere zählt nur die
 *    Abweichung davon („Rest“), sonst wäre der Abendandrang oder das Einschlafen nachts schon eine Wanderung.
 * 2. Quellen: Stream-Ende (alle Zuschauer werden frei), deutlicher Einbruch mitten im Stream (Rest weit unter dem
 *    Üblichen) und Raid (ausdrücklich, mit Ziel).
 * 3. Staffel-Muster: Je Ziel B ein Ausgleich über alle 5-Minuten-Abschnitte: Rest von B = Σ β(A→B) · frei gewordene
 *    Zuschauer von A in den 5–20 Minuten davor. Weil verschiedene Quellen zu verschiedenen Zeiten zusammenfallen,
 *    lassen sich die Anteile so trennen, auch wenn an einem einzelnen Abend drei Streams gleichzeitig enden.
 *    Nicht negativ, leicht gegen 0 gezogen (wenige Fälle → vorsichtig).
 * 4. Einzelnes Ereignis: Den tatsächlichen Zuwachs von B in den 20 Minuten danach teilen sich die gleichzeitigen
 *    Quellen nach ihrem erwarteten Beitrag (β · Größe), dazu ein Anteil „Zufall“ in Höhe der üblichen Schwankung von
 *    B. Chat-Spuren (wer erst bei A, dann bei B schreibt) gehen, wo vorhanden, als zusätzliches Gewicht ein.
 * 5. Bleiben: Wie viel des Zuwachses nach 60 Minuten noch da ist (Raids: wie bisher Minute für Minute).
 *
 * Was nicht wiedergefunden wird, ist offline gegangen oder bei Streams, die hier nicht erfasst sind; das lässt sich
 * nicht trennen. Wie viel davon normal ist, zeigt der Anteil je Tageszeit über die Staffel.
 */

export const BIN = 5;
/** Zuwachs wird 5–20 Minuten nach dem Freiwerden gesucht (Twitch zählt mit ~3 Min Verzug) */
export const LAG_WEIGHTS = [0.3, 0.35, 0.25, 0.1];
const MIN_POOL = 30;
/** Mindestgröße eines Einbruchs mitten im Stream */
const DROP_MIN = 60;
const DROP_SHARE = 0.1;
const DROP_SIGMA = 5;
/** Einbruch zählt nur, wenn 20–30 Min später höchstens so viel davon zurückgekommen ist (sonst Zählaussetzer) */
const DROP_REBOUND = 0.4;
/** Streams müssen so lange live sein, bevor ihr Rest zählt (davor ist alles Anlauf) */
const MIN_AGE = 10;
/** Ridge: zieht β je Quelle um diesen Anteil ihres Gewichts gegen 0 */
const RIDGE = 0.3;
/** Höchstens dieser Anteil der frei gewordenen Zuschauer geht (ohne Raid) zu einem einzelnen Stream */
const MAX_BETA = 0.5;
/** Mindestens so viele frei gewordene Zuschauer einer Quelle, während das Ziel live war, für ein Muster */
const MIN_RELEASED = 2000;
/** Raid zählt zu einem Ende, wenn er so nah daran liegt (Minuten) */
const RAID_END_MIN = 10;

export interface FlowSeries {
  /** Minuten seit 1970 */
  t: Float64Array;
  v: Float64Array;
}

export interface FlowRaid {
  from: string;
  to: string;
  /** Minuten */
  t: number;
  viewers: number;
}

export interface FlowInput {
  series: Map<string, FlowSeries>;
  /** Minuten mit irgendeinem Messwert des Trackers */
  cover: Set<number>;
  /** echte Startzeiten je Streamer (Minuten, sortiert) */
  startsBy: Map<string, Float64Array>;
  raids: FlowRaid[];
  /** Stunde (Berlin, 0–23) einer Minute */
  hourOf: (min: number) => number;
  /** Chat-Spuren: Wechsel von Schreibern von A nach B je 5-Minuten-Abschnitt (Abschnitt = Minute / 5) */
  chatMoves?: { bin: number; from: string; to: string; n: number; stay: number }[];
}

export type SourceKind = "ende" | "einbruch" | "raid";

export interface FlowShare {
  to: string;
  /** zugeordnete Zuschauer */
  viewers: number;
  /** davon nach 60 Min noch da (Anteil), null = nicht messbar */
  stay: number | null;
  /** aus Chat-Spuren gestützt */
  chat: number;
}

export interface FlowEvent {
  id: string;
  kind: SourceKind;
  from: string;
  /** ms */
  at: number;
  /** frei gewordene Zuschauer */
  pool: number;
  /** Raid: Ziel und gemeldete Raid-Größe */
  raidTo?: string;
  raidViewers?: number;
  /** wiedergefunden bei anderen erfassten Streams (inkl. angekommener Raid-Zuschauer) */
  shares: FlowShare[];
  found: number;
  /** üblich wiedergefunden um diese Uhrzeit (Anteil) */
  usualFound: number | null;
  /** weitere Quellen im selben Zeitfenster */
  overlapping: number;
}

export interface PairFlow {
  from: string;
  to: string;
  /** Anteil der frei gewordenen Zuschauer von A, der bei B auftaucht (Staffel-Muster) */
  beta: number;
  se: number;
  /** Ereignisse von A, in denen B live war */
  n: number;
  /** über die Staffel zugeordnete Zuschauer (Muster + angekommene Raid-Zuschauer) */
  viewers: number;
  /** davon über Raids */
  raid: number;
  stay: number | null;
}

export interface SourceSummary {
  id: string;
  ends: number;
  drops: number;
  raids: number;
  pool: number;
  found: number;
  stay: number | null;
  top: PairFlow[];
}

export interface FlowResult {
  events: FlowEvent[];
  pairs: PairFlow[];
  sources: SourceSummary[];
  /** je Stunde (0–23): frei geworden, wiedergefunden */
  hourly: { hour: number; pool: number; found: number; n: number }[];
  /** Anlauf: übliche Zuschauer nach Streamalter, als Anteil des Stands nach 2 Stunden (alle Streams) */
  rampUp: { age: number; median: number; n: number }[];
  /** Normalverlauf je Streamer für die Streamer-Ansicht */
  usual: Map<string, { ramp: { age: number; median: number; n: number }[]; hourly: { hour: number; change: number; n: number }[] }>;
  chatMovesTotal: number;
}

/* ------------------------------------------------------------------ Hilfen */

const ageCls = (m: number) => (m < 20 ? 0 : m < 30 ? 1 : m < 60 ? 2 : m < 120 ? 3 : m < 240 ? 4 : 5);
const hourCls = (h: number) => Math.floor(h / 3);

function trimmedMean(l: number[]) {
  if (!l.length) return 0;
  const v = [...l].sort((a, b) => a - b);
  const cut = Math.floor(v.length * 0.1);
  const w = v.slice(cut, v.length - cut || undefined);
  return w.reduce((s, x) => s + x, 0) / w.length;
}
function median(l: number[]) {
  if (!l.length) return 0;
  const v = [...l].sort((a, b) => a - b);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}
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

interface Binned {
  id: string;
  /** Zuschauer je Abschnitt, NaN = nicht live / keine Daten */
  v: Float64Array;
  /** Streamalter (Minuten) je Abschnitt, Infinity = unbekannt (lange live) */
  age: Float64Array;
  /** Rest je Abschnitt (Änderung zum vorigen minus üblich), NaN = nicht bewertbar */
  r: Float64Array;
  /** übliche Schwankung des Rests (robust) */
  sigma: number;
}

/* ------------------------------------------------------------------ Rechnung */

export function computeFlows(input: FlowInput): FlowResult {
  let k0 = Infinity;
  let k1 = -Infinity;
  for (const s of input.series.values()) {
    if (!s.t.length) continue;
    k0 = Math.min(k0, Math.floor(s.t[0] / BIN));
    k1 = Math.max(k1, Math.floor(s.t[s.t.length - 1] / BIN));
  }
  if (!Number.isFinite(k0)) return { events: [], pairs: [], sources: [], hourly: [], rampUp: [], usual: new Map(), chatMovesTotal: 0 };
  const n = k1 - k0 + 1;
  const cov = new Uint8Array(n);
  for (const m of input.cover) {
    const k = Math.floor(m / BIN) - k0;
    if (k >= 0 && k < n) cov[k] = 1;
  }
  const hourAt = new Int8Array(n);
  for (let k = 0; k < n; k++) hourAt[k] = input.hourOf((k + k0) * BIN);

  // Raid-Beteiligung je Streamer und Abschnitt (±15 Min): dort zählt der Rest nicht als freies Wandern
  const raidBins = new Map<string, Set<number>>();
  const mark = (id: string, k: number) => {
    const set = raidBins.get(id) ?? raidBins.set(id, new Set()).get(id)!;
    for (let d = -3; d <= 4; d++) set.add(k + d);
  };
  for (const r of input.raids) {
    const k = Math.floor(r.t / BIN) - k0;
    mark(r.from, k);
    mark(r.to, k);
  }

  // 1. In Abschnitte legen, Streamalter
  const binned = new Map<string, Binned>();
  for (const [id, s] of input.series) {
    const v = new Float64Array(n).fill(NaN);
    const sum = new Float64Array(n);
    const cnt = new Uint16Array(n);
    for (let i = 0; i < s.t.length; i++) {
      const k = Math.floor(s.t[i] / BIN) - k0;
      sum[k] += s.v[i];
      cnt[k]++;
    }
    for (let k = 0; k < n; k++) if (cnt[k]) v[k] = sum[k] / cnt[k];
    const age = new Float64Array(n).fill(Infinity);
    const starts = input.startsBy.get(id);
    if (starts) {
      for (let k = 0; k < n; k++) {
        if (Number.isNaN(v[k])) continue;
        const t = (k + k0) * BIN + BIN / 2;
        const j = lowerBound(starts, t) - 1;
        // Start gehört zu dieser Sitzung, wenn seit ihm durchgehend live (Lücken bis 15 Min erlaubt)
        if (j >= 0 && t - starts[j] < 24 * 60) {
          let ok = true;
          for (let q = Math.floor(starts[j] / BIN) - k0 + 1, gap = 0; q < k; q++) {
            gap = Number.isNaN(v[q]) && cov[q] ? gap + 1 : 0;
            if (gap > 3) {
              ok = false;
              break;
            }
          }
          if (ok) age[k] = t - starts[j];
        }
      }
    }
    binned.set(id, { id, v, age, r: new Float64Array(n).fill(NaN), sigma: 0 });
  }

  // 2. Normalverlauf: relative Änderung je (Streamer, Alter, Tageszeit) mit Rückfall auf weniger genaue Gruppen
  const lists = new Map<string, number[]>();
  const push = (key: string, x: number) => (lists.get(key) ?? lists.set(key, []).get(key)!).push(x);
  const usable = (b: Binned, k: number) =>
    k > 0 && cov[k] && cov[k - 1] && !Number.isNaN(b.v[k]) && !Number.isNaN(b.v[k - 1]) && b.v[k - 1] >= 20 && b.age[k] >= MIN_AGE && !raidBins.get(b.id)?.has(k);
  for (const b of binned.values()) {
    for (let k = 1; k < n; k++) {
      if (!usable(b, k)) continue;
      const d = Math.max(-0.5, Math.min(0.5, b.v[k] / b.v[k - 1] - 1));
      const a = ageCls(b.age[k]);
      const h = hourCls(hourAt[k]);
      push(`${b.id}|${a}|${h}`, d);
      push(`${b.id}|${a}`, d);
      push(`*|${a}|${h}`, d);
      push(`*|${a}`, d);
    }
  }
  const usualCache = new Map<string, number>();
  const usualOf = (id: string, age: number, hour: number) => {
    const a = ageCls(age);
    const h = hourCls(hour);
    const ck = `${id}|${a}|${h}`;
    const hit = usualCache.get(ck);
    if (hit !== undefined) return hit;
    let out = 0;
    for (const [key, min] of [
      [`${id}|${a}|${h}`, 20],
      [`${id}|${a}`, 20],
      [`*|${a}|${h}`, 50],
      [`*|${a}`, 1],
    ] as const) {
      const l = lists.get(key);
      if (l && l.length >= min) {
        out = trimmedMean(l);
        break;
      }
    }
    usualCache.set(ck, out);
    return out;
  };
  for (const b of binned.values()) {
    const abs: number[] = [];
    for (let k = 1; k < n; k++) {
      if (!usable(b, k)) continue;
      b.r[k] = b.v[k] - b.v[k - 1] * (1 + usualOf(b.id, b.age[k], hourAt[k]));
      abs.push(Math.abs(b.r[k]));
    }
    // MAD-Schätzung der Schwankung (robust gegen die Ereignisse selbst)
    b.sigma = Math.max(5, median(abs) * 1.4826);
  }

  // 3. Quellen
  type Src = { id: string; kind: SourceKind; from: string; k: number; pool: number; raidTo?: string; raidViewers?: number };
  const sources: Src[] = [];
  const raidsFrom = new Map<string, FlowRaid[]>();
  for (const r of input.raids) (raidsFrom.get(r.from) ?? raidsFrom.set(r.from, []).get(r.from)!).push(r);
  const usedRaids = new Set<FlowRaid>();
  for (const b of binned.values()) {
    for (let k = 1; k < n - 6; k++) {
      if (Number.isNaN(b.v[k])) continue;
      // Ende: danach 30 Min nicht live, Tracker lief
      if (Number.isNaN(b.v[k + 1])) {
        let off = true;
        let seen = 0;
        for (let q = k + 1; q <= Math.min(n - 1, k + 6); q++) {
          if (!Number.isNaN(b.v[q])) off = false;
          if (cov[q]) seen++;
        }
        if (!off || seen < 5) continue;
        const pool = Number.isNaN(b.v[k - 1]) ? b.v[k] : Math.max(b.v[k], (b.v[k] + b.v[k - 1]) / 2);
        if (pool < MIN_POOL) continue;
        const tEnd = (k + k0) * BIN + BIN;
        const raid = (raidsFrom.get(b.id) ?? []).find((r) => !usedRaids.has(r) && r.t >= tEnd - RAID_END_MIN - BIN && r.t <= tEnd + RAID_END_MIN);
        if (raid) usedRaids.add(raid);
        sources.push({ id: `e${b.id}${k}`, kind: raid ? "raid" : "ende", from: b.id, k, pool, raidTo: raid?.to, raidViewers: raid?.viewers });
      }
    }
    // Einbruch: Rest über bis zu drei Abschnitte deutlich unter dem Üblichen, nicht kurz vor dem Ende
    for (let k = 2; k < n - 3; k++) {
      if (Number.isNaN(b.r[k]) || b.r[k] >= 0 || b.age[k] < 20) continue;
      let sum = 0;
      let last = k;
      for (let q = k; q < k + 3 && q < n && !Number.isNaN(b.r[q]) && b.r[q] < 0; q++) {
        sum += b.r[q];
        last = q;
      }
      const before = b.v[k - 1];
      const threshold = Math.max(DROP_MIN, DROP_SHARE * before, DROP_SIGMA * b.sigma);
      if (-sum < threshold) continue;
      // Erholt sich der Stand gleich wieder, war es ein Zählaussetzer von Twitch, kein Abwandern
      const later: number[] = [];
      for (let q = last + 4; q <= last + 6 && q < n; q++) if (!Number.isNaN(b.v[q])) later.push(b.v[q]);
      if (later.length < 2 || median(later) > before + sum * (1 - DROP_REBOUND)) {
        k = last;
        continue;
      }
      // kurz danach Ende → gehört zum Ende
      let ends = false;
      for (let q = last + 1; q <= last + 2 && q < n; q++) if (Number.isNaN(b.v[q])) ends = true;
      if (ends || raidBins.get(b.id)?.has(k)) {
        k = last;
        continue;
      }
      sources.push({ id: `d${b.id}${k}`, kind: "einbruch", from: b.id, k: last, pool: -sum });
      k = last + 1;
    }
  }
  // Raids ohne Ende (mitten im Stream)
  for (const r of input.raids) {
    if (usedRaids.has(r) || r.viewers < MIN_POOL || !binned.has(r.from)) continue;
    sources.push({ id: `r${r.from}${r.t}`, kind: "raid", from: r.from, k: Math.floor(r.t / BIN) - k0, pool: r.viewers, raidTo: r.to, raidViewers: r.viewers });
  }
  sources.sort((a, b) => a.k - b.k);

  // Frei gewordene Zuschauer je Quelle-Streamer und Abschnitt (Raids sind ausdrücklich, hier nur der Rest)
  const released = new Map<string, Float64Array>();
  for (const s of sources) {
    const amount = s.kind === "raid" ? Math.max(0, s.pool - (s.raidViewers ?? 0)) : s.pool;
    if (amount <= 0) continue;
    const arr = released.get(s.from) ?? released.set(s.from, new Float64Array(n)).get(s.from)!;
    arr[s.k] += amount;
  }
  // Erwartete Ankunft: über 5–20 Min verteilt
  const lagged = new Map<string, Float64Array>();
  for (const [id, x] of released) {
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      if (!x[k]) continue;
      LAG_WEIGHTS.forEach((w, j) => {
        if (k + 1 + j < n) out[k + 1 + j] += w * x[k];
      });
    }
    lagged.set(id, out);
  }

  // 4. Staffel-Muster je Ziel: nicht-negativer Ausgleich mit Ridge (Koordinatenabstieg)
  const beta = new Map<string, number>();
  const betaSe = new Map<string, number>();
  for (const b of binned.values()) {
    const rows: number[] = [];
    const rowOf = new Int32Array(n).fill(-1);
    for (let k = 1; k < n; k++) if (!Number.isNaN(b.r[k])) rowOf[k] = rows.push(k) - 1;
    if (rows.length < 50) continue;
    // Spalten dünn besetzt: nur Abschnitte, in denen die Quelle etwas freigibt
    const srcs: { id: string; idx: Int32Array; val: Float64Array }[] = [];
    for (const [id, x] of lagged) {
      if (id === b.id) continue;
      const idx: number[] = [];
      const val: number[] = [];
      for (let k = 0; k < n; k++) {
        if (x[k] > 0 && rowOf[k] >= 0) {
          idx.push(rowOf[k]);
          val.push(x[k]);
        }
      }
      // Zu wenig frei geworden, während B live war: daraus lässt sich kein Anteil schätzen (Rauschen von B überwiegt)
      if (idx.length && val.reduce((a, v) => a + v, 0) >= MIN_RELEASED) srcs.push({ id, idx: Int32Array.from(idx), val: Float64Array.from(val) });
    }
    if (!srcs.length) continue;
    const res = Float64Array.from(rows, (k) => b.r[k]);
    const diag = srcs.map((c) => c.val.reduce((s2, v) => s2 + v * v, 0));
    const w = new Float64Array(srcs.length);
    for (let it = 0; it < 60; it++) {
      let moved = 0;
      for (let j = 0; j < srcs.length; j++) {
        const { idx, val } = srcs[j];
        let dot = 0;
        for (let i = 0; i < idx.length; i++) dot += val[i] * res[idx[i]];
        const next = Math.min(MAX_BETA, Math.max(0, (dot + diag[j] * w[j]) / (diag[j] * (1 + RIDGE))));
        const d = next - w[j];
        if (d) {
          for (let i = 0; i < idx.length; i++) res[idx[i]] -= d * val[i];
          w[j] = next;
          moved = Math.max(moved, Math.abs(d));
        }
      }
      if (moved < 1e-4) break;
    }
    const sigma = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / Math.max(1, rows.length - srcs.length));
    srcs.forEach(({ id }, j) => {
      beta.set(`${id}|${b.id}`, w[j]);
      betaSe.set(`${id}|${b.id}`, diag[j] ? sigma / Math.sqrt(diag[j]) : Infinity);
    });
  }

  // Chat-Spuren je (Abschnitt, Quelle, Ziel)
  const chat = new Map<string, { n: number; stay: number }>();
  let chatMovesTotal = 0;
  for (const m of input.chatMoves ?? []) {
    const key = `${m.bin - k0}|${m.from}|${m.to}`;
    const c = chat.get(key) ?? { n: 0, stay: 0 };
    c.n += m.n;
    c.stay += m.stay;
    chat.set(key, c);
    chatMovesTotal += m.n;
  }
  const chatIn = (k: number, from: string, to: string) => {
    let s = 0;
    for (let q = k; q <= k + 4; q++) s += chat.get(`${q}|${from}|${to}`)?.n ?? 0;
    return s;
  };

  // 5. Einzelne Ereignisse: Zuwachs je Ziel auf die gleichzeitigen Quellen verteilen
  const window = (b: Binned, k: number) => {
    let g = 0;
    for (let q = k + 1; q <= k + LAG_WEIGHTS.length; q++) {
      if (q >= n || Number.isNaN(b.r[q])) return null;
      g += b.r[q];
    }
    return g;
  };
  const stayOf = (b: Binned, k: number, gain: number) => {
    if (gain <= 0) return null;
    let g = 0;
    for (let q = k + 1; q <= k + 12; q++) {
      if (q >= n || Number.isNaN(b.r[q])) return null;
      g += b.r[q];
    }
    return Math.max(0, Math.min(1, g / gain));
  };
  /** So viele Zuschauer vertritt ein Chat-Schreiber, der wechselt (grob: auf 30 Zuschauer kommt ein Schreiber) */
  const CHAT_VIEWERS = 30;
  const events: FlowEvent[] = [];
  const pairAgg = new Map<string, { viewers: number; stays: number[]; n: number }>();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, pool: 0, found: 0, n: 0 }));
  for (const s of sources) {
    const overl = sources.filter((o) => o !== s && Math.abs(o.k - s.k) <= 3);
    const shares: FlowShare[] = [];
    for (const b of binned.values()) {
      if (b.id === s.from) continue;
      // Raid-Ziel: ausdrücklich, Ankunft als höchster Stand in 10 Min über dem Stand davor
      if (s.kind === "raid" && b.id === s.raidTo) {
        const before = b.v[s.k - 1] ?? NaN;
        let peak = -Infinity;
        for (let q = s.k; q <= s.k + 2 && q < n; q++) if (!Number.isNaN(b.v[q])) peak = Math.max(peak, b.v[q]);
        const arrived = Number.isNaN(before) || !Number.isFinite(peak) ? 0 : Math.max(0, Math.min(s.raidViewers ?? 0, peak - before));
        let later: number | null = null;
        const q60 = s.k + 12;
        if (q60 < n && !Number.isNaN(b.v[q60]) && !Number.isNaN(before)) later = Math.max(0, Math.min(1, (b.v[q60] - before) / Math.max(1, arrived)));
        shares.push({ to: b.id, viewers: arrived, stay: arrived > 0 ? later : null, chat: chatIn(s.k, s.from, b.id) });
        continue;
      }
      if (raidBins.get(b.id)?.has(s.k + 1)) continue;
      const g = window(b, s.k);
      if (g === null) continue;
      const amount = s.kind === "raid" ? Math.max(0, s.pool - (s.raidViewers ?? 0)) : s.pool;
      if (amount <= 0) continue;
      // Jede gleichzeitige Quelle o bringt erwartet μ = β·Größe (+ Chat-Spuren), unsicher um τ; dazu die übliche
      // Schwankung von B. Der beobachtete Zuwachs g verteilt sich nach τ² auf die Abweichung vom Erwarteten
      // (Bayes mit Normalverteilungen). Ohne Muster und ohne Chat-Spur bleibt so fast nichts hängen.
      const prior = (o: Src) => {
        const amt = o.kind === "raid" ? Math.max(0, o.pool - (o.raidViewers ?? 0)) : o.pool;
        if (o.from === b.id || amt <= 0) return { mu: 0, tau2: 0 };
        const key = `${o.from}|${b.id}`;
        const bt = beta.get(key) ?? 0;
        // Unsicherheit des Musters, aber nicht weit über das Muster hinaus: β ≈ 0 heißt über die Staffel kaum Fluss
        const se = Math.min(betaSe.get(key) ?? 0.02, Math.max(0.01, 2 * bt));
        const viaChat = CHAT_VIEWERS * chatIn(o.k, o.from, b.id);
        return { mu: bt * amt + viaChat, tau2: (amt * Math.max(se, 0.003)) ** 2 + viaChat ** 2 };
      };
      const mine = prior(s);
      const others = overl.map(prior);
      const muSum = mine.mu + others.reduce((x, o) => x + o.mu, 0);
      const varSum = mine.tau2 + others.reduce((x, o) => x + o.tau2, 0) + LAG_WEIGHTS.length * b.sigma ** 2;
      const part = Math.max(0, mine.mu + (mine.tau2 / varSum) * (g - muSum));
      if (part < 5) continue;
      shares.push({ to: b.id, viewers: part, stay: stayOf(b, s.k, g), chat: chatIn(s.k, s.from, b.id) });
    }
    // Nicht mehr zuordnen als frei wurde
    const sum = shares.reduce((a, x) => a + x.viewers, 0);
    if (sum > s.pool) for (const x of shares) x.viewers *= s.pool / sum;
    shares.sort((a, b) => b.viewers - a.viewers);
    const found = shares.reduce((a, x) => a + x.viewers, 0);
    // Übliches je Tageszeit nur aus Enden und Einbrüchen (Raids sind ausdrücklich gelenkt)
    if (s.kind !== "raid") {
      const h = hourAt[s.k];
      hourly[h].pool += s.pool;
      hourly[h].found += found;
      hourly[h].n++;
    }
    for (const x of shares) {
      const key = `${s.from}|${x.to}`;
      const p = pairAgg.get(key) ?? { viewers: 0, stays: [], n: 0 };
      p.viewers += x.viewers;
      p.n++;
      if (x.stay !== null && x.viewers >= 20) p.stays.push(x.stay);
      pairAgg.set(key, p);
    }
    events.push({
      id: s.id,
      kind: s.kind,
      from: s.from,
      at: (s.k + k0) * BIN * 60_000 + BIN * 60_000,
      pool: Math.round(s.pool),
      raidTo: s.raidTo,
      raidViewers: s.raidViewers,
      shares: shares.map((x) => ({ ...x, viewers: Math.round(x.viewers) })),
      found: Math.round(found),
      usualFound: null,
      overlapping: overl.length,
    });
  }
  for (const e of events) {
    if (e.kind === "raid") continue;
    const h = hourly[input.hourOf(e.at / 60_000 - BIN)];
    e.usualFound = h.pool > 0 && h.n >= 10 ? h.found / h.pool : null;
  }

  // Paare: Staffel-Muster + zugeordnete Summe
  // Angekommene Raid-Zuschauer je Paar
  const raidPair = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "raid" || !e.raidTo) continue;
    const arrived = e.shares.find((x) => x.to === e.raidTo)?.viewers ?? 0;
    const key = `${e.from}|${e.raidTo}`;
    raidPair.set(key, (raidPair.get(key) ?? 0) + arrived);
  }
  const eventsOf = new Map<string, Src[]>();
  for (const s of sources) (eventsOf.get(s.from) ?? eventsOf.set(s.from, []).get(s.from)!).push(s);
  const pairs: PairFlow[] = [];
  for (const [key, bt] of beta) {
    const [from, to] = key.split("|");
    const agg = pairAgg.get(key);
    const tb = binned.get(to)!;
    const nLive = (eventsOf.get(from) ?? []).filter((s) => !Number.isNaN(tb.v[s.k]) || !Number.isNaN(tb.v[s.k + 1])).length;
    // Staffel-Summe aus dem Muster (β · frei gewordene Zuschauer, während B live war); einzelne Zuordnungen wären
    // durch das Abschneiden bei 0 nach oben verzerrt
    const amt = (eventsOf.get(from) ?? [])
      .filter((s) => s.kind !== "raid" && (!Number.isNaN(tb.v[s.k]) || !Number.isNaN(tb.v[s.k + 1])))
      .reduce((a, s) => a + s.pool, 0);
    const viewers = Math.round(bt * amt);
    if (viewers <= 0 && !raidPair.has(key)) continue;
    pairs.push({ from, to, beta: bt, se: betaSe.get(key) ?? Infinity, n: nLive, viewers: viewers + (raidPair.get(key) ?? 0), raid: raidPair.get(key) ?? 0, stay: agg && agg.stays.length >= 3 ? median(agg.stays) : null });
  }
  // Raid-Paare ohne β (ausdrücklich)
  for (const [key, v] of raidPair) {
    if (beta.has(key)) continue;
    const [from, to] = key.split("|");
    const agg = pairAgg.get(key);
    pairs.push({ from, to, beta: 0, se: Infinity, n: agg?.n ?? 0, viewers: v, raid: v, stay: agg && agg.stays.length >= 3 ? median(agg.stays) : null });
  }
  pairs.sort((a, b) => b.viewers - a.viewers);

  const summaries: SourceSummary[] = [...eventsOf].map(([id, l]) => {
    const evs = events.filter((e) => e.from === id);
    const stays = evs.flatMap((e) => e.shares.filter((x) => x.stay !== null && x.viewers >= 20).map((x) => x.stay!));
    return {
      id,
      ends: l.filter((s) => s.kind === "ende").length,
      drops: l.filter((s) => s.kind === "einbruch").length,
      raids: l.filter((s) => s.kind === "raid").length,
      pool: Math.round(evs.reduce((a, e) => a + e.pool, 0)),
      found: Math.round(evs.reduce((a, e) => a + e.found, 0)),
      stay: stays.length >= 3 ? median(stays) : null,
      top: pairs.filter((p) => p.from === id && p.viewers > 0).slice(0, 5),
    };
  });
  summaries.sort((a, b) => b.pool - a.pool);

  // Anlauf: Stand je Streamalter relativ zum Stand nach 2 Std (gleiche Sitzung)
  const rampAges = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
  const rampOf = (ids: Iterable<Binned>) => {
    const per = rampAges.map(() => [] as number[]);
    for (const b of ids) {
      for (let k = 0; k < n; k++) {
        // Sitzungsbeginn mit bekanntem Alter < 5 Min
        if (!(b.age[k] < BIN)) continue;
        const ref = k + 24;
        if (ref >= n || Number.isNaN(b.v[ref]) || b.v[ref] < 20) continue;
        rampAges.forEach((a, j) => {
          const q = k + Math.round(a / BIN);
          if (q < n && !Number.isNaN(b.v[q])) per[j].push(b.v[q] / b.v[ref]);
        });
      }
    }
    return rampAges.map((age, j) => ({ age, median: median(per[j]), n: per[j].length }));
  };
  const usual = new Map<string, { ramp: { age: number; median: number; n: number }[]; hourly: { hour: number; change: number; n: number }[] }>();
  for (const b of binned.values()) {
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sum: 0, n: 0 }));
    for (let k = 1; k < n; k++) {
      if (!usable(b, k) || b.age[k] < 60) continue;
      hours[hourAt[k]].sum += b.v[k] / b.v[k - 1] - 1;
      hours[hourAt[k]].n++;
    }
    usual.set(b.id, { ramp: rampOf([b]), hourly: hours.map((h) => ({ hour: h.hour, change: h.n ? (h.sum / h.n) * 12 : 0, n: h.n })) });
  }

  return { events, pairs, sources: summaries, hourly, rampUp: rampOf(binned.values()), usual, chatMovesTotal };
}
