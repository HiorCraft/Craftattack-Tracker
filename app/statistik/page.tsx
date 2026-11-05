import Link from "next/link";
import { Fold } from "@/components/Fold";
import { Explain } from "@/components/Explain";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { getBiggestEvents, getBoardTotalsOverTime, getHistoryAll, getSeries, getTwitchSubscriptionBoard, getTwitchSubscriptionMinuteRecord } from "@/lib/store";
import { boardValue, dateTime, duration, eur, num } from "@/lib/format";
import { getEarningsTotals } from "@/lib/earnings";
import { Sparkline, type SparkPoint } from "@/components/Sparkline";
import { dayKey, getStatsExtras } from "@/lib/analytics";
import { StatsExtras } from "@/components/StatsExtras";
import { BOARD_TONE, METRIC_TONE } from "@/lib/statTone";
import { Head } from "@/components/Head";
import { HowLink } from "@/components/HowLink";
import { graphHref } from "@/lib/graphQuery";


export const metadata: Metadata = { title: "Statistik" };

const dayLabel = (day: string) => new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" }).format(new Date(`${day}T12:00:00+02:00`));
const dtf = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

type Kind = "num" | "eur" | "playtimeSeconds" | "distance" | "damageDealt";
/** Graph-Einstellung der „pro Tag“-Charts: Zuwachs je Tag */
const DAILY = { modus: "zuwachs", raster: "1440" } as const;
const fmt = (kind: Kind, v: number) => (kind === "num" ? num(v) : kind === "eur" ? eur(v) : boardValue(kind, v));

function Chart({
  label,
  tone,
  points,
  kind = "num",
  step = false,
  sub,
  href,
}: {
  label: string;
  tone: string;
  points: SparkPoint[];
  kind?: Kind;
  step?: boolean;
  sub?: string;
  /** Link auf den großen Graphen */
  href?: string;
}) {
  const current = points.length ? fmt(kind, points[points.length - 1].v) : "–";
  let body: React.ReactNode;
  if (points.length < 2) {
    body = <p className="chart__empty">{points.length === 0 ? "Noch keine Daten." : "Erst ein Messpunkt, Graph folgt."}</p>;
  } else {
    const t0 = Date.parse(points[0].at);
    const t1 = Date.parse(points[points.length - 1].at);
    const max = Math.max(...points.map((p) => p.v));
    body = (
      <>
        {href ? (
          <Link href={href} className="chart__body-link" title={`${label} im Graphen öffnen`}>
            <Sparkline points={points} width={320} height={110} kind={kind} step={step} label={label} />
          </Link>
        ) : (
          <Sparkline points={points} width={320} height={110} kind={kind} step={step} label={label} />
        )}
        <div className="chart__axis">
          <span>{dtf.format(t0)}</span>
          <span className="chart__max">max {fmt(kind, max)}</span>
          <span>{dtf.format(t1)}</span>
        </div>
      </>
    );
  }
  return (
    <div className="box chart chart--big" data-tone={tone}>
      <div className="chart__head">
        <span className="eyebrow">
          {href ? (
            <Link href={href} className="chart__link">
              {label} <span aria-hidden="true">↗</span>
            </Link>
          ) : (
            label
          )}
          {sub && <span className="muted"> · {sub}</span>}
        </span>
        <span className="num chart__val">{current}</span>
      </div>
      {body}
    </div>
  );
}

function Record({
  label,
  value,
  who,
  uuid,
  when,
  whenLabel,
  tone = "white",
}: {
  label: string;
  value: string;
  who?: { id: string; name: string } | null;
  uuid?: string;
  when?: string | null;
  /** Fertiger Text statt Datum+Uhrzeit */
  whenLabel?: string | null;
  tone?: string;
}) {
  return (
    <div className="box record" data-tone={tone}>
      <dt>{label}</dt>
      <dd>
        <span className="num record__val">{value}</span>
        {who && (
          <Link className="record__who" href={`/spieler/${encodeURIComponent(who.id)}`}>
            <Head id={who.id} uuid={uuid} name={who.name} size={24} decorative />
            <span>{who.name}</span>
          </Link>
        )}
        {(whenLabel ?? when) && <small className="muted">{whenLabel ?? dateTime(when!)}</small>}
      </dd>
    </div>
  );
}

async function Stats(props: PageProps<"/statistik">) {
  const sp = await props.searchParams;
  // Alte Links auf den Graphen (/statistik?metric=…#graph) führen jetzt auf die eigene Graph-Seite
  if (typeof sp.metric === "string") {
    const q = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"));
    redirect(`/graph?${q}`);
  }
  const { state, now } = await loadTracker();
  const [extras, hist, totals, bigDiamonds, bigDistance, bigBlocks, bigMobs, bigDamage, bigTotems, bigFood, subscriptionBoard, subscriptionSeries, subscriptionMinuteRecord, earningsSeries, earningsTotals] = await Promise.all([
    getStatsExtras(),
    getHistoryAll(),
    getBoardTotalsOverTime(),
    getBiggestEvents("diamonds"),
    getBiggestEvents("distance"),
    getBiggestEvents("blocksBroken"),
    getBiggestEvents("mobsKilled"),
    getBiggestEvents("damageDealt"),
    getBiggestEvents("totemsUsed"),
    getBiggestEvents("foodEaten"),
    getTwitchSubscriptionBoard(),
    getSeries({ metric: "twitchSubs", players: [], from: null, to: now, bucketMinutes: null, mode: "wert" }),
    getTwitchSubscriptionMinuteRecord(),
    getSeries({ metric: "twitchEarnings", players: [], from: null, to: now, bucketMinutes: null, mode: "wert" }),
    getEarningsTotals(),
  ]);

  const players = Object.values(state.players);
  const tracked = (p: (typeof players)[number]) => p.trackedSeconds + (p.online && p.sessionStart ? (now - Date.parse(p.sessionStart)) / 1000 : 0);
  const top = <T,>(arr: T[], score: (x: T) => number) => arr.reduce<T | null>((best, x) => (best === null || score(x) > score(best) ? x : best), null);

  const longest = top(players.filter((p) => p.longestSession > 0), (p) => p.longestSession);
  const mostTracked = top(players, tracked);
  const mostSessions = top(players, (p) => p.sessions);
  const topViewers = top(players.filter((p) => p.peakViewers > 0), (p) => p.peakViewers);
  const mostDeaths = top(players.filter((p) => p.stats.deaths !== undefined), (p) => p.stats.deaths ?? 0);
  const mostSubscriptions = subscriptionBoard[0] ?? null;
  const topEarner = [...earningsTotals].sort((a, b) => b[1] - a[1])[0];
  const topEarnerPlayer = topEarner ? state.players[topEarner[0]] : undefined;
  const busiestDay = top(extras.days, (d) => d.playerHours);
  const mostAfk = extras.afk.perPlayer[0] ?? null;

  const h = hist.points;
  const series = (k: keyof (typeof h)[number]) => h.map((p) => ({ at: p.at, v: Number(p[k]) }));
  const t = totals.points;
  const tseries = (k: Exclude<keyof (typeof t)[number], "at">) => t.map((p) => ({ at: p.at, v: p[k] }));
  const playPoints: SparkPoint[] = extras.days.map((d) => ({ at: `${d.day}T12:00:00+02:00`, v: Math.round(d.playerHours * 3600) }));
  const afkPoints: SparkPoint[] = extras.days.map((d) => ({ at: `${d.day}T12:00:00+02:00`, v: Math.round(d.afkHours * 3600) }));

  const since = h.length ? h[0].at : state.startedAt;
  const who = (p: { id: string; name: string } | null) => (p ? { id: p.id, name: p.name } : null);
  // Tag-Nummer der Staffel: Tag 1 = erster Tag mit Daten
  const firstDay = extras.days[0]?.day ?? dayKey(Date.parse(since));
  const tagNr = (day: string) => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${firstDay}T12:00:00Z`)) / 86400_000) + 1;

  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Alles, was der Tracker je gemessen hat</p>
          <h1 className="t-1">Statistik</h1>
          <p>
            Verläufe über die gesamte Laufzeit seit {dateTime(since)} und die Rekorde dazu.
          </p>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="season-h">
        <div className="wrap">
          <Fold
            id="statistik.season-h"
            titleId="season-h"
            title={
              <>
                Die Staffel in Zahlen <Explain>Gewohnheiten, Gefahren und Treue – über alle Tage, die der Tracker gesehen hat.</Explain>
              </>
            }
          >
          <StatsExtras d={extras} tag={tagNr} />
          </Fold>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Link className="btn" data-tone="white" href="/graph">
            Eigenen Graphen bauen →
          </Link>
        </div>
      </section>

      <section className="block block--tight" data-tone="ink" aria-labelledby="rec-h">
        <div className="wrap">
          <h2 className="t-2" id="rec-h" style={{ marginBottom: 16 }}>
            Rekorde
          </h2>
          {/* Nach Art der Kennzahl gruppiert: jede Gruppe hat ihre Farbe (lib/statTone.ts) */}
          <div className="records-groups">
            <section className="records-group" aria-labelledby="rec-server">
              <h3 className="eyebrow records-group__h" id="rec-server">
                Server & Spielzeit
              </h3>
              <dl className="grid records-grid">
                <Record label="Gleichzeitig online" tone={METRIC_TONE.onlineCount} value={state.records.peakOnline ? num(state.records.peakOnline.value) : "–"} when={state.records.peakOnline?.at} />
                <Record label="Aktivster Tag" tone={METRIC_TONE.tracked} value={busiestDay ? `${num(busiestDay.playerHours)} Spielerstunden` : "–"} whenLabel={busiestDay ? dayLabel(busiestDay.day) : null} />
                <Record label="Meiste Online-Zeit" tone={METRIC_TONE.tracked} value={mostTracked ? duration(tracked(mostTracked)) : "–"} who={who(mostTracked)} uuid={mostTracked?.uuid} />
                <Record label="Längste Session" tone={METRIC_TONE.tracked} value={longest ? duration(longest.longestSession) : "–"} who={who(longest)} uuid={longest?.uuid} />
                <Record label="Meiste Sessions" tone={METRIC_TONE.sessions} value={mostSessions ? num(mostSessions.sessions) : "–"} who={who(mostSessions)} uuid={mostSessions?.uuid} />
              </dl>
            </section>
            <section className="records-group" aria-labelledby="rec-twitch">
              <h3 className="eyebrow records-group__h" id="rec-twitch">
                Twitch
              </h3>
              <dl className="grid records-grid">
                <Record label="Gleichzeitig live" tone={METRIC_TONE.liveCount} value={state.records.peakLive ? num(state.records.peakLive.value) : "–"} when={state.records.peakLive?.at} />
                <Record label="Zuschauer gesamt" tone={METRIC_TONE.viewers} value={state.records.peakViewers ? num(state.records.peakViewers.value) : "–"} when={state.records.peakViewers?.at} />
                <Record label="Meiste Zuschauer (ein Stream)" tone={METRIC_TONE.viewers} value={topViewers ? num(topViewers.peakViewers) : "–"} who={who(topViewers)} uuid={topViewers?.uuid} />
                <Record
                  label="Meiste Twitch Subs"
                  tone={METRIC_TONE.twitchSubs}
                  value={mostSubscriptions ? num(mostSubscriptions.value) : "–"}
                  who={mostSubscriptions ? { id: mostSubscriptions.id, name: mostSubscriptions.name } : null}
                  uuid={mostSubscriptions?.uuid}
                />
                <Record
                  label="Höchste Twitch-Einnahmen (geschätzt)"
                  tone={METRIC_TONE.twitchEarnings}
                  value={topEarner ? eur(topEarner[1]) : "–"}
                  who={topEarner ? { id: topEarner[0], name: topEarnerPlayer?.name ?? topEarner[0] } : null}
                  uuid={topEarnerPlayer?.uuid}
                />
                <Record
                  label="Meiste Subs in einer Minute"
                  tone={METRIC_TONE.twitchSubs}
                  value={subscriptionMinuteRecord ? num(subscriptionMinuteRecord.value) : "–"}
                  who={subscriptionMinuteRecord ? { id: subscriptionMinuteRecord.id, name: subscriptionMinuteRecord.name } : null}
                  uuid={subscriptionMinuteRecord?.uuid}
                  when={subscriptionMinuteRecord?.at}
                />
              </dl>
            </section>
            <section className="records-group" aria-labelledby="rec-afk">
              <h3 className="eyebrow records-group__h" id="rec-afk">
                AFK
              </h3>
              <dl className="grid records-grid">
                <Record label="Meiste AFK-Zeit" tone={METRIC_TONE.afkSeconds} value={mostAfk ? duration(mostAfk.seconds) : "–"} who={mostAfk ? { id: mostAfk.id, name: mostAfk.name } : null} uuid={mostAfk?.uuid} />
                <Record label="Längste AFK-Phase" tone={METRIC_TONE.afkSeconds} value={extras.afk.longest ? duration(extras.afk.longest.seconds) : "–"} who={extras.afk.longest ? { id: extras.afk.longest.id, name: extras.afk.longest.name } : null} uuid={extras.afk.longest?.uuid} when={extras.afk.longest?.from} />
              </dl>
            </section>
            <section className="records-group" aria-labelledby="rec-stats">
              <h3 className="eyebrow records-group__h" id="rec-stats">
                Spielstatistik
              </h3>
              <dl className="grid records-grid">
                <Record label="Größter Diamanten-Fund" tone={BOARD_TONE.diamonds} value={bigDiamonds[0]?.delta ? num(bigDiamonds[0].delta) : "–"} who={bigDiamonds[0]?.player ? { id: bigDiamonds[0].player, name: bigDiamonds[0].playerName ?? bigDiamonds[0].player } : null} uuid={bigDiamonds[0]?.uuid} when={bigDiamonds[0]?.at} />
                <Record label="Meiste Tode" tone={BOARD_TONE.deaths} value={mostDeaths ? num(mostDeaths.stats.deaths ?? 0) : "–"} who={who(mostDeaths)} uuid={mostDeaths?.uuid} />
                <Record label="Größter Abriss am Stück" tone={BOARD_TONE.blocksBroken} value={bigBlocks[0]?.delta ? `${num(bigBlocks[0].delta)} Blöcke` : "–"} who={bigBlocks[0]?.player ? { id: bigBlocks[0].player, name: bigBlocks[0].playerName ?? bigBlocks[0].player } : null} uuid={bigBlocks[0]?.uuid} when={bigBlocks[0]?.at} />
                <Record label="Größte Mob-Schlacht am Stück" tone={BOARD_TONE.mobsKilled} value={bigMobs[0]?.delta ? `${num(bigMobs[0].delta)} Mobs` : "–"} who={bigMobs[0]?.player ? { id: bigMobs[0].player, name: bigMobs[0].playerName ?? bigMobs[0].player } : null} uuid={bigMobs[0]?.uuid} when={bigMobs[0]?.at} />
                <Record label="Weitester Marsch am Stück" tone={BOARD_TONE.distance} value={bigDistance[0]?.delta ? boardValue("distance", bigDistance[0].delta) : "–"} who={bigDistance[0]?.player ? { id: bigDistance[0].player, name: bigDistance[0].playerName ?? bigDistance[0].player } : null} uuid={bigDistance[0]?.uuid} when={bigDistance[0]?.at} />
                <Record label="Meiste Totems am Stück" tone={BOARD_TONE.totemsUsed} value={bigTotems[0]?.delta ? `${num(bigTotems[0].delta)} Totems` : "–"} who={bigTotems[0]?.player ? { id: bigTotems[0].player, name: bigTotems[0].playerName ?? bigTotems[0].player } : null} uuid={bigTotems[0]?.uuid} when={bigTotems[0]?.at} />
                <Record label="Größter Schaden am Stück" tone={BOARD_TONE.damageDealt} value={bigDamage[0]?.delta ? boardValue("damageDealt", bigDamage[0].delta) : "–"} who={bigDamage[0]?.player ? { id: bigDamage[0].player, name: bigDamage[0].playerName ?? bigDamage[0].player } : null} uuid={bigDamage[0]?.uuid} when={bigDamage[0]?.at} />
                <Record label="Meistes Essen am Stück" tone={BOARD_TONE.foodEaten} value={bigFood[0]?.delta ? `${num(bigFood[0].delta)} Essen` : "–"} who={bigFood[0]?.player ? { id: bigFood[0].player, name: bigFood[0].playerName ?? bigFood[0].player } : null} uuid={bigFood[0]?.uuid} when={bigFood[0]?.at} />
              </dl>
            </section>
          </div>
          <HowLink section="zeitstrahl">Wie Rekorde entstehen</HowLink>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="server-h">
        <div className="wrap">
          <Fold id="statistik.server-h" titleId="server-h" title="Server" aside={<p className="muted num">{num(h.length)} Punkte · {hist.bucketMinutes} Min je Punkt</p>}>
          <div className="grid charts__grid" style={{ "--min": "320px" } as React.CSSProperties}>
            <Chart label="Spieler online" href={graphHref("onlineCount")} tone={METRIC_TONE.onlineCount} points={series("onlineCount")} />
            <Chart label="Streams live" href={graphHref("liveCount")} tone={METRIC_TONE.liveCount} points={series("liveCount")} />
            <Chart label="Zuschauer gesamt" href={graphHref("viewers")} tone={METRIC_TONE.viewers} points={series("viewers")} />
            <Chart label="Spielzeit gesamt" href={graphHref("playtimeSeconds")} tone={BOARD_TONE.playtimeSeconds} points={series("playtimeSeconds")} kind="playtimeSeconds" step sub="Top 10 der API" />
            <Chart label="Spielzeit pro Tag" href={graphHref("playtimeSeconds", [], "alle", DAILY)} tone={METRIC_TONE.tracked} points={playPoints} kind="playtimeSeconds" step sub="alle Spieler, laut Tracker" />
            <Chart label="AFK pro Tag" href={graphHref("afkSeconds", [], "alle", DAILY)} tone={METRIC_TONE.afkSeconds} points={afkPoints} kind="playtimeSeconds" step sub="Teil der Spielzeit" />
            <Chart label="Tode gesamt" href={graphHref("deaths")} tone={BOARD_TONE.deaths} points={series("deaths")} step />
          </div>
          </Fold>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="counter-h" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Fold id="statistik.counter-h" titleId="counter-h" title="Alle Spieler zusammen" aside={<p className="muted num">{num(t.length)} Punkte · {totals.bucketMinutes} Min je Punkt</p>}>
          <div className="grid charts__grid" style={{ "--min": "320px" } as React.CSSProperties}>
            <Chart label="Diamanten" href={graphHref("diamonds")} tone={BOARD_TONE.diamonds} points={tseries("diamonds")} step />
            <Chart label="Abgebaute Blöcke" href={graphHref("blocksBroken")} tone={BOARD_TONE.blocksBroken} points={tseries("blocksBroken")} step />
            <Chart label="Erledigte Mobs" href={graphHref("mobsKilled")} tone={BOARD_TONE.mobsKilled} points={tseries("mobsKilled")} step />
            <Chart label="Gelaufene Strecke" href={graphHref("distance")} tone={BOARD_TONE.distance} points={tseries("distance")} kind="distance" step />
            <Chart label="Schaden" href={graphHref("damageDealt")} tone={BOARD_TONE.damageDealt} points={tseries("damageDealt")} kind="damageDealt" step sub="Ausgeteilter Schaden in Herzen" />
            <Chart label="Totems benutzt" href={graphHref("totemsUsed")} tone={BOARD_TONE.totemsUsed} points={tseries("totemsUsed")} step />
            <Chart label="Essen gegessen" href={graphHref("foodEaten")} tone={BOARD_TONE.foodEaten} points={tseries("foodEaten")} step />
            <Chart label="Twitch Subs" href={graphHref("twitchSubs")} tone={METRIC_TONE.twitchSubs} points={subscriptionSeries.series[0]?.points ?? []} step sub="während Spieler online waren" />
            <Chart
              label="Twitch-Einnahmen"
              href={graphHref("twitchEarnings")}
              tone={METRIC_TONE.twitchEarnings}
              points={earningsSeries.series[0]?.points ?? []}
              kind="eur"
              step
              sub="geschätzt aus Abos und Bits auf dem Server"
            />
          </div>
          <HowLink section="zeitstrahl" />
          </Fold>
        </div>
      </section>
    </>
  );
}

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/statistik">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Alles, was der Tracker je gemessen hat" title="Statistik" />}>
      <Stats {...props} />
    </Suspense>
  );
}
