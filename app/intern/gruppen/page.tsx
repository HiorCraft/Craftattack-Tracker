import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { GroupsTimeline } from "@/components/GroupsTimeline";
import { Explain } from "@/components/Explain";
import { getDailyNetwork } from "@/lib/connections";
import { internAllowed } from "@/lib/intern";

export const metadata: Metadata = { title: "Gruppen (Versuch)", robots: { index: false, follow: false } };

/** Alle erkannten Gruppen (intern, Versuch): Karte der Gruppen und eine Karte je Gruppe */
export default function Page(props: PageProps<"/intern/gruppen">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Intern" title="Gruppen" tone="amethyst" />}>
      <Groups searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Groups({ searchParams }: { searchParams: PageProps<"/intern/gruppen">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const key = sp.key;
  if (!internAllowed(key)) notFound();
  const { nodes, daily } = await getDailyNetwork();
  return (
    <>
      <section className="block page-head" data-tone="amethyst">
        <div className="wrap">
          <p className="eyebrow">Intern · Versuch</p>
          <h1 className="t-1">Gruppen</h1>
          <p>
            Wer untereinander deutlich enger verbunden ist als mit dem Rest, über die ganze Staffel oder an einem bestimmten Tag.{" "}
            <Explain>
              Gezählt werden Raids, Chat-Nachrichten, geteilte Chats und Namen im Stream-Titel. Jede Gruppe ist nach ihrem Anführer benannt: dem
              Mitglied, das in der Gruppe die meiste Aufmerksamkeit bekommt. Siehe auch das <Link href={`/intern/netz?key=${encodeURIComponent(key)}`}>Netz</Link>.
            </Explain>
          </p>
        </div>
      </section>
      <section className="block" data-tone="paper">
        <div className="wrap">
          <GroupsTimeline nodes={nodes} daily={daily} base={{ path: "/intern/gruppen", key }} />
        </div>
      </section>
    </>
  );
}
