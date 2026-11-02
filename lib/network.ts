/**
 * Netz-Auswertung für /verbindungen und /intern/netz: gerichtete Stärken, Abstände von einem Spieler aus und
 * Gruppen. Ohne `server-only`, gerechnet wird im Browser mit den Faktoren des Besuchers.
 *
 * Richtung: Raids und Chat-Nachrichten sind einseitig. Wer bei jemandem schreibt oder ihn raidet, hat eine Verbindung
 * zu ihm, aber nicht umgekehrt. Titel-Erwähnungen auch (wer den anderen im
 * Stream-Titel nennt). Ein geteilter Chat (Stream Together) verbindet beide gleich.
 */
import { directedPoints, type LinkCounts, type Weights } from "./connectionWeights";

/**
 * - `von`: was der Spieler selbst tut (er raidet, schreibt bei anderen), weiter über deren Verbindungen
 * - `zu`: was andere ihm gegenüber tun (wer ihn raidet, wer bei ihm schreibt)
 * - `gegenseitig`: nur, was in beide Richtungen geht (jeweils der schwächere Teil)
 */
export type Direction = "von" | "zu" | "gegenseitig";

/** Stärke a → b und b → a nach den Faktoren `w` */
export function directed(e: LinkCounts, w: Weights): { ab: number; ba: number } {
  const p = directedPoints(e, w);
  const sum = (x: Weights) => x.raid + x.shared + x.title + x.msgs;
  return { ab: sum(p.ab), ba: sum(p.ba) };
}

/** Gerichtete Nachbarn: out.get(a).get(b) = Stärke a → b */
export function adjacency(edges: LinkCounts[], w: Weights): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, s: number) => {
    if (s <= 0) return;
    (out.get(a) ?? out.set(a, new Map()).get(a)!).set(b, s);
  };
  for (const e of edges) {
    const { ab, ba } = directed(e, w);
    add(e.a, e.b, ab);
    add(e.b, e.a, ba);
  }
  return out;
}

/** Länge einer Verbindung: je stärker, desto kürzer (1 Punkt = 1, 10 Punkte ≈ 0,29, 0,1 Punkte ≈ 7,3) */
export const costOf = (strength: number) => 1 / Math.log2(1 + strength);
/** Nähe 0–1 aus dem Abstand (direkt mit 1 Punkt = 50 %) */
export const closeness = (dist: number) => 1 / (1 + dist);

export interface Reach {
  id: string;
  /** Summe der Längen auf dem kürzesten Weg */
  dist: number;
  /** Schritte auf diesem Weg */
  hops: number;
  /** Vorgänger auf dem Weg vom Fokus aus (Baum der kürzesten Wege) */
  parent: string | null;
  /** Weg vom Fokus bis hierher, Fokus zuerst */
  path: string[];
}

/**
 * Kürzeste Wege vom Fokus aus (Dijkstra). Bei `zu` läuft die Suche rückwärts: Abstand = wie nah der andere dem
 * Fokus ist, über Verbindungen in Richtung Fokus.
 */
export function distancesFrom(focus: string, out: Map<string, Map<string, number>>, dir: Direction): Map<string, Reach> {
  const step = (u: string): [string, number][] => {
    if (dir === "von") return [...(out.get(u) ?? [])];
    const res: [string, number][] = [];
    // Eingehend zu u: alle v mit v → u
    for (const [v, m] of out) {
      const toU = m.get(u);
      if (!toU) continue;
      if (dir === "zu") res.push([v, toU]);
      else {
        const back = out.get(u)?.get(v) ?? 0;
        if (back > 0) res.push([v, Math.min(toU, back)]);
      }
    }
    return res;
  };
  const res = new Map<string, Reach>([[focus, { id: focus, dist: 0, hops: 0, parent: null, path: [focus] }]]);
  const done = new Set<string>();
  for (;;) {
    let u: Reach | null = null;
    for (const r of res.values()) if (!done.has(r.id) && (!u || r.dist < u.dist)) u = r;
    if (!u) break;
    done.add(u.id);
    for (const [v, s] of step(u.id)) {
      if (done.has(v)) continue;
      const d = u.dist + costOf(s);
      const cur = res.get(v);
      if (!cur || d < cur.dist - 1e-9) res.set(v, { id: v, dist: d, hops: u.hops + 1, parent: u.id, path: [...u.path, v] });
    }
  }
  return res;
}

/**
 * Gruppen (Louvain): Spieler, die untereinander deutlich stärker verbunden sind als mit dem Rest. Ungerichtet
 * (beide Richtungen zusammen). `resolution` > 1 ergibt mehr, kleinere Gruppen.
 * Liefert je Spieler die Gruppen-Nummer, Gruppe 0 ist die größte.
 */
export function detectGroups(edges: LinkCounts[], w: Weights, resolution = 1): Map<string, number> {
  // Ungerichtete Gewichte
  const ids = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  let n = ids.length;
  let adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (const e of edges) {
    const { ab, ba } = directed(e, w);
    const s = ab + ba;
    if (s <= 0) continue;
    const a = index.get(e.a)!;
    const b = index.get(e.b)!;
    adj[a].set(b, (adj[a].get(b) ?? 0) + s);
    adj[b].set(a, (adj[b].get(a) ?? 0) + s);
  }
  /** Zugehörigkeit der ursprünglichen Spieler zu den aktuellen (zusammengefassten) Knoten */
  let member = ids.map((_, i) => i);
  for (let level = 0; level < 10; level++) {
    const deg = adj.map((m) => [...m.values()].reduce((s, v) => s + v, 0));
    const m2 = deg.reduce((s, v) => s + v, 0);
    if (m2 === 0) break;
    const comm = Array.from({ length: n }, (_, i) => i);
    const tot = [...deg];
    let improved = false;
    for (let pass = 0; pass < 20; pass++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const ci = comm[i];
        // Gewicht von i zu jeder Nachbargruppe (ohne Schleife auf sich selbst)
        const links = new Map<number, number>();
        for (const [j, wij] of adj[i]) if (j !== i) links.set(comm[j], (links.get(comm[j]) ?? 0) + wij);
        tot[ci] -= deg[i];
        let best = ci;
        let bestGain = (links.get(ci) ?? 0) - (resolution * tot[ci] * deg[i]) / m2;
        for (const [c, kin] of links) {
          const gain = kin - (resolution * tot[c] * deg[i]) / m2;
          if (gain > bestGain + 1e-12) {
            best = c;
            bestGain = gain;
          }
        }
        tot[best] += deg[i];
        if (best !== ci) {
          comm[i] = best;
          moved = true;
          improved = true;
        }
      }
      if (!moved) break;
    }
    if (!improved) break;
    // Gruppen zu Knoten zusammenfassen und weiter
    const renum = new Map<number, number>();
    for (const c of comm) if (!renum.has(c)) renum.set(c, renum.size);
    const next: Map<number, number>[] = Array.from({ length: renum.size }, () => new Map());
    for (let i = 0; i < n; i++) for (const [j, wij] of adj[i]) {
      const a = renum.get(comm[i])!;
      const b = renum.get(comm[j])!;
      next[a].set(b, (next[a].get(b) ?? 0) + wij);
    }
    member = member.map((x) => renum.get(comm[x])!);
    adj = next;
    n = next.length;
  }
  // Nach Größe nummerieren
  const size = new Map<number, number>();
  for (const c of member) size.set(c, (size.get(c) ?? 0) + 1);
  const order = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
  const rank = new Map(order.map((c, i) => [c, i]));
  return new Map(ids.map((id, i) => [id, rank.get(member[i])!]));
}

/** Farben für Gruppen (CSS-Variablen), wiederholen sich ab der zehnten */
export const GROUP_COLORS = ["--diamond", "--gold", "--redstone", "--grass", "--amethyst", "--lava", "--sky", "--pink", "--twitch", "--dirt"];

/** Gegenseitig: beide tun etwas für den anderen (geteilter Chat zählt für beide Seiten) */
export function isMutual(e: LinkCounts, w: Weights): boolean {
  const { ab, ba } = directed(e, w);
  return ab > 0 && ba > 0;
}
