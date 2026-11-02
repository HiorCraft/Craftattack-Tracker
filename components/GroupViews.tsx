"use client";

import { Explain } from "./Explain";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ConnectionGraph, type GraphEdge, type GraphNode } from "./ConnectionGraph";
import { Head } from "./Head";
import { PlayerSearch } from "./PlayerSearch";
import { emptyLink, weigh, type LinkCounts, type Weights } from "@/lib/connectionWeights";
import { useGroupSettings } from "./GroupSettings";
import { explainGroup, reasonText, ROLE_LABEL, ROLE_TONE, type Group, type GroupAnalysis, type Member, type Role } from "@/lib/groups";
import { GROUP_COLORS } from "@/lib/network";
import { num } from "@/lib/format";

const pct = (v: number) => `${Math.round(v * 100)} %`;
const ROLE_ORDER: Role[] = ["anfuehrer", "kern", "mitglied", "rand"];

/** Gemeinsame Einstellungen (Gewichtung, Feinheit oder Anzahl der Gruppen), siehe GroupSettings */
const useAnalysis = useGroupSettings;

function groupName(g: Group, name: (id: string) => string) {
  return `Gruppe um ${name(g.leader)}`;
}

/** Übersicht aller Gruppen: Karte der Gruppen (Anführer-Köpfe) und eine Karte je Gruppe */
export function GroupsOverview({
  nodes,
  edges,
  base,
  toolbar,
  anchorColor,
}: {
  nodes: GraphNode[];
  edges: LinkCounts[];
  base: { path: string; key: string };
  /** Über dem Netz, z. B. die Zeitleiste */
  toolbar?: React.ReactNode;
  /** Farbe je Spieler aus einer festen Einteilung: Gruppen behalten so über Zeitfenster hinweg ihre Farbe */
  anchorColor?: ((id: string) => string | null) | null;
}) {
  const { analysis: raw, weights, controls, shown: isShown, groupEdges } = useAnalysis(edges);
  const analysis = useMemo(() => (anchorColor ? recolor(raw, anchorColor) : raw), [raw, anchorColor]);
  const [view, setView] = useState<"karte" | "alle">("karte");
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const name = (id: string) => byId.get(id)?.name ?? id;
  const href = (id: string) => `${base.path}/${encodeURIComponent(id)}?key=${encodeURIComponent(base.key)}`;
  const [find, setFind] = useState("");

  // Karte: je Gruppe ein Knoten (Kopf des Anführers), Linien = Verbindungen zwischen Gruppen
  const { mapNodes, mapEdges, leaderGroup } = useMemo(() => groupMap(analysis, byId, weights, edges.filter(isShown)), [analysis, byId, weights, edges, isShown]);
  const colorOf = useMemo(() => (id: string) => analysis.groups[leaderGroup.get(id) ?? 0]?.color ?? GROUP_COLORS[0], [leaderGroup, analysis.groups]);
  // Alle Spieler: jeder Kopf auf der Fläche seiner Gruppe, Rolle als Rahmen
  const allNodes = useMemo(() => nodes.filter((n) => analysis.groupOf.has(n.id)), [nodes, analysis.groupOf]);
  const allEdges: GraphEdge[] = useMemo(() => edges.filter(isShown).map((e) => ({ ...e, ...weigh(e, weights) })).filter((e) => e.weight > 0), [edges, weights, isShown]);
  const memberColor = useMemo(() => (id: string) => analysis.groups[analysis.groupOf.get(id) ?? -1]?.color ?? null, [analysis]);
  const roleOf = useMemo(() => {
    const roles = new Map(analysis.groups.flatMap((g) => g.members.map((m) => [m.id, m.role] as const)));
    return (id: string) => roles.get(id) ?? null;
  }, [analysis.groups]);
  const playerHref = useMemo(() => (id: string) => `/spieler/${encodeURIComponent(id)}`, []);
  const hrefOf = useMemo(() => (id: string) => href(id), [base.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const found = find ? analysis.groupOf.get(find) : undefined;

  return (
    <>
      <div className="conn__layout">
      <div className="conn__side">{controls}</div>
      <div className="conn__main">
      <div className="grp__find">
        <span className="eyebrow">In welcher Gruppe ist …</span>
        <PlayerSearch players={nodes} value={find} onChange={setFind} label="Spieler finden" empty={{ label: "Spieler wählen" }} />
        {found !== undefined && (
          <Link className="tag" data-tone="gold" href={href(find)}>
            {name(find)} → {groupName(analysis.groups[found], name)}
          </Link>
        )}
      </div>
      <div className="box conn__box" data-tone="white">
        <div className="grp__toolbar">
          <div className="gb__seg" role="group" aria-label="Ansicht">
            <button type="button" aria-pressed={view === "karte"} onClick={() => setView("karte")} title="Ein Kopf je Gruppe (ihr Anführer)">
              Gruppen
            </button>
            <button type="button" aria-pressed={view === "alle"} onClick={() => setView("alle")} title="Jeder Spieler auf der Fläche seiner Gruppe">
              Alle Spieler
            </button>
          </div>
          {toolbar}
        </div>
        {view === "karte" ? (
          <ConnectionGraph nodes={mapNodes} edges={mapEdges} territoryOf={colorOf} hrefOf={hrefOf} />
        ) : (
          <ConnectionGraph nodes={allNodes} edges={allEdges} territoryOf={memberColor} roleOf={roleOf} hrefOf={playerHref} />
        )}
        <p className="muted conn__legend">
          {view === "karte" ? "Ein Kopf je Gruppe" : `${num(allNodes.length)} Spieler in ${num(analysis.groups.length)} Gruppen`}{" "}
          <Explain label="Was zeigt das Netz?">
            {view === "karte"
              ? "Ein Kopf je Gruppe (ihr Anführer), Größe = Stärke der Gruppe, Linien = Verbindungen zwischen den Gruppen (Raids, Titel, Nachrichten, geteilte Chats aller Mitglieder). Name beim Überfahren, anklicken öffnet die Gruppe."
              : "Jeder verbundene Spieler, die Fläche zeigt seine Gruppe. Rahmen: Krone = Anführer, dick = Kern, gestrichelt = Rand. Anklicken öffnet das Profil."}
          </Explain>
        </p>
      </div>
      </div>
      </div>
      <ul className="grp__cards">
        {analysis.groups.map((g) => {
          const byRole = (r: Role) => g.members.filter((m) => m.role === r);
          return (
            <li key={g.index} className="box grp__card" data-tone="white" style={{ "--grp": `var(${g.color})` } as React.CSSProperties}>
              <Link href={href(g.leader)} className="grp__card-head">
                <Head id={g.leader} uuid={byId.get(g.leader)?.uuid} name={name(g.leader)} size={40} decorative />
                <span>
                  <b>{groupName(g, name)}</b>
                  <span className="muted">
                    {num(g.members.length)} Spieler · {pct(g.cohesion)} bleibt in der Gruppe
                  </span>
                </span>
              </Link>
              <Bar parts={[{ v: g.cohesion, color: g.color, label: "bleibt in der Gruppe" }]} />
              <p className="muted grp__line">{explainGroup(g, analysis, groupEdges, weights, name).short}</p>
              <p className="grp__line">
                <span className="eyebrow">Kern</span>
                <Heads ids={byRole("kern").map((m) => m.id)} byId={byId} max={8} />
              </p>
              <p className="grp__line">
                <span className="eyebrow">Rand</span>
                <Heads ids={byRole("rand").map((m) => m.id)} byId={byId} max={8} />
              </p>
              {g.neighbours[0] && (
                <p className="muted grp__line">
                  Am engsten mit{" "}
                  <Link href={href(analysis.groups[g.neighbours[0].group].leader)}>{groupName(analysis.groups[g.neighbours[0].group], name)}</Link>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Karte der Gruppen: Anführer-Köpfe, Linien mit den summierten echten Zählwerten zwischen den Gruppen */
function groupMap(analysis: GroupAnalysis, byId: Map<string, GraphNode>, weights: Weights, edges: LinkCounts[]) {
  const leaderGroup = new Map(analysis.groups.map((g) => [g.leader, g.index]));
  const mapNodes: GraphNode[] = analysis.groups.map((g) => {
    const n = byId.get(g.leader)!;
    return { ...n, name: `Gruppe um ${n.name}`, online: g.members.some((m) => byId.get(m.id)?.online), live: false };
  });
  const sums = new Map<string, LinkCounts>();
  for (const e of edges) {
    const ga = analysis.groupOf.get(e.a);
    const gb = analysis.groupOf.get(e.b);
    if (ga === undefined || gb === undefined || ga === gb) continue;
    const la = analysis.groups[ga].leader;
    const lb = analysis.groups[gb].leader;
    const [a, b, flip] = la < lb ? [la, lb, false] : [lb, la, true];
    const k = `${a}|${b}`;
    const t = sums.get(k) ?? sums.set(k, emptyLink(a, b)).get(k)!;
    t.raidsAB += flip ? e.raidsBA : e.raidsAB;
    t.raidsBA += flip ? e.raidsAB : e.raidsBA;
    t.msgsAB += flip ? e.msgsBA : e.msgsAB;
    t.msgsBA += flip ? e.msgsAB : e.msgsBA;
    t.chats += e.chats;
    t.chatSeconds += e.chatSeconds;
    t.titleAB += flip ? e.titleBA : e.titleAB;
    t.titleBA += flip ? e.titleAB : e.titleBA;
    t.now ||= e.now;
  }
  const mapEdges: GraphEdge[] = [...sums.values()].map((e) => ({ ...e, ...weigh(e, weights) })).filter((e) => e.weight > 0);
  return { mapNodes, mapEdges, leaderGroup };
}

function Heads({ ids, byId, max }: { ids: string[]; byId: Map<string, GraphNode>; max: number }) {
  if (!ids.length) return <span className="muted">–</span>;
  return (
    <span className="grp__heads">
      {ids.slice(0, max).map((id) => (
        <Link key={id} href={`/spieler/${encodeURIComponent(id)}`} title={byId.get(id)?.name ?? id}>
          <Head id={id} uuid={byId.get(id)?.uuid} name={byId.get(id)?.name ?? id} size={24} src={32} decorative />
        </Link>
      ))}
      {ids.length > max && <span className="muted"> +{ids.length - max}</span>}
    </span>
  );
}

/** Gestapelter Balken (Anteile 0–1), Rest bleibt leer */
function Bar({ parts }: { parts: { v: number; color: string; label: string }[] }) {
  return (
    <span className="grp__bar" aria-hidden="true">
      {parts
        .filter((p) => p.v > 0.005)
        .map((p, i) => (
          <i key={i} style={{ width: `${p.v * 100}%`, background: `var(${p.color})` }} title={`${p.label}: ${pct(p.v)}`} />
        ))}
    </span>
  );
}

/** Seite einer Gruppe: Anführer und warum, Netz der Mitglieder, Rollen, Zugehörigkeit, Matrix, Nachbargruppen */
export function GroupView({ nodes, edges, member, base }: { nodes: GraphNode[]; edges: LinkCounts[]; member: string; base: { path: string; key: string } }) {
  const { analysis, weights, controls, shown: isShown, groupEdges } = useAnalysis(edges);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const name = (id: string) => byId.get(id)?.name ?? id;
  const href = (id: string) => `${base.path}/${encodeURIComponent(id)}?key=${encodeURIComponent(base.key)}`;
  const [hover, setHover] = useState<string | null>(null);
  const [sort, setSort] = useState<"rolle" | "zugehoerigkeit" | "rang">("rolle");

  const gi = analysis.groupOf.get(member);
  const g = gi === undefined ? null : analysis.groups[gi];
  const ids = useMemo(() => new Set(g?.members.map((m) => m.id) ?? []), [g]);
  const memberOf = useMemo(() => new Map(g?.members.map((m) => [m.id, m]) ?? []), [g]);
  // Umfeld: auch Spieler außerhalb der Gruppe, bis zu `around` Schritte von einem Mitglied entfernt
  const [around, setAround] = useState(0);
  const weighted: GraphEdge[] = useMemo(() => edges.filter(isShown).map((e) => ({ ...e, ...weigh(e, weights) })).filter((e) => e.weight > 0), [edges, weights, isShown]);
  const shown = useMemo(() => {
    const set = new Set(ids);
    let frontier = [...ids];
    for (let step = 0; step < around && frontier.length; step++) {
      const next: string[] = [];
      for (const e of weighted) {
        for (const [x, y] of [
          [e.a, e.b],
          [e.b, e.a],
        ]) {
          if (frontier.includes(x) && !set.has(y)) {
            set.add(y);
            next.push(y);
          }
        }
      }
      frontier = next;
    }
    return set;
  }, [ids, around, weighted]);
  const gNodes = useMemo(() => nodes.filter((n) => shown.has(n.id)), [nodes, shown]);
  const gEdges: GraphEdge[] = useMemo(() => weighted.filter((e) => shown.has(e.a) && shown.has(e.b)), [weighted, shown]);
  // Farbe = Gruppe (als Gebiet hinter den Köpfen), Rahmenform = Rolle in der eigenen Gruppe (auch bei Außenstehenden)
  const roleAll = useMemo(() => new Map(analysis.groups.flatMap((x) => x.members.map((m) => [m.id, m.role] as const))), [analysis.groups]);
  const territoryOf = useMemo(
    () => (id: string) => {
      const og = analysis.groupOf.get(id);
      return og === undefined ? null : GROUP_COLORS[og % GROUP_COLORS.length];
    },
    [analysis.groupOf],
  );
  const roleOf = useMemo(() => (id: string) => roleAll.get(id) ?? null, [roleAll]);
  // Außenstehende führen zu ihrer Gruppe, Mitglieder zum Profil
  const hrefOf = useMemo(() => (id: string) => (memberOf.has(id) ? `/spieler/${encodeURIComponent(id)}` : href(id)), [memberOf]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!g) return <p className="muted">{name(member)} ist in diesem Zeitraum mit niemandem verbunden.</p>;
  const leader = memberOf.get(g.leader)!;
  const receivedTotal = g.members.reduce((s, m) => s + m.received, 0);
  const supporters = g.members
    .filter((m) => m.id !== g.leader)
    .map((m) => ({ id: m.id, w: analysis.pairs.get(`${m.id}|${g.leader}`)?.weight ?? 0 }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w);
  const runnerUp = g.members[1];
  const sorted = [...g.members].sort((a, b) =>
    sort === "rolle" ? ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.rank - a.rank : sort === "rang" ? b.rank - a.rank : b.belonging - a.belonging,
  );
  const counts = Object.fromEntries(ROLE_ORDER.map((r) => [r, g.members.filter((m) => m.role === r).length])) as Record<Role, number>;

  return (
    <>
      <section className="grp__hero" style={{ "--grp": `var(${g.color})` } as React.CSSProperties}>
        <Head id={g.leader} uuid={byId.get(g.leader)?.uuid} name={name(g.leader)} size={72} decorative />
        <div>
          <p className="eyebrow">Gruppe {g.index + 1} von {analysis.groups.length}</p>
          <h2 className="t-2">{groupName(g, name)}</h2>
          <dl className="grp__facts">
            <div>
              <dt>Spieler</dt>
              <dd className="num">{num(g.members.length)}</dd>
            </div>
            <div>
              <dt title="Anteil der Verbindungsstärke der Mitglieder, der innerhalb der Gruppe bleibt">Zusammenhalt</dt>
              <dd className="num">{pct(g.cohesion)}</dd>
            </div>
            <div>
              <dt title="Anteil der möglichen Paare, die direkt verbunden sind">Dichte</dt>
              <dd className="num">{pct(g.density)}</dd>
            </div>
            <div>
              <dt>Raids innen</dt>
              <dd className="num">{num(g.inside.raids)}</dd>
            </div>
            <div>
              <dt>Nachrichten innen</dt>
              <dd className="num">{num(g.inside.msgs)}</dd>
            </div>
            <div>
              <dt title="Gemeinsame Zeit im geteilten Chat">Geteilter Chat</dt>
              <dd className="num">{num(Math.round(g.inside.chatSeconds / 3600))} Std</dd>
            </div>
            <div>
              <dt title="Stream-Zeit, in der ein Mitglied ein anderes im Titel nannte (höchstens 8 Std je Tag)">Im Titel genannt</dt>
              <dd className="num">{num(Math.round(g.inside.titleSeconds / 3600))} Std</dd>
            </div>
          </dl>
          {member !== g.leader && (
            <p className="muted">
              Geöffnet über {name(member)} ({ROLE_LABEL[memberOf.get(member)!.role]}).
            </p>
          )}
        </div>
      </section>

      <div className="conn__layout">
        <div className="conn__side">{controls}</div>
        <div className="conn__main">
      <div className="box conn__box" data-tone="white">
        <div className="gb__seg" role="group" aria-label="Umfeld" style={{ marginBottom: 12 }}>
          {(
            [
              [0, "Nur die Gruppe"],
              [1, "+ direkte Nachbarn"],
              [2, "+ 2 Schritte"],
              [99, "Ganzes Netz"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={around === k} onClick={() => setAround(k)}>
              {l}
            </button>
          ))}
        </div>
        <ConnectionGraph nodes={gNodes} edges={gEdges} focus={hover} territoryOf={territoryOf} roleOf={roleOf} hrefOf={hrefOf} />
        <ul className="conn__legend muted">
          <li>
            <i style={{ background: `var(${g.color})`, opacity: 0.5 }} /> Fläche = Gruppe
          </li>
          {ROLE_ORDER.map((r) => (
            <li key={r}>
              <span className={`gx-role gx-role--${r}`} aria-hidden="true" /> {ROLE_LABEL[r]}
            </li>
          ))}
          <li>
            {around === 0
              ? "Nur Verbindungen innerhalb der Gruppe"
              : `${num(gNodes.length - g.members.length)} Spieler außerhalb, auf der Fläche ihrer Gruppe (anklicken öffnet sie)`}{" "}
            · Name beim Überfahren
          </li>
        </ul>
      </div>
        </div>
      </div>

      <section className="box grp__explain" data-tone="white" aria-labelledby="warum-h" style={{ "--grp": `var(${g.color})` } as React.CSSProperties}>
        <h3 className="t-3" id="warum-h">
          Warum das eine Gruppe ist
        </h3>
        <ul>
          {explainGroup(g, analysis, groupEdges, weights, name).points.map((p) => (
            <li key={p.text} onMouseEnter={() => p.ids?.[0] && setHover(p.ids[0])} onMouseLeave={() => setHover(null)}>
              {p.text}
            </li>
          ))}
        </ul>
        <p className="muted">
          Erkannt nach Louvain <Explain>Die Aufteilung, bei der möglichst viel Verbindungsstärke innerhalb der Gruppen liegt, verglichen mit Zufall.</Explain>
        </p>
      </section>

      <div className="grp__grid">
        <section className="box grp__leader" data-tone="white" aria-labelledby="anf-h">
          <h3 className="t-3" id="anf-h">
            Warum {name(g.leader)} der Anführer ist
          </h3>
          <ul>
            <li>
              Bekommt <b>{pct(receivedTotal ? leader.received / receivedTotal : 0)}</b> der Aufmerksamkeit in der Gruppe: Raids, Nachrichten im eigenen Chat,
              geteilte Chats.
            </li>
            <li>
              Direkt verbunden mit <b>{num(leader.links)}</b> von {num(g.members.length - 1)} Mitgliedern.
            </li>
            {supporters.length > 0 && (
              <li>
                Am meisten von <Names ids={supporters.slice(0, 3).map((s) => s.id)} name={name} />.
              </li>
            )}
            {runnerUp && (
              <li className="muted">
                Dahinter: {name(runnerUp.id)} ({pct(runnerUp.rank / Math.max(1e-9, leader.rank))} von {name(g.leader)}s Wert).
              </li>
            )}
          </ul>
          <p className="muted">
            Gemessen wie PageRank <Explain>Aufmerksamkeit von gut vernetzten Mitgliedern zählt mehr als von Randfiguren.</Explain>
          </p>
        </section>
        <section className="box grp__roles" data-tone="white" aria-label="Rollen">
          {ROLE_ORDER.map((r) => (
            <p key={r}>
              <span className="tag" data-tone={ROLE_TONE[r]}>
                {ROLE_LABEL[r]}
              </span>{" "}
              <b className="num">{num(counts[r])}</b>{" "}
              <span className="muted">
                {r === "anfuehrer"
                  ? "die meiste Aufmerksamkeit"
                  : r === "kern"
                    ? "stark verbunden, fast nur hier"
                    : r === "mitglied"
                      ? "klar dabei"
                      : "kaum verbunden oder fast genauso mit einer anderen Gruppe"}
              </span>
            </p>
          ))}
        </section>
      </div>

      <div className="section-head" style={{ marginTop: 40 }}>
        <h3 className="t-2">Mitglieder</h3>
        <div className="gb__seg" role="group" aria-label="Sortierung">
          {(
            [
              ["rolle", "Rolle"],
              ["zugehoerigkeit", "Zugehörigkeit"],
              ["rang", "Einfluss"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <ul className="grp__members">
        {sorted.map((m) => (
          <MemberRow key={m.id} m={m} g={g} analysis={analysis} name={name} byId={byId} hrefGroup={href} onHover={setHover} active={hover === m.id} />
        ))}
      </ul>

      <div className="section-head" style={{ marginTop: 40 }}>
        <h3 className="t-2">Wer mit wem</h3>
        <p className="muted">Zeile → Spalte: was der Spieler links dem oben tut (Raids, Nachrichten, geteilter Chat). Je dunkler, desto mehr. Feld überfahren für Details.</p>
      </div>
      <Matrix g={g} analysis={analysis} name={name} byId={byId} onHover={setHover} />

      {g.neighbours.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 40 }}>
            <h3 className="t-2">Verbindungen zu anderen Gruppen</h3>
          </div>
          <ul className="grp__cards">
            {g.neighbours.slice(0, 6).map((nb) => {
              const other = analysis.groups[nb.group];
              return (
                <li key={nb.group} className="box grp__card" data-tone="white" style={{ "--grp": `var(${other.color})` } as React.CSSProperties}>
                  <Link href={href(other.leader)} className="grp__card-head">
                    <Head id={other.leader} uuid={byId.get(other.leader)?.uuid} name={name(other.leader)} size={32} decorative />
                    <span>
                      <b>{groupName(other, name)}</b>
                      <span className="muted">{num(Math.round(nb.weight))} Punkte</span>
                    </span>
                  </Link>
                  <p className="muted grp__line">
                    Brücken:{" "}
                    {nb.bridges
                      .slice(0, 3)
                      .map((b) => `${name(b.a)} – ${name(b.b)}`)
                      .join(", ")}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

function Names({ ids, name }: { ids: string[]; name: (id: string) => string }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && (i === ids.length - 1 ? " und " : ", ")}
          <Link href={`/spieler/${encodeURIComponent(id)}`}>{name(id)}</Link>
        </span>
      ))}
    </>
  );
}

function MemberRow({
  m,
  g,
  analysis,
  name,
  byId,
  hrefGroup,
  onHover,
  active,
}: {
  m: Member;
  g: Group;
  analysis: GroupAnalysis;
  name: (id: string) => string;
  byId: Map<string, GraphNode>;
  hrefGroup: (id: string) => string;
  onHover: (id: string | null) => void;
  active: boolean;
}) {
  const parts = [{ v: m.belonging, color: g.color, label: "in dieser Gruppe" }, ...[...m.shares].filter(([k]) => k !== g.index).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ v, color: GROUP_COLORS[k % GROUP_COLORS.length], label: groupName(analysis.groups[k], name) }))];
  const why =
    m.role === "rand"
      ? m.edge === "zwischen" && m.alt
        ? `Fast genauso mit der ${groupName(analysis.groups[m.alt.group], name)} verbunden (${pct(m.alt.share)} dort, ${pct(m.belonging)} hier).`
        : "Kaum mit der Gruppe verbunden, nur über wenige schwache Verbindungen."
      : null;
  return (
    <li className="box grp__member" data-tone="white" data-active={active || undefined} onMouseEnter={() => onHover(m.id)} onMouseLeave={() => onHover(null)}>
      <Link href={`/spieler/${encodeURIComponent(m.id)}`} className="conn__person">
        <Head id={m.id} uuid={byId.get(m.id)?.uuid} name={name(m.id)} size={32} decorative /> <b>{name(m.id)}</b>
      </Link>
      <span className="tag" data-tone={ROLE_TONE[m.role]}>
        {ROLE_LABEL[m.role]}
      </span>
      <span className="grp__belong" title={`Zugehörigkeit ${pct(m.belonging)}`}>
        <Bar parts={parts} />
        <span className="num muted">{pct(m.belonging)}</span>
      </span>
      <p className="grp__why">
        {why && <span className="grp__edge">{why} </span>}
        {m.reasons.length ? (
          <>
            <span className="muted">Dabei durch </span>
            {m.reasons.slice(0, 3).map((r, i) => (
              <span key={r.other}>
                {i > 0 && "; "}
                <b>{name(r.other)}</b> <span className="muted">({reasonText(r)})</span>
              </span>
            ))}
          </>
        ) : (
          <span className="muted">Keine direkte Verbindung in der Gruppe.</span>
        )}
        {m.alt && m.role !== "rand" && m.alt.share > 0.15 && (
          <>
            {" "}
            <Link className="muted" href={hrefGroup(analysis.groups[m.alt.group].leader)}>
              · auch {pct(m.alt.share)} zur {groupName(analysis.groups[m.alt.group], name)}
            </Link>
          </>
        )}
      </p>
    </li>
  );
}

function Matrix({ g, analysis, name, byId, onHover }: { g: Group; analysis: GroupAnalysis; name: (id: string) => string; byId: Map<string, GraphNode>; onHover: (id: string | null) => void }) {
  const [cell, setCell] = useState<{ a: string; b: string } | null>(null);
  const order = [...g.members].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.rank - a.rank).map((m) => m.id);
  const max = Math.max(1, ...order.flatMap((a) => order.map((b) => analysis.pairs.get(`${a}|${b}`)?.weight ?? 0)));
  const info = cell ? analysis.pairs.get(`${cell.a}|${cell.b}`) : null;
  return (
    <div className="box grp__matrix-box" data-tone="white">
      <div className="grp__matrix" style={{ "--n": order.length } as React.CSSProperties} onMouseLeave={() => (setCell(null), onHover(null))}>
        <span />
        {order.map((id) => (
          <span key={id} className="grp__mhead" title={name(id)}>
            <Head id={id} uuid={byId.get(id)?.uuid} name={name(id)} size={18} src={32} decorative />
          </span>
        ))}
        {order.map((a) => (
          <MatrixRow key={a} a={a} order={order} analysis={analysis} max={max} name={name} byId={byId} cell={cell} setCell={(c) => (setCell(c), onHover(c?.a ?? null))} />
        ))}
      </div>
      <p className="muted grp__matrix-tip" role="status">
        {cell ? (
          info && info.weight > 0 ? (
            <>
              <b>{name(cell.a)}</b> → <b>{name(cell.b)}</b>: {reasonText({ ...info, raidsIn: 0, msgsIn: 0 }) || "geteilter Chat"}
            </>
          ) : (
            `${name(cell.a)} → ${name(cell.b)}: keine Verbindung`
          )
        ) : (
          "Feld überfahren für Details."
        )}
      </p>
    </div>
  );
}

function MatrixRow({
  a,
  order,
  analysis,
  max,
  name,
  byId,
  cell,
  setCell,
}: {
  a: string;
  order: string[];
  analysis: GroupAnalysis;
  max: number;
  name: (id: string) => string;
  byId: Map<string, GraphNode>;
  cell: { a: string; b: string } | null;
  setCell: (c: { a: string; b: string } | null) => void;
}) {
  return (
    <>
      <span className="grp__mhead" title={name(a)}>
        <Head id={a} uuid={byId.get(a)?.uuid} name={name(a)} size={18} src={32} decorative />
      </span>
      {order.map((b) => {
        const w = a === b ? 0 : (analysis.pairs.get(`${a}|${b}`)?.weight ?? 0);
        const v = w > 0 ? 0.15 + 0.85 * (Math.log1p(w) / Math.log1p(max)) : 0;
        return (
          <span
            key={b}
            className="grp__cell"
            data-self={a === b || undefined}
            data-on={(cell && (cell.a === a || cell.b === b)) || undefined}
            style={{ "--v": v } as React.CSSProperties}
            onMouseEnter={() => setCell({ a, b })}
            title={`${name(a)} → ${name(b)}`}
          />
        );
      })}
    </>
  );
}

/** Gruppenfarben an eine feste Einteilung binden: jede Gruppe bekommt die Farbe, die die meisten ihrer Mitglieder dort haben */
function recolor(a: GroupAnalysis, anchor: (id: string) => string | null): GroupAnalysis {
  const used = new Set<string>();
  const colors = new Map<number, string>();
  for (const g of [...a.groups].sort((x, y) => y.members.length - x.members.length)) {
    const votes = new Map<string, number>();
    for (const m of g.members) {
      const c = anchor(m.id);
      if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
    }
    const pick = [...votes.entries()].filter(([c]) => !used.has(c)).sort((x, y) => y[1] - x[1])[0]?.[0] ?? GROUP_COLORS.find((c) => !used.has(c)) ?? g.color;
    used.add(pick);
    colors.set(g.index, pick);
  }
  return { ...a, groups: a.groups.map((g) => ({ ...g, color: colors.get(g.index) ?? g.color })) };
}
