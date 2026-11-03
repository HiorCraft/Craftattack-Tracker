import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { NetworkLab } from "@/components/NetworkLab";
import { Explain } from "@/components/Explain";
import { DataAge } from "@/components/DataAge";
import { NETWORK_RANGES, getNetwork } from "@/lib/connections";

export const metadata: Metadata = { title: "Nähe", description: "Ein Spieler in der Mitte, alle anderen nach ihrer Nähe im Netz aus Raids, geteilten Chats, Titeln und Chat-Nachrichten." };

/** Ringe um einen Spieler: alle anderen nach ihrer Nähe im Netz */
export default function Page(props: PageProps<"/naehe">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Community" title="Nähe" tone="amethyst" />}>
      <Rings searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Rings({ searchParams }: { searchParams: PageProps<"/naehe">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const range = NETWORK_RANGES.find((r) => r.key === sp.zeit) ?? NETWORK_RANGES[2];
  const { nodes, edges, at } = await getNetwork(range.hours);
  const spieler = typeof sp.spieler === "string" && nodes.some((n) => n.id === sp.spieler) ? sp.spieler : "";
  return (
    <>
      <section className="block page-head" data-tone="amethyst">
        <div className="wrap">
          <p className="eyebrow">Community</p>
          <h1 className="t-1">Nähe</h1>
          <p>
            Ein Spieler in der Mitte, alle anderen nach ihrer Nähe zu ihm.{" "}
            <Explain>
              Nähe über den kürzesten Weg im Netz: Raids, Titel und Chat-Nachrichten zählen nur in ihre Richtung, geteilter Chat in beide. Ein Klick auf
              einen Kopf setzt ihn in die Mitte. Wer mit wem eine Gruppe bildet, zeigt <Link href="/gruppen">Gruppen</Link>.
            </Explain>{" "}
            <DataAge at={at} prefix="Auswertung" hint="wird alle 10 Minuten im Hintergrund neu berechnet" />
          </p>
        </div>
      </section>
      <section className="block" data-tone="paper">
        <div className="wrap">
          <NetworkLab nodes={nodes} edges={edges} initialFocus={spieler} ranges={NETWORK_RANGES.map(({ key, label }) => ({ key, label }))} range={range.key} />
        </div>
      </section>
    </>
  );
}
