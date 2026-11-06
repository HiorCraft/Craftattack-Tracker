import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { Head } from "@/components/Head";
import { Explain } from "@/components/Explain";
import { HourBars, TraitBadge, clock } from "@/components/Rhythm";
import { ShareButton } from "@/components/ShareButton";
import { loadTracker } from "@/lib/data";
import { getRhythmMedians, getRhythms } from "@/lib/rhythm";
import { classifiable, traitReason } from "@/lib/rhythmCore";
import { playtimeOf } from "@/lib/playtime";
import { boardValue, duration, num } from "@/lib/format";
import { BOARD_TONE } from "@/lib/statTone";
import type { BoardKey } from "@/lib/types";
import { getNetworkSummary } from "@/lib/networkSummary";
import { closeness, distancesFrom } from "@/lib/network";
import { getAdvancementBoard } from "@/lib/playerAdvancements";
import { getTopClips } from "@/lib/clips";
import { getTwitchSubscriptionProfile } from "@/lib/store";
import { dailyHighlights } from "@/lib/highlights";
import { EVENT_META } from "@/lib/events";
import { ADVANCEMENTS, ADV_BY_ID } from "@/lib/advancements";

export async function generateMetadata({ params }: PageProps<"/spieler/[id]/rueckblick">): Promise<Metadata> {
  const { id } = await params;
  const { state } = await loadTracker();
  const p = state.players[decodeURIComponent(id).toLowerCase()];
  return { title: p ? `Staffel-Rückblick: ${p.name}` : "Staffel-Rückblick", description: p ? `Die CraftAttack-14-Staffel von ${p.name} in Zahlen.` : undefined };
}

export default function Page(props: PageProps<"/spieler/[id]/rueckblick">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Staffel-Rückblick" title="Wird zusammengestellt …" tone="grass" />}>
      <Wrapped params={props.params} />
    </Suspense>
  );
}

const DAY = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" });
const SHORT = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", timeZone: "Europe/Berlin" });
const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const dayLabel = (d: string) => DAY.format(new Date(`${d}T12:00:00Z`));

const STATS: BoardKey[] = ["diamonds", "blocksBroken", "mobsKilled", "distance", "damageDealt", "deaths"];
const LABEL: Partial<Record<BoardKey, string>> = {
  diamonds: "Diamanten",
  blocksBroken: "Blöcke abgebaut",
  mobsKilled: "Mobs erledigt",
  distance: "Strecke",
  damageDealt: "Schaden ausgeteilt",
  deaths: "Tode",
};

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
/** Platz unter allen Spielern mit Wert (1 = am meisten) */
const rankOf = (values: number[], v: number) => ({ rank: 1 + values.filter((x) => x > v).length, of: values.length });
const topShare = (rank: number, of: number) => Math.max(1, Math.ceil((rank / of) * 100));
/** „X fiel aus zu großer Höhe“ → „fiel aus zu großer Höhe“ (der erste Name ist immer der Spieler selbst) */
const causeOf = (msg: string) => msg.replace(/^\S+\s+/, "");
/** „1,8× so viel“ / „halb so viel“ im Vergleich zur Server-Mitte */
function vsMedian(v: number, med: number) {
  if (!med) return null;
  const f = v / med;
  if (f >= 1.15) return `${dec.format(f)}× so viel wie die Server-Mitte`;
  if (f <= 0.87) return `${Math.round(f * 100)} % der Server-Mitte`;
  return "etwa wie die Server-Mitte";
}

/** Greifbares Beispiel je Kennzahl; `hours` = Spielstunden */
function example(k: BoardKey, v: number, hours: number): string | null {
  switch (k) {
    case "diamonds":
      return v >= 24 ? `reicht für ${num(Math.floor(v / 24))} komplette Diamantrüstungen (je 24)` : `noch ${num(24 - v)} bis zur ersten kompletten Rüstung`;
    case "blocksBroken":
      return hours > 1 ? `${num(Math.round(v / hours))} Blöcke pro Spielstunde, etwa ${num(Math.round(v / hours / 60))} pro Minute` : null;
    case "mobsKilled":
      return hours > 1 ? `${dec.format(v / hours)} pro Spielstunde` : null;
    case "distance": {
      const km = v / 1000;
      return km >= 150 ? `etwa ${dec.format(km / 290)}× Berlin–Hamburg (290 km)` : `etwa ${dec.format(km / 42.195)} Marathons`;
    }
    case "damageDealt":
      return `so viel wie rund ${num(Math.round(v / 200))} Zombies (je 10 Herzen)`;
    case "deaths":
      return hours > 0 && v > 0 ? `im Schnitt alle ${duration((hours * 3600) / v)} Spielzeit einmal` : null;
    default:
      return null;
  }
}

function Card({ tone, span, kicker, help, children }: { tone: string; span: 4 | 6 | 8 | 12; kicker: string; help?: ReactNode; children: ReactNode }) {
  return (
    <section className={`wr-c wr-c--${span}`} data-tone={tone}>
      <p className="wr-kicker">
        {kicker} {help && <Explain label={`So gezählt: ${kicker}`}>{help}</Explain>}
      </p>
      {children}
    </section>
  );
}

async function Wrapped({ params }: { params: PageProps<"/spieler/[id]/rueckblick">["params"] }) {
  await connection();
  const { id: raw } = await params;
  const id = decodeURIComponent(raw).toLowerCase();
  const { state, events, now } = await loadTracker();
  const p = state.players[id];
  if (!p) notFound();
  const href = `/spieler/${encodeURIComponent(id)}`;

  const [rhythms, med, net, adv, clips, subs] = await Promise.all([
    getRhythms(),
    getRhythmMedians(),
    getNetworkSummary(),
    getAdvancementBoard(id, state.players),
    getTopClips({ player: id, limit: 1 }),
    getTwitchSubscriptionProfile(id, null).catch(() => null),
  ]);
  const r = rhythms.get(id) ?? null;
  const mine = events.filter((e) => e.player === id);
  const players = Object.values(state.players);

  /* ---- Online ---- */
  const play = playtimeOf(p, now).seconds;
  const hours = play / 3600;
  const allPlay = players.map((x) => playtimeOf(x, now).seconds).filter((v) => v > 0);
  const playRank = rankOf(allPlay, play);

  /* ---- Zahlen ---- */
  const stats = STATS.map((k) => {
    const v = p.stats[k];
    if (typeof v !== "number" || v <= 0) return null;
    const all = players.map((x) => x.stats[k]).filter((x): x is number => typeof x === "number" && x > 0);
    return { k, v, med: median(all), ...rankOf(all, v) };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const best = stats.filter((s) => s.k !== "deaths").sort((a, b) => a.rank / a.of - b.rank / b.of)[0];

  /* ---- Längster Tag ---- */
  const top = r?.topDay ?? null;
  const topSum = top ? dailyHighlights(events, id, top.day).summary : null;
  const topFacts = topSum
    ? [
        topSum.diamonds && `${num(topSum.diamonds)} Diamanten`,
        topSum.blocksBroken && `${num(topSum.blocksBroken)} Blöcke`,
        topSum.mobsKilled && `${num(topSum.mobsKilled)} Mobs`,
        topSum.deaths && `${num(topSum.deaths)}× gestorben`,
        topSum.achievements && `${num(topSum.achievements)} Fortschritte`,
      ].filter((x): x is string => Boolean(x))
    : [];

  /* ---- Tode ---- */
  const deaths = mine.filter((e) => e.type === "death" && !e.meta?.unknown);
  const count = (list: string[]) => [...list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const causes = count(deaths.map((e) => (typeof e.meta?.deathMessage === "string" ? causeOf(e.meta.deathMessage) : "")).filter(Boolean));
  const killers = count(deaths.map((e) => (typeof e.meta?.killerName === "string" ? e.meta.killerName : "")).filter(Boolean));
  const kills = events.filter((e) => e.type === "death" && e.meta?.killerId === id).length;

  /* ---- Fortschritte ---- */
  const advTotal = Object.keys(adv.mine).length;
  const reported = Object.entries(adv.mine).filter(([, s]) => s.at);
  const rare = reported
    .map(([aid]) => ({ a: ADV_BY_ID.get(aid), n: (adv.others[aid]?.[0] ?? 0) + (adv.others[aid]?.[1] ?? 0) }))
    .filter((x) => x.a?.parent)
    .sort((a, b) => a.n - b.n)
    .slice(0, 3);

  /* ---- Verbindungen ---- */
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const near = net.edges.some((e) => e.a === id || e.b === id)
    ? [...distancesFrom(id, net.out, "von").values()].filter((x) => x.id !== id).sort((a, b) => a.dist - b.dist).slice(0, 3)
    : [];
  const nm = (x: string) => byId.get(x)?.name ?? state.players[x]?.name ?? x;

  /* ---- Twitch ---- */
  const streamEnds = mine.filter((e) => e.type === "stream_end");
  const streamSeconds = streamEnds.reduce((s, e) => s + Number(e.meta?.streamSeconds ?? 0), 0) + (p.live && p.liveSince ? (now - Date.parse(p.liveSince)) / 1000 : 0);
  const streams = streamEnds.length + (p.live ? 1 : 0);
  const raidsOut = mine.filter((e) => e.type === "raid").length;
  const raidsIn = events.filter((e) => e.type === "raid" && e.meta?.raidTargetPlayerId === id).length;
  const clip = clips[0] ?? null;

  /* ---- Meilensteine ---- */
  const milestones = mine.filter((e) => e.type === "milestone");
  const leads = mine.filter((e) => e.type === "rank" && e.value === 1).length;
  const records = mine.filter((e) => e.type === "record").length;
  const firstAt = mine.find((e) => e.type === "join" || e.type === "first_join")?.at ?? p.firstSeen;

  return (
    <>
      <section className="block block--tight wr-hero" data-tone="grass">
        <div className="wrap wr-hero__in">
          <Head id={id} uuid={p.uuid} name={p.name} size={72} src={128} />
          <div className="wr-hero__text">
            <p className="eyebrow">Staffel-Rückblick · CraftAttack 14</p>
            <h1 className="t-2">{p.name}</h1>
            <p>Dabei seit {SHORT.format(new Date(firstAt))}. Alles, was der Tracker bis heute mitbekommen hat, im Vergleich mit allen anderen Spielern.</p>
          </div>
          <div className="wr-actions">
            <Link className="btn btn--small" data-tone="white" href={href}>
              Zum Profil
            </Link>
            <ShareButton title={`Staffel-Rückblick von ${p.name}`} />
          </div>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap wr-grid">
          <Card
            tone="sky"
            span={6}
            kicker="Online"
            help="Spielzeit laut craftattack.one (zwischen zwei Abrufen mit der vom Tracker gemessenen Zeit ergänzt). Sessions und Tage misst der Tracker selbst; Pausen bis 1 Std zählen zur selben Session."
          >
            <p className="wr-big num">{duration(play)}</p>
            <p>
              Platz <b>{num(playRank.rank)}</b> von {num(playRank.of)} · {vsMedian(play, median(allPlay))}.
            </p>
            {r && r.activeDays > 0 && (
              <ul className="wr-facts">
                <li>
                  An <b>{num(r.activeDays)} von {num(r.spanDays)} Tagen</b> online, im Schnitt {duration(r.minutesPerDay * 60)} pro Tag
                </li>
                <li>
                  <b>{num(r.sessions)} Sessions</b>, die längste {duration(r.longestSession * 60)} am Stück
                </li>
                <li className="muted">Zum Vergleich: etwa {num(Math.round(hours / 8))} Arbeitstage à 8 Stunden</li>
              </ul>
            )}
          </Card>

          {r && classifiable(r) ? (
            <Card
              tone="ender"
              span={6}
              kicker="Spielertyp"
              help="Ein Typ gilt, wenn jemand damit zum auffälligsten Fünftel aller Spieler gehört und eine Mindestgrenze erreicht. Uhrzeiten in deutscher Zeit."
            >
              {r.traits.length ? (
                <ul className="wr-traits">
                  {r.traits.slice(0, 3).map((t) => (
                    <li key={t.key}>
                      <TraitBadge k={t.key} score={t.score} href={`/spielertypen?typ=${t.key}#liste`} />
                      <span>{traitReason(r, t.key, med)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  <b>Ausgeglichen</b>: kein Merkmal sticht heraus, gespielt wird zu ähnlichen Zeiten und Längen wie bei den meisten.
                </p>
              )}
              <div className="wr-hours">
                <HourBars hours={r.hours} label={`Online-Zeit je Stunde, am meisten um ${r.peakHour} Uhr`} />
                <span className="wr-hours__axis" aria-hidden="true">
                  <span>0</span>
                  <span>6</span>
                  <span>12</span>
                  <span>18</span>
                  <span>24 Uhr</span>
                </span>
              </div>
              <p className="wr-small">
                Am meisten um {r.peakHour} Uhr{r.typicalStart !== null ? `, erster Login meist gegen ${clock(r.typicalStart)}` : ""}.{" "}
                <Link href="/spielertypen">Alle Typen</Link>
              </p>
            </Card>
          ) : (
            <Card tone="ender" span={6} kicker="Spielertyp">
              <p>Noch zu wenig Daten: eingeordnet wird ab 8 Std an 4 Tagen.</p>
            </Card>
          )}

          {stats.length > 0 && (
            <Card tone="white" span={12} kicker="In Zahlen" help="Werte laut craftattack.one. Platz unter allen Spielern mit einem Wert; Server-Mitte = Median, also der Wert, den die Hälfte übertrifft.">
              {best && (
                <p>
                  Am stärksten bei <b>{LABEL[best.k]}</b>: Platz {num(best.rank)} von {num(best.of)}, unter den besten {topShare(best.rank, best.of)} %.
                </p>
              )}
              <dl className="wr-stats">
                {stats.map((s) => (
                  <div key={s.k} className="wr-stat" data-tone={BOARD_TONE[s.k]}>
                    <dt>{LABEL[s.k]}</dt>
                    <dd className="wr-stat__v num">{boardValue(s.k, s.v)}</dd>
                    <dd className="wr-stat__rank">
                      Platz {num(s.rank)} von {num(s.of)} · {vsMedian(s.v, s.med)}
                    </dd>
                    {example(s.k, s.v, hours) && <dd className="wr-stat__ex">{example(s.k, s.v, hours)}</dd>}
                  </div>
                ))}
              </dl>
            </Card>
          )}

          {top && topSum && (
            <Card tone="gold" span={6} kicker="Der längste Tag" help="Der Kalendertag mit der meisten Online-Zeit laut Tracker.">
              <p className="wr-mid">{dayLabel(top.day)}</p>
              <p>
                <b>{duration(top.minutes * 60)}</b> online
                {r && r.minutesPerDay > 0 && <>, {dec.format(top.minutes / r.minutesPerDay)}× so lang wie an einem normalen Tag</>}.
              </p>
              {topFacts.length > 0 && <p className="wr-small">An dem Tag: {topFacts.join(" · ")}</p>}
              <p className="wr-small">
                <Link href={`/zeitstrahl?tag=${top.day}`}>Im Zeitstrahl ansehen</Link>
              </p>
            </Card>
          )}

          {(deaths.length > 0 || kills > 0) && (
            <Card tone="redstone" span={6} kicker="Friedhof" help="Tode aus dem Feed von craftattack.one, mit der Todesnachricht aus dem Spiel. Nicht jeder Tod hat eine Nachricht; „erledigt“ zählt Spieler, die er selbst getötet hat.">
              <p className="wr-mid num">{num(p.stats.deaths ?? deaths.length)}× gestorben</p>
              <ul className="wr-facts">
                {causes[0] && (
                  <li>
                    Meistens <b>„{causes[0][0]}“</b> ({num(causes[0][1])}×){causes[1] && <>, danach „{causes[1][0]}“ ({num(causes[1][1])}×)</>}
                  </li>
                )}
                {killers[0] && (
                  <li>
                    Am häufigsten erwischt von <b>{killers[0][0]}</b> ({num(killers[0][1])}×)
                  </li>
                )}
                {kills > 0 && (
                  <li>
                    Selbst <b>{num(kills)}× einen Spieler</b> erledigt
                  </li>
                )}
              </ul>
            </Card>
          )}

          {advTotal > 0 && (
            <Card tone="diamond" span={4} kicker="Fortschritte" help="Gemeldet: im Feed von craftattack.one gesehen. Dazu vermutete: ein späterer Fortschritt setzt sie voraus, oder die Statistik zeigt es. Selten = wenige Spieler haben ihn.">
              <p className="wr-mid num">
                {num(advTotal)} <span className="wr-unit">von {num(ADVANCEMENTS.length)}</span>
              </p>
              <p className="wr-small">
                {num(reported.length)} davon gemeldet, die übrigen vermutet. Die seltensten:
              </p>
              <ol className="wr-list">
                {rare.map((x) => (
                  <li key={x.a!.id}>
                    <b>„{x.a!.title}“</b>{" "}
                    <span className="wr-small">
                      {num(x.n)} von {num(adv.players)} · {x.a!.desc}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {near.length > 0 && (
            <Card tone="amethyst" span={4} kicker="Engste Verbindungen" help="Nähe über den kürzesten Weg im Netz aus Raids, geteiltem Chat, Namen im Stream-Titel und Chat-Nachrichten, in Richtung der anderen. 50 % = direkt mit 1 Punkt verbunden.">
              <ol className="wr-friends">
                {near.map((x) => (
                  <li key={x.id}>
                    <Link href={`/spieler/${encodeURIComponent(x.id)}`}>
                      <Head id={x.id} uuid={byId.get(x.id)?.uuid} name={nm(x.id)} size={28} src={32} decorative />
                      <span>{nm(x.id)}</span>
                    </Link>
                    <span className="wr-small num">{Math.round(closeness(x.dist) * 100)} %</span>
                    <span className="wr-small wr-friends__how">{x.hops === 1 ? "direkt verbunden" : `über ${x.path.slice(1, -1).map(nm).join(", ")}`}</span>
                  </li>
                ))}
              </ol>
              <p className="wr-small">
                <Link href={`/verbindungen?ansicht=distanz&spieler=${encodeURIComponent(id)}`}>Alle Verbindungen</Link>
              </p>
            </Card>
          )}

          {streams > 0 && (
            <Card tone="twitch" span={near.length > 0 && advTotal > 0 ? 4 : 6} kicker="Auf Twitch" help="Live-Zeit und Streams laut Tracker (Stream an/aus), Zuschauer-Spitze und Subs laut Twitch, Raids aus dem Chat.">
              <p className="wr-mid num">{duration(streamSeconds)}</p>
              <ul className="wr-facts">
                <li>
                  {num(streams)} Streams, im Schnitt {duration(streamSeconds / streams)}
                </li>
                {p.peakViewers > 0 && (
                  <li>
                    Bis zu <b>{num(p.peakViewers)} Zuschauer</b> gleichzeitig
                  </li>
                )}
                {subs && subs.total > 0 && (
                  <li>
                    <b>{num(subs.total)} Subs</b> erfasst
                  </li>
                )}
                {(raidsOut > 0 || raidsIn > 0) && (
                  <li>
                    {num(raidsOut)}× geraidet, {num(raidsIn)}× selbst geraidet worden
                  </li>
                )}
              </ul>
              {clip && (
                <a className="wr-clip" href={clip.url} target="_blank" rel="noopener noreferrer" title="Beliebtester Clip">
                  {clip.thumbnail && <img src={clip.thumbnail} alt="" width={96} height={54} loading="lazy" />}
                  <span>
                    <b>{clip.title}</b>
                    <span className="wr-small">Top-Clip · {num(clip.views)} Aufrufe</span>
                  </span>
                </a>
              )}
            </Card>
          )}

          {(milestones.length > 0 || leads > 0 || records > 0) && (
            <Card tone="white" span={12} kicker="Meilensteine" help="Runde Marken (z. B. 1.000 Diamanten), Platz 1 in einer Bestenliste übernommen, neue Server-Rekorde.">
              <dl className="wr-mini">
                <div>
                  <dt>Marken geknackt</dt>
                  <dd className="num">{num(milestones.length)}</dd>
                </div>
                <div>
                  <dt>Platz 1 übernommen</dt>
                  <dd className="num">{num(leads)}×</dd>
                </div>
                <div>
                  <dt>Server-Rekorde</dt>
                  <dd className="num">{num(records)}</dd>
                </div>
              </dl>
              {milestones.length > 0 && (
                <p className="wr-small">
                  Zuletzt:{" "}
                  {milestones
                    .map((e) => EVENT_META.milestone.text(e))
                    .filter((t) => !/ erreicht$/.test(t))
                    .slice(-3)
                    .reverse()
                    .map((t) => `${p.name} ${t}`)
                    .join(" · ")}
                </p>
              )}
            </Card>
          )}
        </div>
        <p className="wrap wr-foot muted">
          Die Staffel läuft noch, der Rückblick wächst mit. Lücken des Trackers (vor allem vor dem 13. Oktober) fehlen in den Zeiten. Grafiken aus Minecraft © Mojang, keine
          offizielle Seite.
        </p>
      </section>
    </>
  );
}

