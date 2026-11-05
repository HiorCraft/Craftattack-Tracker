/**
 * Auswertung der erkannten Gruppen (siehe detectGroups in lib/network.ts): Anführer, Kern, Rand und warum jemand
 * dazugehört. Ohne `server-only`, läuft auf Server und im Browser.
 *
 * - Anführer: wer innerhalb der Gruppe die meiste Aufmerksamkeit bekommt (PageRank über die gerichteten
 *   Verbindungen: geraidet werden, Nachrichten im eigenen Chat, im Titel genannt werden, geteilter Chat). Aufmerksamkeit von gut vernetzten
 *   Mitgliedern zählt mehr.
 * - Zugehörigkeit: Anteil der eigenen Verbindungsstärke, der innerhalb der Gruppe bleibt.
 * - Kern: hohe Zugehörigkeit und stark verbunden; Rand: geringe Zugehörigkeit oder fast genauso stark mit einer
 *   anderen Gruppe verbunden.
 */
import { DEFAULT_WEIGHTS, LINK_KINDS, linkPoints, type LinkCounts, type LinkKind, type Weights } from "./connectionWeights";
import { detectGroups, directed, GROUP_COLORS } from "./network";

export type Role = "anfuehrer" | "kern" | "mitglied" | "rand";

export interface Reason {
  other: string;
  /** Punkte dieser Verbindung (beide Richtungen) */
  weight: number;
  raidsOut: number;
  raidsIn: number;
  msgsOut: number;
  msgsIn: number;
  chats: number;
  chatSeconds: number;
  /** Stream-Zeit (s), in der er den anderen im Titel nannte bzw. genannt wurde */
  titleOut: number;
  titleIn: number;
}

export interface Member {
  id: string;
  role: Role;
  /** Stärke innerhalb der Gruppe (beide Richtungen) */
  inner: number;
  /** Gesamte Stärke */
  total: number;
  /** inner / total */
  belonging: number;
  /** Anteile je Gruppe (Gruppen-Nummer → Anteil an total) */
  shares: Map<number, number>;
  /** Stärkste andere Gruppe */
  alt: { group: number; share: number } | null;
  /** PageRank innerhalb der Gruppe (Summe 1) */
  rank: number;
  /** Aufmerksamkeit, die er innerhalb der Gruppe bekommt bzw. gibt */
  received: number;
  given: number;
  /** Direkt verbundene Mitglieder */
  links: number;
  /** Stärkste Verbindungen in der Gruppe */
  reasons: Reason[];
  /** Warum am Rand: kaum verbunden oder fast genauso mit einer anderen Gruppe */
  edge?: "schwach" | "zwischen";
}

export interface Group {
  index: number;
  color: string;
  leader: string;
  members: Member[];
  /** Anteil der Verbindungsstärke aller Mitglieder, der in der Gruppe bleibt */
  cohesion: number;
  /** Anteil der möglichen Paare, die direkt verbunden sind */
  density: number;
  /** Verbindungen zu anderen Gruppen, stärkste zuerst, mit den stärksten Brücken */
  neighbours: { group: number; weight: number; bridges: { a: string; b: string; weight: number }[] }[];
  /** Summen der Arten innerhalb der Gruppe */
  inside: { raids: number; msgs: number; chats: number; chatSeconds: number; titleSeconds: number };
}

export interface GroupAnalysis {
  groups: Group[];
  groupOf: Map<string, number>;
  /** Gerichtete Verbindungen innerhalb von Gruppen (für die Matrix): `${a}|${b}` → Zählwerte aus Sicht a → b */
  pairs: Map<string, Reason>;
}

function reasonFor(e: LinkCounts, self: string, weight: number): Reason {
  const mine = e.a === self;
  return {
    other: mine ? e.b : e.a,
    weight,
    raidsOut: mine ? e.raidsAB : e.raidsBA,
    raidsIn: mine ? e.raidsBA : e.raidsAB,
    msgsOut: mine ? e.msgsAB : e.msgsBA,
    msgsIn: mine ? e.msgsBA : e.msgsAB,
    chats: e.chats,
    chatSeconds: e.chatSeconds,
    titleOut: mine ? e.titleAB : e.titleBA,
    titleIn: mine ? e.titleBA : e.titleAB,
  };
}

/** PageRank über gerichtete, gewichtete Kanten (u → v = u schenkt v Aufmerksamkeit) */
function pageRank(ids: string[], out: Map<string, Map<string, number>>, damping = 0.85): Map<string, number> {
  const n = ids.length;
  let pr = new Map(ids.map((id) => [id, 1 / n]));
  for (let it = 0; it < 60; it++) {
    const next = new Map(ids.map((id) => [id, (1 - damping) / n]));
    let sink = 0;
    for (const u of ids) {
      const m = out.get(u);
      const sum = m ? [...m.values()].reduce((s, v) => s + v, 0) : 0;
      if (!sum) {
        sink += pr.get(u)!;
        continue;
      }
      for (const [v, w] of m!) next.set(v, next.get(v)! + (damping * pr.get(u)! * w) / sum);
    }
    for (const id of ids) next.set(id, next.get(id)! + (damping * sink) / n);
    pr = next;
  }
  return pr;
}

export function analyzeGroups(edges: LinkCounts[], w: Weights = DEFAULT_WEIGHTS, resolution = 1): GroupAnalysis {
  const groupOf = detectGroups(edges, w, resolution);
  const total = new Map<string, number>();
  const sharesOf = new Map<string, Map<number, number>>();
  const reasons = new Map<string, Reason[]>();
  const innerOut = new Map<number, Map<string, Map<string, number>>>();
  const pairs = new Map<string, Reason>();
  const between = new Map<string, { weight: number; bridges: { a: string; b: string; weight: number }[] }>();
  const inside = new Map<number, Group["inside"]>();

  for (const e of edges) {
    const { ab, ba } = directed(e, w);
    const s = ab + ba;
    if (s <= 0) continue;
    const ga = groupOf.get(e.a)!;
    const gb = groupOf.get(e.b)!;
    for (const [id, g] of [
      [e.a, gb],
      [e.b, ga],
    ] as const) {
      total.set(id, (total.get(id) ?? 0) + s);
      const m = sharesOf.get(id) ?? sharesOf.set(id, new Map()).get(id)!;
      m.set(g, (m.get(g) ?? 0) + s);
    }
    if (ga === gb) {
      for (const id of [e.a, e.b]) (reasons.get(id) ?? reasons.set(id, []).get(id)!).push(reasonFor(e, id, s));
      const g = innerOut.get(ga) ?? innerOut.set(ga, new Map()).get(ga)!;
      const put = (x: string, y: string, v: number) => v > 0 && (g.get(x) ?? g.set(x, new Map()).get(x)!).set(y, v);
      put(e.a, e.b, ab);
      put(e.b, e.a, ba);
      pairs.set(`${e.a}|${e.b}`, reasonFor(e, e.a, ab));
      pairs.set(`${e.b}|${e.a}`, reasonFor(e, e.b, ba));
      const t = inside.get(ga) ?? inside.set(ga, { raids: 0, msgs: 0, chats: 0, chatSeconds: 0, titleSeconds: 0 }).get(ga)!;
      t.raids += e.raidsAB + e.raidsBA;
      t.msgs += e.msgsAB + e.msgsBA;
      t.chats += e.chats;
      t.chatSeconds += e.chatSeconds;
      t.titleSeconds += e.titleAB + e.titleBA;
    } else {
      for (const [x, y, a, b] of [
        [ga, gb, e.a, e.b],
        [gb, ga, e.b, e.a],
      ] as const) {
        const k = `${x}|${y}`;
        const v = between.get(k) ?? between.set(k, { weight: 0, bridges: [] }).get(k)!;
        v.weight += s;
        v.bridges.push({ a, b, weight: s });
      }
    }
  }

  const byGroup = new Map<number, string[]>();
  for (const [id, g] of groupOf) (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(id);

  const groups: Group[] = [];
  for (const [index, ids] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    const out = innerOut.get(index) ?? new Map();
    const pr = pageRank(ids, out);
    const received = new Map<string, number>();
    const given = new Map<string, number>();
    for (const [u, m] of out) for (const [v, x] of m) {
      given.set(u, (given.get(u) ?? 0) + x);
      received.set(v, (received.get(v) ?? 0) + x);
    }
    const members: Member[] = ids.map((id) => {
      const shares = new Map([...(sharesOf.get(id) ?? new Map())].map(([g, v]) => [g, v / (total.get(id) || 1)]));
      const inner = (sharesOf.get(id)?.get(index) ?? 0);
      const alt = [...shares].filter(([g]) => g !== index).sort((a, b) => b[1] - a[1])[0];
      const rs = (reasons.get(id) ?? []).sort((a, b) => b.weight - a.weight);
      return {
        id,
        role: "mitglied",
        inner,
        total: total.get(id) ?? 0,
        belonging: shares.get(index) ?? 0,
        shares,
        alt: alt ? { group: alt[0], share: alt[1] } : null,
        rank: pr.get(id) ?? 0,
        received: received.get(id) ?? 0,
        given: given.get(id) ?? 0,
        links: rs.length,
        reasons: rs.slice(0, 5),
      };
    });
    members.sort((a, b) => b.rank - a.rank);
    const leader = members[0].id;
    members[0].role = "anfuehrer";
    // Kern: hohe Zugehörigkeit und überdurchschnittlich stark in der Gruppe verbunden
    const innerSorted = members.map((m) => m.inner).sort((a, b) => a - b);
    const medianInner = innerSorted[Math.floor(innerSorted.length / 2)] ?? 0;
    const coreMax = Math.max(2, Math.ceil(members.length * 0.3));
    let cores = 0;
    for (const m of [...members].sort((a, b) => b.inner * b.belonging - a.inner * a.belonging)) {
      if (m.role === "anfuehrer") continue;
      const between = m.belonging < 0.45 || Boolean(m.alt && m.alt.share >= m.belonging * 0.7);
      const weak = m.inner < medianInner * 0.15;
      if (between || weak) {
        m.role = "rand";
        m.edge = between ? "zwischen" : "schwach";
      }
      else if (cores < coreMax && m.belonging >= 0.6 && m.inner >= medianInner) {
        m.role = "kern";
        cores++;
      }
    }
    const sumTotal = members.reduce((s, m) => s + m.total, 0);
    const sumInner = members.reduce((s, m) => s + m.inner, 0);
    const neighbours = [...between.entries()]
      .filter(([k]) => Number(k.split("|")[0]) === index)
      .map(([k, v]) => ({ group: Number(k.split("|")[1]), weight: v.weight, bridges: v.bridges.sort((a, b) => b.weight - a.weight).slice(0, 4) }))
      .sort((a, b) => b.weight - a.weight);
    const possible = (members.length * (members.length - 1)) / 2;
    groups.push({
      index,
      color: GROUP_COLORS[index % GROUP_COLORS.length],
      leader,
      members,
      cohesion: sumTotal ? sumInner / sumTotal : 0,
      density: possible ? members.reduce((s, m) => s + m.links, 0) / 2 / possible : 0,
      neighbours,
      inside: inside.get(index) ?? { raids: 0, msgs: 0, chats: 0, chatSeconds: 0, titleSeconds: 0 },
    });
  }
  return { groups, groupOf, pairs };
}

export const ROLE_LABEL: Record<Role, string> = { anfuehrer: "Anführer", kern: "Kern", mitglied: "Mitglied", rand: "Rand" };
export const ROLE_TONE: Record<Role, string> = { anfuehrer: "gold", kern: "grass", mitglied: "white", rand: "paper" };

/** Kurzer Satz zu einer Verbindung, z. B. „raidet ihn 3× · 120 Nachr. bei ihm · 2× geteilter Chat“ */
export function reasonText(r: Reason): string {
  const n = (v: number) => v.toLocaleString("de-DE");
  const parts: string[] = [];
  if (r.raidsOut) parts.push(`raidet ${n(r.raidsOut)}×`);
  if (r.raidsIn) parts.push(`wird ${n(r.raidsIn)}× geraidet`);
  if (r.msgsOut) parts.push(`${n(r.msgsOut)} Nachr. bei ihm`);
  if (r.msgsIn) parts.push(`${n(r.msgsIn)} Nachr. von ihm`);
  if (r.chats) parts.push(`${n(r.chats)}× geteilter Chat (${hours(r.chatSeconds)})`);
  if (r.titleOut) parts.push(`nennt ihn ${hours(r.titleOut)} im Titel`);
  if (r.titleIn) parts.push(`von ihm ${hours(r.titleIn)} im Titel genannt`);
  return parts.join(" · ");
}

/** Feinheit, bei der die Gruppen-Erkennung möglichst genau `count` Gruppen findet (Suche auf der Log-Skala) */
export function resolutionForCount(edges: LinkCounts[], w: Weights, count: number): number {
  const groupsAt = (r: number) => new Set(detectGroups(edges, w, r).values()).size;
  let lo = Math.log(0.1);
  let hi = Math.log(40);
  let best = { r: 1, diff: Infinity };
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const r = Math.exp(mid);
    const n = groupsAt(r);
    const diff = Math.abs(n - count);
    if (diff < best.diff || (diff === best.diff && Math.abs(Math.log(r)) < Math.abs(Math.log(best.r)))) best = { r, diff };
    if (n === count) break;
    if (n < count) lo = mid;
    else hi = mid;
  }
  return Math.round(best.r * 100) / 100;
}

export interface GroupExplanation {
  /** Kurzform für Karten, z. B. „vor allem geteilte Chats · 6× mehr als Zufall“ */
  short: string;
  /** Begründung in Sätzen; `ids` = darin genannte Spieler (für Links) */
  points: { text: string; ids?: string[] }[];
}

const KIND_LABEL: Record<LinkKind, string> = { raid: "Raids", shared: "geteilten Chat", title: "Erwähnungen im Stream-Titel", msgs: "Chat-Nachrichten" };
const hours = (s: number) => `${Math.round(s / 3600).toLocaleString("de-DE")} Std`;

/**
 * Warum diese Spieler eine Gruppe sind: wie viel mehr sie untereinander verbunden sind als zufällig zu erwarten,
 * was sie verbindet (Art im Vergleich zum ganzen Netz), die tragenden Paare, ob der Kern geschlossen ist und wie
 * schwach die Verbindung nach außen ist.
 */
export function explainGroup(g: Group, analysis: GroupAnalysis, edges: LinkCounts[], w: Weights, name: (id: string) => string): GroupExplanation {
  const members = new Set(g.members.map((m) => m.id));
  const pts = (e: LinkCounts) => linkPoints(e, w);
  const inner: Weights = { raid: 0, shared: 0, title: 0, msgs: 0 };
  const all: Weights = { raid: 0, shared: 0, title: 0, msgs: 0 };
  const sum = (p: Weights) => p.raid + p.shared + p.title + p.msgs;
  let memberTotal = 0;
  const innerPairs: { a: string; b: string; s: number; e: LinkCounts }[] = [];
  for (const e of edges) {
    const p = pts(e);
    const s = sum(p);
    if (s <= 0) continue;
    for (const k of LINK_KINDS) all[k] += p[k];
    const ina = members.has(e.a);
    const inb = members.has(e.b);
    memberTotal += (ina ? s : 0) + (inb ? s : 0);
    if (ina && inb) {
      for (const k of LINK_KINDS) inner[k] += p[k];
      innerPairs.push({ a: e.a, b: e.b, s, e });
    }
  }
  const allSum = sum(all) || 1;
  const innerSum = sum(inner) || 1;
  // Zufall: Jede Verbindung eines Mitglieds landet mit der Wahrscheinlichkeit bei einem Mitglied, die dem Anteil der
  // Gruppe an der gesamten Verbindungsstärke entspricht
  const expected = Math.max(0.01, memberTotal / (2 * allSum));
  const factor = g.cohesion / expected;
  const kinds = LINK_KINDS.filter((k) => inner[k] > 0).sort((a, b) => inner[b] - inner[a]);
  const top = kinds[0];
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  const points: GroupExplanation["points"] = [];
  points.push({
    text: `${pct(g.cohesion)} der Verbindungen der Mitglieder bleiben in der Gruppe. Wären sie zufällig über alle verteilt, wären es etwa ${pct(expected)}: ${factor >= 1.5 ? `${factor.toLocaleString("de-DE", { maximumFractionDigits: 1 })}× so viel wie Zufall` : "kaum mehr als Zufall, eine lockere Gruppe"}.`,
  });
  if (top) {
    const share = inner[top] / innerSum;
    const net = all[top] / allSum;
    const counts =
      top === "raid"
        ? `${g.inside.raids.toLocaleString("de-DE")} Raids`
        : top === "shared"
          ? `${hours(g.inside.chatSeconds)} in ${g.inside.chats.toLocaleString("de-DE")} geteilten Chats`
          : top === "title"
            ? `${hours(g.inside.titleSeconds)} Stream mit dem anderen im Titel`
            : `${g.inside.msgs.toLocaleString("de-DE")} Nachrichten`;
    points.push({
      text: `Was sie verbindet: vor allem ${KIND_LABEL[top]} (${counts}, ${pct(share)} der Punkte in der Gruppe${Math.abs(share - net) > 0.1 ? `, im ganzen Netz nur ${pct(net)}` : ""}).${kinds[1] ? ` Danach ${KIND_LABEL[kinds[1]]} (${pct(inner[kinds[1]] / innerSum)}).` : ""}`,
    });
  }
  const backbone = innerPairs.sort((a, b) => b.s - a.s).slice(0, 3);
  if (backbone.length) {
    const share = backbone.reduce((s, p) => s + p.s, 0) / innerSum;
    points.push({
      text: `Getragen vor allem von ${backbone.map((p) => `${name(p.a)} und ${name(p.b)}`).join(", ")} (zusammen ${pct(share)} der Punkte in der Gruppe).`,
      ids: backbone.flatMap((p) => [p.a, p.b]),
    });
  }
  const core = g.members.filter((m) => m.role === "anfuehrer" || m.role === "kern").map((m) => m.id);
  if (core.length >= 3) {
    const set = new Set(core);
    const links = innerPairs.filter((p) => set.has(p.a) && set.has(p.b)).length;
    const possible = (core.length * (core.length - 1)) / 2;
    points.push({
      text:
        links === possible
          ? `Der Kern (${core.map(name).join(", ")}) ist geschlossen: alle sind direkt miteinander verbunden.`
          : `Im Kern (${core.map(name).join(", ")}) sind ${links} von ${possible} Paaren direkt verbunden.`,
      ids: core,
    });
  }
  const nb = g.neighbours[0];
  if (nb) {
    const other = analysis.groups[nb.group];
    const share = nb.weight / (memberTotal || 1);
    const bridge = nb.bridges[0];
    points.push({
      text: `Nach außen am meisten zur Gruppe um ${name(other.leader)}, aber nur ${pct(share)} der Verbindungen${bridge ? `, vor allem über ${name(bridge.a)} – ${name(bridge.b)}` : ""}.`,
      ids: bridge ? [bridge.a, bridge.b] : undefined,
    });
  } else points.push({ text: "Keine Verbindungen zu anderen Gruppen." });
  const edgeCount = g.members.filter((m) => m.role === "rand").length;
  if (edgeCount) points.push({ text: `${edgeCount} ${edgeCount === 1 ? "Spieler steht" : "Spieler stehen"} am Rand: kaum verbunden oder fast genauso mit einer anderen Gruppe.` });
  return {
    short: `${top ? `vor allem ${KIND_LABEL[top]}` : "kaum Verbindungen"} · ${factor >= 1.5 ? `${factor.toLocaleString("de-DE", { maximumFractionDigits: 1 })}× mehr als Zufall` : "locker"}`,
    points,
  };
}
