"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { GraphNode } from "./ConnectionGraph";
import { Explain } from "./Explain";
import { DIRECTIONS } from "./ConnectionExplorer";
import { Head } from "./Head";
import { PlayerSearch } from "./PlayerSearch";
import { RadialGraph, type RadialScale } from "./RadialGraph";
import { useGroupSettings } from "./GroupSettings";
import type { LinkCounts } from "@/lib/connectionWeights";
import { adjacency, closeness, directed, distancesFrom, GROUP_COLORS, type Direction } from "@/lib/network";
import { duration, num } from "@/lib/format";

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * Nähe (/naehe): ein Spieler in der Mitte, alle anderen nach ihrer Nähe zu ihm (Ringe).
 * Gruppen haben eine eigene Seite (/gruppen); hier färben sie nur die Rahmen. Die Mitte steht in der Adresse (`?spieler=`).
 * Gerichtet ausgewertet: Raids und Chat-Nachrichten gelten nur in ihre Richtung.
 */
export function NetworkLab({
  nodes,
  edges,
  initialFocus = "",
  ranges,
  range,
}: {
  nodes: GraphNode[];
  edges: LinkCounts[];
  initialFocus?: string;
  ranges: { key: string; label: string }[];
  range: string;
}) {
  const { analysis, weights, controls } = useGroupSettings(edges);
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
  const [focus, setFocus] = useState(initialFocus);
  const center = focus || busiest;
  // Mitte in der Adresse halten (teilbar, Zeitraum-Wechsel behält sie)
  useEffect(() => {
    if (!focus) return;
    const u = new URL(window.location.href);
    u.searchParams.set("spieler", focus);
    window.history.replaceState(window.history.state, "", u);
  }, [focus]);
  const rangeHref = (key: string) => {
    const q = new URLSearchParams({ ...(key === "alle" ? {} : { zeit: key }), ...(focus ? { spieler: focus } : {}) }).toString();
    return q ? `/naehe?${q}` : "/naehe";
  };
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
    const title = fwd ? e.titleAB : e.titleBA;
    const { ab, ba } = directed(e, weights);
    const parts = [
      raids ? `${num(raids)}× geraidet` : null,
      msgs ? `${num(msgs)} Nachrichten im Chat von ${name(to)}` : null,
      title ? `${duration(title)} Stream mit ${name(to)} im Titel` : null,
      e.chats ? `${num(e.chats)}× geteilter Chat (${duration(e.chatSeconds)})` : null,
    ].filter(Boolean);
    const pts = dir === "gegenseitig" ? Math.min(ab, ba) : fwd ? ab : ba;
    return parts.length ? `${parts.join(" · ")} = ${pts.toLocaleString("de-DE", { maximumFractionDigits: 1 })} Punkte` : "";
  };
  const unreachable = useMemo(() => nodes.filter((n) => !reach.has(n.id)).sort((a, b) => a.name.localeCompare(b.name, "de")), [nodes, reach]);

  const nearest = [...reach.values()].filter((r) => r.id !== center).sort((a, b) => a.dist - b.dist);
  const reachMax = Math.max(10, reach.size - 1);

  return (
    <div className="conn__layout">
      <div className="conn__side stack" style={{ "--stack": "12px" } as React.CSSProperties}>
        <div className="box conn__controls" data-tone="white">
          <fieldset className="conn__group">
            <legend className="eyebrow">Zeitraum</legend>
            <div className="gb__seg" role="group" aria-label="Zeitraum">
              {ranges.map((r) => (
                <Link key={r.key} href={rangeHref(r.key)} aria-current={range === r.key ? "true" : undefined} scroll={false}>
                  {r.label}
                </Link>
              ))}
            </div>
          </fieldset>
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
          </fieldset>
          <fieldset className="conn__group">
            <legend className="eyebrow">Ringe</legend>
            <div className="gb__seg" role="group" aria-label="Ringe">
              <button type="button" aria-pressed={scale === "naehe"} onClick={() => setScale("naehe")} title="Abstand zur Mitte = Nähe (stärkere Verbindungen weiter innen)">
                Nach Nähe
              </button>
              <button type="button" aria-pressed={scale === "schritte"} onClick={() => setScale("schritte")} title="Ein Ring je Schritt über andere Spieler">
                Nach Schritten
              </button>
            </div>
            <label className="conn__weight" title={`Die Nähesten von ${num(reach.size - 1)} erreichbaren`}>
              <span className="conn__weight-name">Spieler</span>
              <input
                type="range"
                min={10}
                max={reachMax}
                step={1}
                value={maxNodes === 0 ? reachMax : Math.min(maxNodes, reachMax)}
                onChange={(e) => setMaxNodes(Number(e.target.value) >= reach.size - 1 ? 0 : Number(e.target.value))}
              />
              <b className="num conn__weight-val">{maxNodes === 0 || maxNodes >= reach.size - 1 ? "alle" : maxNodes}</b>
            </label>
            <label className="conn__row">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Nicht verbundene außen zeigen
            </label>
            <label className="conn__row">
              <input type="checkbox" checked={colorGroups} onChange={(e) => setColorGroups(e.target.checked)} /> Rahmen in Gruppenfarbe
            </label>
          </fieldset>
        </div>
        {controls}
      </div>

      <div className="conn__main">
        <div className="box conn__box" data-tone="white">
          <RadialGraph nodes={nodes} reach={reach} strengthOf={strengthOf} dir={dir} scale={scale} maxNodes={maxNodes === 0 ? reach.size : maxNodes + 1} colorOf={colorOf} onFocus={setFocus} explain={explain} showAll={showAll && maxNodes === 0} />
          {center && (
            <p className="muted conn__legend">
              <Link href={`/spieler/${encodeURIComponent(center)}`}>Profil von {name(center)}</Link> · {num(reach.size - 1)} erreichbar
              {unreachable.length > 0 && (
                <>
                  {" "}
                  · {num(unreachable.length)} nicht{" "}
                  <Explain label="Nicht erreichbar">
                    In dieser Richtung nicht verbunden: {unreachable.map((n) => n.name).join(", ")}
                  </Explain>
                </>
              )}
              {" · "}
              <Link href={`/gruppen/${encodeURIComponent(center)}`}>Gruppe von {name(center)}</Link>
            </p>
          )}
        </div>

        {center && nearest.length > 0 && (
          <div className="box" data-tone="white" style={{ marginTop: 16 }}>
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
                  {nearest.slice(0, 15).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button type="button" className="conn__person" onClick={() => setFocus(r.id)}>
                          <Head id={r.id} uuid={byId.get(r.id)?.uuid} name={name(r.id)} size={22} decorative /> <span>{name(r.id)}</span>
                        </button>
                      </td>
                      <td className="num">{pct(closeness(r.dist))}</td>
                      <td className="num">{r.hops === 1 ? "direkt" : num(r.hops)}</td>
                      <td>
                        <Link href={`/gruppen/${encodeURIComponent(r.id)}`} className="conn__person">
                          <i className="netlab__swatch" style={{ background: `var(${GROUP_COLORS[(groupOf.get(r.id) ?? 0) % GROUP_COLORS.length]})` }} aria-hidden="true" />{" "}
                          {groupOf.get(r.id) === groupOf.get(center) ? "gleiche" : `um ${name(analysis.groups[groupOf.get(r.id) ?? -1]?.leader ?? r.id)}`}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
