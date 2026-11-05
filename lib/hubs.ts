/**
 * Hauptnavigation: fünf Bereiche, jeder mit eigenen Reitern. Die Adressen der Seiten bleiben, wie sie sind;
 * die Bereiche fassen sie nur zusammen (Reiterleiste unter dem Kopf).
 */
export interface HubTab {
  href: string;
  label: string;
  /** Weitere Pfade, die zu diesem Reiter gehören (Unterseiten) */
  also?: string[];
}
export interface Hub {
  key: string;
  label: string;
  tabs: HubTab[];
}

export const HUBS: Hub[] = [
  {
    key: "jetzt",
    label: "Jetzt",
    tabs: [
      { href: "/", label: "Übersicht" },
      { href: "/live", label: "Live" },
      { href: "/events", label: "Events" },
    ],
  },
  { key: "spieler", label: "Spieler", tabs: [{ href: "/spieler", label: "Spieler" }] },
  { key: "bestenlisten", label: "Bestenlisten", tabs: [{ href: "/bestenlisten", label: "Bestenlisten" }] },
  {
    key: "verlauf",
    label: "Verlauf",
    tabs: [
      { href: "/ereignisse", label: "Ereignisse" },
      { href: "/zeitstrahl", label: "Zeitstrahl" },
      { href: "/graph", label: "Graph" },
      { href: "/statistik", label: "Statistik" },
    ],
  },
  {
    key: "community",
    label: "Community",
    tabs: [
      { href: "/verbindungen", label: "Verbindungen", also: ["/gruppen"] },
      { href: "/zuschauer", label: "Zuschauer" },
    ],
  },
];

const matches = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** Bereich und Reiter zu einem Pfad (null, wenn die Seite zu keinem Bereich gehört) */
export function hubOf(path: string | null): { hub: Hub; tab: HubTab } | null {
  if (!path) return null;
  for (const hub of HUBS)
    for (const tab of hub.tabs) if (matches(path, tab.href) || tab.also?.some((a) => matches(path, a))) return { hub, tab };
  return null;
}
