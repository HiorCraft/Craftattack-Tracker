"use client";

import { useRef, useState } from "react";

/**
 * Tagesverlauf im Graph-Baukasten: jede Linie (Kennzahl × Spieler) wird auf eine Achse von 0 bis 24 Uhr (Berlin)
 * gefaltet. Darstellung als Linie je Tag (ältere Tage heller), Summe über die Tage oder Durchschnitt mit Streuung
 * (mittlere Hälfte oder Spannweite). So sieht man, wie ein typischer Tag aussieht, statt Tag und Nacht hintereinander.
 */

export type DayMode = "linien" | "summe" | "schnitt";
export type DaySpread = "keine" | "quartile" | "spanne";

export interface DayLine {
  id: string;
  name: string;
  color: string;
  unit: string;
  invert?: boolean;
  /** Zähler im Zuwachs-Modus: Werte eines Abschnitts addieren statt mitteln */
  additive: boolean;
  /** Abschnitte ohne Messpunkt als 0 zählen (z. B. Zähler: offline = kein Zuwachs), sonst auslassen */
  zeroFill: boolean;
  format: (v: number) => string;
  points: { at: string; v: number }[];
}

const dayFmt = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin" });
const hmFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin" });
const dayLabelFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" });

/** Berliner Tag „YYYY-MM-DD“ und Minute des Tages */
function berlin(ms: number): { day: string; minute: number } {
  const parts = hmFmt.formatToParts(ms);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { day: dayFmt.format(ms), minute: h * 60 + m };
}

/** Wochentag eines Tages „YYYY-MM-DD“: 1 = Montag … 7 = Sonntag */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Alle Kalendertage (Berlin) von a bis b (ms), mit den erlaubten Wochentagen */
export function daysBetween(a: number, b: number, weekdays: Set<number>): string[] {
  const out: string[] = [];
  let last = "";
  for (let t = a; t <= b + 3_600_000; t += 3_600_000) {
    const d = dayFmt.format(t);
    if (d !== last && d <= dayFmt.format(b)) {
      last = d;
      if (weekdays.has(weekdayOf(d))) out.push(d);
    }
  }
  return out;
}

export const dayLabel = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return dayLabelFmt.format(Date.UTC(y, m - 1, d, 12));
};

interface Folded {
  line: DayLine;
  /** je Tag (in der Reihenfolge von `days`) die Werte je Abschnitt; null = keine Daten */
  byDay: (number | null)[][];
  avg: (number | null)[];
  sum: (number | null)[];
  lo: (number | null)[];
  hi: (number | null)[];
}

const quantile = (sorted: number[], p: number) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const a = Math.floor(i);
  const b = Math.ceil(i);
  return sorted[a] + (sorted[b] - sorted[a]) * (i - a);
};

function fold(line: DayLine, days: string[], slotMin: number, spread: DaySpread): Folded {
  const zeroFill = line.zeroFill;
  const slots = Math.round(1440 / slotMin);
  const index = new Map(days.map((d, i) => [d, i]));
  const sums = days.map(() => new Array<number>(slots).fill(0));
  const counts = days.map(() => new Array<number>(slots).fill(0));
  for (const p of line.points) {
    const b = berlin(Date.parse(p.at));
    const di = index.get(b.day);
    if (di === undefined) continue;
    const s = Math.min(slots - 1, Math.floor(b.minute / slotMin));
    sums[di][s] += p.v;
    counts[di][s] += 1;
  }
  const hasData = counts.map((c) => c.some((n) => n > 0));
  const byDay = days.map((_, di) =>
    sums[di].map((v, s) => {
      if (counts[di][s] > 0) return line.additive ? v : v / counts[di][s];
      // Ohne Messpunkt: 0, wenn gewünscht (z. B. Zähler: offline = kein Zuwachs); sonst unbekannt
      return zeroFill ? 0 : null;
    }),
  );
  // Tage ganz ohne Daten zählen nur mit, wenn Lücken als 0 gelten
  const useDay = days.map((_, di) => zeroFill || hasData[di]);
  const avg: (number | null)[] = [];
  const sum: (number | null)[] = [];
  const lo: (number | null)[] = [];
  const hi: (number | null)[] = [];
  for (let s = 0; s < slots; s++) {
    const vals = byDay.flatMap((row, di) => (useDay[di] && row[s] !== null ? [row[s] as number] : [])).sort((a, b) => a - b);
    if (!vals.length) {
      avg.push(null);
      sum.push(null);
      lo.push(null);
      hi.push(null);
      continue;
    }
    const total = vals.reduce((a, b) => a + b, 0);
    sum.push(total);
    avg.push(total / vals.length);
    lo.push(spread === "spanne" ? vals[0] : quantile(vals, 0.25));
    hi.push(spread === "spanne" ? vals[vals.length - 1] : quantile(vals, 0.75));
  }
  return { line, byDay: byDay.map((row, di) => (useDay[di] ? row : row.map(() => null))), avg, sum, lo, hi };
}

function niceStep(max: number, ticks: number) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

const slotTime = (s: number, slotMin: number) => `${String(Math.floor((s * slotMin) / 60)).padStart(2, "0")}:${String((s * slotMin) % 60).padStart(2, "0")}`;

export function DayProfileChart({
  lines,
  hidden,
  days,
  slotMin,
  mode,
  spread,
  percent,
}: {
  lines: DayLine[];
  hidden: Set<string>;
  days: string[];
  slotMin: number;
  mode: DayMode;
  spread: DaySpread;
  percent: boolean;
}) {
  const W = 1000;
  const H = 300;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const slots = Math.round(1440 / slotMin);
  const folded = lines.filter((l) => !hidden.has(l.id)).map((l) => fold(l, days, slotMin, spread));
  const shown = (f: Folded): (number | null)[][] =>
    mode === "linien" ? f.byDay : mode === "summe" ? [f.sum] : spread === "keine" ? [f.avg] : [f.avg, f.lo, f.hi];
  const allVals = folded.flatMap((f) => shown(f).flat()).filter((v): v is number => v !== null);
  if (!days.length) return <p className="chart__empty">Keine Tage im Zeitraum mit den gewählten Wochentagen.</p>;
  if (!allVals.length) return <p className="chart__empty">Keine Daten für diese Auswahl.</p>;

  const units = new Set(folded.map((f) => f.line.unit));
  const normalized = percent || units.size > 1;
  const invert = !normalized && folded.every((f) => f.line.invert);
  const maxOf = new Map(folded.map((f) => [f.line.id, Math.max(1e-9, ...shown(f).flat().filter((v): v is number => v !== null))]));
  const vmax = Math.max(...allVals);
  const ystep = normalized ? 25 : invert ? Math.max(1, Math.round(niceStep(Math.max(vmax - 1, 1), 4))) : niceStep(Math.max(vmax, 1), 4);
  const ymax = normalized ? 100 : invert ? 1 + Math.max(ystep, Math.ceil((vmax - 1) / ystep) * ystep) : Math.max(ystep, Math.ceil(vmax / ystep) * ystep);
  const ymin = invert ? 1 : 0;
  const scaled = (f: Folded, v: number) => (normalized ? (v / (maxOf.get(f.line.id) ?? 1)) * 100 : v);
  const yOf = (v: number) => (invert ? ((v - ymin) / (ymax - ymin)) * H : H - ((v - ymin) / (ymax - ymin)) * H);
  const y = (f: Folded, v: number) => yOf(scaled(f, v));
  const x = (s: number) => (slots <= 1 ? 0 : (s / (slots - 1)) * W);

  /** Linie mit Lücken bei fehlenden Werten */
  const path = (f: Folded, vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, s) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(s).toFixed(1)},${y(f, v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  /** Streuband je zusammenhängendem Abschnitt */
  const band = (f: Folded) => {
    let d = "";
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        d += `M${run.map((s) => `${x(s).toFixed(1)},${y(f, f.hi[s]!).toFixed(1)}`).join("L")}L${[...run]
          .reverse()
          .map((s) => `${x(s).toFixed(1)},${y(f, f.lo[s]!).toFixed(1)}`)
          .join("L")}Z`;
      }
      run = [];
    };
    f.hi.forEach((v, s) => (v === null || f.lo[s] === null ? flush() : run.push(s)));
    flush();
    return d;
  };

  const yTicks: number[] = [];
  for (let v = ymin; v <= ymax + 1e-9; v += ystep) yTicks.push(v);
  const axisFormat = normalized ? (v: number) => `${Math.round(v)} %` : (folded[0]?.line.format ?? String);
  // Ältere Tage heller: Reihenfolge ohne zusätzliche Farben lesbar
  const dayOpacity = (di: number) => (days.length <= 1 ? 1 : 0.2 + 0.8 * (di / (days.length - 1)));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    setHover(Math.max(0, Math.min(slots - 1, Math.round(((e.clientX - r.left) / r.width) * (slots - 1)))));
  };
  const tipLeft = hover === null ? 0 : x(hover) / W;
  const recent = days.map((d, di) => ({ d, di })).reverse();

  return (
    <div className="gb-chart">
      <div className="gb-chart__y" aria-hidden="true" data-invert={invert || undefined}>
        {(invert ? yTicks : [...yTicks].reverse()).map((v) => (
          <span key={v} className="gb-chart__ylabel">
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
          aria-label="Tagesverlauf: mehrere Tage auf einer Achse von 0 bis 24 Uhr"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <line key={v} x1={0} x2={W} y1={yOf(v)} y2={yOf(v)} className="gb-chart__grid" vectorEffect="non-scaling-stroke" />
          ))}
          {mode === "schnitt" &&
            spread !== "keine" &&
            folded.map((f) => <path key={`b-${f.line.id}`} d={band(f)} fill={f.line.color} fillOpacity={0.16} stroke="none" />)}
          {folded.map((f) =>
            mode === "linien" ? (
              f.byDay.map((row, di) => (
                <path
                  key={`${f.line.id}-${days[di]}`}
                  d={path(f, row)}
                  fill="none"
                  stroke={f.line.color}
                  strokeOpacity={dayOpacity(di)}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))
            ) : (
              <path
                key={f.line.id}
                d={path(f, mode === "summe" ? f.sum : f.avg)}
                fill="none"
                stroke={f.line.color}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} className="spark__cursor" vectorEffect="non-scaling-stroke" />}
        </svg>
        {hover !== null && (
          <div
            className="gb-chart__tip"
            style={{ left: `${tipLeft * 100}%`, transform: `translateX(${tipLeft > 0.7 ? "-100%" : tipLeft < 0.3 ? "0" : "-50%"})` }}
            role="status"
          >
            <span className="gb-chart__tip-time">
              {slotTime(hover, slotMin)}–{slotTime(hover + 1, slotMin)} Uhr
            </span>
            {folded.map((f) => {
              const fmt = f.line.format;
              if (mode === "summe")
                return (
                  <span key={f.line.id} className="gb-chart__tip-row">
                    <i style={{ background: f.line.color }} />
                    <span className="gb-chart__tip-name">{f.line.name}</span>
                    <span className="num">{f.sum[hover] === null ? "–" : `Σ ${fmt(f.sum[hover]!)}`}</span>
                  </span>
                );
              if (mode === "schnitt")
                return (
                  <span key={f.line.id} className="gb-chart__tip-row">
                    <i style={{ background: f.line.color }} />
                    <span className="gb-chart__tip-name">
                      {f.line.name}
                      {spread !== "keine" && f.lo[hover] !== null && (
                        <span className="muted">
                          {" "}
                          ({spread === "spanne" ? "min–max" : "Mitte"} {fmt(f.lo[hover]!)}–{fmt(f.hi[hover]!)})
                        </span>
                      )}
                    </span>
                    <span className="num">{f.avg[hover] === null ? "–" : `Ø ${fmt(f.avg[hover]!)}`}</span>
                  </span>
                );
              // Linie je Tag: je Linie ihr Name als Überschrift, darunter die jüngsten Tage (bei mehreren Linien weniger)
              const n = folded.length > 1 ? 4 : 6;
              return (
                <span key={f.line.id} className="gb-chart__tip-group">
                  {folded.length > 1 && <span className="gb-chart__tip-head">{f.line.name}</span>}
                  {recent.slice(0, n).map(({ d, di }) => (
                    <span key={d} className="gb-chart__tip-row">
                      <i style={{ background: f.line.color, opacity: dayOpacity(di) }} />
                      <span className="gb-chart__tip-name">{dayLabel(d)}</span>
                      <span className="num">{f.byDay[di][hover] === null ? "–" : fmt(f.byDay[di][hover]!)}</span>
                    </span>
                  ))}
                </span>
              );
            })}
            {mode === "linien" && days.length > (folded.length > 1 ? 4 : 6) && (
              <span className="muted">… und {days.length - (folded.length > 1 ? 4 : 6)} ältere Tage je Linie</span>
            )}
          </div>
        )}
        <div className="chart__axis gb-chart__x">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
            <span key={h}>{h} Uhr</span>
          ))}
        </div>
        <p className="muted gb-chart__note">
          {days.length} {days.length === 1 ? "Tag" : "Tage"} übereinandergelegt
          {mode === "linien" && days.length > 1 ? " · ältere Tage heller" : ""}
          {normalized ? " · jede Kennzahl auf ihr eigenes Maximum skaliert (100 %)" : ""}
        </p>
      </div>
    </div>
  );
}
