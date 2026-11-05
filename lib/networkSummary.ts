import "server-only";
import { getNetwork } from "./connections";
import { adjacency } from "./network";
import { analyzeGroups, type GroupAnalysis } from "./groups";
import { DEFAULT_WEIGHTS, type LinkCounts } from "./connectionWeights";
import type { NetworkNode } from "./connections";

/**
 * Netz der ganzen Staffel mit Standard-Gewichten und fertigen Gruppen, für Auszüge auf anderen Seiten (Profil).
 * Einmal gerechnet und zwei Minuten behalten: sonst liefe die Gruppensuche bei jedem Profilaufruf.
 */
export interface NetworkSummary {
  nodes: NetworkNode[];
  edges: LinkCounts[];
  out: Map<string, Map<string, number>>;
  analysis: GroupAnalysis;
}

const TTL_MS = 2 * 60_000;
let cached: { at: number; value: Promise<NetworkSummary> } | null = null;

export function getNetworkSummary(): Promise<NetworkSummary> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = getNetwork(null).then(({ nodes, edges }) => ({ nodes, edges, out: adjacency(edges, DEFAULT_WEIGHTS), analysis: analyzeGroups(edges, DEFAULT_WEIGHTS) }));
  cached = { at: Date.now(), value };
  // Fehler nicht zwei Minuten lang behalten
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}
