import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { Head } from "@/components/Head";
import { HourBars, TraitBadges, clock } from "@/components/Rhythm";
import { ShareButton } from "@/components/ShareButton";
import { loadTracker } from "@/lib/data";
import { getRhythms } from "@/lib/rhythm";
import { classifiable } from "@/lib/rhythmCore";
import { playtimeOf } from "@/lib/playtime";
import { boardValue, duration, num } from "@/lib/format";
import { BOARD_TONE } from "@/lib/statTone";
import type { BoardKey, TrackerEvent } from "@/lib/types";
import { getNetworkSummary } from "@/lib/networkSummary";
import { closeness, distancesFrom } from "@/lib/network";
import { getAdvancementBoard } from "@/lib/playerAdvancements";
import { ADV_BY_ID } from "@/lib/advancements";
import { getTopClips } from "@/lib/clips";
import { getTwitchSubscriptionProfile } from "@/lib/store";
import { dailyHighlights } from "@/lib/highlights";

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

/** Platz unter allen Spielern mit Wert (1 = am meisten) */
function rankOf(values: number[], v: number) {
  return { rank: 1 + values.filter((x) => x > v).length, of: values.length };
}
const topShare = (rank: number, of: number) => Math.max(1, Math.ceil((rank / of) * 100));

/** „X fiel aus zu großer Höhe“ → „fiel aus zu großer Höhe“ (der erste Name ist immer der Spieler selbst) */
const causeOf = (msg: string) => msg.replace(/^\S+\s+/, "");

async function Wrapped({ params }: { params: PageProps<"/spieler/[id]/rueckblick">["params"] }) {
  await connection();
  const { id: raw } = await params;
  const id = decodeURIComponent(raw).toLowerCase();
  const { state, events, now } = await loadTracker();
  const p = state.players[id];
  if (!p) notFound();
  const href = `/spieler/${encodeURIComponent(id)}`;

  const [rhythms, net, adv, clips, subs] = await Promise.all([
    getRhythms(),
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
  const playRank = rankOf(
    players.map((x) => playtimeOf(x, now).seconds).filter((v) => v > 0),
    play,
  );

  /* ---- Zahlen mit Platz ---- */
  const stats = STATS.map((k) => {
    const v = p.stats[k];
    if (v === undefined || v === null) return null;
    const all = players.map((x) => x.stats[k]).filter((x): x is number => typeof x === "number" && x > 0);
    return { k, v, ...rankOf(all, v) };
  }).filter((x): x is NonNullable<typeof x> => x !== null && x.v > 0);
  const best = [...stats].filter((s) => s.k !== "deaths").sort((a, b) => a.rank / a.of - b.rank / b.of)[0];

  /* ---- Bester Tag ---- */
  const top = r?.topDay ?? null;
  const topSummary = top ? dailyHighlights(events, id, top.day).summary : null;

  /* ---- Tode ---- */
  const deaths = mine.filter((e) => e.type === "death" && !e.meta?.unknown);
  const causes = new Map<string, number>();
  const killers = new Map<string, number>();
  for (const e of deaths) {
    if (typeof e.meta?.deathMessage === "string") causes.set(causeOf(e.meta.deathMessage), (causes.get(causeOf(e.meta.deathMessage)) ?? 0) + 1);
    if (typeof e.meta?.killerName === "string") killers.set(e.meta.killerName, (killers.get(e.meta.killerName) ?? 0) + 1);
  }
  const topCause = [...causes].sort((a, b) => b[1] - a[1])[0];
  const topKiller = [...killers].sort((a, b) => b[1] - a[1])[0];
  const kills = events.filter((e) => e.type === "death" && e.meta?.killerId === id).length;

  /* ---- Fortschritte ---- */
  const reported = Object.entries(adv.mine).filter(([, s]) => s.at);
  const rarest = reported
    .map(([aid]) => ({ a: ADV_BY_ID.get(aid), n: (adv.others[aid]?.[0] ?? 0) + (adv.others[aid]?.[1] ?? 0) }))
    .filter((x) => x.a && x.a.parent)
    .sort((a, b) => a.n - b.n)[0];
  const advTotal = Object.keys(adv.mine).length;

  /* ---- Verbindungen ---- */
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  const near = net.edges.some((e) => e.a === id || e.b === id)
    ? [...distancesFrom(id, net.out, "von").values()].filter((x) => x.id !== id).sort((a, b) => a.dist - b.dist).slice(0, 3)
    : [];

  /* ---- Twitch ---- */
  const streamEnds = mine.filter((e) => e.type === "stream_end");
  const streamSeconds = streamEnds.reduce((s, e) => s + Number(e.meta?.streamSeconds ?? 0), 0) + (p.live && p.liveSince ? (now - Date.parse(p.liveSince)) / 1000 : 0);
  const streams = streamEnds.length + (p.live ? 1 : 0);
  const raidsOut = mine.filter((e) => e.type === "raid").length;
  const raidsIn = events.filter((e) => e.type === "raid" && e.meta?.raidTargetPlayerId === id).length;
  const clip = clips[0] ?? null;

  /* ---- Meilensteine ---- */
  const milestones = mine.filter((e) => e.type === "milestone").length;
  const leads = mine.filter((e) => e.type === "rank" && e.value === 1).length;
  const records = mine.filter((e) => e.type === "record").length;
  const firstAt = [...mine].find((e: TrackerEvent) => e.type === "join" || e.type === "first_join")?.at ?? p.firstSeen;

  return (
    <>
      <section className="block wr-hero" data-tone="grass">
        <div className="wrap wr-hero__in">
          <Head id={id} uuid={p.uuid} name={p.name} size={112} src={128} />
          <div>
            <p className="eyebrow">Staffel-Rückblick · CraftAttack 14</p>
            <h1 className="t-1">{p.name}</h1>
            <p>
              Dabei seit {SHORT.format(new Date(firstAt))}. Alles, was der Tracker bis heute mitbekommen hat.
            </p>
            <div className="wr-actions">
              <Link className="btn btn--small" data-tone="white" href={href}>
                Zum Profil
              </Link>
              <ShareButton title={`Staffel-Rückblick von ${p.name}`} />
            </div>
          </div>
        </div>
      </section>

      <div className="wr">
        <section className="wr-card" data-tone="sky">
          <p className="wr-kicker">Online</p>
          <p className="wr-big num">{duration(play)}</p>
          <p className="wr-line">
            Spielzeit, damit <b>Platz {num(playRank.rank)}</b> von {num(playRank.of)}.
            {r && r.activeDays > 0 && (
              <>
                {" "}
                An <b>{num(r.activeDays)} von {num(r.spanDays)} Tagen</b> online, {num(r.sessions)} Sessions
                {r.longestSession > 0 && (
                  <>
                    , die längste <b>{duration(r.longestSession * 60)}</b> am Stück
                  </>
                )}
                .
              </>
            )}
          </p>
        </section>

        {r && classifiable(r) && (
          <section className="wr-card" data-tone="ender">
            <p className="wr-kicker">Spielertyp</p>
            <div className="wr-types">
              <TraitBadges traits={r.traits} max={3} hrefOf={(k) => `/spielertypen?typ=${k}#liste`} />
            </div>
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
            <p className="wr-line">
              Am meisten um <b>{r.peakHour} Uhr</b>
              {r.typicalStart !== null && (
                <>
                  , der erste Login meist gegen <b>{clock(r.typicalStart)}</b>
                </>
              )}
              . {Math.round(r.weekend * 100)} % der Zeit am Wochenende.
            </p>
          </section>
        )}

        {stats.length > 0 && (
          <section className="wr-card" data-tone="paper">
            <p className="wr-kicker">In Zahlen</p>
            {best && (
              <p className="wr-line wr-line--lead">
                Am stärksten bei <b>{LABEL[best.k]}</b>: Platz {num(best.rank)}, unter den besten {topShare(best.rank, best.of)} %.
              </p>
            )}
            <dl className="wr-stats">
              {stats.map((s) => (
                <div key={s.k} className="box wr-stat" data-tone={BOARD_TONE[s.k]}>
                  <dt>{LABEL[s.k]}</dt>
                  <dd className="num">{boardValue(s.k, s.v)}</dd>
                  <dd className="wr-stat__rank">
                    Platz {num(s.rank)} von {num(s.of)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {top && topSummary && (
          <section className="wr-card" data-tone="gold">
            <p className="wr-kicker">Der längste Tag</p>
            <p className="wr-big">{dayLabel(top.day)}</p>
            <p className="wr-line">
              <b>{duration(top.minutes * 60)}</b> online
              {[
                topSummary.diamonds ? `${num(topSummary.diamonds)} Diamanten` : null,
                topSummary.blocksBroken ? `${num(topSummary.blocksBroken)} Blöcke abgebaut` : null,
                topSummary.mobsKilled ? `${num(topSummary.mobsKilled)} Mobs` : null,
                topSummary.deaths ? `${num(topSummary.deaths)}× gestorben` : null,
                topSummary.achievements ? `${num(topSummary.achievements)} Fortschritte` : null,
              ]
                .filter(Boolean)
                .map((t) => `, ${t}`)
                .join("")}
              .{" "}
              <Link href={`/zeitstrahl?tag=${top.day}`}>Im Zeitstrahl ansehen</Link>
            </p>
          </section>
        )}

        {(deaths.length > 0 || kills > 0) && (
          <section className="wr-card" data-tone="redstone">
            <p className="wr-kicker">Friedhof</p>
            <p className="wr-big num">{num(p.stats.deaths ?? deaths.length)}× gestorben</p>
            <p className="wr-line">
              {topCause && (
                <>
                  Meistens: <b>„{topCause[0]}“</b> ({num(topCause[1])}×).{" "}
                </>
              )}
              {topKiller && (
                <>
                  Am häufigsten erwischt von <b>{topKiller[0]}</b> ({num(topKiller[1])}×).{" "}
                </>
              )}
              {kills > 0 && (
                <>
                  Selbst <b>{num(kills)} Spieler</b> erledigt.
                </>
              )}
            </p>
          </section>
        )}

        {advTotal > 0 && (
          <section className="wr-card" data-tone="diamond">
            <p className="wr-kicker">Fortschritte</p>
            <p className="wr-big num">{num(advTotal)}</p>
            <p className="wr-line">
              Fortschritte erreicht, {num(reported.length)} davon im Feed gemeldet.
              {rarest?.a && (
                <>
                  {" "}
                  Der seltenste: <b>„{rarest.a.title}“</b>, das haben nur {num(rarest.n)} von {num(adv.players)} Spielern.
                </>
              )}
            </p>
          </section>
        )}

        {near.length > 0 && (
          <section className="wr-card" data-tone="amethyst">
            <p className="wr-kicker">Engste Verbindungen</p>
            <ol className="wr-friends">
              {near.map((x, i) => (
                <li key={x.id}>
                  <span className="wr-friends__n">{i + 1}</span>
                  <Link href={`/spieler/${encodeURIComponent(x.id)}`}>
                    <Head id={x.id} uuid={byId.get(x.id)?.uuid} name={byId.get(x.id)?.name ?? x.id} size={40} src={64} decorative />
                    <span>{byId.get(x.id)?.name ?? x.id}</span>
                  </Link>
                  <span className="muted num">{Math.round(closeness(x.dist) * 100)} % Nähe</span>
                </li>
              ))}
            </ol>
            <p className="wr-line">
              Aus Raids, geteiltem Chat, Namen im Stream-Titel und Chat-Nachrichten.{" "}
              <Link href={`/verbindungen?ansicht=distanz&spieler=${encodeURIComponent(id)}`}>Alle Verbindungen</Link>
            </p>
          </section>
        )}

        {streams > 0 && (
          <section className="wr-card" data-tone="twitch">
            <p className="wr-kicker">Auf Twitch</p>
            <p className="wr-big num">{duration(streamSeconds)} live</p>
            <p className="wr-line">
              In {num(streams)} Streams
              {p.peakViewers > 0 && (
                <>
                  , bis zu <b>{num(p.peakViewers)} Zuschauer</b> gleichzeitig
                </>
              )}
              {subs && subs.total > 0 && (
                <>
                  , <b>{num(subs.total)} Subs</b>
                </>
              )}
              . {raidsOut > 0 && `${num(raidsOut)}× geraidet`}
              {raidsOut > 0 && raidsIn > 0 && ", "}
              {raidsIn > 0 && `${num(raidsIn)}× von anderen geraidet worden`}
              {(raidsOut > 0 || raidsIn > 0) && "."}
            </p>
            {clip && (
              <a className="wr-clip" href={clip.url} target="_blank" rel="noopener noreferrer">
                {clip.thumbnail && <img src={clip.thumbnail} alt="" width={160} height={90} loading="lazy" />}
                <span>
                  <span className="muted">Beliebtester Clip</span>
                  <b>{clip.title}</b>
                  <span className="muted">{num(clip.views)} Aufrufe</span>
                </span>
              </a>
            )}
          </section>
        )}

        {(milestones > 0 || leads > 0 || records > 0) && (
          <section className="wr-card" data-tone="white">
            <p className="wr-kicker">Meilensteine</p>
            <dl className="wr-mini">
              {milestones > 0 && (
                <div>
                  <dt>Marken geknackt</dt>
                  <dd className="num">{num(milestones)}</dd>
                </div>
              )}
              {leads > 0 && (
                <div>
                  <dt>Führung übernommen</dt>
                  <dd className="num">{num(leads)}×</dd>
                </div>
              )}
              {records > 0 && (
                <div>
                  <dt>Server-Rekorde</dt>
                  <dd className="num">{num(records)}</dd>
                </div>
              )}
            </dl>
          </section>
        )}

        <section className="wr-card wr-card--end" data-tone="ink">
          <p className="wr-kicker">Das war&apos;s, bis jetzt</p>
          <p className="wr-line">Die Staffel läuft noch, der Rückblick wächst mit. Grafiken aus Minecraft © Mojang, keine offizielle Seite.</p>
          <div className="wr-actions">
            <Link className="btn btn--small" data-tone="white" href={href}>
              Zum Profil
            </Link>
            <ShareButton title={`Staffel-Rückblick von ${p.name}`} />
          </div>
        </section>
      </div>
    </>
  );
}
