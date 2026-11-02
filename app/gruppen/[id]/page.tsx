import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { GroupView } from "@/components/GroupViews";
import { getNetwork } from "@/lib/connections";

export const metadata: Metadata = { title: "Gruppe" };

/**
 * Eine Gruppe, adressiert über einen Spieler (`/gruppen/<id>`): die Gruppe, in der er gerade ist. So bleiben
 * Links gültig, auch wenn sich Gruppen mit neuen Daten oder anderer Feinheit verschieben.
 */
export default function Page(props: PageProps<"/gruppen/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Community · Gruppe" title="Gruppe" tone="amethyst" />}>
      <Group params={props.params} />
    </Suspense>
  );
}

async function Group({ params }: { params: PageProps<"/gruppen/[id]">["params"] }) {
  await connection();
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  const { nodes, edges } = await getNetwork(null);
  if (!nodes.some((n) => n.id === id)) notFound();
  return (
    <>
      <section className="block block--tight" data-tone="amethyst">
        <div className="wrap">
          <p className="eyebrow">
            <Link href="/gruppen">← Alle Gruppen</Link>
          </p>
        </div>
      </section>
      <section className="block" data-tone="paper">
        <div className="wrap">
          <GroupView nodes={nodes} edges={edges} member={id} />
        </div>
      </section>
    </>
  );
}
