"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { headUrl } from "@/lib/format";
import { closeness, type Direction, type Reach } from "@/lib/network";
import type { GraphNode } from "./ConnectionGraph";

export type RadialScale = "schritte" | "naehe";

const R = 430;
const HEAD = 30;

/**
 * Ein Spieler in der Mitte, alle anderen auf Ringen nach ihrem Abstand zu ihm. Gezeichnet werden nur die Wege der
 * kürzesten Verbindungen vom Mittelpunkt aus (ein Baum): Wie nah die anderen untereinander stehen, zeigt das Bild
 * bewusst nicht. Wer über denselben direkten Kontakt erreicht wird, liegt im selben Winkelbereich wie dieser.
 * Klick auf einen Kopf stellt ihn in die Mitte. Mit `showAll` stehen alle übrigen Spieler (in dieser Richtung nicht
 * verbunden) auf einem äußeren Ring. Linien und Köpfe lassen sich überfahren: `explain` sagt, was die Verbindung ausmacht.
 */
export function RadialGraph({
  nodes,
  reach,
  strengthOf,
  dir,
  scale,
  maxNodes,
  colorOf,
  onFocus,
  explain,
  showAll = false,
}: {
  nodes: GraphNode[];
  reach: Map<string, Reach>;
  /** Stärke der genutzten Verbindung vom Vorgänger zum Spieler (für die Linienbreite) */
  strengthOf: (parent: string, child: string) => number;
  dir: Direction;
  scale: RadialScale;
  maxNodes: number;
  colorOf?: ((id: string) => string | null) | null;
  onFocus: (id: string) => void;
  /** Erklärung einer Verbindung in Richtung der Beziehung (from → to), z. B. „3× geraidet · 120 Nachr.“ */
  explain: (from: string, to: string) => string;
  /** Auch nicht verbundene Spieler zeigen (äußerer Ring) */
  showAll?: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [edge, setEdge] = useState<{ parent: string; child: string } | null>(null);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const router = useRouter();
  /** Rechtsklick (Handy: lange drücken) öffnet das Profil */
  const profile = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    router.push(`/spieler/${encodeURIComponent(id)}`);
  };

  const layout = useMemo(() => {
    const list = [...reach.values()].sort((a, b) => a.dist - b.dist).slice(0, maxNodes);
    const inside = new Set(list.map((r) => r.id));
    const root = list[0];
    if (!root) return null;
    const kids = new Map<string, Reach[]>();
    for (const r of list) if (r.parent && inside.has(r.parent)) (kids.get(r.parent) ?? kids.set(r.parent, []).get(r.parent)!).push(r);
    const leaves = new Map<string, number>();
    const count = (id: string): number => {
      const c = kids.get(id) ?? [];
      const n = c.length ? c.reduce((s, k) => s + count(k.id), 0) : 1;
      leaves.set(id, n);
      return n;
    };
    count(root.id);
    const maxHops = Math.max(1, ...list.map((r) => r.hops));
    const radius = (r: Reach, parentR: number) => {
      if (r.hops === 0) return 0;
      if (scale === "schritte") return (r.hops / maxHops) * R;
      return Math.max(parentR + 46, (1 - closeness(r.dist)) * R * 1.15);
    };
    const pos = new Map<string, { x: number; y: number; r: number; a: number }>();
    const place = (id: string, a0: number, a1: number, parentR: number) => {
      const r = reach.get(id)!;
      const rad = radius(r, parentR);
      const a = (a0 + a1) / 2;
      pos.set(id, { x: Math.cos(a) * rad, y: Math.sin(a) * rad, r: rad, a });
      const c = [...(kids.get(id) ?? [])].sort((x, y) => x.dist - y.dist);
      const total = leaves.get(id) ?? 1;
      let start = a0;
      // Die Nähesten in die Mitte ihres Bereichs: abwechselnd links und rechts einsortieren
      const ordered: Reach[] = [];
      c.forEach((k, i) => (i % 2 ? ordered.push(k) : ordered.unshift(k)));
      for (const k of ordered) {
        const span = ((a1 - a0) * (leaves.get(k.id) ?? 1)) / total;
        place(k.id, start, start + span, rad);
        start += span;
      }
    };
    place(root.id, -Math.PI / 2, (Math.PI * 3) / 2, 0);
    const rings =
      scale === "schritte"
        ? Array.from({ length: maxHops }, (_, i) => ({ r: ((i + 1) / maxHops) * R, text: i === 0 ? "direkt" : `${i + 1} Schritte` }))
        : [0.75, 0.5, 0.25].map((c) => ({ r: (1 - c) * R * 1.15, text: `Nähe ${Math.round(c * 100)} %` }));
    // Nicht verbundene Spieler gleichmäßig auf einem äußeren Ring
    const outside = showAll ? nodes.filter((n) => !reach.has(n.id)).sort((a, b) => a.name.localeCompare(b.name, "de")) : [];
    outside.forEach((n, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) / outside.length) * Math.PI * 2;
      pos.set(n.id, { x: Math.cos(a) * (R + 40), y: Math.sin(a) * (R + 40), r: R + 40, a });
    });
    return { list, pos, rings, root: root.id, outside };
  }, [reach, maxNodes, scale, showAll, nodes]);

  if (!layout) return <p className="muted">Niemand gewählt.</p>;
  const { list, pos, rings, root, outside } = layout;
  const extent = outside.length ? R + 100 : R + 60;
  const maxS = Math.max(1, ...list.filter((r) => r.parent).map((r) => strengthOf(r.parent!, r.id)));
  const h = hover ? reach.get(hover) : null;
  const name = (id: string) => byId.get(id)?.name ?? id;
  const onPath = new Set(h?.path ?? []);
  /** Richtung der Beziehung eines Baum-Schritts: von = Vorgänger → Spieler, zu = Spieler → Vorgänger */
  const rel = (parent: string, child: string): [string, string] => (dir === "zu" ? [child, parent] : [parent, child]);
  const arrow = dir === "gegenseitig" ? " ↔ " : " → ";
  const steps = (r: Reach) => r.path.slice(1).map((id, i) => rel(r.path[i], id));

  return (
    <div className="radial">
      <svg viewBox={`${-extent} ${-extent + 10} ${extent * 2} ${extent * 2 - 20}`} className="radial__svg" role="img" aria-label={`Nähe zu ${name(root)}`}>
        <defs>
          <marker id="radial-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {rings.map((g) => (
          <g key={g.text} className="radial__ring">
            <circle r={g.r} />
            <text y={-g.r - 6}>{g.text}</text>
          </g>
        ))}
        {list
          .filter((r) => r.parent && pos.has(r.parent))
          .map((r) => {
            const a = pos.get(r.parent!)!;
            const b = pos.get(r.id)!;
            const s = Math.sqrt(strengthOf(r.parent!, r.id) / maxS);
            // Pfeil in Richtung der Verbindung: von = vom Vorgänger weg, zu = zum Vorgänger hin
            const [p, q] = dir === "zu" ? [b, a] : [a, b];
            const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
            const cut = HEAD / 2 + 6;
            const ux = (q.x - p.x) / len;
            const uy = (q.y - p.y) / len;
            const isEdge = edge?.child === r.id;
            const active = isEdge || (!hover && !edge) || (hover && onPath.has(r.id) && onPath.has(r.parent!));
            const coords = { x1: p.x + ux * cut, y1: p.y + uy * cut, x2: q.x - ux * cut, y2: q.y - uy * cut };
            return (
              <g key={r.id}>
                <line
                  {...coords}
                  className="radial__edge"
                  data-on={isEdge || undefined}
                  style={{ strokeWidth: (isEdge ? 3 : 1.5) + s * 6, opacity: active ? 0.85 : 0.12 }}
                  markerEnd={dir === "gegenseitig" ? undefined : "url(#radial-arrow)"}
                />
                {/* Breite, unsichtbare Fläche zum Überfahren */}
                <line {...coords} className="radial__hit" onMouseEnter={() => setEdge({ parent: r.parent!, child: r.id })} onMouseLeave={() => setEdge(null)} />
              </g>
            );
          })}
        {list.map((r) => {
          const p = pos.get(r.id);
          const n = byId.get(r.id);
          if (!p || !n) return null;
          const own = colorOf?.(r.id);
          const size = r.id === root ? HEAD * 1.6 : HEAD;
          const dim = hover && !onPath.has(r.id) && r.id !== hover;
          return (
            <g
              key={r.id}
              className="radial__node"
              style={{ transform: `translate(${p.x}px, ${p.y}px)`, opacity: dim ? 0.35 : 1 }}
              onMouseEnter={() => setHover(r.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => r.id !== root && onFocus(r.id)}
              onContextMenu={profile(r.id)}
              role="button"
              tabIndex={0}
              aria-label={`${n.name}: Nähe ${Math.round(closeness(r.dist) * 100)} %, in die Mitte stellen`}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && r.id !== root && onFocus(r.id)}
            >
              <rect x={-size / 2 - 4} y={-size / 2 - 4} width={size + 8} height={size + 8} className="radial__frame" style={own ? { fill: `var(${own})` } : n.live ? { fill: "var(--twitch)" } : undefined} />
              <image href={headUrl(n.uuid, 64, n.id)} x={-size / 2} y={-size / 2} width={size} height={size} style={{ imageRendering: "pixelated" }} />
              {/* Name nur beim überfahrenen Kopf und in der Mitte, sonst verdecken die Namen das Bild */}
              {(r.id === hover || r.id === root) && (
                <text y={size / 2 + 18} className="radial__label">
                  {n.name}
                </text>
              )}
            </g>
          );
        })}
        {outside.map((n) => {
          const p = pos.get(n.id)!;
          const size = HEAD * 0.75;
          return (
            <g
              key={n.id}
              className="radial__node radial__node--out"
              style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onFocus(n.id)}
              onContextMenu={profile(n.id)}
              role="button"
              tabIndex={0}
              aria-label={`${n.name}: in dieser Richtung nicht verbunden, in die Mitte stellen`}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onFocus(n.id)}
            >
              <rect x={-size / 2 - 3} y={-size / 2 - 3} width={size + 6} height={size + 6} className="radial__frame" />
              <image href={headUrl(n.uuid, 64, n.id)} x={-size / 2} y={-size / 2} width={size} height={size} style={{ imageRendering: "pixelated" }} />
              {hover === n.id && (
                <text y={size / 2 + 16} className="radial__label">
                  {n.name}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="radial__tip" role="status">
        {edge ? (
          (() => {
            const [a, b] = rel(edge.parent, edge.child);
            return (
              <p>
                <b>
                  {name(a)}
                  {arrow}
                  {name(b)}
                </b>
                : {explain(a, b) || "keine Verbindung in diese Richtung"}
              </p>
            );
          })()
        ) : h && h.id !== root ? (
          <>
            <p>
              <b>{name(h.id)}</b>: Nähe {Math.round(closeness(h.dist) * 100)} %, {h.hops === 1 ? "direkt verbunden" : `über ${h.hops - 1} Spieler dazwischen`}
            </p>
            <ol className="radial__steps">
              {(dir === "zu" ? [...steps(h)].reverse() : steps(h)).map(([a, b]) => (
                <li key={`${a}|${b}`}>
                  {name(a)}
                  {arrow}
                  {name(b)}: <span className="muted">{explain(a, b)}</span>
                </li>
              ))}
            </ol>
          </>
        ) : hover && !reach.has(hover) ? (
          <p>
            <b>{name(hover)}</b>: <span className="muted">in dieser Richtung mit {name(root)} nicht verbunden, auch nicht über andere.</span>
          </p>
        ) : (
          <p className="muted">Kopf überfahren für den Weg und warum, Linie überfahren für die einzelne Verbindung, Kopf anklicken stellt ihn in die Mitte, Rechtsklick öffnet das Profil.</p>
        )}
      </div>
    </div>
  );
}
