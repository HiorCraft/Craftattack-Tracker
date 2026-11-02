"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ConnectionGraph, type GraphEdge, type GraphNode } from "./ConnectionGraph";
import { DIRECTIONS } from "./ConnectionExplorer";
import { Head } from "./Head";
import { PlayerSearch } from "./PlayerSearch";
import { RadialGraph, type RadialScale } from "./RadialGraph";
import { useGroupSettings } from "./GroupSettings";
import { weigh, type LinkCounts } from "@/lib/connectionWeights";
import { adjacency, closeness, directed, distancesFrom, GROUP_COLORS, type Direction } from "@/lib/network";
import { duration, num } from "@/lib/format";

const pct = (v: number) => `${Math.round(v * 100)} %`;

interface Group {
  index: number;
  color: string;
  members: { id: string; inner: number }[];
  /** Anteil der Verbindungsstärke der Mitglieder, der innerhalb der Gruppe bleibt */
  cohesion: number;
  /** Stärkste Verbindung zu einer anderen Gruppe */
  neighbour: { index: number; weight: number } | null;
}

/**
 * Versuchsfläche fürs Netz (intern): Nähe als Ringe um einen Spieler und automatisch erkannte Gruppen.
 * Gerichtet ausgewertet: Raids und Chat-Nachrichten gelten nur in ihre Richtung.
 */
export function NetworkLab({ nodes, edges, internKey }: { nodes: GraphNode[]; edges: LinkCounts[]; internKey: string }) {
  const [tab, setTab] = useState<"naehe" | "gruppen">("naehe");
  const { analysis, weights, controls, shown: isShown, groupEdges } = useGroupSettings(edges);
  const [dir, setDir] = useState<Direction>("von");
  const [scale, setScale] = useState<RadialScale>("naehe");
  /** Wie viele der Nähesten (0 = alle erreichbaren, auch weit entfernte) */
  const [maxNodes, setMaxNodes] = useState(0);
  /** Auch Spieler zeigen, die in dieser Richtung gar nicht verbunden sind (äußerer Ring) */
  const [showAll, setShowAll] = useState(true);
  const [colorGroups, setColorGroups] = useState(true);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // Startpunkt: der Spieler mit den meisten Verbindungen
  const busiest = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of edges) for (const id of [e.a, e.b]) deg.set(id, (deg.get(id) ?? 0) + 1);
    return [...deg.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }, [edges]);
  const [focus, setFocus] = useState("");
  const center = focus || busiest;
  const name = (id: string) => byId.get(id)?.name ?? id;

  const out = useMemo(() => adjacency(edges, weights), [edges, weights]);
  const reach = useMemo(() => (center ? distancesFrom(center, out, dir) : new Map()), [center, out, dir]);
  const groupOf = analysis.groupOf;
  const colorOf = useMemo(() => (colorGroups ? (id: string) => GROUP_COLORS[(groupOf.get(id) ?? 0) % GROUP_COLORS.length] : null), [groupOf, colorGroups]);
  const strengthOf = (parent: string, child: string) => {
    const ab = out.get(parent)?.get(child) ?? 0;
    const ba = out.get(child)?.get(parent) ?? 0;
    return dir === "von" ? ab : dir === "zu" ? ba : Math.min(ab, ba);
  };
  // Zählwerte je Paar für die Erklärung einer Verbindung
  const pairOf = useMemo(() => new Map(edges.map((e) => [`${e.a}|${e.b}`, e])), [edges]);
  const explain = (from: string, to: string) => {
    const e = pairOf.get(from < to ? `${from}|${to}` : `${to}|${from}`);
    if (!e) return "";
    const fwd = e.a === from;
    const raids = fwd ? e.raidsAB : e.raidsBA;
    const msgs = fwd ? e.msgsAB : e.msgsBA;
    const { ab, ba } = directed(e, weights);
    const parts = [
      raids ? `${num(raids)}× geraidet` : null,
      msgs ? `${num(msgs)} Nachrichten im Chat von ${name(to)}` : null,
      e.chats ? `${num(e.chats)}× geteilter Chat (${duration(e.chatSeconds)})` : null,
    ].filter(Boolean);
    const pts = dir === "gegenseitig" ? Math.min(ab, ba) : fwd ? ab : ba;
    return parts.length ? `${parts.join(" · ")} = ${pts.toLocaleString("de-DE", { maximumFractionDigits: 1 })} Punkte` : "";
  };
  const unreachable = useMemo(() => nodes.filter((n) => !reach.has(n.id)).sort((a, b) => a.name.localeCompare(b.name, "de")), [nodes, reach]);

  const groupNodes = useMemo(() => nodes.filter((n) => groupOf.has(n.id)), [nodes, groupOf]);
  const roleAll = useMemo(() => new Map(analysis.groups.flatMap((x) => x.members.map((m) => [m.id, m.role] as const))), [analysis.groups]);
  const groupColor = useMemo(() => (id: string) => GROUP_COLORS[(groupOf.get(id) ?? 0) % GROUP_COLORS.length], [groupOf]);
  const graphEdges: GraphEdge[] = useMemo(() => edges.filter(isShown).map((e) => ({ ...e, ...weigh(e, weights) })).filter((e) => e.weight > 0), [edges, weights, isShown]);
  const groups: Group[] = useMemo(() => {
    const list = new Map<number, Group>();
    const total = new Map<string, number>();
    const inner = new Map<string, number>();
    const between = new Map<string, number>();
    for (const e of groupEdges) {
      const { ab, ba } = directed(e, weights);
      const s = ab + ba;
      if (s <= 0) continue;
      const ga = groupOf.get(e.a)!;
      const gb = groupOf.get(e.b)!;
      for (const id of [e.a, e.b]) total.set(id, (total.get(id) ?? 0) + s);
      if (ga === gb) for (const id of [e.a, e.b]) inner.set(id, (inner.get(id) ?? 0) + s);
      else for (const [x, y] of [[ga, gb], [gb, ga]]) between.set(`${x}|${y}`, (between.get(`${x}|${y}`) ?? 0) + s);
    }
    for (const [id, g] of groupOf) {
      if (!list.has(g)) list.set(g, { index: g, color: GROUP_COLORS[g % GROUP_COLORS.length], members: [], cohesion: 0, neighbour: null });
      list.get(g)!.members.push({ id, inner: inner.get(id) ?? 0 });
    }
    for (const g of list.values()) {
      g.members.sort((a, b) => b.inner - a.inner);
      const t = g.members.reduce((s, m) => s + (total.get(m.id) ?? 0), 0);
      g.cohesion = t ? g.members.reduce((s, m) => s + m.inner, 0) / t : 0;
      for (const [k, w] of between) {
        const [x, y] = k.split("|").map(Number);
        if (x === g.index && (!g.neighbour || w > g.neighbour.weight)) g.neighbour = { index: y, weight: w };
      }
    }
    return [...list.values()].sort((a, b) => a.index - b.index);
  }, [groupEdges, weights, groupOf]);

  return (
    <>
      <div className="box conn__controls" data-tone="white">
        <fieldset className="conn__group">
          <legend className="eyebrow">Ansicht</legend>
          <div className="gb__seg" role="group" aria-label="Ansicht">
            <button type="button" aria-pressed={tab === "naehe"} onClick={() => setTab("naehe")}>
              Nähe zu einem Spieler
            </button>
            <button type="button" aria-pressed={tab === "gruppen"} onClick={() => setTab("gruppen")}>
              Gruppen
            </button>
          </div>
          <label className="conn__row">
            <input type="checkbox" checked={colorGroups} onChange={(e) => setColorGroups(e.target.checked)} /> Rahmen in Gruppenfarbe
          </label>
        </fieldset>
        {tab === "naehe" ? (
          <fieldset className="conn__group">
            <legend className="eyebrow">Mitte</legend>
            <PlayerSearch players={nodes} value={center} onChange={(id) => setFocus(id)} label="Spieler in der Mitte" />
            <div className="gb__seg" role="group" aria-label="Richtung">
              {DIRECTIONS.map((d) => (
                <button key={d.key} type="button" aria-pressed={dir === d.key} title={d.hint} onClick={() => setDir(d.key)}>
                  {d.label}
                </button>
              ))}
            </div>
            <div className="gb__seg" role="group" aria-label="Ringe">
              <button type="button" aria-pressed={scale === "naehe"} onClick={() => setScale("naehe")} title="Abstand zur Mitte = Nähe (stärkere Verbindungen weiter innen)">
                Ringe nach Nähe
              </button>
              <button type="button" aria-pressed={scale === "schritte"} onClick={() => setScale("schritte")} title="Ein Ring je Schritt über andere Spieler">
                Ringe nach Schritten
              </button>
            </div>
            <label className="conn__weight">
              <span className="conn__weight-name">Spieler</span>
              <input
                type="range"
                min={10}
                max={Math.max(10, reach.size - 1)}
                step={1}
                value={maxNodes === 0 ? Math.max(10, reach.size - 1) : Math.min(maxNodes, Math.max(10, reach.size - 1))}
                onChange={(e) => setMaxNodes(Number(e.target.value) >= reach.size - 1 ? 0 : Number(e.target.value))}
              />
              <b className="num conn__weight-val">{maxNodes === 0 || maxNodes >= reach.size - 1 ? "alle" : maxNodes}</b>
              <span className="muted conn__weight-unit">
                die Nähesten von {num(reach.size - 1)} erreichbaren{" "}
                <button type="button" className="tag" onClick={() => setMaxNodes(maxNodes === 0 ? 40 : 0)}>
                  {maxNodes === 0 ? "Nur Umgebung" : "Alle, auch weit weg"}
                </button>
              </span>
            </label>
            <label className="conn__row">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Auch nicht verbundene Spieler zeigen (äußerer Ring)
            </label>
          </fieldset>
        ) : (
          <fieldset className="conn__group">
            <legend className="eyebrow">Gruppen</legend>
            <p className="muted">
              {num(groups.length)} Gruppen. Erkannt nach Louvain: Spieler, die untereinander deutlich mehr verbunden sind als mit dem Rest (beide
              Richtungen zusammen). Feinheit oder Anzahl unten einstellen.
            </p>
          </fieldset>
        )}
      </div>
      {controls}

      {tab === "naehe" ? (
        <>
          <div className="box conn__box" data-tone="white">
            <RadialGraph nodes={nodes} reach={reach} strengthOf={strengthOf} dir={dir} scale={scale} maxNodes={maxNodes === 0 ? reach.size : maxNodes + 1} colorOf={colorOf} onFocus={setFocus} explain={explain} showAll={showAll && maxNodes === 0} />
          </div>
          {center && (
            <p className="muted" style={{ marginTop: 12 }}>
              <Link href={`/spieler/${encodeURIComponent(center)}`}>Profil von {name(center)}</Link> · {num(reach.size - 1)} erreichbar
              {unreachable.length > 0 && `, ${num(unreachable.length)} in dieser Richtung nicht: ${unreachable.slice(0, 12).map((n) => n.name).join(", ")}${unreachable.length > 12 ? " …" : ""}`}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="box conn__box" data-tone="white">
            <ConnectionGraph nodes={groupNodes} edges={graphEdges} territoryOf={groupColor} roleOf={(id) => roleAll.get(id) ?? null} />
          </div>
          <ul className="netlab__groups">
            {groups.map((g) => (
              <li key={g.index} className="box netlab__group" data-tone="white" style={{ borderLeftColor: `var(${g.color})` }}>
                <p className="netlab__group-head">
                  <i style={{ background: `var(${g.color})` }} aria-hidden="true" />{" "}
                  <Link href={`/intern/gruppen/${encodeURIComponent(g.members[0].id)}?key=${encodeURIComponent(internKey)}`}>
                    <b>Gruppe {g.index + 1}</b> → eigene Seite
                  </Link>
                  <span className="muted">
                    {" "}
                    · {num(g.members.length)} Spieler · {pct(g.cohesion)} der Verbindungen bleiben in der Gruppe
                    {g.neighbour && ` · am meisten mit Gruppe ${g.neighbour.index + 1}`}
                  </span>
                </p>
                <ul className="netlab__members">
                  {g.members.map((m, i) => (
                    <li key={m.id}>
                      <button type="button" className="tag tag--head" data-tone={i < 3 ? "gold" : "white"} title={i < 3 ? "Kern der Gruppe (am stärksten verbunden)" : undefined} onClick={() => (setFocus(m.id), setTab("naehe"))}>
                        <Head id={m.id} uuid={byId.get(m.id)?.uuid} name={name(m.id)} size={20} src={32} decorative /> {name(m.id)}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === "naehe" && center && (
        <div className="box" data-tone="white" style={{ marginTop: 24 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Am nächsten</th>
                  <th className="num">Nähe</th>
                  <th className="num">Schritte</th>
                  <th>Gruppe</th>
                </tr>
              </thead>
              <tbody>
                {[...reach.values()]
                  .filter((r) => r.id !== center)
                  .sort((a, b) => a.dist - b.dist)
                  .slice(0, 15)
                  .map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button type="button" className="conn__person" onClick={() => setFocus(r.id)}>
                          <Head id={r.id} uuid={byId.get(r.id)?.uuid} name={name(r.id)} size={22} decorative /> <span>{name(r.id)}</span>
                        </button>
                      </td>
                      <td className="num">{pct(closeness(r.dist))}</td>
                      <td className="num">{r.hops === 1 ? "direkt" : num(r.hops)}</td>
                      <td>
                        <i className="netlab__swatch" style={{ background: `var(${GROUP_COLORS[(groupOf.get(r.id) ?? 0) % GROUP_COLORS.length]})` }} aria-hidden="true" /> {(groupOf.get(r.id) ?? 0) + 1}
                        {groupOf.get(r.id) === groupOf.get(center) && <span className="muted"> (gleiche)</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
