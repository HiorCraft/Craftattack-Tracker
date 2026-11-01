import Link from "next/link";
import { getFeedFilter } from "@/lib/feedThresholds";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { getHistoryRange } from "@/lib/analytics";
import { getActiveSharedChatSessions, getHistoryAll } from "@/lib/store";
import { getStreamTotals } from "@/lib/earnings";
import { getStreamFollowerGains } from "@/lib/streamFollowers";
import { ago, eur, num } from "@/lib/format";
import { Sparkline } from "@/components/Sparkline";
import { EventFeed } from "@/components/EventFeed";
import { FigValue } from "@/components/FigValue";
import { METRIC_TONE } from "@/lib/statTone";
import { Head } from "@/components/Head";


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

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/live">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Twitch" title="Live" />}>
      <Live searchParams={props.searchParams} />
    </Suspense>
  );
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
  const [streamTotals, followerGains] = await Promise.all([
    getStreamTotals(live.map((p) => ({ player: p.id, startedAt: p.live?.startedAt ?? p.liveSince ?? null }))),
    getStreamFollowerGains(live),
  ]);
  const liveStreamSubs = live.reduce((total, player) => total + (streamTotals.get(player.id)?.subs ?? 0), 0);
  const liveStreamEur = live.reduce((total, player) => total + (streamTotals.get(player.id)?.eur ?? 0), 0);
  // Geteilter Chat (Stream Together): Partner je live streamendem Spieler
  const sharedOf = new Map<string, { partners: string[]; others: number }>();
  for (const s of await getActiveSharedChatSessions()) {
    for (const id of s.participants) sharedOf.set(id, { partners: s.participants.filter((x) => x !== id), others: s.otherCount });
  }
  const liveStreamFollowers = live.reduce((total, player) => total + (followerGains.get(player.id) ?? 0), 0);
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
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Twitch</p>
          <h1 className="t-1">Live</h1>
          <p>Wer gerade streamt, wie viele zuschauen und wer wann an- und ausgemacht hat.</p>
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
            <div className="box st-fig" data-tone={METRIC_TONE.liveCount}>
              <dt>Streams</dt>
              <FigValue>{num(live.length)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.viewers}>
              <dt title="Zuschauer der Streamer, die gerade auf dem Server sind">Zuschauer auf dem Server</dt>
              <FigValue>{num(viewers)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.viewers}>
              <dt title="Zuschauer aller Streams, auch ohne Server">Zuschauer gesamt</dt>
              <FigValue>{num(viewersAll)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.viewers}>
              <dt>Peak · {rangeLabel}</dt>
              <FigValue>{num(peak)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.onlineCount}>
              <dt>Davon auf dem Server</dt>
              <FigValue>{num(live.filter((p) => p.online).length)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.twitchSubs}>
              <dt title="Abos seit Beginn der laufenden Streams (Community-Geschenke einmal gezählt)">Subs in aktuellen Livestreams</dt>
              <FigValue>{num(liveStreamSubs)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.followers}>
              <dt title="Follower jetzt minus Follower beim Start, über alle laufenden Streams">Follower-Zuwachs in aktuellen Streams</dt>
              <FigValue>{num(liveStreamFollowers)}</FigValue>
            </div>
            <div className="box st-fig" data-tone={METRIC_TONE.twitchEarnings}>
              <dt title="Geschätzt aus Abos und Bits seit Beginn der laufenden Streams, ohne Werbung">Einnahmen in aktuellen Livestreams</dt>
              <FigValue>{eur(liveStreamEur)}</FigValue>
            </div>
          </dl>
          <Link
            className="box spark-card spark-card--link"
            data-tone="white"
            style={{ marginTop: 24 }}
            href={`/graph?metric=viewers&zeit=${GRAPH_ZEIT[range.key] ?? "6h"}`}
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
                    <Head id={p.id} uuid={p.uuid} name={p.name} size={56} decorative />
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
                      {sharedOf.has(p.id) && (
                        <p className="stream__shared">
                          <span className="tag" data-tone="twitch">
                            Geteilter Chat
                          </span>{" "}
                          mit{" "}
                          {[
                            ...sharedOf.get(p.id)!.partners.map((id) => state.players[id]?.name ?? id),
                            ...(sharedOf.get(p.id)!.others > 0 ? [`${sharedOf.get(p.id)!.others} weiteren Kanälen`] : []),
                          ].join(", ") || "anderen Kanälen"}
                        </p>
                      )}
                      <div className="stream__stats">
                        <span className="stream__stat" data-tone={METRIC_TONE.followers}>
                          <strong className="num">{followerGains.has(p.id) ? num(followerGains.get(p.id)!) : "–"}</strong>
                          <small>Follower in diesem Stream</small>
                        </span>
                        <span
                          className="stream__stat"
                          data-tone={METRIC_TONE.twitchSubs}
                          title={
                            streamTotals.get(p.id)?.precise
                              ? `davon auf dem Server: ${num(streamTotals.get(p.id)!.subsOnServer)}`
                              : "Stream begann vor der genauen Erfassung: nur Abos auf dem Server"
                          }
                        >
                          <strong className="num">{num(streamTotals.get(p.id)?.subs ?? 0)}</strong>
                          <small>Subs in diesem Stream</small>
                        </span>
                        <span className="stream__stat" data-tone={METRIC_TONE.twitchEarnings} title="Geschätzt aus Abos und Bits, ohne Werbung">
                          <strong className="num">{eur(streamTotals.get(p.id)?.eur ?? 0)}</strong>
                          <small>Einnahmen (geschätzt)</small>
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
          <EventFeed events={twitchEvents} isShown={await getFeedFilter()} empty={range.hours === null ? "Noch kein Stream an- oder ausgegangen, seit der Tracker läuft." : `Kein Stream in den letzten ${range.label} an- oder ausgegangen.`} />
        </div>
      </section>
    </>
  );
}
