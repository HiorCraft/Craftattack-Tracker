import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import { loadTracker } from "@/lib/data";
import { getHistoryAll, getTwitchSubscriptionBoard } from "@/lib/store";
import { BOARD_KEYS } from "@/lib/types";
import { boardValue, num, duration, dateTime } from "@/lib/format";
import { StatusLine } from "@/components/StatusLine";
import { EventFeed } from "@/components/EventFeed";
import { Sparkline } from "@/components/Sparkline";
import { BOARD_ICON, Icon } from "@/components/Icons";
import { FigValue } from "@/components/FigValue";
import { TrendChart } from "@/components/TrendChart";
import { getBoardRanksBefore, getHistoryRange } from "@/lib/analytics";
import { EVENT_GROUPS } from "@/lib/events";
import { getFeedFilter } from "@/lib/feedThresholds";
import { getTopClips } from "@/lib/clips";
import { ClipGrid } from "@/components/ClipGrid";
import { BOARD_STYLE } from "@/lib/boards";
import { BoardValue } from "@/components/BoardValue";
import { BOARD_TONE, METRIC_TONE } from "@/lib/statTone";
import { Head } from "@/components/Head";
import { HowLink } from "@/components/HowLink";
import { graphHref } from "@/lib/graphQuery";

// Titel, Untertitel und Farben wie auf craftattack.one/stats
const BOARDS = BOARD_STYLE;


/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Home() {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Live vom Server · inoffizieller Tracker" title="Übersicht" tone="diamond" />}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  const { state, events, now } = await loadTracker();
  const [histAll, trend, ranksBefore, subscriptionBoard] = await Promise.all([
    getHistoryAll(),
    getHistoryRange(72),
    getBoardRanksBefore(24),
    getTwitchSubscriptionBoard(),
  ]);
  const s = state.latest;
  const liveList = s ? [...(s.live ?? [])].sort((a, b) => b.viewers - a.viewers) : [];
  // Globale Zuschauer: nur Streams von Spielern, die gerade auf dem Server sind
  const viewers = liveList.filter((l) => l.onServer !== false).reduce((a, l) => a + l.viewers, 0);
  const isShown = await getFeedFilter();
  const recent = [...events].reverse().filter(isShown).slice(0, 25);
  // Gesamte Laufzeit (gebündelt), nicht nur die letzten Stunden
  const hist = histAll.points.length >= 2 ? histAll.points : state.history;
  const trackedPlayers = Object.keys(state.players).length;
  // Vom Tracker selbst gemessene Online-Zeit – für alle Spieler, nicht nur die Top 10 der API
  const trackedTime = Object.values(state.players)
    .map((p) => ({
      ...p,
      seconds: p.trackedSeconds + (p.online && p.sessionStart ? (now - Date.parse(p.sessionStart)) / 1000 : 0),
    }))
    .filter((p) => p.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 10);

  return (
    <div className="st" data-state={s ? (s.serverOnline ? "ok" : "offline") : "loading"}>
      <section className="block page-head" data-tone="diamond">
        <div className="wrap">
          <p className="eyebrow">Live vom Server · inoffizieller Tracker</p>
          <h1 className="hero__logo">
            <img
              src="/img/ca14-wordmark.webp"
              srcSet="/img/ca14-wordmark-480.webp 480w, /img/ca14-wordmark.webp 880w"
              sizes="(max-width: 560px) 70vw, 360px"
              alt="CraftAttack 14"
              width={880}
              height={591}
              fetchPriority="high"
              decoding="async"
            />
          </h1>
          <p>
            Wer ist drauf, wer streamt, wer stirbt – und <strong>wann</strong> genau. Der Tracker merkt sich
            jede Änderung der offiziellen Stats und macht daraus eine Chronik.
          </p>
          <StatusLine state={state} />
          {s && !s.serverOnline && (
            <div className="box st-banner" data-tone="redstone" role="status">
              <p className="t-3 st-banner__title">Der Server ist gerade offline.</p>
              <p>Neustart, Wartung oder Feierabend. Die Zahlen unten sind der letzte Stand.</p>
            </div>
          )}
          {!s && state.lastError && (
            <div className="box st-banner" data-tone="gold" role="status">
              <p className="t-3 st-banner__title">Keine Verbindung zur API.</p>
              <p>{state.lastError} – der Tracker versucht es automatisch erneut und pausiert Anfragen bei einer Cloudflare-Sperre.</p>
            </div>
          )}
        </div>
      </section>

      <section className="block block--tight" data-tone="ink" aria-labelledby="fig-h">
        <div className="wrap">
          <h2 className="sr-only" id="fig-h">
            Auf einen Blick
          </h2>
          <dl className="grid st-figs st-figs--5">
            <Link href="/spieler?filter=online" className="box st-fig" data-tone={METRIC_TONE.onlineCount}>
              <dt>Online</dt>
              <FigValue>{s ? num(s.onlineCount) : "–"}</FigValue>
            </Link>
            <Link href="/live" className="box st-fig" data-tone={METRIC_TONE.liveCount}>
              <dt>Live auf Twitch</dt>
              <FigValue>{s ? num(liveList.length) : "–"}</FigValue>
            </Link>
            <Link href="/live" className="box st-fig" data-tone={METRIC_TONE.viewers}>
              <dt>Zuschauer</dt>
              <FigValue>{s ? num(viewers) : "–"}</FigValue>
            </Link>
            <div className="box st-fig" data-tone={BOARD_TONE.playtimeSeconds}>
              <dt>Stunden gespielt</dt>
              <FigValue>{s ? num(s.totals.playtimeSeconds / 3600) : "–"}</FigValue>
            </div>
            <Link href="/ereignisse?g=death" className="box st-fig" data-tone={BOARD_TONE.deaths}>
              <dt>Tode</dt>
              <FigValue>{s ? num(s.totals.deaths) : "–"}</FigValue>
            </Link>
          </dl>
        </div>
      </section>

      <section className="block block--tight" data-tone="white" aria-labelledby="online-h">
        <div className="wrap">
          <h2 className="t-2 st-online__h" id="online-h">
            <span className="dot" aria-hidden="true" /> Gerade online{" "}
            {s && s.online.length > 0 && <span className="num">({s.online.length})</span>}
          </h2>
          {s && s.online.length > 0 ? (
            <ul className="st-chips">
              {[...s.online]
                .sort((a, b) => (b.live?.viewers ?? -1) - (a.live?.viewers ?? -1))
                .map((p) => (
                  <li key={p.id}>
                    <Link
                      className="st-chip-in"
                      data-live={p.live ? "true" : undefined}
                      href={`/spieler/${encodeURIComponent(p.id)}`}
                      title={p.live?.title}
                    >
                      <Head id={p.id} uuid={p.uuid} name={p.name} size={32} decorative />
                      <span>{p.name}</span>
                      {p.live && (
                        <span className="st-livetag">
                          <span className="dot dot--live" /> {num(p.live.viewers)}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="st-online__empty">
              {s
                ? s.serverOnline
                  ? "Gerade ist keiner drauf. Alle am Schlafen?"
                  : "Der Server ist offline, also ist auch keiner drauf."
                : "Sobald die erste Abfrage durch ist, siehst du hier, wer drauf ist."}
            </p>
          )}
        </div>
      </section>

      <Suspense fallback={null}>
        <TopClips />
      </Suspense>

      <section className="block" data-tone="paper" aria-labelledby="feed-h">
        <div className="wrap">
          <div className="section-head">
            <div className="stack" style={{ "--stack": "8px" } as React.CSSProperties}>
              <h2 className="t-2" id="feed-h">
                Zuletzt passiert
              </h2>
              <p className="lead">Was, wer, wo, wann. Neuestes oben.</p>
            </div>
            <Link className="btn btn--small" data-tone="white" href="/ereignisse">
              Alle Ereignisse
            </Link>
          </div>
          <div className="box trend-card" data-tone="white" style={{ marginBottom: 24 }}>
            <div className="spark-card__head">
              <span className="eyebrow">Verlauf</span>
            </div>
            <TrendChart points={trend} now={now} />
            <Link className="how-link" href={graphHref(["onlineCount", "liveCount", "viewers"], [], "3d")}>
              Im Graph öffnen →
            </Link>
          </div>
          <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
            <div style={{ gridColumn: "span 2" }} className="feed-col">
              <ul className="filters" style={{ marginBottom: 12 }} aria-label="Nur eine Kategorie zeigen">
                {EVENT_GROUPS.map((grp) => (
                  <li key={grp.key}>
                    <Link className="tag" data-tone="white" href={`/ereignisse?g=${grp.key}`}>
                      <span className="swatch" data-tone={grp.tone} aria-hidden="true" />
                      {grp.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <EventFeed events={recent} isShown={isShown} />
            </div>
            <aside className="stack" style={{ "--stack": "16px" } as React.CSSProperties}>
              <div className="box spark-card" data-tone="white">
                <div className="spark-card__head">
                  <span className="eyebrow">Online · seit Start</span>
                  <span className="num spark-card__val">{s ? num(s.onlineCount) : "–"}</span>
                </div>
                <Sparkline points={hist.map((h) => ({ at: h.at, v: h.onlineCount }))} label="Online" />
              </div>
              <div className="box spark-card" data-tone="white">
                <div className="spark-card__head">
                  <span className="eyebrow">Zuschauer · seit Start</span>
                  <span className="num spark-card__val">{num(viewers)}</span>
                </div>
                <Sparkline points={hist.map((h) => ({ at: h.at, v: h.viewers }))} label="Zuschauer" />
              </div>
              <div className="box spark-card" data-tone="white">
                <div className="spark-card__head">
                  <span className="eyebrow">Tracker</span>
                </div>
                <dl className="player-card__stats" style={{ borderTop: 0, paddingTop: 0 }}>
                  <dt>Läuft seit</dt>
                  <dd className="num">{duration((now - Date.parse(state.startedAt)) / 1000)}</dd>
                  <dt>Spieler erfasst</dt>
                  <dd className="num">{num(trackedPlayers)}</dd>
                  <dt>Abfragen</dt>
                  <dd className="num">{num(state.polls)}</dd>
                  <dt>Ereignisse</dt>
                  <dd className="num">{num(state.eventCount)}</dd>
                </dl>
              </div>
              <div className="box spark-card" data-tone="white">
                <div className="spark-card__head">
                  <span className="eyebrow">Rekorde seit Start</span>
                </div>
                <div className="records">
                  {(
                    [
                      ["peakOnline", "Gleichzeitig online"],
                      ["peakLive", "Gleichzeitig live"],
                      ["peakViewers", "Zuschauer gesamt"],
                    ] as const
                  ).map(([k, label]) => {
                    const r = state.records[k];
                    return (
                      <div className="records__row" key={k}>
                        <span>{label}</span>
                        <span className="num">{r ? num(r.value) : "–"}</span>
                        {r && <small>{dateTime(r.at)}</small>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="block" data-tone="paper" aria-labelledby="boards-h" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2" id="boards-h">
              Bestenlisten
            </h2>
            <Link className="btn btn--small" data-tone="white" href="/bestenlisten">
              Mehr als Top 10
            </Link>
          </div>
          <div className="grid st-boards">
            {BOARD_KEYS.map((key) => {
              const b = BOARDS[key];
              const IconCmp = Icon[BOARD_ICON[key]];
              const list = s?.boards?.[key] ?? [];
              return (
                <section className="box st-board" data-tone={b.tone} key={key} aria-labelledby={`b-${key}`}>
                  <header className="st-board__head">
                    <span className="st-board__icon">
                      <IconCmp aria-hidden="true" />
                    </span>
                    <div>
                      <h3 className="t-3" id={`b-${key}`}>
                        {b.title}
                      </h3>
                      <p className="st-board__sub">{b.sub}</p>
                    </div>
                  </header>
                  <ol className="st-board__list">
                    {list.length === 0 ? (
                      <li className="st-board__note">Noch keiner.</li>
                    ) : (
                      list.slice(0, 10).map((e, i) => {
                        const before = ranksBefore[key]?.[e.id];
                        const diff = before === undefined ? null : before - (i + 1);
                        return (
                          <li key={e.id}>
                            <Link className="st-board__row" href={`/spieler/${encodeURIComponent(e.id)}`}>
                              <span className="st-board__rank num">{i + 1}</span>
                              <Head id={e.id} uuid={e.uuid} name={e.name} decorative />
                              <span className="st-board__name">{e.name}</span>
                              <span className="st-board__val num" title={boardValue(key, e.value)}>
                                <BoardValue k={key} v={e.value} />
                              </span>
                              {diff === null ? (
                                <span className="st-board__mv st-board__mv--new" title="Vor 24 Stunden noch nicht erfasst">
                                  neu
                                </span>
                              ) : diff > 0 ? (
                                <span className="st-board__mv st-board__mv--up num" title={`Vor 24 Stunden Platz ${before}`}>
                                  ▲{diff}
                                </span>
                              ) : diff < 0 ? (
                                <span className="st-board__mv st-board__mv--down num" title={`Vor 24 Stunden Platz ${before}`}>
                                  ▼{-diff}
                                </span>
                              ) : (
                                <span className="st-board__mv" aria-hidden="true" />
                              )}
                            </Link>
                          </li>
                        );
                      })
                    )}
                  </ol>
                </section>
              );
            })}
            <section className="box st-board" data-tone={METRIC_TONE.twitchSubs} aria-labelledby="b-twitch-subs">
              <header className="st-board__head">
                <span className="st-board__icon">
                  <Icon.gift aria-hidden="true" />
                </span>
                <div>
                  <h3 className="t-3" id="b-twitch-subs">
                    Sub-Stars
                  </h3>
                  <p className="st-board__sub">Twitch-Abos, während die Spieler auf dem Server online waren</p>
                </div>
              </header>
              <ol className="st-board__list">
                {subscriptionBoard.length === 0 ? (
                  <li className="st-board__note">Noch keine Subs erfasst.</li>
                ) : (
                  subscriptionBoard.slice(0, 10).map((entry, index) => (
                    <li key={entry.id}>
                      <Link className="st-board__row" href={`/spieler/${encodeURIComponent(entry.id)}`}>
                        <span className="st-board__rank num">{index + 1}</span>
                        <Head id={entry.id} uuid={entry.uuid} name={entry.name} decorative />
                        <span className="st-board__name">{entry.name}</span>
                        <span className="st-board__val num">{num(entry.value)}</span>
                        <span className="st-board__mv" aria-hidden="true" />
                      </Link>
                    </li>
                  ))
                )}
              </ol>
            </section>
            <section className="box st-board" data-tone={METRIC_TONE.tracked} aria-labelledby="b-tracked">
              <header className="st-board__head">
                <span className="st-board__icon">
                  <Icon.users aria-hidden="true" />
                </span>
                <div>
                  <h3 className="t-3" id="b-tracked">
                    Dauergäste
                  </h3>
                  <p className="st-board__sub">Online-Zeit laut Tracker, alle Spieler</p>
                </div>
              </header>
              <ol className="st-board__list">
                {trackedTime.length === 0 ? (
                  <li className="st-board__note">Noch keiner.</li>
                ) : (
                  trackedTime.map((p, i) => (
                    <li key={p.id}>
                      <Link className="st-board__row" href={`/spieler/${encodeURIComponent(p.id)}`}>
                        <span className="st-board__rank num">{i + 1}</span>
                        <Head id={p.id} uuid={p.uuid} name={p.name} decorative />
                        <span className="st-board__name">{p.name}</span>
                        <span className="st-board__val num">{duration(p.seconds)}</span>
                      </Link>
                    </li>
                  ))
                )}
              </ol>
            </section>
          </div>
          <HowLink section="bestenlisten" />
        </div>
      </section>
    </div>
  );
}

/** Meistgesehene Clips der letzten 24 Stunden (fehlen welche, die der letzten Woche) */
async function TopClips() {
  await connection();
  let clips = await getTopClips({ hours: 24, limit: 8, perPlayer: 2 });
  let range = "der letzten 24 Stunden";
  if (clips.length < 4) {
    clips = await getTopClips({ hours: 7 * 24, limit: 8, perPlayer: 2 });
    range = "der letzten 7 Tage";
  }
  if (!clips.length) return null;
  return (
    <section className="block block--tight" data-tone="paper" aria-labelledby="clips-h">
      <div className="wrap">
        <div className="section-head">
          <div className="stack" style={{ "--stack": "8px" } as React.CSSProperties}>
            <h2 className="t-2" id="clips-h">
              Top-Clips
            </h2>
            <p className="lead">Die meistgesehenen Clips {range}, höchstens zwei je Kanal.</p>
          </div>
          <Link className="btn btn--small" data-tone="white" href="/ereignisse?t=clip">
            Alle Clips
          </Link>
        </div>
        <ClipGrid clips={clips} />
      </div>
    </section>
  );
}
