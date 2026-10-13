import Link from "next/link";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { getHistoryRange } from "@/lib/analytics";
import { getHistoryAll, getTwitchLiveSubscriptionCounts } from "@/lib/store";
import { ago, headUrl, num } from "@/lib/format";
import { Sparkline } from "@/components/Sparkline";
import { EventFeed } from "@/components/EventFeed";
import { FigValue } from "@/components/FigValue";

// Kein Skeleton: die Seite wird komplett auf dem Server gerendert (SSR) und blockiert bis die Daten da sind.
export const instant = false;

export const metadata: Metadata = { title: "Live" };

/** Wählbarer Zeitraum für Peak, Zuschauer-Graph und Chronik */
const RANGES: { key: string; label: string; hours: number | null }[] = [
  { key: "1h", label: "1 Std", hours: 1 },
  { key: "6h", label: "6 Std", hours: 6 },
  { key: "12h", label: "12 Std", hours: 12 },
  { key: "24h", label: "24 Std", hours: 24 },
  { key: "7d", label: "7 Tage", hours: 7 * 24 },
  { key: "alle", label: "Alles", hours: null },
];

/** Zeitraum der Live-Seite → Zeitraum des Graph-Baukastens (der kennt kein 12 h) */
const GRAPH_ZEIT: Record<string, string> = { "1h": "1h", "6h": "6h", "12h": "24h", "24h": "24h", "7d": "7d", alle: "alle" };

export default function Page(props: PageProps<"/live">) {
  return <Live searchParams={props.searchParams} />;
}

async function Live({ searchParams }: { searchParams: PageProps<"/live">["searchParams"] }) {
  const sp = await searchParams;
  const range = RANGES.find((r) => r.key === sp.zeit) ?? RANGES[1];
  const [{ state, events, now }, hist] = await Promise.all([
    loadTracker(),
    range.hours === null
      ? getHistoryAll().then((h) => h.points.map((p) => ({ at: p.at, v: p.viewers })))
      : getHistoryRange(range.hours).then((rows) => rows.map((r) => ({ at: new Date(r.at).toISOString(), v: r.viewers }))),
  ]);
  const since = range.hours === null ? 0 : now - range.hours * 3600_000;
  const players = Object.values(state.players);
  const live = players.filter((p) => p.live).sort((a, b) => (b.live!.viewers ?? 0) - (a.live!.viewers ?? 0));
  const streamSubs = await getTwitchLiveSubscriptionCounts(
    live.map((p) => ({ player: p.id, startedAt: p.liveSince ?? p.live?.startedAt ?? null })),
  );
  const liveStreamSubs = live.reduce((total, player) => total + (streamSubs.get(player.id) ?? 0), 0);
  const liveStreamFollowers = live.reduce(
    (total, player) => total + (player.followersLiveAtSample === player.liveSince ? (player.followersOnLiveStream ?? 0) : 0),
    0,
  );
  const viewersAll = live.reduce((s, p) => s + (p.live?.viewers ?? 0), 0);
  // Zählt global nur, wer dabei auch auf dem Server ist
  const viewers = live.filter((p) => p.online).reduce((s, p) => s + (p.live?.viewers ?? 0), 0);
  const peak = hist.reduce((m, h) => Math.max(m, h.v), 0);
  const twitchEvents = [...events]
    .reverse()
    .filter((e) => e.where === "twitch" && Date.parse(e.at) >= since)
    .slice(0, 40);
  const rangeLabel = range.hours === null ? "gesamt" : `letzte ${range.label}`;

  return (
    <>
      <section className="block page-head" data-tone="twitch">
        <div className="wrap">
          <p className="eyebrow">Twitch</p>
          <h1 className="t-1">Live</h1>
          <p>Wer gerade streamt, wie viele zuschauen und wer wann an- und ausgemacht hat. Subs zählen nur, wenn der Streamer dabei auf dem Server online ist.</p>
        </div>
      </section>

      <section className="block block--tight" data-tone="ink">
        <div className="wrap">
          <ul className="filters" aria-label="Zeitraum">
            {RANGES.map((r) => (
              <li key={r.key}>
                <Link className="tag" aria-current={range.key === r.key ? "true" : undefined} href={r.key === "6h" ? "/live" : `/live?zeit=${r.key}`}>
                  {r.label}
                </Link>
              </li>
            ))}
          </ul>
          <dl className="grid st-figs">
            <div className="box st-fig" data-tone="amethyst">
              <dt>Streams</dt>
              <FigValue>{num(live.length)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="twitch">
              <dt title="Zuschauer der Streamer, die gerade auf dem Server sind">Zuschauer auf dem Server</dt>
              <FigValue>{num(viewers)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="amethyst">
              <dt title="Zuschauer aller Streams, auch ohne Server">Zuschauer gesamt</dt>
              <FigValue>{num(viewersAll)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="gold">
              <dt>Peak · {rangeLabel}</dt>
              <FigValue>{num(peak)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="grass">
              <dt>Davon auf dem Server</dt>
              <FigValue>{num(live.filter((p) => p.online).length)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="amethyst">
              <dt title="Gesammelte Subs in den aktuell laufenden Streams">Subs in aktuellen Livestreams</dt>
              <FigValue>{num(liveStreamSubs)}</FigValue>
            </div>
            <div className="box st-fig" data-tone="pink">
              <dt title="Follower, die während der aktuellen Streams bei Serveranwesenheit dazugekommen sind">Follower-Zuwachs in aktuellen Streams</dt>
              <FigValue>{num(liveStreamFollowers)}</FigValue>
            </div>
          </dl>
          <Link
            className="box spark-card spark-card--link"
            data-tone="white"
            style={{ marginTop: 24 }}
            href={`/statistik?metric=viewers&zeit=${GRAPH_ZEIT[range.key] ?? "6h"}#graph`}
            title="Zuschauer-Graph in der Statistik öffnen"
          >
            <div className="spark-card__head">
              <span className="eyebrow">
                Zuschauer auf dem Server · {rangeLabel} <span className="pstat__go" aria-hidden="true">↗</span>
              </span>
              <span className="num spark-card__val">{num(viewers)}</span>
            </div>
            <Sparkline points={hist} width={900} height={120} label="Zuschauer" />
          </Link>
        </div>
      </section>

      <section className="block" data-tone="paper">
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2">Gerade live</h2>
            <p className="muted">Nach Zuschauern sortiert</p>
          </div>
          {live.length === 0 ? (
            <p className="st-online__empty">Gerade streamt niemand.</p>
          ) : (
            <ul className="grid" style={{ "--min": "340px", "--gap": "16px", listStyle: "none", margin: 0, padding: 0 } as React.CSSProperties}>
              {live.map((p) => (
                <li key={p.id}>
                  <a
                    className="box stream"
                    data-tone="white"
                    href={`https://www.twitch.tv/${encodeURIComponent(p.live!.login)}`}
                    target="_blank"
                    rel="noopener"
                  >
                    <img className="head" src={headUrl(p.uuid, 56, p.id)} alt="" width={56} height={56} loading="lazy" />
                    <div style={{ minWidth: 0 }}>
                      <p className="stream__name">
                        {p.name}{" "}
                        {p.online ? (
                          <span className="tag" data-tone="grass" style={{ fontSize: ".75rem", padding: "1px 6px", verticalAlign: "middle" }}>
                            auf dem Server
                          </span>
                        ) : (
                          <span className="tag" data-tone="paper" style={{ fontSize: ".75rem", padding: "1px 6px", verticalAlign: "middle" }}>
                            nicht auf dem Server
                          </span>
                        )}
                      </p>
                      <p className="stream__title" title={p.live!.title}>
                        {p.live!.title}
                      </p>
                      <p className="muted" style={{ fontSize: ".8125rem", marginTop: 4 }}>
                        Live seit {p.liveSince ? ago(p.liveSince).replace("vor ", "") : "–"}
                      </p>
                      <div className="stream__stats">
                        <span className="stream__stat" data-tone="pink">
                          <strong className="num">
                            {p.followersLiveAtSample === p.liveSince ? num(p.followersOnLiveStream ?? 0) : "–"}
                          </strong>
                          <small>Follower-Zuwachs auf dem Server</small>
                        </span>
                        <span className="stream__stat" data-tone="amethyst">
                          <strong className="num">{num(streamSubs.get(p.id) ?? 0)}</strong>
                          <small>Subs in diesem Stream</small>
                        </span>
                      </div>
                    </div>
                    <p className="stream__viewers num">
                      <span className="dot dot--live" style={{ display: "inline-block", marginRight: 6 }} />
                      {num(p.live!.viewers)}
                      <small>Zuschauer</small>
                      <small className="stream__peak">Peak {num(p.livePeakViewers ?? p.live!.viewers)}</small>
                    </p>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="block" data-tone="paper" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2">Stream-Chronik</h2>
            <Link className="btn btn--small" data-tone="white" href={`/ereignisse?wo=twitch${range.hours === null ? "" : `&zeit=${range.key}`}`}>
              Alle
            </Link>
          </div>
          <EventFeed events={twitchEvents} empty={range.hours === null ? "Noch kein Stream an- oder ausgegangen, seit der Tracker läuft." : `Kein Stream in den letzten ${range.label} an- oder ausgegangen.`} />
        </div>
      </section>
    </>
  );
}
