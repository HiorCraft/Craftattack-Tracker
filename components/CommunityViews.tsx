"use client";

import { useMemo } from "react";
import { ConnectionGraph } from "./ConnectionGraph";
import { RadialGraph } from "./RadialGraph";
import { CentralRings } from "./CentralRings";
import { Explain } from "./Explain";
import { Head } from "./Head";
import { ShowMore } from "./ShowMore";
import type { CommunityCtx } from "./communityCtx";
import { GroupCards, GroupDetail, GroupMap } from "./GroupViews";
import { ROLE_LABEL, type Role } from "@/lib/groups";
import { adjacency, centralities, closeness, directed, distancesFrom } from "@/lib/network";
import { duration, num } from "@/lib/format";

const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Spieler in Tabellen: anklicken wählt ihn aus (wie im Graphen) */
export function Person({ c, id, size = 22 }: { c: CommunityCtx; id: string; size?: number }) {
  return (
    <button type="button" className="conn__person" onClick={() => c.select(id)} title={`${c.name(id)} auswählen`} data-active={c.focus === id || undefined}>
      <Head id={id} uuid={c.byId.get(id)?.uuid} name={c.name(id)} size={size} decorative /> <span>{c.name(id)}</span>
    </button>
  );
}

const ROLE_ORDER: Role[] = ["anfuehrer", "kern", "mitglied", "rand"];

/**
 * Verbindungen: das ganze Netz (ein gewählter Spieler ist hervorgehoben), darunter die stärksten Verbindungen bzw. seine.
 * Mit Gruppen: Flächen und Rollen im Netz, darunter die Gruppen bzw. die Gruppe des Spielers.
 */
export function NetzView({ c }: { c: CommunityCtx }) {
  const { focus, weighted, s, analysis } = c;
  const groups = s.groups;
  const { gNodes, gEdges } = useMemo(() => {
    const ids = new Set(weighted.flatMap((e) => [e.a, e.b]));
    return { gNodes: c.nodes.filter((n) => ids.has(n.id)), gEdges: weighted };
  }, [weighted, c.nodes]);
  const roleOf = useMemo(() => {
    const roles = new Map(analysis.groups.flatMap((g) => g.members.map((m) => [m.id, m.role] as const)));
    return (id: string) => roles.get(id) ?? null;
  }, [analysis.groups]);
  const top = useMemo(
    () => weighted.filter((e) => !focus || e.a === focus || e.b === focus).sort((a, b) => b.weight - a.weight || b.chatSeconds - a.chatSeconds),
    [weighted, focus],
  );
  const inNet = !focus || gNodes.some((n) => n.id === focus);
  const map = groups && !focus && s.groupMap;

  return (
    <>
      <div className="box conn__box" data-tone="white">
        {map ? (
          <GroupMap c={c} />
        ) : inNet ? (
          <ConnectionGraph
            nodes={gNodes}
            edges={gEdges}
            focus={c.hover ?? (focus || null)}
            territoryOf={groups ? c.groupColor : null}
            roleOf={groups ? roleOf : null}
            onSelect={c.select}
          />
        ) : (
          <p className="muted conn__empty">{c.name(focus)} ist mit diesen Einstellungen mit niemandem verbunden.</p>
        )}
        <ul className="conn__legend muted">
          {map ? (
            <li>Ein Kopf je Gruppe (ihr Anführer), Größe = Stärke der Gruppe, Linien = Verbindungen zwischen den Gruppen</li>
          ) : groups ? (
            <>
              <li>Fläche = Gruppe</li>
              {ROLE_ORDER.map((r) => (
                <li key={r}>
                  <span className={`gx-role gx-role--${r}`} aria-hidden="true" /> {ROLE_LABEL[r]}
                </li>
              ))}
            </>
          ) : (
            <>
              <li>
                <i style={{ background: "var(--twitch)" }} /> vor allem Raids
              </li>
              <li>
                <i style={{ background: "var(--diamond)" }} /> vor allem geteilter Chat
              </li>
              <li>
                <i style={{ background: "var(--grass)" }} /> vor allem Stream-Titel
              </li>
              <li>
                <i style={{ background: "var(--gold)" }} /> vor allem Chat-Nachrichten
              </li>
            </>
          )}
          <li>
            <Explain label="Bedienung">
              Kopf anklicken wählt den Spieler aus (Touch: einmal tippen zeigt den Namen, zweimal wählt aus), Rechtsklick öffnet sein Profil. Kopf ziehen zum
              Verschieben. Lila Rahmen: live · grünes Kästchen: auf dem Server.
            </Explain>
          </li>
        </ul>
      </div>

      {groups && (focus ? <GroupDetail c={c} /> : <GroupCards c={c} />)}

      <div className="section-head" style={{ marginTop: 32 }}>
        <h2 className="t-2">
          {focus ? `Verbindungen von ${c.name(focus)}` : "Stärkste Verbindungen"} <Explain>Punkte nach der eingestellten Gewichtung.</Explain>
        </h2>
      </div>
      {top.length === 0 ? (
        <p className="muted">Mit diesen Einstellungen gibt es keine Verbindungen.</p>
      ) : (
        <div className="box" data-tone="white">
          <ShowMore height={720} label="Verbindungen">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Spieler</th>
                    <th />
                    <th className="num">Raids →</th>
                    <th className="num">← Raids</th>
                    <th className="num">Geteilte Chats</th>
                    <th className="num">Zeit im Chat</th>
                    <th className="num" title="Stream-Zeit, in der der erste Spieler den zweiten im Titel nannte (höchstens 8 Std je Tag)">
                      Titel →
                    </th>
                    <th className="num" title="Stream-Zeit, in der der zweite Spieler den ersten im Titel nannte">
                      ← Titel
                    </th>
                    <th className="num" title="Nachrichten des ersten Spielers im Chat des zweiten">
                      Nachr. →
                    </th>
                    <th className="num" title="Nachrichten des zweiten Spielers im Chat des ersten">
                      ← Nachr.
                    </th>
                    <th className="num">Punkte</th>
                  </tr>
                </thead>
                <tbody>
                  {top.slice(0, 60).map((e) => {
                    // Gewählter Spieler immer links, Richtungen passend gedreht
                    const flip = focus !== "" && e.b === focus;
                    const [a, b] = flip ? [e.b, e.a] : [e.a, e.b];
                    const [rAB, rBA, tAB, tBA, mAB, mBA] = flip ? [e.raidsBA, e.raidsAB, e.titleBA, e.titleAB, e.msgsBA, e.msgsAB] : [e.raidsAB, e.raidsBA, e.titleAB, e.titleBA, e.msgsAB, e.msgsBA];
                    return (
                      <tr key={`${e.a}|${e.b}`}>
                        <td>
                          <Person c={c} id={a} />
                        </td>
                        <td>
                          <Person c={c} id={b} />
                        </td>
                        <td className="num">{rAB ? num(rAB) : "–"}</td>
                        <td className="num">{rBA ? num(rBA) : "–"}</td>
                        <td className="num">
                          {e.now && (
                            <span className="tag" data-tone="grass" style={{ fontSize: ".75rem", padding: "1px 6px", marginRight: 6 }}>
                              jetzt
                            </span>
                          )}
                          {e.chats ? num(e.chats) : "–"}
                        </td>
                        <td className="num">{e.chatSeconds ? duration(e.chatSeconds) : "–"}</td>
                        <td className="num">{tAB ? duration(tAB) : "–"}</td>
                        <td className="num">{tBA ? duration(tBA) : "–"}</td>
                        <td className="num">{mAB ? num(mAB) : "–"}</td>
                        <td className="num">{mBA ? num(mBA) : "–"}</td>
                        <td className="num">
                          <b>{dec.format(e.weight)}</b>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </ShowMore>
          {top.length > 60 && <p className="muted">… und {num(top.length - 60)} schwächere.</p>}
        </div>
      )}
    </>
  );
}

/** Distanz: ohne Spieler die Zentralität aller, mit Spieler die Ringe um ihn */
export function NaeheView({ c }: { c: CommunityCtx }) {
  const { focus, s, counts, weights, analysis } = c;
  const out = useMemo(() => adjacency(counts, weights), [counts, weights]);
  const ids = useMemo(() => [...new Set(counts.flatMap((e) => [e.a, e.b]))], [counts]);
  const netNodes = useMemo(() => c.nodes.filter((n) => ids.includes(n.id)), [c.nodes, ids]);
  const colorOf = s.groups ? c.groupColor : null;
  const groupLabel = (id: string) => {
    if (!s.groups) return null;
    const gi = analysis.groupOf.get(id);
    if (gi === undefined) return null;
    const g = analysis.groups[gi];
    return (
      <span className="conn__person">
        <i className="netlab__swatch" style={{ background: `var(${g.color})` }} aria-hidden="true" /> {focus && analysis.groupOf.get(focus) === gi ? "gleiche" : `um ${c.name(g.leader)}`}
      </span>
    );
  };

  // Allgemein: Zentralität (nur wenn gebraucht, sonst unnötig gerechnet)
  const central = useMemo(() => (focus ? [] : centralities(ids, out, s.dir)), [focus, ids, out, s.dir]);

  const reach = useMemo(() => (focus && ids.includes(focus) ? distancesFrom(focus, out, s.dir) : new Map()), [focus, ids, out, s.dir]);
  const pairOf = useMemo(() => new Map(counts.map((e) => [`${e.a}|${e.b}`, e])), [counts]);
  const strengthOf = (parent: string, child: string) => {
    const ab = out.get(parent)?.get(child) ?? 0;
    const ba = out.get(child)?.get(parent) ?? 0;
    return s.dir === "von" ? ab : s.dir === "zu" ? ba : Math.min(ab, ba);
  };
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
      msgs ? `${num(msgs)} Nachrichten im Chat von ${c.name(to)}` : null,
      title ? `${duration(title)} Stream mit ${c.name(to)} im Titel` : null,
      e.chats ? `${num(e.chats)}× geteilter Chat (${duration(e.chatSeconds)})` : null,
    ].filter(Boolean);
    const pts = s.dir === "gegenseitig" ? Math.min(ab, ba) : fwd ? ab : ba;
    return parts.length ? `${parts.join(" · ")} = ${pts.toLocaleString("de-DE", { maximumFractionDigits: 1 })} Punkte` : "";
  };

  if (!focus) {
    return (
      <>
        <div className="box conn__box" data-tone="white">
          {central.length ? <CentralRings nodes={netNodes} central={central} edges={c.weighted} groupOf={analysis.groupOf} colorOf={colorOf} onSelect={c.select} /> : <p className="muted conn__empty">Mit diesen Einstellungen gibt es keine Verbindungen.</p>}
        </div>
        <div className="section-head" style={{ marginTop: 32 }}>
          <h2 className="t-2">
            Wer steht allen am nächsten?{" "}
            <Explain>
              Zentralität: die durchschnittliche Nähe zu allen anderen Spielern über den kürzesten Weg im Netz (nicht erreichbar zählt 0).{" "}
              {s.dir === "von" ? "„Von ihm aus“: wie gut er die anderen erreicht." : s.dir === "zu" ? "„Zu ihm hin“: wie nah die anderen ihm kommen." : "Nur gegenseitige Verbindungen."} Spieler
              anklicken zeigt die Nähe aller zu ihm.
            </Explain>
          </h2>
        </div>
        {central.length > 0 && (
          <div className="box" data-tone="white">
            <ShowMore height={720} label="Spieler">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Spieler</th>
                      <th className="num">Zentralität</th>
                      <th className="num">Direkt verbunden</th>
                      <th className="num">Erreichbar</th>
                      {s.groups && <th>Gruppe</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {central.map((r, i) => (
                      <tr key={r.id}>
                        <td className="num muted">{i + 1}</td>
                        <td>
                          <Person c={c} id={r.id} />
                        </td>
                        <td className="num">
                          <span className="conn__near" style={{ "--near": r.score / Math.max(1e-9, central[0].score) } as React.CSSProperties}>
                            {pct(r.score)}
                          </span>
                        </td>
                        <td className="num">{num(r.direct)}</td>
                        <td className="num">{num(r.reached)}</td>
                        {s.groups && <td>{groupLabel(r.id)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ShowMore>
          </div>
        )}
      </>
    );
  }

  const nearest = [...reach.values()].filter((r) => r.id !== focus).sort((a, b) => a.dist - b.dist);
  const unreachable = netNodes.filter((n) => !reach.has(n.id));
  const maxNodes = s.maxNodes === 0 ? reach.size : s.maxNodes + 1;

  return (
    <>
      <div className="box conn__box" data-tone="white">
        {reach.size ? (
          <RadialGraph
            nodes={netNodes}
            reach={reach}
            strengthOf={strengthOf}
            dir={s.dir}
            scale={s.scale}
            maxNodes={maxNodes}
            colorOf={colorOf}
            onFocus={c.select}
            explain={explain}
            showAll={s.showAll && s.maxNodes === 0}
          />
        ) : (
          <p className="muted conn__empty">{c.name(focus)} ist mit diesen Einstellungen mit niemandem verbunden.</p>
        )}
        {reach.size > 0 && (
          <p className="muted conn__legend">
            {num(reach.size - 1)} erreichbar
            {unreachable.length > 0 && (
              <>
                {" "}
                · {num(unreachable.length)} nicht <Explain label="Nicht erreichbar">In dieser Richtung nicht verbunden: {unreachable.map((n) => n.name).join(", ")}</Explain>
              </>
            )}
          </p>
        )}
      </div>

      <div className="section-head" style={{ marginTop: 32 }}>
        <h2 className="t-2">
          Wie nah steht {c.name(focus)} den anderen?{" "}
          <Explain>
            Über den kürzesten Weg im Netz. Raids, Titel und Chat-Nachrichten zählen nur in ihre Richtung, geteilter Chat in beide. Nähe 50 % = direkt mit 1 Punkt
            verbunden; über Umwege sinkt sie.
          </Explain>
        </h2>
      </div>
      {nearest.length === 0 ? (
        <p className="muted">In dieser Richtung ist niemand verbunden.</p>
      ) : (
        <div className="box" data-tone="white">
          <ShowMore height={720} label="Spieler">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Spieler</th>
                    <th className="num">Nähe</th>
                    <th className="num">Schritte</th>
                    <th>Weg</th>
                    {s.groups && <th>Gruppe</th>}
                  </tr>
                </thead>
                <tbody>
                  {nearest.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Person c={c} id={r.id} />
                      </td>
                      <td className="num">
                        <span className="conn__near" style={{ "--near": closeness(r.dist) } as React.CSSProperties}>
                          {pct(closeness(r.dist))}
                        </span>
                      </td>
                      <td className="num">{r.hops === 1 ? "direkt" : num(r.hops)}</td>
                      <td className="muted conn__path">{(s.dir === "zu" ? [...r.path].reverse() : r.path).map(c.name).join(s.dir === "gegenseitig" ? " ↔ " : " → ")}</td>
                      {s.groups && <td>{groupLabel(r.id)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ShowMore>
        </div>
      )}
    </>
  );
}
