"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";
import { COLORS, MAX_METRICS, METRICS, METRIC_KEYS, RANGES, RASTER, toSearch, type GraphQuery, type Metric, type PlayerOption } from "@/lib/graphQuery";

/** `datetime-local`-Wert (lokale Zeit des Browsers) → Millisekunden */
const localMs = (s: string) => (s ? Date.parse(s) : NaN);

function apiUrl(q: GraphQuery, metric: Metric, now: number) {
  const p = new URLSearchParams();
  p.set("metric", metric);
  if (q.spieler.length && METRICS[metric].perPlayer) p.set("spieler", q.spieler.join(","));
  const r = RANGES.find((x) => x.key === q.zeit);
  if (q.zeit === "eigen") {
    const a = localMs(q.von);
    const b = localMs(q.bis);
    if (Number.isFinite(a)) p.set("von", String(a));
    if (Number.isFinite(b)) p.set("bis", String(b));
  } else if (r?.ms) {
    p.set("von", String(now - r.ms));
  }
  if (q.raster !== "auto") p.set("raster", q.raster);
  // Zuwachs nur bei Zählern – alles andere bleibt „Stand“
  if (q.modus === "zuwachs" && METRICS[metric].counter) p.set("modus", "zuwachs");
  return `/api/series?${p}`;
}

interface ApiLine {
  id: string;
  name: string;
  points: { at: string; v: number }[];
}

/** Eine gezeichnete Linie: Kennzahl × Spieler (bzw. Server/Alle) */
interface Line extends ApiLine {
  metric: Metric;
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

/** „Schöne“ Achsenschritte */
function niceStep(max: number, ticks: number) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

/**
 * Mehrere Linien in einem Chart. Bei einer Kennzahl gibt es eine echte Y-Achse;
 * bei mehreren wird jede Kennzahl auf ihr eigenes Maximum skaliert (0–100 %), damit z. B.
 * Tode und Blöcke zusammen lesbar bleiben. Echte Werte stehen im Tooltip und in der Legende.
 */
function MultiChart({ lines, hidden, dataKey }: { lines: Line[]; hidden: Set<string>; dataKey: string }) {
  const W = 1000;
  const H = 320;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null); // Zeitpunkt (ms)

  const visible = lines.filter((l) => !hidden.has(l.id) && l.points.length > 0);
  const all = visible.flatMap((l) => l.points);
  if (all.length === 0) return <p className="chart__empty">Keine Daten für diese Auswahl.</p>;

  const metrics = [...new Set(visible.map((l) => l.metric))];
  const normalized = metrics.length > 1;

  const t0 = Math.min(...all.map((p) => Date.parse(p.at)));
  const t1 = Math.max(...all.map((p) => Date.parse(p.at)));
  const span = Math.max(1, t1 - t0);

  // Maximum je Kennzahl (für die Skalierung) bzw. gesamt (für die Achse)
  const maxOf = new Map<Metric, number>();
  for (const l of visible) {
    const m = Math.max(...l.points.map((p) => p.v));
    maxOf.set(l.metric, Math.max(maxOf.get(l.metric) ?? 0, m));
  }
  const vmax = Math.max(...maxOf.values());
  const ystep = normalized ? 25 : niceStep(Math.max(vmax, 1), 4);
  const ymax = normalized ? 100 : Math.max(ystep, Math.ceil(vmax / ystep) * ystep);
  const x = (t: number) => ((t - t0) / span) * W;
  const scaled = (l: Line, v: number) => (normalized ? (v / Math.max(1e-9, maxOf.get(l.metric) ?? 1)) * 100 : v);
  const y = (l: Line, v: number) => H - (scaled(l, v) / ymax) * H;

  const paths = lines
    .filter((l) => l.points.length > 0)
    .map((l) => {
      const pts = l.points.map((p) => [x(Date.parse(p.at)), y(l, p.v)] as const);
      return { id: l.id, d: smoothPath(pts), color: l.color, off: hidden.has(l.id) };
    });

  const yTicks: number[] = [];
  for (let v = 0; v <= ymax + 1e-9; v += ystep) yTicks.push(v);
  const axisFormat = normalized ? (v: number) => `${Math.round(v)} %` : visible[0].format;
  const xTicks = 6;
  const multiDay = span > 36e5 * 20;
  const xLabel = (t: number) => (multiDay ? `${df.format(t)} ${tf.format(t)}` : tf.format(t));

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    setHover(t0 + ((e.clientX - rect.left) / rect.width) * span);
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
      <div className="gb-chart__y" aria-hidden="true">
        {[...yTicks].reverse().map((v) => (
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
          aria-label="Eigener Graph"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((v) => (
            <line key={v} x1={0} x2={W} y1={H - (v / ymax) * H} y2={H - (v / ymax) * H} className="gb-chart__grid" vectorEffect="non-scaling-stroke" />
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
        {tip && tipT !== null && (
          <div className="gb-chart__tip" style={{ left: `${tipLeft * 100}%`, transform: `translateX(${tipLeft > 0.7 ? "-100%" : tipLeft < 0.3 ? "0" : "-50%"})` }} role="status">
            <span className="gb-chart__tip-time">{dtf.format(tipT)} Uhr</span>
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
        {normalized && <p className="muted gb-chart__note">Mehrere Kennzahlen: jede Linie ist auf ihr eigenes Maximum skaliert (100 %). Echte Werte zeigen Tooltip und Legende.</p>}
      </div>
    </div>
  );
}

/* ---------- Formular + Laden ---------- */

export function GraphBuilder({ players, initial }: { players: PlayerOption[]; initial: GraphQuery }) {
  const [q, setQ] = useState<GraphQuery>(initial);
  const [search, setSearch] = useState("");
  // Ergebnis samt der Abfrage, zu der es gehört – „lädt“ heißt: Ergebnis passt noch nicht zur aktuellen Abfrage
  const [result, setResult] = useState<{ key: string; lines?: Line[]; bucketMinutes?: number; error?: string } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const key = toSearch(q).toString();
  const loading = result?.key !== key;
  const lines = result?.lines ?? [];
  const error = result?.key === key ? (result.error ?? null) : null;
  const nameOf = useMemo(() => new Map(players.map((p) => [p.id, p.name])), [players]);

  const anyPerPlayer = q.metrics.some((m) => METRICS[m].perPlayer);
  const anyCounter = q.metrics.some((m) => METRICS[m].counter);
  const multi = q.metrics.length > 1;

  // URL mitführen, damit die Auswahl teilbar ist
  useEffect(() => {
    const s = toSearch(q).toString();
    window.history.replaceState(null, "", `${window.location.pathname}${s ? `?${s}` : ""}${window.location.hash || "#graph"}`);
  }, [q]);

  useEffect(() => {
    const ctrl = new AbortController();
    const now = Date.now();
    Promise.all(
      q.metrics.map(async (metric) => {
        const r = await fetch(apiUrl(q, metric, now), { signal: ctrl.signal });
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
        return { metric, ...((await r.json()) as { series: ApiLine[]; bucketMinutes: number }) };
      }),
    )
      .then((results) => {
        const out: Line[] = [];
        for (const res of results) {
          const meta = METRICS[res.metric];
          for (const s of res.series) {
            const single = q.metrics.length === 1;
            out.push({
              ...s,
              id: `${res.metric}:${s.id}`,
              name: single ? s.name : res.series.length > 1 || q.spieler.length ? `${meta.label} · ${s.name}` : meta.label,
              metric: res.metric,
              color: res.metric === "twitchSubs" && res.series.length === 1 ? "var(--amethyst)" : COLORS[out.length % COLORS.length],
              format: meta.format,
            });
          }
        }
        setResult({ key, lines: out, bucketMinutes: Math.max(...results.map((r) => r.bucketMinutes)) });
      })
      .catch((e: Error) => {
        if (e.name === "AbortError") return;
        setResult((prev) => ({ key, lines: prev?.lines, bucketMinutes: prev?.bucketMinutes, error: e.message }));
      });
    return () => ctrl.abort();
  }, [q, key]);

  const set = (patch: Partial<GraphQuery>) => setQ((prev) => ({ ...prev, ...patch }));
  const toggleMetric = (m: Metric) => {
    if (q.metrics.includes(m)) {
      if (q.metrics.length > 1) set({ metrics: q.metrics.filter((x) => x !== m) });
    } else if (q.metrics.length < MAX_METRICS) {
      set({ metrics: [...q.metrics, m] });
    }
  };
  const togglePlayer = (id: string) =>
    set({ spieler: q.spieler.includes(id) ? q.spieler.filter((x) => x !== id) : q.spieler.length >= 12 ? q.spieler : [...q.spieler, id] });

  const suggestions = useMemo(() => {
    const s = search.trim().toLowerCase();
    return players.filter((p) => !q.spieler.includes(p.id) && (!s || p.name.toLowerCase().includes(s) || p.id.includes(s))).slice(0, s ? 12 : 8);
  }, [players, q.spieler, search]);

  const latest = (l: Line) => (l.points.length ? l.format(l.points[l.points.length - 1].v) : "–");
  const peak = (l: Line) => (l.points.length ? l.format(Math.max(...l.points.map((p) => p.v))) : "–");
  const total = (l: Line) => l.format(l.points.reduce((s, p) => s + p.v, 0));
  const hints = [...new Set(q.metrics.map((m) => METRICS[m].hint).filter(Boolean))];
  const bucket = result?.bucketMinutes;

  return (
    <div className="gb" id="graph">
      <div className="box gb__form" data-tone="white">
        <div className="gb__row">
          <p className="eyebrow">Kennzahlen</p>
          <div className="gb__metrics">
            {(["server", "player"] as const).map((grp) => (
              <div key={grp} className="gb__metric-group">
                <span className="gb__group-label">{grp === "server" ? "Server" : "Spieler"}</span>
                <ul className="gb__tiles" aria-label={grp === "server" ? "Server-Kennzahlen" : "Spieler-Kennzahlen"}>
                  {METRIC_KEYS.filter((k) => METRICS[k].perPlayer === (grp === "player")).map((k) => {
                    const m = METRICS[k];
                    const IconCmp = Icon[m.icon as keyof typeof Icon];
                    const on = q.metrics.includes(k);
                    const full = !on && q.metrics.length >= MAX_METRICS;
                    return (
                      <li key={k}>
                        <button type="button" className="gb__tile" data-tone={on ? m.tone : "white"} aria-pressed={on} disabled={full} onClick={() => toggleMetric(k)} title={m.hint}>
                          <span className="gb__tile-icon">
                            <IconCmp width={18} height={18} aria-hidden="true" />
                          </span>
                          <span>{m.label}</span>
                          {on && (
                            <span className="gb__tile-check" aria-hidden="true">
                              ✓
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            <span className="muted gb__hint">
              {q.metrics.length} von {MAX_METRICS} gewählt.{hints.map((h) => ` ${h}.`)}
            </span>
          </div>
        </div>

        {anyPerPlayer && (
          <div className="gb__row gb__row--players">
            <p className="eyebrow">Spieler</p>
            <div className="gb__players">
              <ul className="gb__chips" aria-label="Ausgewählte Spieler">
                <li>
                  <button type="button" className="gb__chip" data-tone={q.spieler.length === 0 ? "ink" : "white"} onClick={() => set({ spieler: [] })}>
                    Alle zusammen
                  </button>
                </li>
                {q.spieler.map((id) => (
                  <li key={id}>
                    <button type="button" className="gb__chip" data-tone="ink" onClick={() => togglePlayer(id)} title="Entfernen">
                      {nameOf.get(id) ?? id} <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="gb__pick">
                <input type="search" placeholder="Spieler suchen …" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Spieler suchen" />
                <ul className="gb__chips" aria-label="Vorschläge">
                  {suggestions.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="gb__chip" data-tone="white" onClick={() => togglePlayer(p.id)} disabled={q.spieler.length >= 12}>
                        + {p.name}
                      </button>
                    </li>
                  ))}
                  {suggestions.length === 0 && <li className="muted">Niemand gefunden.</li>}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="gb__row">
          <p className="eyebrow">Zeitraum</p>
          <div>
            <div className="gb__seg" role="group" aria-label="Zeitraum">
              {RANGES.map((r) => (
                <button key={r.key} type="button" aria-pressed={q.zeit === r.key} onClick={() => set({ zeit: r.key })}>
                  {r.label}
                </button>
              ))}
            </div>
            {q.zeit === "eigen" && (
              <div className="gb__custom">
                <label>
                  <span className="eyebrow">Von</span>
                  <input type="datetime-local" value={q.von} onChange={(e) => set({ von: e.target.value })} />
                </label>
                <label>
                  <span className="eyebrow">Bis</span>
                  <input type="datetime-local" value={q.bis} onChange={(e) => set({ bis: e.target.value })} />
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="gb__row">
          <p className="eyebrow">Raster</p>
          <div className="gb__seg" role="group" aria-label="Raster">
            {RASTER.map((r) => (
              <button key={r.key} type="button" aria-pressed={q.raster === r.key} onClick={() => set({ raster: r.key })}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {anyCounter && (
          <div className="gb__row">
            <p className="eyebrow">Anzeige</p>
            <div>
              <div className="gb__seg" role="group" aria-label="Anzeige">
                <button type="button" aria-pressed={q.modus === "wert"} onClick={() => set({ modus: "wert" })}>
                  Stand
                </button>
                <button type="button" aria-pressed={q.modus === "zuwachs"} onClick={() => set({ modus: "zuwachs" })}>
                  Zuwachs je Raster
                </button>
              </div>
              {q.modus === "zuwachs" && multi && <span className="muted gb__hint">Zuwachs gilt nur für Zähler, andere Kennzahlen zeigen den Stand.</span>}
            </div>
          </div>
        )}
      </div>

      <div className="box gb__chart" data-tone="white" aria-busy={loading} data-loading={loading || undefined}>
        <div className="chart__head">
          <span className="eyebrow">
            {q.metrics.map((m) => METRICS[m].label).join(" + ")}
            {q.modus === "zuwachs" && anyCounter && " · Zuwachs"}
            {bucket !== undefined && <span className="muted"> · {bucket >= 60 ? `${bucket / 60} Std` : `${bucket} Min`} je Punkt</span>}
          </span>
          {loading && <span className="muted">Lädt …</span>}
        </div>
        {error ? <p className="chart__empty">Fehler: {error}</p> : result?.lines ? <MultiChart lines={lines} hidden={hidden} dataKey={result.key} /> : <p className="chart__empty">Lädt …</p>}
        {lines.length > 0 && (
          <ul className="gb__legend" aria-label="Legende">
            {lines.map((l) => {
              const off = hidden.has(l.id);
              const delta = q.modus === "zuwachs" && METRICS[l.metric].counter;
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
                    <span className="num">{delta ? `Σ ${total(l)}` : latest(l)}</span>
                    <span className="muted num">max {peak(l)}</span>
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
