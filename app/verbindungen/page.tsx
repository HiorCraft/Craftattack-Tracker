import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { PageSkeleton } from "@/components/Skeletons";
import { ConnectionExplorer } from "@/components/ConnectionExplorer";
import { FigValue } from "@/components/FigValue";
import { NETWORK_RANGES, getNetwork } from "@/lib/connections";
import { num } from "@/lib/format";

export const metadata: Metadata = { title: "Verbindungen" };

const RANGES = NETWORK_RANGES;

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/verbindungen">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Twitch" title="Verbindungen" tone="amethyst" />}>
      <Connections searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Connections({ searchParams }: { searchParams: PageProps<"/verbindungen">["searchParams"] }) {
  const sp = await searchParams;
  const range = RANGES.find((r) => r.key === sp.zeit) ?? RANGES[2];
  const { nodes, edges } = await getNetwork(range.hours);

  const raids = edges.reduce((s, e) => s + e.raidsAB + e.raidsBA, 0);
  const chats = edges.reduce((s, e) => s + e.chats, 0);
  const msgs = edges.reduce((s, e) => s + e.msgsAB + e.msgsBA, 0);
  const titleHours = Math.round(edges.reduce((s, e) => s + e.titleAB + e.titleBA, 0) / 3600);

  return (
    <>
      <section className="block page-head" data-tone="amethyst">
        <div className="wrap">
          <p className="eyebrow">Twitch</p>
          <h1 className="t-1">Verbindungen</h1>
          <p>
            Wer wen geraidet hat, wer wie lange gemeinsam im geteilten Chat war, wer wen im Stream-Titel nennt und wer im Twitch-Chat des anderen schreibt. Je enger die
            Verbindung, desto dicker die Linie und desto näher stehen die Köpfe zusammen. Wie viel jede Art zählt, stellst du
            selbst ein.
          </p>
        </div>
      </section>

      <section className="block block--tight" data-tone="ink">
        <div className="wrap">
          <ul className="filters" aria-label="Zeitraum">
            {RANGES.map((r) => (
              <li key={r.key}>
                <Link className="tag" aria-current={range.key === r.key ? "true" : undefined} href={r.key === "alle" ? "/verbindungen" : `/verbindungen?zeit=${r.key}`}>
                  {r.label}
                </Link>
              </li>
            ))}
          </ul>
          <dl className="grid st-figs">
            <div className="box st-fig" data-tone="twitch">
              <dt>Raids</dt>
              <FigValue>{num(raids)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="diamond">
              <dt title="Je Paar von Spielern, die gemeinsam im geteilten Chat waren">Geteilte Chats</dt>
              <FigValue>{num(chats)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="grass">
              <dt title="Stream-Zeit, in der Spieler einen anderen im Titel nannten („WG mit @…“), höchstens 8 Std je Tag und Paar">Im Titel genannt</dt>
              <FigValue unit="Std">{num(titleHours)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="gold">
              <dt title="Nachrichten von Spielern im Twitch-Chat eines anderen Spielers">Chat-Nachrichten</dt>
              <FigValue>{num(msgs)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="pink">
              <dt>Verbindungen</dt>
              <FigValue>{num(edges.length)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="sky">
              <dt>Spieler im Netz</dt>
              <FigValue>{num(new Set(edges.flatMap((e) => [e.a, e.b])).size)}</FigValue>
            </div>
          </dl>
        </div>
      </section>

      <section className="block" data-tone="paper">
        <div className="wrap">
          <ConnectionExplorer nodes={nodes} edges={edges} />
        </div>
      </section>
    </>
  );
}
