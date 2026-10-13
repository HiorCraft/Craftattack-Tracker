import Link from "next/link";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { getBiggestEvents, getBoardTotalsOverTime, getHistoryAll, getSeries, getTwitchSubscriptionBoard, getTwitchSubscriptionMinuteRecord } from "@/lib/store";
import { boardValue, dateTime, duration, headUrl, num } from "@/lib/format";
import { Sparkline, type SparkPoint } from "@/components/Sparkline";
import { GraphBuilder } from "@/components/GraphBuilder";
import { parseGraphQuery, toSearch } from "@/lib/graphQuery";
import { dayKey, getStatsExtras } from "@/lib/analytics";
import { StatsExtras } from "@/components/StatsExtras";

// Kein Skeleton: die Seite wird komplett auf dem Server gerendert (SSR) und blockiert bis die Daten da sind.
export const instant = false;

export const metadata: Metadata = { title: "Statistik" };

const dayLabel = (day: string) => new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" }).format(new Date(`${day}T12:00:00+02:00`));
const dtf = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

type Kind = "num" | "playtimeSeconds" | "distance";
const fmt = (kind: Kind, v: number) => (kind === "num" ? num(v) : boardValue(kind, v));

function Chart({
  label,
  tone,
  points,
  kind = "num",
  step = false,
  sub,
}: {
  label: string;
  tone: string;
  points: SparkPoint[];
  kind?: Kind;
  step?: boolean;
  sub?: string;
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
        <Sparkline points={points} width={320} height={110} kind={kind} step={step} label={label} />
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
          {label}
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
            <img className="head" src={headUrl(uuid, 24, who.id)} alt="" width={24} height={24} loading="lazy" />
            <span>{who.name}</span>
          </Link>
        )}
        {(whenLabel ?? when) && <small className="muted">{whenLabel ?? dateTime(when!)}</small>}
      </dd>
    </div>
  );
}

export default async function Page(props: PageProps<"/statistik">) {
  const sp = await props.searchParams;
  const { state, now } = await loadTracker();
  const [extras, hist, totals, bigDiamonds, bigDistance, bigBlocks, bigMobs, subscriptionBoard, subscriptionSeries, subscriptionMinuteRecord] = await Promise.all([
    getStatsExtras(),
    getHistoryAll(),
    getBoardTotalsOverTime(),
    getBiggestEvents("diamonds"),
    getBiggestEvents("distance"),
    getBiggestEvents("blocksBroken"),
    getBiggestEvents("mobsKilled"),
    getTwitchSubscriptionBoard(),
    getSeries({ metric: "twitchSubs", players: [], from: null, to: now, bucketMinutes: null, mode: "wert" }),
    getTwitchSubscriptionMinuteRecord(),
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
  const busiestDay = top(extras.days, (d) => d.playerHours);
  const mostAfk = extras.afk.perPlayer[0] ?? null;
  const peakDay = top(hist.points, (h) => h.onlineCount);

  const h = hist.points;
  const series = (k: keyof (typeof h)[number]) => h.map((p) => ({ at: p.at, v: Number(p[k]) }));
  const t = totals.points;
  const tseries = (k: Exclude<keyof (typeof t)[number], "at">) => t.map((p) => ({ at: p.at, v: p[k] }));
  const playPoints: SparkPoint[] = extras.days.map((d) => ({ at: `${d.day}T12:00:00+02:00`, v: Math.round(d.playerHours * 3600) }));
  const afkPoints: SparkPoint[] = extras.days.map((d) => ({ at: `${d.day}T12:00:00+02:00`, v: Math.round(d.afkHours * 3600) }));

  const since = h.length ? h[0].at : state.startedAt;
  const playerOptions = players
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  const who = (p: { id: string; name: string } | null) => (p ? { id: p.id, name: p.name } : null);
  // Tag-Nummer der Staffel: Tag 1 = erster Tag mit Daten
  const firstDay = extras.days[0]?.day ?? dayKey(Date.parse(since));
  const tagNr = (day: string) => Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${firstDay}T12:00:00Z`)) / 86400_000) + 1;

  return (
    <>
      <section className="block page-head" data-tone="gold">
        <div className="wrap">
          <p className="eyebrow">Alles, was der Tracker je gemessen hat</p>
          <h1 className="t-1">Statistik</h1>
          <p>
            Verläufe über die gesamte Laufzeit seit {dateTime(since)} und die Rekorde dazu. Mit der Maus über eine Kurve fahren zeigt Zeitpunkt
            und Wert.
          </p>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="season-h">
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2" id="season-h">
              Die Staffel in Zahlen
            </h2>
            <p className="muted">Gewohnheiten, Gefahren und Treue – über alle Tage, die der Tracker gesehen hat.</p>
          </div>
          <StatsExtras d={extras} tag={tagNr} />
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="graph-h" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2" id="graph-h">
              Eigener Graph
            </h2>
            <p className="muted">Kennzahl, Spieler, Zeitraum und Raster frei wählen. Die Adresse im Browser enthält die Auswahl und lässt sich teilen.</p>
          </div>
          {/* key: bei neuen Adress-Parametern (z. B. Link vom Profil) die Auswahl neu aufsetzen statt den alten State zu behalten */}
          <GraphBuilder key={toSearch(parseGraphQuery(sp)).toString()} players={playerOptions} initial={parseGraphQuery(sp)} />
        </div>
      </section>

      <section className="block block--tight" data-tone="ink" aria-labelledby="rec-h">
        <div className="wrap">
          <h2 className="t-2" id="rec-h" style={{ marginBottom: 16 }}>
            Rekorde
          </h2>
          <dl className="grid records-grid">
            <Record label="Gleichzeitig online" tone="grass" value={state.records.peakOnline ? num(state.records.peakOnline.value) : "–"} when={state.records.peakOnline?.at} />
            <Record label="Gleichzeitig live" tone="twitch" value={state.records.peakLive ? num(state.records.peakLive.value) : "–"} when={state.records.peakLive?.at} />
            <Record label="Zuschauer gesamt" tone="twitch" value={state.records.peakViewers ? num(state.records.peakViewers.value) : "–"} when={state.records.peakViewers?.at} />
            <Record label="Meiste Zuschauer (ein Stream)" tone="twitch" value={topViewers ? num(topViewers.peakViewers) : "–"} who={who(topViewers)} uuid={topViewers?.uuid} />
            <Record label="Längste Session" tone="sky" value={longest ? duration(longest.longestSession) : "–"} who={who(longest)} uuid={longest?.uuid} />
            <Record label="Meiste Online-Zeit" tone="sky" value={mostTracked ? duration(tracked(mostTracked)) : "–"} who={who(mostTracked)} uuid={mostTracked?.uuid} />
            <Record label="Meiste Sessions" tone="sky" value={mostSessions ? num(mostSessions.sessions) : "–"} who={who(mostSessions)} uuid={mostSessions?.uuid} />
            <Record label="Aktivster Tag" tone="sky" value={busiestDay ? `${num(busiestDay.playerHours)} Spielerstunden` : "–"} whenLabel={busiestDay ? dayLabel(busiestDay.day) : null} />
            <Record label="Meiste AFK-Zeit" tone="gold" value={mostAfk ? duration(mostAfk.seconds) : "–"} who={mostAfk ? { id: mostAfk.id, name: mostAfk.name } : null} uuid={mostAfk?.uuid} />
            <Record label="Längste AFK-Phase" tone="gold" value={extras.afk.longest ? duration(extras.afk.longest.seconds) : "–"} who={extras.afk.longest ? { id: extras.afk.longest.id, name: extras.afk.longest.name } : null} uuid={extras.afk.longest?.uuid} when={extras.afk.longest?.from} />
            <Record label="Meiste Tode" tone="redstone" value={mostDeaths ? num(mostDeaths.stats.deaths ?? 0) : "–"} who={who(mostDeaths)} uuid={mostDeaths?.uuid} />
            <Record
              label="Meiste Twitch Subs"
              tone="amethyst"
              value={mostSubscriptions ? num(mostSubscriptions.value) : "–"}
              who={mostSubscriptions ? { id: mostSubscriptions.id, name: mostSubscriptions.name } : null}
              uuid={mostSubscriptions?.uuid}
            />
            <Record
              label="Meiste Subs in einer Minute"
              tone="amethyst"
              value={subscriptionMinuteRecord ? num(subscriptionMinuteRecord.value) : "–"}
              who={subscriptionMinuteRecord ? { id: subscriptionMinuteRecord.id, name: subscriptionMinuteRecord.name } : null}
              uuid={subscriptionMinuteRecord?.uuid}
              when={subscriptionMinuteRecord?.at}
            />
            <Record label="Vollster Moment" tone="grass" value={peakDay ? `${num(peakDay.onlineCount)} online` : "–"} when={peakDay?.at} />
            <Record label="Größter Diamanten-Fund" tone="diamond" value={bigDiamonds[0]?.delta ? num(bigDiamonds[0].delta) : "–"} who={bigDiamonds[0]?.player ? { id: bigDiamonds[0].player, name: bigDiamonds[0].playerName ?? bigDiamonds[0].player } : null} uuid={bigDiamonds[0]?.uuid} when={bigDiamonds[0]?.at} />
            <Record label="Weitester Marsch am Stück" tone="pink" value={bigDistance[0]?.delta ? boardValue("distance", bigDistance[0].delta) : "–"} who={bigDistance[0]?.player ? { id: bigDistance[0].player, name: bigDistance[0].playerName ?? bigDistance[0].player } : null} uuid={bigDistance[0]?.uuid} when={bigDistance[0]?.at} />
            <Record label="Größter Abriss am Stück" tone="gold" value={bigBlocks[0]?.delta ? `${num(bigBlocks[0].delta)} Blöcke` : "–"} who={bigBlocks[0]?.player ? { id: bigBlocks[0].player, name: bigBlocks[0].playerName ?? bigBlocks[0].player } : null} uuid={bigBlocks[0]?.uuid} when={bigBlocks[0]?.at} />
            <Record label="Größte Mob-Schlacht am Stück" tone="grass" value={bigMobs[0]?.delta ? `${num(bigMobs[0].delta)} Mobs` : "–"} who={bigMobs[0]?.player ? { id: bigMobs[0].player, name: bigMobs[0].playerName ?? bigMobs[0].player } : null} uuid={bigMobs[0]?.uuid} when={bigMobs[0]?.at} />
          </dl>
          <p className="muted" style={{ marginTop: 16, fontSize: ".9375rem" }}>
            „Am Stück“ heißt: innerhalb eines Abfrage-Intervalls von 30 Sekunden. Online-Zeit, Sessions und Zuschauer misst der Tracker selbst seit
            seinem Start.
          </p>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="server-h">
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2" id="server-h">
              Server
            </h2>
            <p className="muted num">{num(h.length)} Punkte · {hist.bucketMinutes} Min je Punkt</p>
          </div>
          <div className="grid charts__grid" style={{ "--min": "320px" } as React.CSSProperties}>
            <Chart label="Spieler online" tone="grass" points={series("onlineCount")} />
            <Chart label="Streams live" tone="twitch" points={series("liveCount")} />
            <Chart label="Zuschauer gesamt" tone="twitch" points={series("viewers")} />
            <Chart label="Spielzeit gesamt" tone="sky" points={series("playtimeSeconds")} kind="playtimeSeconds" step sub="Top 10 der API" />
            <Chart label="Spielzeit pro Tag" tone="sky" points={playPoints} kind="playtimeSeconds" step sub="alle Spieler, laut Tracker" />
            <Chart label="AFK pro Tag" tone="gold" points={afkPoints} kind="playtimeSeconds" step sub="Teil der Spielzeit" />
            <Chart label="Tode gesamt" tone="redstone" points={series("deaths")} step />
          </div>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="counter-h" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2" id="counter-h">
              Alle Spieler zusammen
            </h2>
            <p className="muted num">{num(t.length)} Punkte · {totals.bucketMinutes} Min je Punkt</p>
          </div>
          <div className="grid charts__grid" style={{ "--min": "320px" } as React.CSSProperties}>
            <Chart label="Diamanten" tone="diamond" points={tseries("diamonds")} step />
            <Chart label="Abgebaute Blöcke" tone="gold" points={tseries("blocksBroken")} step />
            <Chart label="Erledigte Mobs" tone="grass" points={tseries("mobsKilled")} step />
            <Chart label="Gelaufene Strecke" tone="pink" points={tseries("distance")} kind="distance" step />
            <Chart label="Twitch Subs" tone="amethyst" points={subscriptionSeries.series[0]?.points ?? []} step sub="während Spieler online waren" />
          </div>
          <p className="muted" style={{ marginTop: 16, fontSize: ".9375rem" }}>
            Summe über alle Spieler, die der Tracker kennt. Jeder Spieler zählt mit seinem jeweils letzten bekannten Stand, deshalb kann die Kurve
            am Anfang springen, wenn neue Spieler dazukommen. Pro Spieler gibt es die Graphen auf der <Link href="/spieler">Spielerseite</Link>.
          </p>
        </div>
      </section>
    </>
  );
}
