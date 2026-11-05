"use client";

import { useMemo, useRef, useState } from "react";
import type { TrendPoint } from "@/lib/analytics";
import { num } from "@/lib/format";
import { EstimateRects, EstimateTip, useEstimateGaps } from "./Estimates";

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const dtf = new Intl.DateTimeFormat("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const RANGES = [6, 24, 72] as const;

const SERIES = [
  { key: "online", label: "Spieler online", color: "var(--presence)", area: true },
  { key: "live", label: "Streams live", color: "var(--ink)", area: false },
  { key: "viewers", label: "Zuschauer gesamt", color: "var(--twitch)", area: false },
] as const;

/** Verlauf der letzten 6/24/72 Stunden: drei Kurven, jede auf ihr eigenes Maximum skaliert. */
export function TrendChart({ points, now }: { points: TrendPoint[]; now: number }) {
  const [hours, setHours] = useState<(typeof RANGES)[number]>(24);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const zones = useEstimateGaps();
  const W = 800;
  const H = 200;
  const pad = 20;

  const data = useMemo(() => {
    const from = now - hours * 3600_000;
    const pts = points.filter((p) => p.at >= from);
    // Bei kurzen Zeiträumen die feinen Punkte behalten, bei langen ausdünnen
    const stride = Math.max(1, Math.floor(pts.length / 600));
    return pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  }, [points, hours, now]);

  if (data.length < 2) {
    return (
      <div className="trend">
        <Chips hours={hours} setHours={setHours} />
        <p className="chart__empty">Noch keine Verlaufsdaten für diesen Zeitraum.</p>
      </div>
    );
  }

  const t0 = data[0].at;
  const t1 = data[data.length - 1].at;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => ((t - t0) / span) * W;
  const maxes = Object.fromEntries(SERIES.map((s) => [s.key, Math.max(1, ...data.map((p) => p[s.key]))])) as Record<(typeof SERIES)[number]["key"], number>;
  const y = (v: number, max: number) => H - pad - (v / (max * 1.08)) * (H - pad - 8);
  const path = (key: (typeof SERIES)[number]["key"]) => data.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p[key], maxes[key]).toFixed(1)}`).join("");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const t = t0 + ((e.clientX - rect.left) / rect.width) * span;
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i].at - t) < Math.abs(data[best].at - t)) best = i;
    setHover(best);
  };
  const h = hover !== null ? data[hover] : null;
  const tipLeft = h ? x(h.at) / W : 0;

  return (
    <div className="trend">
      <Chips hours={hours} setHours={setHours} />
      <div className="trend__plot">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="trend__svg" role="img" aria-label="Verlauf: Spieler online, Streams live, Zuschauer" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <EstimateRects zones={zones} x={x} t0={t0} t1={t1} height={H - pad} />
          <line x1={0} x2={W} y1={H - pad} y2={H - pad} className="trend__grid" vectorEffect="non-scaling-stroke" />
          <path d={`${path("online")}L${W},${H - pad}L0,${H - pad}Z`} fill="var(--presence)" opacity={0.35} />
          {SERIES.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          ))}
          {h && <line x1={x(h.at)} x2={x(h.at)} y1={0} y2={H - pad} className="trend__cursor" vectorEffect="non-scaling-stroke" />}
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={f * W} y={H - 4} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="trend__axis">
              {hours > 24 ? dtf.format(t0 + span * f) : tf.format(t0 + span * f)}
            </text>
          ))}
        </svg>
        {h && (
          <div className="spark__tip trend__tip" style={{ left: `${tipLeft * 100}%`, transform: `translateX(${tipLeft > 0.7 ? "-100%" : tipLeft < 0.3 ? "0" : "-50%"})` }} role="status">
            <span className="spark__tip-time">{dtf.format(h.at)}</span>
            <EstimateTip zones={zones} t={h.at} />
            {SERIES.map((s) => (
              <span key={s.key} className="trend__tipline">
                <i style={{ background: s.color }} /> {s.label}: <b className="num">{num(h[s.key])}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <ul className="legend">
        {SERIES.map((s) => (
          <li key={s.key}>
            <i style={{ background: s.color }} /> {s.label} <span className="muted num">(max. {num(maxes[s.key])})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chips({ hours, setHours }: { hours: number; setHours: (h: (typeof RANGES)[number]) => void }) {
  return (
    <div className="chips" role="tablist" aria-label="Zeitraum">
      {RANGES.map((r) => (
        <button key={r} type="button" role="tab" className="tag" aria-selected={hours === r} aria-current={hours === r ? "true" : undefined} onClick={() => setHours(r)}>
          {r} h
        </button>
      ))}
    </div>
  );
}
