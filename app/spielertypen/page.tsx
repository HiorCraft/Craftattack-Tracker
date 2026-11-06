import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { Explain } from "@/components/Explain";
import { Head } from "@/components/Head";
import { ShowMore } from "@/components/ShowMore";
import { FigValue } from "@/components/FigValue";
import { HourBars, TraitBadges, clock } from "@/components/Rhythm";
import { loadTracker } from "@/lib/data";
import { getRhythms, type Rhythm } from "@/lib/rhythm";
import { MIN_DAYS, MIN_MINUTES, TRAITS, type TraitKey } from "@/lib/rhythmCore";
import { duration, num } from "@/lib/format";

export const metadata: Metadata = {
  title: "Spielertypen",
  description: "Wann, wie lange und wie regelmäßig die CraftAttack-Spieler spielen: Nachteulen, Wochenend-Spieler, Marathon-Spieler und mehr.",
};

export default function Page(props: PageProps<"/spielertypen">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Spieler" title="Spielertypen" />}>
      <Types searchParams={props.searchParams} />
    </Suspense>
  );
}

const GROUPS: { key: string; label: string }[] = [
  { key: "zeit", label: "Tageszeit" },
  { key: "woche", label: "Woche" },
  { key: "laenge", label: "Session-Länge" },
  { key: "takt", label: "Regelmäßigkeit" },
  { key: "stream", label: "Stream und AFK" },
];
const KEYS = Object.keys(TRAITS) as TraitKey[];
const pct = (v: number) => `${Math.round(v * 100)} %`;
const typHref = (k?: string) => (k ? `/spielertypen?typ=${k}#liste` : "/spielertypen#liste");

async function Types({ searchParams }: { searchParams: PageProps<"/spielertypen">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const [{ state }, rhythms] = await Promise.all([loadTracker(), getRhythms()]);
  const typ = typeof sp.typ === "string" && (KEYS.includes(sp.typ as TraitKey) || sp.typ === "ausgeglichen") ? sp.typ : null;
  const name = (id: string) => state.players[id]?.name ?? id;
  const ranked = [...rhythms.values()].filter((r) => r.minutes >= MIN_MINUTES && r.activeDays >= MIN_DAYS);
  const byTrait = new Map<TraitKey, Rhythm[]>(
    KEYS.map((k) => [
      k,
      ranked
        .filter((r) => r.traits.some((t) => t.key === k))
        .sort((a, b) => (b.traits.find((t) => t.key === k)?.score ?? 0) - (a.traits.find((t) => t.key === k)?.score ?? 0)),
    ]),
  );
  const plain = ranked.filter((r) => !r.traits.length);
  const mainCount = new Map<TraitKey, number>();
  for (const r of ranked) if (r.traits[0]) mainCount.set(r.traits[0].key, (mainCount.get(r.traits[0].key) ?? 0) + 1);
  const commonest = [...mainCount].sort((a, b) => b[1] - a[1])[0];
  const list = (typ === "ausgeglichen" ? plain : typ ? (byTrait.get(typ as TraitKey) ?? []) : [...ranked].sort((a, b) => b.minutes - a.minutes));

  return (
    <>
      <section className="block page-head" data-tone="grass">
        <div className="wrap">
          <p className="eyebrow">Spieler</p>
          <h1 className="t-1">Spielertypen</h1>
          <p>
            Wann, wie lange und wie regelmäßig gespielt wird, und wer dabei heraussticht.{" "}
            <Explain label="Wie eingeordnet wird">
              Grundlage sind die vom Tracker gemessenen Sessions (Ein- und Ausloggen), Live-Phasen und AFK-Phasen, Zeiten in deutscher Ortszeit. Eingeordnet
              wird, wer mindestens {MIN_MINUTES / 60} Std an {MIN_DAYS} Tagen online war. Ein Typ gilt, wenn jemand damit zum auffälligsten Fünftel aller
              Spieler gehört und eine Mindestgrenze erreicht (z. B. Nachteule: mindestens 18 % der Zeit zwischen 0 und 6 Uhr). Je Bereich zählt nur das
              deutlichste Merkmal; das stärkste insgesamt steht vorn. Kurze Unterbrechungen unter 15 Min zählen nicht als neue Session.
            </Explain>
          </p>
        </div>
      </section>

      <section className="block" data-tone="paper">
        <div className="wrap stack">
          <dl className="grid st-figs">
            <div className="box st-fig" data-tone="white">
              <dt>Eingeordnet</dt>
              <FigValue>{num(ranked.length)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="white">
              <dt>Häufigster Haupttyp</dt>
              <FigValue>{commonest ? TRAITS[commonest[0]].label : "–"}</FigValue>
            </div>
            <div className="box st-fig" data-tone="white">
              <dt>Ausgeglichen</dt>
              <FigValue>{num(plain.length)}</FigValue>
            </div>
          </dl>

          {GROUPS.map((g) => (
            <div key={g.key}>
              <h2 className="t-3 rh-group">{g.label}</h2>
              <div className="rh-types">
                {KEYS.filter((k) => TRAITS[k].group === g.key).map((k) => {
                  const who = byTrait.get(k) ?? [];
                  return (
                    <div key={k} className="box rh-type" data-tone="white" style={{ "--tone": `var(${TRAITS[k].tone})` } as React.CSSProperties}>
                      <h3 className="rh-type__title">
                        <Link href={typHref(k)} aria-current={typ === k ? "true" : undefined}>
                          {TRAITS[k].label}
                        </Link>
                        <span className="rh-type__n num">{num(who.length)}</span>
                      </h3>
                      <p className="muted rh-type__hint">{TRAITS[k].hint}</p>
                      <div className="rh-type__heads">
                        {who.slice(0, 10).map((r) => (
                          <Link key={r.id} href={`/spieler/${encodeURIComponent(r.id)}`} title={name(r.id)}>
                            <Head id={r.id} uuid={state.players[r.id]?.uuid} name={name(r.id)} size={28} />
                          </Link>
                        ))}
                        {who.length > 10 && (
                          <Link className="rh-type__more" href={typHref(k)}>
                            +{who.length - 10}
                          </Link>
                        )}
                        {!who.length && <span className="muted">niemand</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="block" data-tone="paper" id="liste" aria-labelledby="liste-h">
        <div className="wrap stack">
          <div className="section-head">
            <h2 className="t-2" id="liste-h">
              {typ === "ausgeglichen" ? "Ausgeglichen" : typ ? TRAITS[typ as TraitKey].label : "Alle Spieler"}
            </h2>
            <div className="gb__seg rh-filter" role="group" aria-label="Typ">
              <Link href={typHref()} aria-current={!typ ? "true" : undefined}>
                Alle
              </Link>
              {KEYS.map((k) => (
                <Link key={k} href={typHref(k)} aria-current={typ === k ? "true" : undefined}>
                  {TRAITS[k].label}
                </Link>
              ))}
              <Link href={typHref("ausgeglichen")} aria-current={typ === "ausgeglichen" ? "true" : undefined}>
                Ausgeglichen
              </Link>
            </div>
          </div>
          <div className="box" data-tone="white">
            <ShowMore height={900} label="Spieler">
              <div className="tbl-wrap">
                <table className="tbl rh-tbl">
                  <thead>
                    <tr>
                      <th>Spieler</th>
                      <th>Typ</th>
                      <th>
                        Tagesverlauf <Explain label="Tagesverlauf">Online-Zeit je Stunde von 0 bis 24 Uhr, die Nacht (0–6 Uhr) ist hinterlegt.</Explain>
                      </th>
                      <th className="num">Online</th>
                      <th className="num" title="Median der Session-Länge">Session</th>
                      <th className="num" title="Tage mit mindestens 15 Min online, von allen Tagen seit dem ersten Mal">Aktive Tage</th>
                      <th className="num" title="Typische erste Einlog-Uhrzeit des Tages">Erster Login</th>
                      <th className="num" title="Anteil der Online-Zeit, in der live gestreamt wurde">Live</th>
                      <th className="num" title="Anteil der Online-Zeit AFK">AFK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link className="rh-who" href={`/spieler/${encodeURIComponent(r.id)}`}>
                            <Head id={r.id} uuid={state.players[r.id]?.uuid} name={name(r.id)} size={22} decorative />
                            {name(r.id)}
                          </Link>
                        </td>
                        <td>
                          <TraitBadges traits={r.traits} hrefOf={(k) => typHref(k)} />
                        </td>
                        <td>
                          <HourBars hours={r.hours} label={`Tagesverlauf von ${name(r.id)}, am meisten um ${r.peakHour} Uhr`} />
                        </td>
                        <td className="num">{duration(r.minutes * 60)}</td>
                        <td className="num">{duration(r.medianSession * 60)}</td>
                        <td className="num">
                          {num(r.activeDays)}
                          <span className="muted"> / {num(r.spanDays)}</span>
                        </td>
                        <td className="num">{r.typicalStart !== null ? clock(r.typicalStart) : "–"}</td>
                        <td className="num">{r.liveShare !== null ? pct(r.liveShare) : "–"}</td>
                        <td className="num">{pct(r.afkShare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ShowMore>
          </div>
        </div>
      </section>
    </>
  );
}
