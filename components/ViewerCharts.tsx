"use client";

import { useRef, useState } from "react";

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

/* ------------------------------------------------------------------ Spielerverlauf */

export interface ViewMarker {
  at: number;
  /** loss = kostete Zuschauer, gain = brachte Zuschauer, own = eigenes/neutrales Ereignis */
  tone: "loss" | "gain" | "own";
  /** kurzer Text für Tooltip und Tabelle */
  label: string;
}

export interface ViewBand {
  from: number;
  to: number;
  kind: "dip" | "hype";
  label: string;
}

export interface ViewVod {
  from: number;
  to: number;
  vodId: string;
  vodStart: number;
}

/** Ab hier im VOD einsteigen: etwas vor dem geklickten Zeitpunkt */
const VOD_LEAD_S = 30;

/**
 * Als normalen neuen Tab öffnen: `window.open` mit Fenster-Optionen (z. B. "noopener") öffnet ein Popup-Fenster und
 * wird teils blockiert; ein Klick auf einen Link mit target="_blank" ist überall ein Tab.
 */
function openTab(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function vodUrl(v: ViewVod, at: number) {
  const o = Math.max(0, Math.floor((at - v.vodStart) / 1000) - VOD_LEAD_S);
  return `https://www.twitch.tv/videos/${encodeURIComponent(v.vodId)}?t=${Math.floor(o / 3600)}h${Math.floor((o % 3600) / 60)}m${o % 60}s`;
}

export function PlayerViewerChart({
  points,
  markers,
  bands,
  vods,
  from,
  to,
}: {
  points: [number, number][];
  markers: ViewMarker[];
  bands: ViewBand[];
  vods: ViewVod[];
  from: number;
  to: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 900;
  const H = 300;
  const L = 56;
  const R = 12;
  const T = 22;
  const B = 28;
  const ticks = niceTicks(Math.max(10, ...points.map((p) => p[1])));
  const yMax = ticks[ticks.length - 1];
  const x = (t: number) => L + ((t - from) / (to - from)) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  // Linie mit Lücken, wo keine Daten sind (Stream aus oder Tracker-Ausfall)
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach(([t, v], i) => {
    if (i > 0 && t - points[i - 1][0] > 15 * 60_000) {
      if (cur.length) segs.push(cur.join(" "));
      cur = [];
    }
    cur.push(`${x(t).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur.join(" "));

  const timeAt = (clientX: number) => {
    if (!ref.current) return null;
    const px = svgX(ref.current, clientX, W);
    return from + ((px - L) / (W - L - R)) * (to - from);
  };
  const nearest = (t: number) => {
    let best: [number, number] | null = null;
    for (const p of points) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best && Math.abs(best[0] - t) <= 10 * 60_000 ? best : null;
  };
  // VOD, das den Zeitpunkt abdeckt; überlappen mehrere (Mini-VODs an 48-h-Grenzen), das längste
  const vodFor = (t: number) =>
    vods.filter((v) => t >= v.from && t <= v.to).sort((x, y) => y.to - y.from - (x.to - x.from))[0] ?? null;
  const ht = hover;
  const hp = ht !== null ? nearest(ht) : null;
  const hm = ht !== null ? markers.filter((m) => Math.abs(m.at - ht) <= 6 * 60_000) : [];
  const hb = ht !== null ? bands.find((b) => ht >= b.from && ht <= b.to) : undefined;
  const hv = ht !== null ? vodFor(ht) : null;
  // Volle Stunden (Berlin hat ganze Stunden Versatz zu UTC); Schritt nach Spannweite
  const spanH = (to - from) / 3_600_000;
  const stepH = spanH <= 8 ? 1 : spanH <= 16 ? 2 : 3;
  const hourTicks: number[] = [];
  for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t <= to; t += 3_600_000) {
    if (hourOf(t) % stepH === 0) hourTicks.push(t);
  }

  return (
    <div className="mig__chart">
      <ul className="mig__keys" aria-label="Legende">
        <li>
          <i className="mig__c1" aria-hidden="true" /> Zuschauer
        </li>
        <li>
          <i className="mig__mk-loss" aria-hidden="true" /> kostete Zuschauer
        </li>
        <li>
          <i className="mig__mk-gain" aria-hidden="true" /> brachte Zuschauer
        </li>
        <li>
          <i className="mig__mk-own" aria-hidden="true" /> eigenes Ereignis
        </li>
        <li>
          <i className="mig__bd-dip" aria-hidden="true" /> ungeklärter Einbruch
        </li>
        <li>
          <i className="mig__bd-hype" aria-hidden="true" /> ungeklärter Anstieg
        </li>
      </ul>
      <div className="mig__plot">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Zuschauerverlauf mit Ereignissen; Klick öffnet das VOD an dieser Stelle"
          className={hv ? "mig__clickable" : undefined}
          onPointerMove={(e) => setHover(timeAt(e.clientX))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const t = timeAt(e.clientX);
            const v = t !== null ? vodFor(t) : null;
            if (t !== null && v) openTab(vodUrl(v, t));
          }}
        >
          {bands.map((b) => (
            <rect key={`${b.from}-${b.kind}`} x={x(b.from)} y={T} width={Math.max(3, x(b.to) - x(b.from))} height={H - T - B} className={b.kind === "dip" ? "mig__bd-dip" : "mig__bd-hype"} />
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
          {markers.map((m, i) => (
            <g key={`${m.at}-${i}`} className={`mig__mk mig__mk-${m.tone}`}>
              <line x1={x(m.at)} x2={x(m.at)} y1={T - 6} y2={H - B} />
              <circle cx={x(m.at)} cy={T - 10} r={4} />
            </g>
          ))}
          {segs.map((d, i) => (
            <polyline key={i} points={d} className="mig__line mig__l1" />
          ))}
          {ht !== null && ht >= from && ht <= to && <line x1={x(ht)} x2={x(ht)} y1={T} y2={H - B} className="mig__cross" />}
          {hp && <circle cx={x(hp[0])} cy={y(hp[1])} r={4.5} className="mig__dot mig__l1" />}
        </svg>
        {ht !== null && ht >= from && ht <= to && (
          <div className="mig__tip" style={{ left: `${(x(ht) / W) * 100}%` }} role="status">
            <b>
              {timeFmt.format(ht)}
              {hp ? ` · ${nf.format(hp[1])} Zuschauer` : " · offline"}
            </b>
            {hm.map((m, i) => (
              <span key={i}>
                <i className={`mig__mk-${m.tone}`} aria-hidden="true" /> {timeFmt.format(m.at)} {m.label}
              </span>
            ))}
            {hb && <span>{hb.label}</span>}
            {hv && <span className="muted">Klick: VOD ab {timeFmt.format(Math.max(hv.vodStart, ht - VOD_LEAD_S * 1000))}</span>}
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

