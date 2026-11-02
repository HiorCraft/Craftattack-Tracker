import { Suspense } from "react";
import type { Metadata } from "next";
import { PageSkeleton } from "@/components/Skeletons";
import { GraphBuilder } from "@/components/GraphBuilder";
import { loadTracker } from "@/lib/data";
import { parseGraphQuery, toSearch } from "@/lib/graphQuery";
import { itemOptions } from "@/lib/leaderboards";

export const metadata: Metadata = { title: "Graph" };

/**
 * Der eine Graph der Seite: jede Kurve (Profil, Statistik, Live, Bestenlisten) verlinkt hierher und lässt sich
 * frei weiterbauen – Kennzahlen, Ränge, einzelne Blöcke/Mobs, Spieler, Zeitraum. Kopf knapp, damit der Graph ohne
 * Scrollen sichtbar ist.
 */
async function Graph(props: PageProps<"/graph">) {
  const [sp, { state }] = await Promise.all([props.searchParams, loadTracker()]);
  const all = Object.values(state.players);
  const players = all.map((p) => ({ id: p.id, name: p.name, uuid: p.uuid, online: p.online })).sort((a, b) => a.name.localeCompare(b.name, "de"));
  const initial = parseGraphQuery(sp);
  return (
    <>
      <section className="block page-head page-head--compact" data-tone="ender">
        <div className="wrap">
          <h1 className="t-1">Graph</h1>
          <p>Jede Kennzahl, jeder Rang und jeder Block – für den Server oder einzelne Spieler. Der Link lässt sich teilen.</p>
        </div>
      </section>
      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          {/* key: bei neuen Adress-Parametern (z. B. Link aus dem Profil) die Auswahl neu aufsetzen */}
          <GraphBuilder key={toSearch(initial).toString()} players={players} initial={initial} items={itemOptions(all)} />
        </div>
      </section>
    </>
  );
}

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/graph">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Graph" title="Graph" />}>
      <Graph {...props} />
    </Suspense>
  );
}
