import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { GroupsTimeline } from "@/components/GroupsTimeline";
import { Explain } from "@/components/Explain";
import { getDailyNetwork } from "@/lib/connections";

export const metadata: Metadata = { title: "Gruppen", description: "Wer auf CraftAttack 14 untereinander eng verbunden ist: Gruppen aus Raids, geteilten Chats, Titeln und Chat-Nachrichten, über die Zeit." };

/** Alle erkannten Gruppen: Karte der Gruppen bzw. aller Spieler, über die Zeit */
export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Community" title="Gruppen" tone="amethyst" />}>
      <Groups />
    </Suspense>
  );
}

async function Groups() {
  await connection();
  const { nodes, daily } = await getDailyNetwork();
  return (
    <>
      <section className="block page-head" data-tone="amethyst">
        <div className="wrap">
          <p className="eyebrow">Community</p>
          <h1 className="t-1">Gruppen</h1>
          <p>
            Wer untereinander deutlich enger verbunden ist als mit dem Rest, über die ganze Staffel oder an einem bestimmten Tag.{" "}
            <Explain>
              Gezählt werden Raids, Chat-Nachrichten, geteilte Chats und Namen im Stream-Titel; die Einteilung rechnet ein Programm (Louvain) aus diesen
              öffentlichen Daten, sie sagt nichts über echte Freundschaften. Jede Gruppe ist nach ihrem Anführer benannt: dem Mitglied, das in der Gruppe
              die meiste Aufmerksamkeit bekommt. Siehe auch <Link href="/verbindungen">Netz</Link> und <Link href="/naehe">Nähe</Link>.
            </Explain>
          </p>
        </div>
      </section>
      <section className="block" data-tone="paper">
        <div className="wrap">
          <GroupsTimeline nodes={nodes} daily={daily} />
        </div>
      </section>
    </>
  );
}
