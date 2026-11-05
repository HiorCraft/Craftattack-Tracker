"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DayProfileChart, daysBetween, type DayLine } from "./DayProfileChart";
import { EstimateRects, EstimateTip, useEstimateGaps } from "./Estimates";
import { BASE_PATH } from "@/lib/estimateMode";
import { fuzzyFilter } from "@/lib/fuzzy";
import {
  COLORS,
  MAX_METRICS,
  METRICS,
  METRIC_KEYS,
  RANGES,
  RANK_KEYS,
  RASTER,
  itemMetric,
  metaOf,
  parseItemMetric,
  rankMetric,
  rankOfMetric,
  toSearch,
  valueOfRank,
  type GraphQuery,
  DAY_MODES,
  DAY_SPREADS,
  WEEKDAYS,
  type ItemOptions,
  type Metric,
  type MetricMeta,
  type PlayerOption,
} from "@/lib/graphQuery";
import { LEADERBOARDS, type TopCategory } from "@/lib/leaderboards";
import { STAT_GROUPS } from "@/lib/playerStats";
import { PlayerMulti } from "./PlayerSearch";
import { GraphExplain, type ExplainTarget } from "./GraphExplain";
import { ItemPicker } from "./ItemPicker";

/** Reiter der Kennzahl-Auswahl: Server, die Spieler-Rubriken, Ränge und einzelne Blöcke/Mobs */
const PICKER_TABS = [{ key: "server", label: "Server" }, ...STAT_GROUPS, { key: "rang", label: "Ränge" }, { key: "einzeln", label: "Einzeln" }] as const;
type PickerTab = (typeof PICKER_TABS)[number]["key"];

/** `datetime-local`-Wert (lokale Zeit des Browsers) → Millisekunden */
const localMs = (s: string) => (s ? Date.parse(s) : NaN);
/** Millisekunden → `datetime-local`-Wert in lokaler Zeit (minutengenau) */
/** Jetzt (nur in Klick-Handlern aufrufen, nicht beim Rendern) */
const nowMs = () => Date.now();
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/**
 * Raster für die Abfrage: Im Tagesverlauf braucht ein Tag genug Abschnitte, „Auto“ wählt dort 15 Min
 * (bei „Alles“ 1 Std), statt bei langen Zeiträumen auf Stunden oder Tage zu vergröbern.
 */
function effectiveRaster(q: Pick<GraphQuery, "zeit" | "raster" | "ansicht">) {
  if (q.ansicht !== "tag" || q.raster !== "auto") return q.raster;
  return q.zeit === "alle" ? "60" : "15";
}

/** Zeitraum-Parameter der API aus der Auswahl */
function rangeParams(q: Pick<GraphQuery, "zeit" | "von" | "bis" | "raster" | "ansicht">, now: number, p: URLSearchParams) {
  const r = RANGES.find((x) => x.key === q.zeit);
  if (q.zeit === "eigen") {
    const a = localMs(q.von);
    const b = localMs(q.bis);
    if (Number.isFinite(a)) p.set("von", String(a));
    if (Number.isFinite(b)) p.set("bis", String(b));
  } else if (r?.ms) {
    // Auf die Minute gerundet: Gleiche Auswahl ergibt dieselbe URL, der Server-Cache kann sie für alle Besucher teilen
    p.set("von", String(Math.floor((now - r.ms) / 60_000) * 60_000));
  }
  const raster = effectiveRaster(q);
  if (raster !== "auto") p.set("raster", raster);
}

function apiUrl(q: GraphQuery, metric: Metric, players: string[], now: number) {
  const p = new URLSearchParams();
  p.set("metric", metric);
  if (players.length) p.set("spieler", players.join(","));
  rangeParams(q, now, p);
  return `${BASE_PATH}/api/series?${p}`;
}

/** So lange gilt eine geladene Zeitreihe als frisch; danach wird sie bei der nächsten Änderung neu geholt */
const CACHE_TTL_MS = 2 * 60_000;

/** Geladene Linien eines Teils (eine Kennzahl für einen Spieler bzw. für Summe/beste fünf) */
interface CacheEntry {
  lines: ApiLine[];
  bucketMinutes: number;
  at: number;
}

/** Zeitraum im Cache-Schlüssel: relative Zeiträume über ihren Namen, damit „24 Std“ nicht ständig neu lädt */
const rangeKey = (q: GraphQuery) => [q.zeit === "eigen" ? `${q.von}~${q.bis}` : q.zeit, effectiveRaster(q)].join(":");

/**
 * Datenteile einer Auswahl: je Kennzahl ein Teil pro gewähltem Spieler, sonst einer für Summe bzw. beste fünf.
 * Einheit/% und Stand/Zuwachs gehören nicht dazu – sie ändern nur die Darstellung.
 */
function partsOf(q: GraphQuery, meta: (m: Metric) => MetricMeta): { metric: Metric; player: string | null; key: string }[] {
  const range = rangeKey(q);
  return q.metrics.flatMap((metric): { metric: Metric; player: string | null; key: string }[] =>
    meta(metric).perPlayer && q.spieler.length
      ? q.spieler.map((player) => ({ metric, player, key: `${metric}@${player}@${range}` }))
      : [{ metric, player: null, key: `${metric}@*@${range}` }],
  );
}

/** Zuwachs je Bündel aus dem Stand (wie der Server: Differenz zum vorigen Punkt, nie negativ) */
function toDelta(points: { at: string; v: number }[]) {
  return points.slice(1).map((p, i) => ({ at: p.at, v: Math.max(0, p.v - points[i].v) }));
}

function suggestionsUrl(q: GraphQuery, metric: Metric, now: number) {
  const p = new URLSearchParams();
  p.set("metric", metric);
  rangeParams(q, now, p);
  if (q.modus === "zuwachs" && metaOf(metric).counter) p.set("modus", "zuwachs");
  return `${BASE_PATH}/api/series/suggestions?${p}`;
}

interface ApiLine {
  id: string;
  name: string;
  points: { at: string; v: number }[];
}

/** Eine gezeichnete Linie: Kennzahl × Spieler (bzw. Server/Alle) */
interface Line extends ApiLine {
  metric: Metric;
  meta: MetricMeta;
  /** Zeigt Zuwachs je Bündel statt Stand */
  delta?: boolean;
  color: string;
  format: (v: number) => string;
}

/* ---------- Chart ---------- */

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const df = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" });
const dtf = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

/**
 * Weiche Kurve durch alle Punkte (monotone kubische Interpolation wie d3 curveMonotoneX):
 * schwingt nicht über, bleibt also bei Zählern immer zwischen den echten Werten.
 */
function smoothPath(pts: (readonly [number, number])[]) {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-9, xs[i + 1] - xs[i]));
    m.push((ys[i + 1] - ys[i]) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t.push(0);
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t.push((w1 + w2) / (w1 / m[i - 1] + w2 / m[i]));
    }
  }
  t.push(m[n - 2]);
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(xs[i] + h).toFixed(1)},${(ys[i] + t[i] * h).toFixed(1)} ${(xs[i + 1] - h).toFixed(1)},${(ys[i + 1] - t[i + 1] * h).toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
  }
  return d;
}

/**
 * Teilt eine Linie an Datenlücken (z. B. Tracker aus): Abstand über dem Dreifachen des üblichen Abstands,
 * mindestens 15 Min. Dort bleibt der Graph leer, statt eine Schräge über die fehlende Zeit zu ziehen.
 */
function splitAtGaps<T extends { at: string }>(points: T[]): T[][] {
  if (points.length < 3) return [points];
  const steps = points.slice(1).map((p, i) => Date.parse(p.at) - Date.parse(points[i].at)).sort((a, b) => a - b);
  const limit = Math.max(15 * 60_000, steps[Math.floor(steps.length / 2)] * 3);
  const parts: T[][] = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    if (Date.parse(points[i].at) - Date.parse(points[i - 1].at) > limit) parts.push([]);
    parts[parts.length - 1].push(points[i]);
  }
  return parts;
}

/**
 * Zähler ändern sich nur, während ein Spieler auf dem Server ist; offline gibt es keine Messpunkte, der Wert steht
 * aber weiter auf dem Stand des letzten Logins. Statt einer Lücke läuft die Linie deshalb waagerecht weiter
 * („hold“) bzw. im Zuwachs-Modus auf 0 („zero“), bis der nächste Messpunkt kommt.
 */
function bridgeGaps<T extends { at: string; v: number }>(points: T[], mode: "hold" | "zero"): { at: string; v: number }[] {
  const parts = splitAtGaps(points);
  if (parts.length < 2) return points;
  const steps = points.slice(1).map((p, i) => Date.parse(p.at) - Date.parse(points[i].at)).sort((a, b) => a - b);
  const step = Math.max(60_000, steps[Math.floor(steps.length / 2)] ?? 60_000);
  const out: { at: string; v: number }[] = [...parts[0]];
  for (const part of parts.slice(1)) {
    const prev = out[out.length - 1];
    const next = part[0];
    const a = Date.parse(prev.at);
    const b = Date.parse(next.at);
    if (mode === "zero") {
      out.push({ at: new Date(Math.min(a + step, b - 1)).toISOString(), v: 0 });
      out.push({ at: new Date(Math.max(b - step, a + 1)).toISOString(), v: 0 });
    } else {
      out.push({ at: new Date(Math.max(b - step, a + 1)).toISOString(), v: prev.v });
    }
    out.push(...part);
  }
  return out;
}

/** „Schöne“ Achsenschritte */
function niceStep(max: number, ticks: number) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}


/**
 * Mehrere Linien in einem Chart. Haben alle Kennzahlen dieselbe Einheit (z. B. Blöcke), gibt es eine echte
 * Y-Achse in dieser Einheit; Ränge stehen dabei umgedreht (Platz 1 oben). Bei verschiedenen Einheiten oder auf
 * Wunsch (`percent`) wird jede Kennzahl auf ihr eigenes Maximum skaliert (0–100 %). Echte Werte zeigen Tooltip und Legende.
 */
function MultiChart({
  lines,
  hidden,
  dataKey,
  percent,
  onZoom,
  onPick,
  selected = null,
  onSelect,
  step = 60_000,
}: {
  lines: Line[];
  hidden: Set<string>;
  dataKey: string;
  percent: boolean;
  /** Ziehen im Graphen wählt einen Zeitraum (ms) */
  onZoom?: (from: number, to: number) => void;
  /** Rechtsklick (Touch: lange drücken): diese Stelle erklären */
  onPick?: (at: number) => void;
  /** Gerade erklärter Zeitraum (als Band markiert, an den Rändern mit Griffen verstellbar) */
  selected?: { from: number; to: number } | null;
  /** Band über die Griffe verändert (beim Loslassen) */
  onSelect?: (from: number, to: number) => void;
  /** Raster der Griffe (ein Bündel des Graphen, ms) */
  step?: number;
}) {
  const W = 1000;
  const H = 300;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null); // Zeitpunkt (ms)
  /** Laufende Auswahl beim Ziehen (Zeitpunkte in ms) */
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);
  /** Griff des Bands wird gezogen: Vorschau, übernommen beim Loslassen */
  const [resize, setResize] = useState<{ edge: "from" | "to"; from: number; to: number } | null>(null);
  /** Touch: lange drücken erklärt (kein Rechtsklick auf dem Handy) */
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; fired: boolean } | null>(null);
  const zones = useEstimateGaps();

  const visible = lines.filter((l) => !hidden.has(l.id) && l.points.length > 0);
  const all = visible.flatMap((l) => l.points);
  if (all.length === 0) return <p className="chart__empty">Keine Daten für diese Auswahl.</p>;

  const units = new Set(visible.map((l) => l.meta.unit));
  const normalized = percent || units.size > 1;
  const invert = !normalized && visible.every((l) => l.meta.invert);

  const t0 = Math.min(...all.map((p) => Date.parse(p.at)));
  const t1 = Math.max(...all.map((p) => Date.parse(p.at)));
  const span = Math.max(1, t1 - t0);

  // Maximum je Kennzahl (für die Prozent-Skalierung) bzw. gesamt (für die Achse)
  const maxOf = new Map<Metric, number>();
  for (const l of visible) maxOf.set(l.metric, Math.max(maxOf.get(l.metric) ?? 0, ...l.points.map((p) => p.v)));
  const vmax = Math.max(...maxOf.values());
  // Rang-Achse: Platz 1 oben, ganzzahlige Schritte
  const ystep = normalized ? 25 : invert ? Math.max(1, Math.round(niceStep(Math.max(vmax - 1, 1), 4))) : niceStep(Math.max(vmax, 1), 4);
  const ymax = normalized ? 100 : invert ? 1 + Math.max(ystep, Math.ceil((vmax - 1) / ystep) * ystep) : Math.max(ystep, Math.ceil(vmax / ystep) * ystep);
  const ymin = invert ? 1 : 0;
  const x = (t: number) => ((t - t0) / span) * W;
  const scaled = (l: Line, v: number) => {
    if (!normalized) return v;
    const max = Math.max(1e-9, maxOf.get(l.metric) ?? 1);
    // Rang in Prozent: bester Platz = 100 %
    return l.meta.invert ? (1 - (v - 1) / Math.max(1, max - 1)) * 100 : (v / max) * 100;
  };
  const yOf = (v: number) => (invert ? ((v - ymin) / (ymax - ymin)) * H : H - ((v - ymin) / (ymax - ymin)) * H);
  const y = (l: Line, v: number) => yOf(scaled(l, v));

  const paths = lines
    .filter((l) => l.points.length > 0)
    .map((l) => {
      const parts = l.meta.counter ? [bridgeGaps(l.points, l.delta ? "zero" : "hold")] : splitAtGaps(l.points);
      const d = parts.map((part) => smoothPath(part.map((p) => [x(Date.parse(p.at)), y(l, p.v)] as const))).join(" ");
      return { id: l.id, d, color: l.color, off: hidden.has(l.id) };
    });

  const yTicks: number[] = [];
  for (let v = ymin; v <= ymax + 1e-9; v += ystep) yTicks.push(v);
  const axisFormat = normalized ? (v: number) => `${Math.round(v)} %` : visible[0].format;
  const xTicks = 6;
  const multiDay = span > 36e5 * 20;
  const xLabel = (t: number) => (multiDay ? `${df.format(t)} ${tf.format(t)}` : tf.format(t));

  const timeAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return t0 + (Math.min(rect.width, Math.max(0, clientX - rect.left)) / rect.width) * span;
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const t = timeAt(e.clientX);
    if (t === null) return;
    setHover(t);
    if (press.current && Math.abs(e.clientX - press.current.x) > 8) cancelPress();
    if (drag) setDrag({ ...drag, b: t });
  };
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const t = timeAt(e.clientX);
    if (t === null) return;
    if (e.pointerType === "touch" && onPick) {
      const at = t;
      press.current = { x: e.clientX, fired: false, timer: setTimeout(() => {
        if (press.current) press.current.fired = true;
        setDrag(null);
        onPick(at);
      }, 550) };
    }
    if (!onZoom) return;
    ref.current?.setPointerCapture(e.pointerId);
    setDrag({ a: t, b: t });
  };
  const onUp = () => {
    const fired = press.current?.fired;
    cancelPress();
    // Ziehen vergrößert; ein einfacher Klick tut nichts (Erklären per Rechtsklick)
    if (!fired && drag && onZoom && Math.abs(x(drag.b) - x(drag.a)) > 12) onZoom(Math.min(drag.a, drag.b), Math.max(drag.a, drag.b));
    setDrag(null);
  };
  const onContext = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPick) return;
    e.preventDefault();
    const t = timeAt(e.clientX);
    if (t !== null) onPick(t);
  };
  /* Griffe am Band: ziehen verschiebt den Rand im Raster der Bündel, mindestens ein Bündel breit */
  const band = resize ?? selected;
  const snap = (t: number) => Math.round(t / step) * step;
  const onHandleDown = (edge: "from" | "to") => (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!selected || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setResize({ edge, from: selected.from, to: selected.to });
  };
  const onHandleMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!resize) return;
    const t = timeAt(e.clientX);
    if (t === null) return;
    const v = snap(t);
    setResize(resize.edge === "from" ? { ...resize, from: Math.min(v, resize.to - step) } : { ...resize, to: Math.max(v, resize.from + step) });
  };
  const onHandleUp = () => {
    if (resize && onSelect && (resize.from !== selected?.from || resize.to !== selected?.to)) onSelect(resize.from, resize.to);
    setResize(null);
  };
  const handleKey = (edge: "from" | "to") => (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (!selected || !onSelect || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const d = (e.key === "ArrowLeft" ? -1 : 1) * step;
    if (edge === "from") onSelect(Math.min(selected.from + d, selected.to - step), selected.to);
    else onSelect(selected.from, Math.max(selected.to + d, selected.from + step));
  };

  // Werte je Linie zum Hover-Zeitpunkt (nächster Messpunkt)
  const tip =
    hover === null
      ? null
      : visible.map((l) => {
          let best = -1;
          let bestD = Infinity;
          for (let i = 0; i < l.points.length; i++) {
            const d = Math.abs(Date.parse(l.points[i].at) - hover);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          return { line: l, p: best >= 0 ? l.points[best] : null };
        });
  const firstHit = tip?.find((t) => t.p)?.p;
  const tipT = firstHit ? Date.parse(firstHit.at) : hover;
  const tipLeft = tipT === null ? 0 : (tipT - t0) / span;

  return (
    <div className="gb-chart">
      <div className="gb-chart__y" aria-hidden="true" data-invert={invert || undefined}>
        {(invert ? yTicks : [...yTicks].reverse()).map((v) => (
          <span key={`${dataKey}:${v}`} className="gb-chart__ylabel">
            {axisFormat(v)}
          </span>
        ))}
      </div>
      <div className="gb-chart__plot">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="gb-chart__svg"
          role="img"
          aria-label="Graph"
          onPointerMove={onMove}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerCancel={() => (cancelPress(), setDrag(null))}
          onPointerLeave={() => !drag && setHover(null)}
          onContextMenu={onContext}
        >
          <EstimateRects zones={zones} x={x} t0={t0} t1={t1} height={H} />
          {drag && Math.abs(x(drag.b) - x(drag.a)) > 2 && (
            <rect x={x(Math.min(drag.a, drag.b))} y={0} width={Math.abs(x(drag.b) - x(drag.a))} height={H} className="gb-chart__zoom" />
          )}
          {yTicks.map((v) => (
            <line key={v} x1={0} x2={W} y1={yOf(v)} y2={yOf(v)} className="gb-chart__grid" vectorEffect="non-scaling-stroke" />
          ))}
          {/* key = Daten-Identität: bei neuen Daten wird die Gruppe neu eingeblendet (Einzeichnen von links nach rechts) */}
          <g key={dataKey} className="gb-chart__lines">
            {paths.map((p) => (
              <path
                key={p.id}
                d={p.d}
                className="gb-chart__line"
                data-off={p.off || undefined}
                fill="none"
                stroke={p.color}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
          {band && band.to > t0 && band.from < t1 && (
            <g className="gb-chart__sel" aria-hidden="true">
              <rect x={x(Math.max(t0, band.from))} y={0} width={Math.max(3, x(Math.min(t1, band.to)) - x(Math.max(t0, band.from)))} height={H} />
              <line x1={x(Math.max(t0, band.from))} x2={x(Math.max(t0, band.from))} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
              <line x1={x(Math.min(t1, band.to))} x2={x(Math.min(t1, band.to))} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
            </g>
          )}
          {tip && tipT !== null && (
            <>
              <line x1={x(tipT)} x2={x(tipT)} y1={0} y2={H} className="spark__cursor" vectorEffect="non-scaling-stroke" />
              {tip.map(
                (t) =>
                  t.p && <circle key={t.line.id} cx={x(Date.parse(t.p.at))} cy={y(t.line, t.p.v)} r={5} fill={t.line.color} stroke="var(--line)" strokeWidth={2} vectorEffect="non-scaling-stroke" />,
              )}
            </>
          )}
        </svg>
        {band && onSelect && band.to > t0 && band.from < t1 &&
          (["from", "to"] as const).map((edge) => {
            const at = edge === "from" ? Math.max(t0, band.from) : Math.min(t1, band.to);
            return (
              <span
                key={edge}
                className="gb-chart__handle"
                data-edge={edge}
                data-active={resize?.edge === edge || undefined}
                style={{ left: `${(x(at) / W) * 100}%` }}
                role="slider"
                tabIndex={0}
                aria-label={edge === "from" ? "Beginn des erklärten Bereichs" : "Ende des erklärten Bereichs"}
                aria-valuemin={t0}
                aria-valuemax={t1}
                aria-valuenow={at}
                aria-valuetext={dtf.format(at)}
                title="Ziehen: Bereich vergrößern oder verkleinern"
                onPointerDown={onHandleDown(edge)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={() => setResize(null)}
                onKeyDown={handleKey(edge)}
              />
            );
          })}
        {tip && tipT !== null && !resize && (
          <div className="gb-chart__tip" style={{ left: `${tipLeft * 100}%`, transform: `translateX(${tipLeft > 0.7 ? "-100%" : tipLeft < 0.3 ? "0" : "-50%"})` }} role="status">
            <span className="gb-chart__tip-time">{dtf.format(tipT)} Uhr</span>
            <EstimateTip zones={zones} t={tipT} />
            {tip.map((t) => (
              <span key={t.line.id} className="gb-chart__tip-row">
                <i style={{ background: t.line.color }} />
                <span className="gb-chart__tip-name">{t.line.name}</span>
                <span className="num">{t.p ? t.line.format(t.p.v) : "–"}</span>
              </span>
            ))}
          </div>
        )}
        <div className="chart__axis gb-chart__x">
          {Array.from({ length: xTicks + 1 }, (_, i) => (
            <span key={i}>{xLabel(t0 + (span * i) / xTicks)}</span>
          ))}
        </div>
        {normalized && (
          <p className="muted gb-chart__note">
            {units.size > 1 ? "Verschiedene Einheiten: " : ""}jede Kennzahl ist auf ihr eigenes Maximum skaliert (100 %). Echte Werte zeigen Tooltip und Legende.
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------- Auswahl + Laden ---------- */

export function GraphBuilder({ players, initial, items }: { players: PlayerOption[]; initial: GraphQuery; items: ItemOptions }) {
  const [q, setQ] = useState<GraphQuery>(initial);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [picker, setPicker] = useState<PickerTab | null>(null);
  const [metricSearch, setMetricSearch] = useState("");
  const [playerScores, setPlayerScores] = useState<{ key: string; scores: Record<string, number>; error?: string } | null>(null);
  // Geladene Teile (siehe `partsOf`); Darstellung entsteht daraus ohne neue Abfrage
  const [cache, setCache] = useState<Map<string, CacheEntry>>(() => new Map());
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  // Zuletzt vollständig gezeigte Auswahl: bleibt sichtbar, bis die neue komplett geladen ist
  const [shownQ, setShownQ] = useState<GraphQuery | null>(null);
  const inflight = useRef(new Set<string>());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const itemNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const [c, list] of Object.entries(items)) for (const o of list ?? []) m.set(`${c}|${o.key}`, o.name);
    return m;
  }, [items]);
  const meta = useMemo(() => (m: Metric) => metaOf(m, (c, k) => itemNames.get(`${c}|${k}`)), [itemNames]);

  const metas = q.metrics.map(meta);
  const anyPerPlayer = metas.some((m) => m.perPlayer);
  const anyCounter = metas.some((m) => m.counter);
  const multi = q.metrics.length > 1;
  const mixedUnits = new Set(metas.map((m) => m.unit)).size > 1;
  // Sortierung der Spieler-Vorschläge nach einer normalen Kennzahl (Ränge und Einzel-Items haben keine Gesamtwertung)
  const playerMetrics = q.metrics.filter((m): m is keyof typeof METRICS => m in METRICS && METRICS[m as keyof typeof METRICS].perPlayer);
  const rankingMetric = (q.modus === "zuwachs" && playerMetrics.find((m) => METRICS[m].counter)) || playerMetrics[0];
  const rankingKey = rankingMetric ? [rankingMetric, q.zeit, q.von, q.bis, q.raster, q.modus].join(":") : "";
  const currentScores = playerScores?.key === rankingKey && !playerScores.error ? playerScores.scores : null;

  // Reihenfolge der Vorschläge erst holen, wenn die Spielersuche offen ist (und nur einmal je Auswahl)
  const wantScores = playersOpen;
  useEffect(() => {
    if (!rankingMetric || !wantScores || playerScores?.key === rankingKey) return;
    const ctrl = new AbortController();
    fetch(suggestionsUrl(q, rankingMetric, Date.now()), { signal: ctrl.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `HTTP ${response.status}`);
        return (await response.json()) as { scores: Record<string, number> };
      })
      .then(({ scores }) => setPlayerScores({ key: rankingKey, scores }))
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setPlayerScores({ key: rankingKey, scores: {}, error: e.message });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rankingKey fasst alle relevanten Teile von q zusammen
  }, [rankingMetric, rankingKey, wantScores]);

  // URL mitführen, damit die Auswahl teilbar ist
  useEffect(() => {
    const s = toSearch(q).toString();
    window.history.replaceState(null, "", `${window.location.pathname}${s ? `?${s}` : ""}`);
  }, [q]);

  const dataKey = [q.metrics.join(","), q.spieler.join(","), rangeKey(q)].join("|");
  const parts = useMemo(() => partsOf(q, meta), [q, meta]);
  const isReady = (x: GraphQuery) => partsOf(x, meta).every((p) => cache.has(p.key));
  const ready = isReady(q);
  const viewQ = ready ? q : shownQ && isReady(shownQ) ? shownQ : null;
  const loading = !ready;
  const error = !ready && loadError?.key === dataKey ? loadError.message : null;

  // Nur fehlende oder veraltete Teile laden, je Kennzahl in einer Abfrage. Nicht abbrechen: auch Ergebnisse einer
  // inzwischen geänderten Auswahl landen im Cache (z. B. beim schnellen Hin- und Herschalten).
  useEffect(() => {
    const now = Date.now();
    const todo = new Map<Metric, { players: string[]; keys: string[] }>();
    for (const p of parts) {
      const hit = cache.get(p.key);
      if (inflight.current.has(p.key) || (hit && now - hit.at < CACHE_TTL_MS)) continue;
      const job = todo.get(p.metric) ?? { players: [], keys: [] };
      if (p.player) job.players.push(p.player);
      job.keys.push(p.key);
      todo.set(p.metric, job);
    }
    for (const [metric, job] of todo) {
      job.keys.forEach((k) => inflight.current.add(k));
      fetch(apiUrl(q, metric, job.players, now))
        .then(async (r) => {
          if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
          return (await r.json()) as { series: ApiLine[]; bucketMinutes: number };
        })
        .then(({ series, bucketMinutes }) =>
          setCache((prev) => {
            const next = new Map(prev);
            const at = Date.now();
            if (job.players.length) job.players.forEach((id, i) => next.set(job.keys[i], { lines: series.filter((l) => l.id === id), bucketMinutes, at }));
            else next.set(job.keys[0], { lines: series, bucketMinutes, at });
            return next;
          }),
        )
        .catch((e: Error) => setLoadError({ key: dataKey, message: e.message }))
        .finally(() => job.keys.forEach((k) => inflight.current.delete(k)));
    }
  }, [parts, cache, q, dataKey]);

  // Linien aus dem Cache; Einheit/% und Stand/Zuwachs gelten sofort, auch für das noch stehende alte Bild
  const view = useMemo(() => {
    if (!viewQ) return null;
    const vq: GraphQuery = { ...viewQ, achse: q.achse, modus: q.modus };
    const dayView = q.ansicht === "tag";
    const lines: Line[] = [];
    let bucketMinutes = 0;
    for (const metric of vq.metrics) {
      const m = meta(metric);
      const entries = partsOf({ ...vq, metrics: [metric] }, meta).map((p) => cache.get(p.key)!);
      const series = entries.flatMap((e) => e.lines);
      bucketMinutes = Math.max(bucketMinutes, ...entries.map((e) => e.bucketMinutes));
      // Im Tagesverlauf zeigen Zähler immer den Zuwachs je Abschnitt; ein laufender Stand über den Tag ergäbe nichts
      const delta = (vq.modus === "zuwachs" || dayView) && m.counter;
      // Zähler stehen offline auf dem letzten Stand: Linie bis zur Abfrage fortführen (eigener Zeitraum hat ein festes Ende)
      const loadedAt = Math.min(...entries.map((e) => e.at));
      // Beim eigenen Zeitraum bis zu dessen Ende (höchstens bis jetzt)
      const holdTo = vq.zeit === "eigen" && Number.isFinite(localMs(vq.bis)) ? Math.min(localMs(vq.bis), loadedAt) : loadedAt;
      const holdUntil = (points: ApiLine["points"]) => {
        const last = points[points.length - 1];
        if (!m.counter || !last || holdTo - Date.parse(last.at) < 60_000) return points;
        return [...points, { at: new Date(holdTo).toISOString(), v: last.v }];
      };
      for (const s of series) {
        lines.push({
          ...s,
          points: delta ? toDelta(holdUntil(s.points)) : holdUntil(s.points),
          id: `${metric}:${s.id}`,
          name: vq.metrics.length === 1 ? s.name : series.length > 1 || vq.spieler.length || m.needsPlayers ? `${m.label} · ${s.name}` : m.label,
          metric,
          meta: m,
          delta,
          color: metric === "twitchSubs" && series.length === 1 ? "var(--twitch)" : COLORS[lines.length % COLORS.length],
          format: m.format,
        });
      }
    }
    // Zeitraum für den Tagesverlauf: relative Zeiträume bis zum Laden, eigener Zeitraum fest, „Alles“ ab dem ersten Punkt
    const loadedAt = Math.max(0, ...partsOf(vq, meta).map((p) => cache.get(p.key)?.at ?? 0));
    const firstPoint = Math.min(...lines.flatMap((l) => (l.points.length ? [Date.parse(l.points[0].at)] : [])));
    const r = RANGES.find((x) => x.key === vq.zeit);
    const rangeTo = vq.zeit === "eigen" && Number.isFinite(localMs(vq.bis)) ? localMs(vq.bis) : loadedAt;
    const rangeFrom =
      vq.zeit === "eigen" && Number.isFinite(localMs(vq.von)) ? localMs(vq.von) : r?.ms ? loadedAt - r.ms : Number.isFinite(firstPoint) ? firstPoint : loadedAt;
    return { q: vq, lines, bucketMinutes, key: toSearch(vq).toString(), rangeFrom, rangeTo };
  }, [viewQ, q.achse, q.modus, q.ansicht, cache, meta]);
  const lines = view?.lines ?? [];
  /** Spätester Messpunkt: bis dahin reicht „später →“ */
  const latestPoint = Math.max(0, ...lines.flatMap((l) => l.points.slice(-1).map((p) => Date.parse(p.at))));

  const set = (patch: Partial<GraphQuery>) => {
    // Das aktuelle Bild bleibt stehen, bis die neue Auswahl geladen ist
    if (ready) setShownQ(q);
    setQ({ ...q, ...patch });
  };
  /* Zeitraum im Graphen ändern: Ziehen vergrößert, Knöpfe zoomen heraus, verschieben, gehen zurück */
  const [pastRanges, setPastRanges] = useState<Pick<GraphQuery, "zeit" | "von" | "bis">[]>([]);
  const currentRange = (): [number, number] => {
    const now = nowMs();
    if (q.zeit === "eigen") {
      const a = localMs(q.von);
      const b = localMs(q.bis);
      return [Number.isFinite(a) ? a : now - 24 * 3600_000, Number.isFinite(b) ? Math.min(b, now) : now];
    }
    const r = RANGES.find((x) => x.key === q.zeit);
    if (r?.ms) return [now - r.ms, now];
    const first = Math.min(...lines.flatMap((l) => l.points.map((p) => Date.parse(p.at))));
    return [Number.isFinite(first) ? first : now - 7 * 24 * 3600_000, now];
  };
  const goRange = (from: number, to: number) => {
    const now = nowMs();
    let a = from;
    const b = Math.min(to, now);
    // Mindestens 10 Minuten, nichts in der Zukunft
    if (b - a < 10 * 60_000) a = b - 10 * 60_000;
    setPastRanges((p) => [...p, { zeit: q.zeit, von: q.von, bis: q.bis }].slice(-20));
    set({ zeit: "eigen", von: toLocalInput(a), bis: toLocalInput(b) });
  };
  const zoomOut = () => {
    const [a, b] = currentRange();
    const len = (b - a) * 2;
    const end = Math.min(nowMs(), (a + b) / 2 + len / 2);
    goRange(end - len, end);
  };
  const pan = (dir: -1 | 1) => {
    const [a, b] = currentRange();
    const end = Math.min(nowMs(), b + ((b - a) / 2) * dir);
    goRange(end - (b - a), end);
  };
  /* Erklärung einer Veränderung: Rechtsklick in den Graphen erklärt das Bündel unter dem Zeiger (im Graphen als Band
     markiert, an den Rändern mit Griffen zu vergrößern und zu verkleinern) */
  const [explain, setExplain] = useState<ExplainTarget | null>(null);
  const pick = (at: number) => {
    const bucket = Math.max(1, view?.bucketMinutes || 5) * 60_000;
    const from = Math.floor(at / bucket) * bucket;
    setExplain({ from, to: from + bucket });
  };
  const explainMetrics = q.metrics.map((m) => {
    const base = valueOfRank(m) ?? m;
    const line = lines.find((l) => l.metric === m);
    return { metric: m, label: meta(m).label, format: meta(base).format, color: line?.color ?? "var(--ink)" };
  });
  const back = () => {
    const prev = pastRanges[pastRanges.length - 1];
    if (!prev) return;
    setPastRanges((p) => p.slice(0, -1));
    set(prev);
  };
  const toggleMetric = (m: Metric) => {
    if (q.metrics.includes(m)) {
      if (q.metrics.length > 1) set({ metrics: q.metrics.filter((x) => x !== m) });
    } else if (q.metrics.length < MAX_METRICS) {
      set({ metrics: [...q.metrics, m] });
    }
  };
  const togglePlayer = (id: string) =>
    set({ spieler: q.spieler.includes(id) ? q.spieler.filter((x) => x !== id) : q.spieler.length >= 12 ? q.spieler : [...q.spieler, id] });


  // Kennzahl-Auswahl: Suche über alle Reiter (außer Einzeln), sonst der gewählte Reiter
  const needle = metricSearch.trim().toLowerCase();
  const pickable: { m: Metric; label: string; tone: string; hint?: string }[] = useMemo(() => {
    const base = METRIC_KEYS.map((k) => ({ m: k as Metric, label: METRICS[k].label, tone: METRICS[k].tone, hint: METRICS[k].hint, group: METRICS[k].group as string }));
    const ranks = RANK_KEYS.map((k) => ({ m: rankMetric(k) as Metric, label: LEADERBOARDS[k].title, tone: LEADERBOARDS[k].tone, hint: `Platz in „${LEADERBOARDS[k].title}“ (${LEADERBOARDS[k].sub})`, group: "rang" }));
    const all = [...base, ...ranks];
    return (needle ? fuzzyFilter(all, needle, (x) => [x.label, x.hint]) : all.filter((x) => x.group === picker)).map(({ m, label, tone, hint }) => ({ m, label, tone, hint }));
  }, [needle, picker]);

  const latest = (l: Line) => (l.points.length ? l.format(l.points[l.points.length - 1].v) : "–");
  const best = (l: Line) => (l.points.length ? l.format(l.meta.invert ? Math.min(...l.points.map((p) => p.v)) : Math.max(...l.points.map((p) => p.v))) : "–");
  const total = (l: Line) => l.format(l.points.reduce((s, p) => s + p.v, 0));
  const bucket = view?.bucketMinutes;
  // Wert ↔ Platz: alle Kennzahlen mit Rang-Verlauf auf einmal umschalten
  const rankable = q.metrics.some((m) => rankOfMetric(m) || valueOfRank(m));
  const asRank = rankable && q.metrics.every((m) => !rankOfMetric(m));
  const switchRank = (toRank: boolean) =>
    set({ metrics: [...new Set(q.metrics.map((m) => (toRank ? rankOfMetric(m) : valueOfRank(m)) ?? m))] });
  const selectedItems = q.metrics.flatMap((m) => {
    const it = parseItemMetric(m);
    return it ? [`${it.category}|${it.key}`] : [];
  });

  return (
    <div className="gb" id="graph">
      <div className="box gb__form" data-tone="white">
        {/* Gewählte Kennzahlen; „+ Kennzahl“ öffnet die Auswahl */}
        <div className="gb__selected">
          {q.metrics.map((m, i) => {
            const mm = metas[i];
            return (
              <button key={m} type="button" className="gb__chip gb__chip--metric" data-tone="white" onClick={() => toggleMetric(m)} disabled={q.metrics.length === 1} title={mm.hint ?? "Entfernen"}>
                <span className="swatch" data-tone={mm.tone} aria-hidden="true" />
                {mm.label}
                {q.metrics.length > 1 && <span aria-hidden="true"> ×</span>}
              </button>
            );
          })}
          {q.metrics.length < MAX_METRICS && (
            <button type="button" className="gb__chip" data-tone={picker ? "ink" : "white"} aria-expanded={picker !== null} onClick={() => setPicker(picker ? null : "server")}>
              + Kennzahl
            </button>
          )}
          <span className="muted gb__hint">
            {q.metrics.length}/{MAX_METRICS}
          </span>
        </div>

        {picker && (
          <div className="gb__picker">
            <div className="gb__picker-bar">
              <div className="gb__tabs" role="tablist" aria-label="Rubrik">
                {PICKER_TABS.map((t) => (
                  <button key={t.key} type="button" role="tab" aria-selected={!needle && picker === t.key} onClick={() => (setPicker(t.key), setMetricSearch(""))}>
                    {t.label}
                  </button>
                ))}
              </div>
              {picker !== "einzeln" && (
                <input type="search" placeholder="Kennzahl suchen …" value={metricSearch} onChange={(e) => setMetricSearch(e.target.value)} aria-label="Kennzahl suchen" />
              )}
              <button type="button" className="gb__close" onClick={() => setPicker(null)} aria-label="Auswahl schließen">
                ×
              </button>
            </div>
            {picker === "einzeln" && !needle ? (
              <ItemPicker options={items} selected={selectedItems} onPick={(c: TopCategory, k: string) => toggleMetric(itemMetric(c, k))} />
            ) : (
              <ul className="gb__chips" aria-label="Kennzahlen">
                {pickable.map((x) => {
                  const on = q.metrics.includes(x.m);
                  return (
                    <li key={x.m}>
                      <button type="button" className="gb__chip" data-tone={on ? "ink" : "white"} aria-pressed={on} disabled={!on && q.metrics.length >= MAX_METRICS} onClick={() => toggleMetric(x.m)} title={x.hint}>
                        <span className="swatch" data-tone={x.tone} aria-hidden="true" />
                        {x.label}
                      </button>
                    </li>
                  );
                })}
                {pickable.length === 0 && <li className="muted">Keine Kennzahl passt zu „{metricSearch}“.</li>}
              </ul>
            )}
          </div>
        )}

        {anyPerPlayer && (
          <div className="gb__line">
            <span className="eyebrow">Spieler</span>
            <PlayerMulti
              players={players}
              selected={q.spieler}
              max={12}
              onAdd={togglePlayer}
              onRemove={togglePlayer}
              onClear={() => set({ spieler: [] })}
              allLabel={metas.some((m) => m.needsPlayers) && !metas.some((m) => m.perPlayer && !m.needsPlayers) ? "Beste 5" : "Alle"}
              allHint="Ohne Auswahl: Summe aller Spieler, bei Rängen und Einzel-Items die besten fünf"
              rank={currentScores ? (a, b) => (currentScores[b.id] ?? 0) - (currentScores[a.id] ?? 0) || a.name.localeCompare(b.name, "de") : undefined}
              onOpenChange={setPlayersOpen}
            />
          </div>
        )}

        <div className="gb__line gb__controls">
          <div className="gb__seg" role="group" aria-label="Ansicht" title="Tagesverlauf: alle Tage des Zeitraums auf eine Achse von 0 bis 24 Uhr legen">
            <button type="button" aria-pressed={q.ansicht === "zeit"} onClick={() => set({ ansicht: "zeit" })}>
              Zeitachse
            </button>
            <button
              type="button"
              aria-pressed={q.ansicht === "tag"}
              onClick={() => set({ ansicht: "tag", ...(["1h", "6h", "24h"].includes(q.zeit) ? { zeit: "7d" } : {}) })}
            >
              Tagesverlauf
            </button>
          </div>
          <div className="gb__seg" role="group" aria-label="Zeitraum">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={q.zeit === r.key}
                onClick={() => {
                  // Eigener Zeitraum ohne Angaben: mit dem gerade gezeigten beginnen
                  if (r.key === "eigen" && (!q.von || !q.bis)) {
                    const [a, b] = currentRange();
                    set({ zeit: "eigen", von: toLocalInput(a), bis: toLocalInput(b) });
                  } else set({ zeit: r.key });
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          {q.zeit === "eigen" && (
            <span className="gb__custom">
              <input type="datetime-local" value={q.von} onChange={(e) => set({ von: e.target.value })} aria-label="Von" />
              <input type="datetime-local" value={q.bis} onChange={(e) => set({ bis: e.target.value })} aria-label="Bis" />
            </span>
          )}
          <div className="gb__seg" role="group" aria-label="Raster" title="Raster: wie viel Zeit ein Punkt zusammenfasst">
            {RASTER.map((r) => (
              <button key={r.key} type="button" aria-pressed={q.raster === r.key} onClick={() => set({ raster: r.key })}>
                {r.label}
              </button>
            ))}
          </div>
          {anyCounter && q.ansicht === "zeit" && (
            <div className="gb__seg" role="group" aria-label="Anzeige" title={q.modus === "zuwachs" && multi ? "Zuwachs gilt nur für Zähler, andere Kennzahlen zeigen den Stand" : undefined}>
              <button type="button" aria-pressed={q.modus === "wert"} onClick={() => set({ modus: "wert" })}>
                Stand
              </button>
              <button type="button" aria-pressed={q.modus === "zuwachs"} onClick={() => set({ modus: "zuwachs" })}>
                Zuwachs
              </button>
            </div>
          )}
          {rankable && (
            <div className="gb__seg" role="group" aria-label="Wert oder Platz" title="Alle Kennzahlen als Platz in ihrer Bestenliste zeigen">
              <button type="button" aria-pressed={!asRank} onClick={() => switchRank(false)}>
                Wert
              </button>
              <button type="button" aria-pressed={asRank} onClick={() => switchRank(true)}>
                Platz
              </button>
            </div>
          )}
          <div className="gb__seg" role="group" aria-label="Y-Achse" title={mixedUnits ? "Verschiedene Einheiten werden immer in Prozent gezeigt" : undefined}>
            <button type="button" aria-pressed={q.achse === "einheit" && !mixedUnits} disabled={mixedUnits} onClick={() => set({ achse: "einheit" })}>
              Einheit
            </button>
            <button type="button" aria-pressed={q.achse === "prozent" || mixedUnits} onClick={() => set({ achse: "prozent" })}>
              %
            </button>
          </div>
        </div>
        {q.ansicht === "tag" && (
          <div className="gb__line gb__controls gb__day">
            <span className="gb__group">
              <span className="eyebrow">Tage</span>
              <span className="gb__seg" role="group" aria-label="Tage zusammenfassen">
                {DAY_MODES.map((d) => (
                  <button key={d.key} type="button" aria-pressed={q.tage === d.key} onClick={() => set({ tage: d.key })}>
                    {d.label}
                  </button>
                ))}
              </span>
            </span>
            {q.tage === "schnitt" && (
              <span className="gb__group">
                <span className="eyebrow">Streuung</span>
                <span className="gb__seg" role="group" aria-label="Streuung um den Durchschnitt">
                  {DAY_SPREADS.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      aria-pressed={q.streuung === d.key}
                      onClick={() => set({ streuung: d.key })}
                      title={d.key === "quartile" ? "Band, in dem die mittlere Hälfte der Tage liegt (25–75 %)" : d.key === "spanne" ? "Band vom niedrigsten bis zum höchsten Tag" : undefined}
                    >
                      {d.label}
                    </button>
                  ))}
                </span>
              </span>
            )}
            <span className="gb__group">
              <span className="eyebrow">Wochentage</span>
              <span className="gb__seg" role="group" aria-label="Wochentage">
                {WEEKDAYS.map((w, i) => {
                  const d = String(i + 1);
                  const on = q.wochentage.includes(d);
                  return (
                    <button
                      key={w}
                      type="button"
                      aria-pressed={on}
                      // Der letzte Tag bleibt: ohne Wochentag gäbe es nichts zu zeigen
                      disabled={on && q.wochentage.length === 1}
                      onClick={() => set({ wochentage: (on ? q.wochentage.replace(d, "") : q.wochentage + d).split("").sort().join("") })}
                    >
                      {w}
                    </button>
                  );
                })}
              </span>
              <span className="gb__quick">
                {[
                  { label: "alle", v: "1234567" },
                  { label: "Mo–Fr", v: "12345" },
                  { label: "Sa–So", v: "67" },
                ].map((o) => (
                  <button key={o.v} type="button" className="gb__link" aria-pressed={q.wochentage === o.v} onClick={() => set({ wochentage: o.v })}>
                    {o.label}
                  </button>
                ))}
              </span>
            </span>
            <span className="gb__group">
              <span className="eyebrow">Ohne Messpunkt</span>
              <span className="gb__seg" role="group" aria-label="Abschnitte ohne Messpunkt">
                <button
                  type="button"
                  aria-pressed={q.luecken === "auto"}
                  onClick={() => set({ luecken: "auto" })}
                  title="Zähler: 0 (offline = kein Zuwachs); andere Kennzahlen: auslassen"
                >
                  automatisch
                </button>
                <button type="button" aria-pressed={q.luecken === "auslassen"} onClick={() => set({ luecken: "auslassen" })} title="Zählt nicht mit, z. B. Durchschnitt nur über Tage, an denen gestreamt wurde">
                  auslassen
                </button>
                <button type="button" aria-pressed={q.luecken === "null"} onClick={() => set({ luecken: "null" })} title="Zählt als 0, z. B. Durchschnitt über alle Tage">
                  als 0
                </button>
              </span>
            </span>
            {anyCounter && <p className="muted gb__hint">Zähler zeigen im Tagesverlauf den Zuwachs je Abschnitt.</p>}
          </div>
        )}
      </div>

      <div className="box gb__chart" data-tone="white" aria-busy={loading}>
        <div className="chart__head">
          <span className="eyebrow">
            {(view?.q.metrics ?? q.metrics).map((m) => meta(m).label).join(" + ")}
            {q.ansicht === "tag" && ` · Tagesverlauf, ${DAY_MODES.find((d) => d.key === q.tage)?.label}`}
            {(q.modus === "zuwachs" || q.ansicht === "tag") && anyCounter && " · Zuwachs"}
            {bucket !== undefined && <span className="muted"> · {bucket >= 60 ? `${bucket / 60} Std` : `${bucket} Min`} je Punkt</span>}
          </span>
          {loading && !error && <span className="muted gb__loading">Lädt …</span>}
          {error && <span className="gb__loading">Fehler: {error}</span>}
        </div>
        {view && q.ansicht === "tag" ? (
          (view.bucketMinutes ?? 0) > 180 ? (
            <p className="chart__empty">Das Raster ist für den Tagesverlauf zu grob – wähle „Auto“, 15 Min oder 1 Std.</p>
          ) : (
            <DayProfileChart
              lines={lines.map(
                (l): DayLine => ({
                  id: l.id,
                  name: l.name,
                  color: l.color,
                  unit: l.meta.unit,
                  invert: l.meta.invert,
                  additive: Boolean(l.delta),
                  zeroFill: q.luecken === "null" ? true : q.luecken === "auslassen" ? false : Boolean(l.delta),
                  format: l.format,
                  points: l.points,
                }),
              )}
              hidden={hidden}
              days={daysBetween(view.rangeFrom, view.rangeTo, new Set(q.wochentage.split("").map(Number)))}
              slotMin={Math.max(5, view.bucketMinutes || 15)}
              mode={q.tage}
              spread={q.streuung}
              percent={q.achse === "prozent"}
            />
          )
        ) : view ? (
          <>
            <div className="gb-zoom" role="toolbar" aria-label="Zeitraum im Graphen">
              <button type="button" className="tag" onClick={() => pan(-1)} title="Halben Zeitraum früher">
                ← früher
              </button>
              <button type="button" className="tag" onClick={zoomOut} title="Doppelten Zeitraum zeigen">
                − herauszoomen
              </button>
              <button type="button" className="tag" onClick={() => pan(1)} disabled={q.zeit !== "eigen" || localMs(q.bis) >= latestPoint - 60_000} title="Halben Zeitraum später">
                später →
              </button>
              {pastRanges.length > 0 && (
                <button type="button" className="tag" onClick={back} title="Vorigen Zeitraum wiederherstellen">
                  ↩ zurück
                </button>
              )}
              <button type="button" className="tag" onClick={() => setExplain({ from: currentRange()[0], to: currentRange()[1] })} title="Wer hat im gezeigten Zeitraum am meisten beigetragen?">
                ? Zeitraum erklären
              </button>
              <span className="muted gb-zoom__hint">Ziehen vergrößert · Rechtsklick (Handy: lange drücken) erklärt die Stelle · Ränder des Bereichs ziehen zum Anpassen</span>
            </div>
            <MultiChart
              lines={lines}
              hidden={hidden}
              dataKey={view.key}
              percent={q.achse === "prozent"}
              onZoom={goRange}
              onPick={pick}
              selected={explain}
              onSelect={(from, to) => setExplain({ from, to })}
              step={Math.max(1, view?.bucketMinutes || 5) * 60_000}
            />
            {explain && <GraphExplain target={explain} metrics={explainMetrics} players={q.spieler} onClose={() => setExplain(null)} />}
          </>
        ) : (
          <p className="chart__empty">{error ? `Fehler: ${error}` : "Lädt …"}</p>
        )}
        {lines.length > 0 && (
          <ul className="gb__legend" aria-label="Legende">
            {lines.map((l) => {
              const off = hidden.has(l.id);
              const delta = q.modus === "zuwachs" && l.meta.counter;
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    className="gb__legend-btn"
                    aria-pressed={!off}
                    onClick={() =>
                      setHidden((h) => {
                        const n = new Set(h);
                        if (n.has(l.id)) n.delete(l.id);
                        else n.add(l.id);
                        return n;
                      })
                    }
                  >
                    <i style={{ background: l.color }} />
                    <span className="gb__legend-name">{l.name}</span>
                    {q.ansicht === "zeit" && (
                      <>
                        <span className="num">{delta ? `Σ ${total(l)}` : latest(l)}</span>
                        <span className="muted num">
                          {l.meta.invert ? "bester" : "max"} {best(l)}
                        </span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
