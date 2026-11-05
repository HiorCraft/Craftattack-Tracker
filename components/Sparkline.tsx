"use client";

import { useRef, useState } from "react";
import { boardValue, eur, num } from "@/lib/format";
import { EstimateRects, EstimateTip, useEstimateGaps, type EstimateZone } from "./Estimates";

export interface SparkPoint {
  at: string;
  v: number;
}

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const df = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

/**
 * Kleine Verlaufskurve mit Hover: Zeigt beim Überfahren Zeitpunkt und Wert.
 * `step` zeichnet Treppen (für Zähler), sonst Linien.
 */
export function Sparkline({
  points,
  width = 300,
  height = 64,
  format,
  kind = "num",
  step = false,
  invert = false,
  label,
  zones,
}: {
  points: SparkPoint[];
  width?: number;
  height?: number;
  /** Nur aus Client-Komponenten nutzbar (Funktionen sind nicht serialisierbar) */
  format?: (v: number) => string;
  /** Für Server-Komponenten: Formatierung per Schlüssel */
  kind?: "num" | "eur" | "playtimeSeconds" | "distance" | "damageDealt" | "rank";
  step?: boolean;
  /** Kleine Werte oben zeichnen (z. B. Rang: Platz 1 ist oben) */
  invert?: boolean;
  label?: string;
  /** Schätzung: geschätzte Bereiche (Standard: die Tracker-Lücken) */
  zones?: EstimateZone[];
}) {
  const gaps = useEstimateGaps();
  const est = zones ?? gaps;
  const fmt = format ?? (kind === "num" ? num : kind === "eur" ? eur : kind === "rank" ? (v: number) => `Platz ${num(v)}` : (v: number) => boardValue(kind, v));
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <line x1="0" y1={height - 2} x2={width} y2={height - 2} className="spark__line" opacity=".3" />
      </svg>
    );
  }

  const t0 = Date.parse(points[0].at);
  const t1 = Date.parse(points[points.length - 1].at);
  const span = Math.max(1, t1 - t0);
  const values = points.map((p) => p.v);
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const pad = 4;
  const x = (t: number) => ((t - t0) / span) * width;
  const y = (v: number) => pad + (invert ? (v - min) / range : 1 - (v - min) / range) * (height - pad * 2);
  const xs = points.map((p) => x(Date.parse(p.at)));
  const ys = points.map((p) => y(p.v));

  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += step ? ` H${xs[i].toFixed(1)} V${ys[i].toFixed(1)}` : ` L${xs[i].toFixed(1)},${ys[i].toFixed(1)}`;
  }
  const area = `${d} L${width},${height} L0,${height} Z`;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * width;
    // nächsten Punkt suchen
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const dd = Math.abs(xs[i] - px);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    setHover(best);
  };

  const h = hover ?? points.length - 1;
  const hp = points[h];
  const sameDay = span < 20 * 36e5;
  const tipLeft = xs[h] / width;

  return (
    <div className="spark-wrap">
      <svg
        ref={ref}
        className="spark"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label ? `${label} im Zeitverlauf` : "Verlauf"}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <EstimateRects zones={est} x={x} t0={t0} t1={t1} height={height} />
        <path d={area} className="spark__area" />
        <path d={d} className="spark__line" vectorEffect="non-scaling-stroke" />
        {hover !== null && (
          <line x1={xs[h]} x2={xs[h]} y1={0} y2={height} className="spark__cursor" vectorEffect="non-scaling-stroke" />
        )}
        <circle cx={xs[h]} cy={ys[h]} r="4" className="spark__dot" vectorEffect="non-scaling-stroke" />
      </svg>
      {hover !== null && (
        <div
          className="spark__tip"
          style={{ left: `${tipLeft * 100}%`, transform: `translateX(${tipLeft > 0.7 ? "-100%" : tipLeft < 0.3 ? "0" : "-50%"})` }}
          role="status"
        >
          <span className="num spark__tip-val">{fmt(hp.v)}</span>
          <span className="spark__tip-time">{sameDay ? `${tf.format(new Date(hp.at))} Uhr` : df.format(new Date(hp.at))}</span>
          <EstimateTip zones={est} t={Date.parse(hp.at)} />
        </div>
      )}
    </div>
  );
}
