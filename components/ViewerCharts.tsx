"use client";

import { useRef, useState } from "react";
import { headUrl } from "@/lib/format";

/**
 * Interaktive Diagramme der Zuschauer-Seite: Tagesverteilung als gestapelte Fläche und der
 * Zuschauerverlauf eines Spielers mit Ereignissen. Fadenkreuz mit Tooltip; im Spielerverlauf öffnet ein Klick das
 * VOD an dieser Stelle. Farben kommen aus `.mig` in globals.css (geprüfte Palette, hell/dunkel).
 */

const nf = new Intl.NumberFormat("de-DE");
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const hourFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin" });
/** Stunde in Berlin als Zahl („de-DE“ formatiert eine reine Stunde als „17 Uhr“) */
const hourOf = (t: number) => Number(hourFmt.formatToParts(t).find((p) => p.type === "hour")?.value ?? 0);

/** Runde Achsenschritte (1, 2, 5 · 10^n) */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const dayShortFmt = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: "UTC" });
const short = (v: number) => (v >= 10_000 ? `${nf.format(Math.round(v / 1000))} Tsd.` : nf.format(Math.round(v)));

/** Zeigerposition im SVG-Koordinatensystem (viewBox) */
function svgX(svg: SVGSVGElement, clientX: number, width: number) {
  const r = svg.getBoundingClientRect();
  return ((clientX - r.left) / r.width) * width;
}

/* ------------------------------------------------------------------ Tagesverteilung */

export function DayStackChart({ times, covered, series }: { times: number[]; covered: boolean[]; series: { id: string; name: string; values: number[] }[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 900;
  const H = 320;
  const L = 56;
  const R = 12;
  const T = 12;
  const B = 28;
  const n = times.length;
  const totals = times.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const ticks = niceTicks(Math.max(1, ...totals));
  const yMax = ticks[ticks.length - 1];
  const x = (i: number) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  // Abschnitte mit Tracker-Daten; dazwischen bleibt eine Lücke statt einer Fläche auf 0
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (!covered[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  // Stapel von unten nach oben in fester Reihenfolge (größte Streams zuerst, „Andere“ oben)
  const lower = new Array<number>(n).fill(0);
  const bands = series.map((s, k) => {
    const lo = [...lower];
    const hi = lo.map((v, i) => v + s.values[i]);
    for (let i = 0; i < n; i++) lower[i] = hi[i];
    const d = runs
      .map(([a, b]) => {
        const idx = Array.from({ length: b - a + 1 }, (_, j) => a + j);
        // Einzelner Abschnitt: halbe Breite links und rechts, sonst wäre er unsichtbar
        const xs = idx.length === 1 ? [x(a) - 2, x(a) + 2] : idx.map(x);
        const his = idx.length === 1 ? [hi[a], hi[a]] : idx.map((i) => hi[i]);
        const los = idx.length === 1 ? [lo[a], lo[a]] : idx.map((i) => lo[i]);
        const top = xs.map((xx, j) => `${xx.toFixed(1)},${y(his[j]).toFixed(1)}`);
        const bottom = xs.map((xx, j) => `${xx.toFixed(1)},${y(los[j]).toFixed(1)}`).reverse();
        return `M${top.join("L")}L${bottom.join("L")}Z`;
      })
      .join("");
    return { s, k, d };
  });
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!ref.current) return;
    const px = svgX(ref.current, e.clientX, W);
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  };
  // Alle 3 Stunden eine Beschriftung (36 Abschnitte à 5 Min)
  const hourTicks = times.map((t, i) => ({ t, i })).filter(({ i }) => i % 36 === 0);
  const tip = hover !== null
    ? series
        .map((s, k) => ({ name: s.name, k, v: s.values[hover] }))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v)
    : [];
  return (
    <div className="mig__chart">
      <ul className="mig__keys" aria-label="Legende">
        {series.map((s, k) => (
          <li key={s.id || "andere"}>
            <i className={k === series.length - 1 && !s.id ? "mig__c0" : `mig__c${k + 1}`} aria-hidden="true" /> {s.name}
          </li>
        ))}
      </ul>
      <div className="mig__plot">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Zuschauer aller CraftAttack-Streams über den Tag, gestapelt"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="mig__grid" />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="mig__tick">
                {short(v)}
              </text>
            </g>
          ))}
          {hourTicks.map(({ t, i }) => (
            <text key={t} x={x(i)} y={H - 8} textAnchor="middle" className="mig__tick">
              {hourOf(t)} Uhr
            </text>
          ))}
          {bands.map(({ s, k, d }) => (
            <path key={s.id || "andere"} d={d} className={`mig__band ${k === series.length - 1 && !s.id ? "mig__c0" : `mig__c${k + 1}`}`} />
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="mig__cross" />}
        </svg>
        {hover !== null && (
          <div className="mig__tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <b>
              {timeFmt.format(times[hover])} · {covered[hover] ? `${nf.format(totals[hover])} Zuschauer` : "keine Daten (Tracker lief nicht)"}
            </b>
            {tip.slice(0, 8).map((r) => (
              <span key={r.name}>
                <i className={r.k === series.length - 1 && !series[r.k].id ? "mig__c0" : `mig__c${r.k + 1}`} aria-hidden="true" /> {r.name}: {nf.format(r.v)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Streamer an einem Tag */

export interface ViewMarker {
  at: number;
  /** loss = kostete Zuschauer, gain = brachte Zuschauer, own = eigenes/neutrales Ereignis */
  tone: "loss" | "gain" | "own";
  /** kurzer Text für Tooltip und Tabelle */
  label: string;
  /** Symbol am Kopf der Linie */
  icon: string;
  /** beteiligter anderer Streamer: Kopf an der Linie, Klick führt zu seinem Tag */
  other?: { id: string; name: string; uuid?: string; href: string };
  /** Bedeutung für die Analyse des Verlaufs (0–1): steuert, ab welcher Stufe des Reglers das Ereignis erscheint */
  importance: number;
}

export interface ViewBand {
  from: number;
  to: number;
  kind: "dip" | "hype";
  label: string;
  reasons: string[];
}

export interface ViewVod {
  from: number;
  to: number;
  vodId: string;
  vodStart: number;
}

export interface ViewCompetition {
  at: number;
  n: number;
  viewers: number;
}

/** Ab hier im VOD einsteigen: etwas vor dem geklickten Zeitpunkt */
const VOD_LEAD_S = 30;

/**
 * Als normalen neuen Tab öffnen: `window.open` mit Fenster-Optionen (z. B. "noopener") öffnet ein Popup-Fenster und
 * wird teils blockiert; ein Klick auf einen Link mit target="_blank" ist überall ein Tab.
 */
export function openTab(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function vodUrl(v: ViewVod, at: number) {
  const o = Math.max(0, Math.floor((at - v.vodStart) / 1000) - VOD_LEAD_S);
  return `https://www.twitch.tv/videos/${encodeURIComponent(v.vodId)}?t=${Math.floor(o / 3600)}h${Math.floor((o % 3600) / 60)}m${o % 60}s`;
}

/** Ab dieser Bedeutung steht der Regler anfangs (die wichtigen Ereignisse) */
const IMPORTANT = 0.6;

const LAYERS = [
  { key: "trend", label: "Trend", hint: "Gleitender Median über 25 Min: das eigentliche Niveau ohne kurze Ausschläge" },
  { key: "bumps", label: "Ausschläge", hint: "Kurz über (grün) oder unter (rot) dem Trend, kommt gleich wieder zurück" },
  { key: "shifts", label: "Hypes & Abstürze", hint: "Anhaltende Änderung des Niveaus, deutlich mehr als sonst um diese Zeit und bei diesem Streamalter" },
  { key: "comp", label: "Konkurrenz", hint: "Wie viele andere CraftAttack-Streams gerade live sind (dunkler = mehr)" },
] as const;
type Layer = (typeof LAYERS)[number]["key"];

export function StreamerDayChart({
  points,
  trend,
  noise,
  markers,
  bands,
  competition,
  vods,
  from,
  to,
}: {
  points: [number, number][];
  trend: (number | null)[];
  noise: number;
  markers: ViewMarker[];
  bands: ViewBand[];
  competition: ViewCompetition[];
  vods: ViewVod[];
  from: number;
  to: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [on, setOn] = useState<Record<Layer, boolean>>({ trend: true, bumps: true, shifts: true, comp: false });
  // Ereignisse nach Bedeutung: der Regler zeigt die k wichtigsten (0 = keine, alle = alle)
  const ranked = [...markers].sort((a, b) => b.importance - a.importance);
  const important = ranked.filter((m) => m.importance >= IMPORTANT).length;
  const [k, setK] = useState(() => Math.min(ranked.length, Math.max(Math.min(3, ranked.length), important)));
  const cutoff = k > 0 ? ranked[k - 1].importance : Infinity;
  const shownMarkers = markers.filter((m) => k >= ranked.length || m.importance > cutoff || (m.importance === cutoff && ranked.indexOf(m) < k));
  const W = 900;
  const H = 340;
  const L = 56;
  const R = 12;
  const T = shownMarkers.length ? 44 : 14;
  const STRIP = on.comp ? 16 : 0;
  const B = 28 + STRIP;
  const ticks = niceTicks(Math.max(10, ...points.map((p) => p[1])));
  const yMax = ticks[ticks.length - 1];
  const x = (t: number) => L + ((t - from) / (to - from)) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const gap = (i: number) => i > 0 && points[i][0] - points[i - 1][0] > 15 * 60_000;
  // Linien mit Lücken (Stream aus oder Tracker-Ausfall)
  const lineOf = (vals: (number | null)[]) => {
    const segs: string[] = [];
    let cur: string[] = [];
    vals.forEach((v, i) => {
      if (v === null || gap(i)) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
      }
      if (v !== null) cur.push(`${x(points[i][0]).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length > 1) segs.push(cur.join(" "));
    return segs;
  };
  const actual = lineOf(points.map((p) => p[1]));
  const trendSegs = lineOf(trend);
  // Ausschläge: Flächen zwischen Verlauf und Trend, wo die Abweichung über dem Rauschen liegt
  const bumps: { d: string; up: boolean }[] = [];
  if (on.bumps) {
    let run: number[] = [];
    let up = false;
    const flush = () => {
      if (run.length >= 2) {
        const top = run.map((i) => `${x(points[i][0]).toFixed(1)},${y(points[i][1]).toFixed(1)}`);
        const bottom = [...run].reverse().map((i) => `${x(points[i][0]).toFixed(1)},${y(trend[i]!).toFixed(1)}`);
        bumps.push({ d: `M${top.join("L")}L${bottom.join("L")}Z`, up });
      }
      run = [];
    };
    points.forEach(([, v], i) => {
      const tr = trend[i];
      if (tr === null || gap(i)) {
        flush();
        return;
      }
      const thr = Math.max(3 * noise, 0.04 * tr, 15);
      const dev = v - tr;
      if (Math.abs(dev) > thr) {
        if (run.length && dev > 0 !== up) flush();
        up = dev > 0;
        run.push(i);
      } else flush();
    });
    flush();
  }
  const maxN = Math.max(1, ...competition.map((c) => c.n));

  const timeAt = (clientX: number) => {
    if (!ref.current) return null;
    const px = svgX(ref.current, clientX, W);
    return from + ((px - L) / (W - L - R)) * (to - from);
  };
  const nearestIdx = (t: number) => {
    let best = -1;
    for (let i = 0; i < points.length; i++) if (best < 0 || Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
    return best >= 0 && Math.abs(points[best][0] - t) <= 10 * 60_000 ? best : -1;
  };
  const vodFor = (t: number) => vods.filter((v) => t >= v.from && t <= v.to).sort((p, q) => q.to - q.from - (p.to - p.from))[0] ?? null;
  const ht = hover;
  const hi = ht !== null ? nearestIdx(ht) : -1;
  const hm = ht !== null ? shownMarkers.filter((m) => Math.abs(m.at - ht) <= 6 * 60_000) : [];
  const hb = ht !== null && on.shifts ? bands.find((b) => ht >= b.from && ht <= b.to) : undefined;
  const hc = ht !== null && on.comp ? competition.find((c) => ht >= c.at && ht < c.at + 5 * 60_000) : undefined;
  const hv = ht !== null ? vodFor(ht) : null;
  const spanH = (to - from) / 3_600_000;
  const stepH = spanH <= 8 ? 1 : spanH <= 16 ? 2 : 3;
  const hourTicks: number[] = [];
  for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t <= to; t += 3_600_000) if (hourOf(t) % stepH === 0) hourTicks.push(t);
  // Köpfe nah beieinander übereinander staffeln
  const lane: number[] = [];
  shownMarkers.forEach((m, i) => {
    let l = 0;
    for (let j = 0; j < i; j++) if (Math.abs(x(shownMarkers[j].at) - x(m.at)) < 18 && lane[j] === l) l++;
    lane.push(Math.min(l, 1));
  });

  return (
    <div className="mig__chart">
      <div className="vf__controls">
        <div className="gb__seg vf__layers" role="group" aria-label="Anzeigen">
          {LAYERS.map((l) => (
            <button key={l.key} type="button" aria-pressed={on[l.key]} title={l.hint} onClick={() => setOn((o) => ({ ...o, [l.key]: !o[l.key] }))}>
              {l.label}
            </button>
          ))}
        </div>
        {ranked.length > 0 && (
          <label className="vf__evslider" title="Ereignisse nach Bedeutung für den Verlauf: eigener Start und Ende, große Raids und Wanderungen zuerst, Titelwechsel zuletzt. Klick auf einen Kopf öffnet dessen Tag">
            <span className="vf__evlabel">
              Ereignisse <b className="num">{k === 0 ? "keine" : k >= ranked.length ? `alle ${ranked.length}` : `${k} wichtigste von ${ranked.length}`}</b>
            </span>
            <span className="vf__evrange">
              <span className="muted">keine</span>
              <input type="range" min={0} max={ranked.length} step={1} value={k} onChange={(e) => setK(Number(e.target.value))} aria-label="Wie viele Ereignisse, nach Bedeutung" />
              <span className="muted">alle</span>
            </span>
          </label>
        )}
      </div>
      <div className="mig__plot">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Zuschauerverlauf mit Trend, Ausschlägen und Ereignissen; Klick öffnet das VOD an dieser Stelle"
          className={hv ? "mig__clickable" : undefined}
          onPointerMove={(e) => setHover(timeAt(e.clientX))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            if ((e.target as Element).closest("a")) return;
            const t = timeAt(e.clientX);
            const v = t !== null ? vodFor(t) : null;
            if (t !== null && v) openTab(vodUrl(v, t));
          }}
        >
          {on.shifts &&
            bands.map((b) => (
              <g key={`${b.from}-${b.kind}`}>
                <rect x={x(b.from)} y={T} width={Math.max(3, x(b.to) - x(b.from))} height={H - T - B} className={b.kind === "dip" ? "mig__bd-dip" : "mig__bd-hype"} />
                <text x={x(b.from) + 4} y={T + 14} className={`vf__bandlabel vf__bandlabel--${b.kind}`}>
                  {b.kind === "dip" ? "▼ Absturz" : "▲ Hype"}
                </text>
              </g>
            ))}
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="mig__grid" />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="mig__tick">
                {short(v)}
              </text>
            </g>
          ))}
          {hourTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="mig__tick">
              {hourOf(t)} Uhr
            </text>
          ))}
          {on.comp &&
            competition.map((c) => (
              <rect key={c.at} x={x(c.at)} y={H - B + 6} width={Math.max(1, x(c.at + 5 * 60_000) - x(c.at))} height={STRIP - 6} className="vf__comp" opacity={0.1 + (0.9 * c.n) / maxN} />
            ))}
          {bumps.map((b, i) => (
            <path key={i} d={b.d} className={b.up ? "vf__bump-up" : "vf__bump-down"} />
          ))}
          {actual.map((d, i) => (
            <polyline key={i} points={d} className={`mig__line mig__l1${on.trend ? " vf__raw" : ""}`} />
          ))}
          {on.trend && trendSegs.map((d, i) => <polyline key={i} points={d} className="vf__trend" />)}
          {shownMarkers.length > 0 &&
            shownMarkers.map((m, i) => {
              const cx = x(m.at);
              const top = 4 + lane[i] * 20;
              return (
                <g key={`${m.at}-${i}`} className={`mig__mk mig__mk-${m.tone}`}>
                  <line x1={cx} x2={cx} y1={top + 18} y2={H - B} />
                  {m.other ? (
                    <a href={m.other.href} aria-label={`${m.label}: ${m.other.name} an diesem Tag ansehen`}>
                      <title>{`${m.label} · Klick: ${m.other.name} an diesem Tag`}</title>
                      <rect x={cx - 9} y={top - 1} width={18} height={18} className="vf__headbox" />
                      <image href={headUrl(m.other.uuid, 32, m.other.id)} x={cx - 8} y={top} width={16} height={16} style={{ imageRendering: "pixelated" }} />
                      <text x={cx + 11} y={top + 12} className="vf__icon">
                        {m.icon}
                      </text>
                    </a>
                  ) : (
                    <g>
                      <title>{m.label}</title>
                      <circle cx={cx} cy={top + 8} r={8} className="vf__iconbg" />
                      <text x={cx} y={top + 12} textAnchor="middle" className="vf__icon">
                        {m.icon}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          {ht !== null && ht >= from && ht <= to && <line x1={x(ht)} x2={x(ht)} y1={T} y2={H - B} className="mig__cross" />}
          {hi >= 0 && <circle cx={x(points[hi][0])} cy={y(points[hi][1])} r={4.5} className="mig__dot mig__l1" />}
        </svg>
        {ht !== null && ht >= from && ht <= to && (
          <div className="mig__tip" style={{ left: `${(x(ht) / W) * 100}%` }} role="status">
            <b>
              {timeFmt.format(ht)}
              {hi >= 0 ? ` · ${nf.format(points[hi][1])} Zuschauer` : " · offline"}
            </b>
            {hi >= 0 && on.trend && trend[hi] !== null && <span className="muted">Trend {nf.format(trend[hi]!)}</span>}
            {hm.map((m, i) => (
              <span key={i}>
                <i className={`mig__mk-${m.tone}`} aria-hidden="true" /> {m.icon} {timeFmt.format(m.at)} {m.label}
              </span>
            ))}
            {hb && (
              <span>
                {hb.label}
                {hb.reasons.length ? ` · ${hb.reasons.join(" · ")}` : " · ungeklärt, vermutlich der Stream selbst"}
              </span>
            )}
            {hc && <span className="muted">{hc.n} andere CraftAttack-Streams live ({nf.format(hc.viewers)} Zuschauer)</span>}
            {hv && <span className="muted">Klick: VOD ab {timeFmt.format(Math.max(hv.vodStart, ht - VOD_LEAD_S * 1000))}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Staffel eines Streamers: Ø Zuschauer je Tag und das ganze CraftAttack, beide in % der ersten drei Tage */
export function SeasonChart({
  days,
  label,
  hrefPrefix,
}: {
  days: { day: string; avg: number; market: number; outlier: "hype" | "dip" | null; reasons: string[]; share: number; others: number }[];
  label: string;
  /** Link zu einem Tag: Präfix + "YYYY-MM-DD" */
  hrefPrefix: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 900;
  const H = 260;
  const L = 48;
  const R = 12;
  const T = 14;
  const B = 26;
  const base = (f: (d: (typeof days)[number]) => number) => {
    const l = days.slice(0, 3).map(f).filter((v) => v > 0);
    return l.length ? l.reduce((a, b) => a + b, 0) / l.length : 1;
  };
  const own0 = base((d) => d.avg);
  const mk0 = base((d) => d.market);
  const own = days.map((d) => d.avg / own0);
  const mk = days.map((d) => (d.market > 0 ? d.market / mk0 : null));
  const yMax = Math.max(1.2, ...own, ...mk.filter((v): v is number => v !== null)) * 1.05;
  const n = Math.max(1, days.length - 1);
  const x = (i: number) => L + (i / n) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const line = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
  const dayLbl = (d: string) => dayShortFmt.format(Date.parse(`${d}T12:00:00Z`));
  const hd = hover !== null ? days[hover] : null;
  return (
    <div className="mig__chart">
      <ul className="mig__keys" aria-label="Legende">
        <li>
          <i className="mig__c1" aria-hidden="true" /> {label} (Ø je Tag)
        </li>
        <li>
          <i className="mig__c0" aria-hidden="true" /> ganzes CraftAttack (abends)
        </li>
        <li>
          <i className="mig__bd-hype" aria-hidden="true" /> besser als sonst
        </li>
        <li>
          <i className="mig__bd-dip" aria-hidden="true" /> schwächer als sonst
        </li>
      </ul>
      <div className="mig__plot">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Zuschauer je Tag im Vergleich zum ganzen CraftAttack" onPointerLeave={() => setHover(null)}>
          {[0, 0.5, 1, 1.5, 2].filter((v) => v <= yMax).map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 1 ? "mig__ref" : "mig__grid"} />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="mig__tick">
                {pctFmt.format(v * 100)} %
              </text>
            </g>
          ))}
          {days.map((d, i) =>
            i % Math.ceil(days.length / 8) === 0 ? (
              <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" className="mig__tick">
                {dayLbl(d.day)}
              </text>
            ) : null,
          )}
          <polyline points={line(mk)} className="mig__line mig__c0line" />
          <polyline points={line(own)} className="mig__line mig__l1" />
          {days.map((d, i) => (
            <a key={d.day} href={hrefPrefix + d.day} onPointerEnter={() => setHover(i)} aria-label={`${dayLbl(d.day)} ansehen`}>
              <rect x={x(i) - (W - L - R) / n / 2} y={T} width={(W - L - R) / n} height={H - T - B} fill="transparent" />
              <circle cx={x(i)} cy={y(own[i])} r={d.outlier ? 6 : 3} className={d.outlier === "hype" ? "vf__dot-hype" : d.outlier === "dip" ? "vf__dot-dip" : "mig__c1"} />
            </a>
          ))}
        </svg>
        {hd && hover !== null && (
          <div className="mig__tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
            <b>
              {dayLbl(hd.day)}: Ø {nf.format(hd.avg)} Zuschauer
            </b>
            <span>
              {pctFmt.format(hd.share * 100)} % des CraftAttack-Publikums · {hd.others.toLocaleString("de-DE")} andere live
            </span>
            {hd.outlier && <span>{hd.outlier === "hype" ? "Besser als an den Tagen davor und danach" : "Schwächer als an den Tagen davor und danach"}{hd.reasons.length ? `: ${hd.reasons.join(" · ")}` : ""}</span>}
            <span className="muted">Klick: diesen Tag ansehen</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Raid-Bindung */

const pctFmt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export function RetentionChart({ curve }: { curve: { m: number; median: number; p25: number; p75: number; n: number }[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 900;
  const H = 280;
  const L = 52;
  const R = 12;
  const T = 12;
  const B = 28;
  const maxM = curve.length - 1;
  const yMax = Math.max(1, Math.ceil(Math.max(...curve.map((c) => c.p75)) * 5) / 5);
  const yMin = Math.min(0, Math.floor(Math.min(...curve.map((c) => c.p25)) * 5) / 5);
  const x = (m: number) => L + (m / maxM) * (W - L - R);
  const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += 0.2) ticks.push(Math.round(v * 10) / 10);
  const band = `M${curve.map((c) => `${x(c.m).toFixed(1)},${y(c.p75).toFixed(1)}`).join("L")}L${[...curve]
    .reverse()
    .map((c) => `${x(c.m).toFixed(1)},${y(c.p25).toFixed(1)}`)
    .join("L")}Z`;
  const line = curve.map((c) => `${x(c.m).toFixed(1)},${y(c.median).toFixed(1)}`).join(" ");
  const hc = hover !== null ? curve[hover] : null;
  return (
    <div className="mig__chart">
      <ul className="mig__keys" aria-label="Legende">
        <li>
          <i className="mig__c1" aria-hidden="true" /> Median aller Raids
        </li>
        <li>
          <i className="mig__band-key" aria-hidden="true" /> mittlere Hälfte (25–75 %)
        </li>
      </ul>
      <div className="mig__plot">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Anteil der Raid-Zuschauer, die nach 0 bis 60 Minuten noch da sind"
          onPointerMove={(e) => {
            if (!ref.current) return;
            const px = svgX(ref.current, e.clientX, W);
            setHover(Math.max(0, Math.min(maxM, Math.round(((px - L) / (W - L - R)) * maxM))));
          }}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 || v === 1 ? "mig__ref" : "mig__grid"} />
              <text x={L - 6} y={y(v) + 4} textAnchor="end" className="mig__tick">
                {pctFmt.format(v * 100)} %
              </text>
            </g>
          ))}
          {[0, 10, 20, 30, 40, 50, 60]
            .filter((m) => m <= maxM)
            .map((m) => (
              <text key={m} x={x(m)} y={H - 8} textAnchor="middle" className="mig__tick">
                {m === 0 ? "Raid" : `+${m} Min`}
              </text>
            ))}
          <path d={band} className="mig__iqr" />
          <polyline points={line} className="mig__line mig__l1" />
          {hc && (
            <>
              <line x1={x(hc.m)} x2={x(hc.m)} y1={T} y2={H - B} className="mig__cross" />
              <circle cx={x(hc.m)} cy={y(hc.median)} r={4.5} className="mig__dot mig__l1" />
            </>
          )}
        </svg>
        {hc && (
          <div className="mig__tip" style={{ left: `${(x(hc.m) / W) * 100}%` }} role="status">
            <b>
              {hc.m === 0 ? "Beim Raid" : `${hc.m} Min nach dem Raid`}: {pctFmt.format(hc.median * 100)} % noch da
            </b>
            <span>
              mittlere Hälfte: {pctFmt.format(hc.p25 * 100)}–{pctFmt.format(hc.p75 * 100)} %
            </span>
            <span className="muted">{hc.n} Raids</span>
          </div>
        )}
      </div>
    </div>
  );
}

