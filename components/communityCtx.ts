import type { GraphEdge, GraphNode } from "./ConnectionGraph";
import type { LinkCounts, Weights } from "@/lib/connectionWeights";
import type { CommunitySettings } from "@/lib/communitySettings";
import type { GroupAnalysis } from "@/lib/groups";

/** Was alle Ansichten der Verbindungs-Seite gemeinsam bekommen: dieselben gefilterten Daten und Einstellungen */
export interface CommunityCtx {
  nodes: GraphNode[];
  byId: Map<string, GraphNode>;
  name: (id: string) => string;
  /** Verbindungen nach Zeitraum, Spieler-Filter, Mindeststärke und „gegenseitig“ */
  counts: LinkCounts[];
  /** Dieselben mit Punkten nach der Gewichtung */
  weighted: GraphEdge[];
  weights: Weights;
  analysis: GroupAnalysis;
  /** Gruppenfarbe je Spieler (CSS-Variable) */
  groupColor: (id: string) => string | null;
  s: CommunitySettings;
  set: (patch: Partial<CommunitySettings>) => void;
  /** Gewählter Spieler oder leer (allgemeine Ansicht) */
  focus: string;
  select: (id: string) => void;
}
