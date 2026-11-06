"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { headUrl } from "@/lib/format";
import type { Centrality } from "@/lib/network";
import { KIND_INFO } from "@/lib/connectionWeights";
import type { GraphEdge, GraphNode } from "./ConnectionGraph";
import { fitView, PanZoomSvg } from "./PanZoomSvg";

const R = 430;
const HEAD = 22;
const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * Nähe ohne gewählten Spieler: alle auf Ringen nach ihrer Zentralität, die Zentralsten in der Mitte. Gruppen liegen
 * nebeneinander im selben Winkelbereich. Darunter alle Verbindungen (Farbe = Art mit den meisten Punkten, Stärke =
 * Punkte); beim Überfahren eines Kopfes nur seine. Anklicken wählt den Spieler aus, Rechtsklick öffnet das Profil.
 */
export function CentralRings({
  nodes,
  central,
  edges,
  groupOf,
  colorOf,
  onSelect,
}: {
  nodes: GraphNode[];
  central: Centrality[];
  edges: GraphEdge[];
  groupOf: Map<string, number>;
  colorOf: ((id: string) => string | null) | null;
  onSelect: (id: string) => void;
}) {
  const router = useRouter();
  const [hover, setHover] = useState<string | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const layout = useMemo(() => {
    const max = Math.max(1e-9, central[0]?.score ?? 0);
    // Nach Gruppe, darin die Zentralsten zuerst: Gruppen bekommen zusammenhängende Winkel
    const order = [...central].sort(
      (a, b) =>
        (groupOf.get(a.id) ?? 999) - (groupOf.get(b.id) ?? 999) ||
        b.score - a.score,
    );
    const pos = new Map<string, { x: number; y: number }>();
    order.forEach((c, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) / order.length) * Math.PI * 2;
      // Nachbarn im Winkel abwechselnd etwas nach innen und außen, damit sich Köpfe weniger überdecken
      const r =
        c.id === central[0]?.id
          ? 0
          : 50 + (1 - c.score / max) * (R - 50) + (i % 2 ? 12 : -12);
      pos.set(c.id, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    });
    const rings = [0.75, 0.5, 0.25].map((f) => ({
      r: 50 + (1 - f) * (R - 50),
      text: `Zentralität ${pct(max * f)}`,
    }));
    return { pos, rings };
  }, [central, groupOf]);
  const h = hover ? central.find((c) => c.id === hover) : null;
  const base = useMemo(
    () => fitView([...layout.pos.values()], HEAD + 34, 320),
    [layout],
  );
  const lines = useMemo(() => {
    const max = Math.max(1e-9, ...edges.map((e) => e.weight));
    return edges
      .filter((e) => layout.pos.has(e.a) && layout.pos.has(e.b))
      .sort((x, y) => x.weight - y.weight)
      .map((e) => ({
        e,
        a: layout.pos.get(e.a)!,
        b: layout.pos.get(e.b)!,
        s: Math.sqrt(e.weight / max),
      }));
  }, [edges, layout]);
  const hoverEdges = hover
    ? lines.filter((l) => l.e.a === hover || l.e.b === hover)
    : [];
  /** Beim Überfahren nur die Namen der stärksten Verbindungen, sonst stehen sie übereinander */
  const named = new Set(
    [...hoverEdges]
      .sort((x, y) => y.e.weight - x.e.weight)
      .slice(0, 5)
      .map((l) => (l.e.a === hover ? l.e.b : l.e.a)),
  );

  return (
    <div className="radial">
      <PanZoomSvg
        base={base}
        className="radial__svg"
        label="Zentralität aller Spieler"
      >
        {(k) => (
          <>
            {layout.rings.map((g) => (
              <g key={g.text} className="radial__ring">
                <circle r={g.r} />
                <text y={-g.r - 6}>{g.text}</text>
              </g>
            ))}
            <g className="radial__links" data-dim={hover ? "" : undefined}>
              {lines.map(({ e, a, b, s }) => (
                <line
                  key={`${e.a}|${e.b}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={KIND_INFO[e.kind].color}
                  style={{
                    strokeWidth: (1 + s * 5) * k,
                    opacity: 0.2 + s * 0.6,
                  }}
                />
              ))}
            </g>
            {hoverEdges.map(({ e, a, b, s }) => (
              <line
                key={`h${e.a}|${e.b}`}
                className="radial__link-on"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={KIND_INFO[e.kind].color}
                style={{ strokeWidth: (1.5 + s * 6) * k }}
              />
            ))}
            {/* Weniger zentrale zuerst zeichnen, damit die Mitte oben liegt */}
            {[...central].reverse().map((c) => {
              const n = byId.get(c.id);
              const p = layout.pos.get(c.id);
              if (!n || !p) return null;
              const own = colorOf?.(c.id);
              const top = c.id === central[0]?.id;
              const linked =
                hover &&
                hover !== c.id &&
                hoverEdges.some((l) => l.e.a === c.id || l.e.b === c.id);
              const size = top ? HEAD * 1.5 : HEAD;
              return (
                <g
                  key={c.id}
                  className="radial__node"
                  style={{
                    transform: `translate(${p.x}px, ${p.y}px)`,
                    opacity: hover && hover !== c.id && !linked ? 0.4 : 1,
                  }}
                  onMouseEnter={() => setHover(c.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSelect(c.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    router.push(`/spieler/${encodeURIComponent(c.id)}`);
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${n.name}: Zentralität ${pct(c.score)}, auswählen`}
                  onKeyDown={(e) =>
                    (e.key === "Enter" || e.key === " ") && onSelect(c.id)
                  }
                >
                  <g style={{ transform: `scale(${k})` }}>
                    <rect
                      x={-size / 2 - 4}
                      y={-size / 2 - 4}
                      width={size + 8}
                      height={size + 8}
                      className="radial__frame"
                      style={
                        own
                          ? { fill: `var(${own})` }
                          : n.live
                            ? { fill: "var(--twitch)" }
                            : undefined
                      }
                    />
                    <image
                      href={headUrl(n.uuid, 64, n.id)}
                      x={-size / 2}
                      y={-size / 2}
                      width={size}
                      height={size}
                      style={{ imageRendering: "pixelated" }}
                    />
                    {(hover === c.id || (top && !hover) || named.has(c.id)) && (
                      <text y={size / 2 + 18} className="radial__label">
                        {n.name}
                      </text>
                    )}
                  </g>
                </g>
              );
            })}
          </>
        )}
      </PanZoomSvg>
      <div className="radial__tip" role="status">
        {h ? (
          <p>
            <b>{byId.get(h.id)?.name ?? h.id}</b>: Zentralität {pct(h.score)} ·{" "}
            {h.direct} direkt verbunden · {h.reached} erreichbar
            {hoverEdges.length > 0 && (
              <span className="muted">
                {" "}
                · stärkste:{" "}
                {[...hoverEdges]
                  .sort((x, y) => y.e.weight - x.e.weight)
                  .slice(0, 3)
                  .map(
                    (l) => byId.get(l.e.a === h.id ? l.e.b : l.e.a)?.name ?? "",
                  )
                  .join(", ")}
              </span>
            )}
          </p>
        ) : (
          <p className="muted">
            Je weiter innen, desto näher steht der Spieler im Schnitt allen
            anderen. Linien: Verbindungen, Farbe nach der stärksten Art. Kopf
            überfahren zeigt nur seine, anklicken wählt ihn aus, Rechtsklick
            öffnet das Profil. Ziehen verschiebt, Strg + Mausrad zoomt.
          </p>
        )}
      </div>
    </div>
  );
}
