import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { BOARD_KEYS, type BoardKey, type TrackerEvent } from "@/lib/types";
import { ago, boardValue, dateTime, duration, headUrl, num, skinUrl } from "@/lib/format";
import { EventFeed } from "@/components/EventFeed";
import { BOARD_ICON, Icon } from "@/components/Icons";
import { FigValue } from "@/components/FigValue";
import { StatSpark } from "@/components/StatSpark";
import { getAllSessions, getFullBoard, getPlayerHistory, getTwitchSubscriptionBoard, getTwitchSubscriptionProfile } from "@/lib/store";
import { companionsOf, overlapsFor } from "@/lib/overlap";
import { TwitchEmbed } from "@/components/TwitchEmbed";
import { PlayerInsights } from "@/components/PlayerInsights";
import { getPlayerAfkSpans, getPlayerRates, getRankHistory, spanSeconds } from "@/lib/analytics";
import { PlayerActivity } from "@/components/PlayerActivity";
import { playtimeOf, trackedSecondsOf } from "@/lib/playtime";

// Kein Skeleton: die Seite wird komplett auf dem Server gerendert (SSR) und blockiert bis die Daten da sind.
export const instant = false;

export async function generateMetadata({ params }: PageProps<"/spieler/[id]">): Promise<Metadata> {
  const { id } = await params;
  return { title: decodeURIComponent(id) };
}

const LABEL: Record<BoardKey, string> = {
  playtimeSeconds: "Spielzeit",
  diamonds: "Diamanten",
  deaths: "Tode",
  blocksBroken: "Blöcke",
  mobsKilled: "Mobs",
  distance: "Strecke",
};
const TONE: Record<BoardKey, string> = {
  playtimeSeconds: "sky",
  diamonds: "diamond",
  deaths: "redstone",
  blocksBroken: "gold",
  mobsKilled: "grass",
  distance: "pink",
};

export default function Page(props: PageProps<"/spieler/[id]">) {
  return (
      <Player params={props.params} />
  );
}

interface Session {
  start: string;
  end: string | null;
  seconds: number;
}

/** Ein Eintrag der gemeinsamen Liste: Server-Session oder Twitch-Stream */
interface Phase extends Session {
  kind: "server" | "stream";
  /** Stream: höchste Zuschauerzahl */
  peak?: number;
  /** Überschneidung mit der jeweils anderen Art (Sekunden) */
  overlap: number;
}

/** Baut aus Stream-an/aus-Ereignissen eine Stream-Liste (laufender Stream: end = null). */
function streams(events: TrackerEvent[], live: boolean, liveSince: string | null, now: number): (Session & { peak?: number })[] {
  const out: (Session & { peak?: number })[] = [];
  let open: string | null = null;
  for (const e of events) {
    if (e.type === "stream_start") open = e.at;
    if (e.type === "stream_end") {
      const secs = Number(e.meta?.streamSeconds ?? 0);
      const start = open ?? (typeof e.meta?.startedAt === "string" ? e.meta.startedAt : new Date(Date.parse(e.at) - secs * 1000).toISOString());
      out.push({ start, end: e.at, seconds: secs || (Date.parse(e.at) - Date.parse(start)) / 1000, peak: Number(e.meta?.peakViewers ?? 0) || undefined });
      open = null;
    }
  }
  if (live && liveSince) out.push({ start: liveSince, end: null, seconds: (now - Date.parse(liveSince)) / 1000 });
  return out.reverse();
}

/** Sekunden, die sich eine Phase mit einer Liste anderer Phasen überschneidet */
function overlapSeconds(a: Session, others: Session[], now: number): number {
  const a0 = Date.parse(a.start);
  const a1 = a.end ? Date.parse(a.end) : now;
  let sum = 0;
  for (const o of others) {
    const b0 = Date.parse(o.start);
    const b1 = o.end ? Date.parse(o.end) : now;
    sum += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }
  return sum / 1000;
}

/** Baut aus Join/Leave-Ereignissen eine Session-Liste. */
function sessions(events: TrackerEvent[], online: boolean, sessionStart: string | null, now: number): Session[] {
  const out: Session[] = [];
  let open: string | null = null;
  for (const e of events) {
    if (e.type === "join") open = e.at;
    if (e.type === "leave") {
      out.push({ start: open ?? e.at, end: e.at, seconds: Number(e.meta?.sessionSeconds ?? 0) });
      open = null;
    }
  }
  if (online && sessionStart) {
    out.push({ start: sessionStart, end: null, seconds: (now - Date.parse(sessionStart)) / 1000 });
  }
  return out.reverse();
}

async function Player({ params }: { params: PageProps<"/spieler/[id]">["params"] }) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw).toLowerCase();
  const { state, events, now } = await loadTracker();
  const p = state.players[id];
  if (!p) notFound();
  const [history, allSessions, rates, rankHistory, afkSpans, subscriptions, subscriptionBoard, followerBoard] = await Promise.all([
    getPlayerHistory(id),
    getAllSessions(),
    getPlayerRates(),
    getRankHistory(),
    getPlayerAfkSpans(id),
    getTwitchSubscriptionProfile(id, p.live ? p.liveSince ?? p.live.startedAt ?? null : null),
    getTwitchSubscriptionBoard(),
    getFullBoard("followers"),
  ]);
  const overlaps = overlapsFor(id, allSessions, now);
  const nameOf = (pid: string) => state.players[pid]?.name ?? pid;

  const trackedSeconds = trackedSecondsOf(p, now);
  // Spielzeit: API-Wert, außerhalb der Top 10 ab dem letzten API-Wert aus Join/Leave weitergerechnet
  const playtime = playtimeOf(p, now);
  const twitchLogin = p.live?.login ?? p.twitchLogin;
  const twitchUrl = twitchLogin ? `https://www.twitch.tv/${encodeURIComponent(twitchLogin)}` : null;
  const streamSeconds = (p.streamOnServerSeconds ?? 0) + (p.streamOffServerSeconds ?? 0);
  // AFK-Zeit aus dem Spielerverlauf (rückwirkend, gleiche Quelle wie Zeitstrahl und Statistik)
  const afkSeconds = afkSpans.reduce((s, [a, b]) => s + (b - a) / 1000, 0);
  const afkFarm = { mobs: spanSeconds(afkSpans, "mobs"), blocks: spanSeconds(afkSpans, "blocks") };
  const onlineSeconds = trackedSeconds;
  const activeSeconds = Math.max(0, onlineSeconds - afkSeconds);
  /** Link auf den Graphen der Statistik-Seite für diese Kennzahl und diesen Spieler */
  const graphHref = (metric: string) => `/statistik?metric=${metric}&spieler=${encodeURIComponent(id)}&zeit=alle#graph`;
  const mine = events.filter((e) => e.player === id || e.meta?.raidTargetPlayerId === id);
  const sess = sessions(mine, p.online, p.sessionStart, now);
  const strm = streams(mine, Boolean(p.live), p.liveSince, now);
  // Sessions und Streams gemeinsam, neueste zuerst; die Überschneidung mit der anderen Art steht dabei
  const phases: Phase[] = [
    ...sess.map((s) => ({ ...s, kind: "server" as const, overlap: overlapSeconds(s, strm, now) })),
    ...strm.map((s) => ({ ...s, kind: "stream" as const, overlap: overlapSeconds(s, sess, now) })),
  ].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const recent = [...mine].reverse().slice(0, 150);
  const deaths = mine.filter((e) => e.type === "death").reduce((s, e) => s + (e.delta ?? 0), 0);
  // Rang: bevorzugt aus /api/ext/<login> (für alle Spieler), sonst Position in der Top 10 der Haupt-API
  const ranks = Object.fromEntries(
    BOARD_KEYS.map((k) => {
      const ext = k !== "playtimeSeconds" ? p.ranks?.[k] : undefined;
      if (ext) return [k, { rank: ext.rank, of: ext.of }];
      const pos = (state.latest?.boards?.[k] ?? []).findIndex((e) => e.id === id) + 1;
      return [k, pos > 0 ? { rank: pos, of: null } : null];
    }),
  ) as Record<BoardKey, { rank: number; of: number | null } | null>;
  const subscriptionRankIndex = subscriptionBoard.findIndex((entry) => entry.id === id);
  const followerRankIndex = followerBoard.findIndex((entry) => entry.id === id);
  const profileStatKeys = [...BOARD_KEYS, "followers", "twitchSubs"] as const;

  return (
    <>
      <section className="block page-head" data-tone={p.live ? "twitch" : p.online ? "grass" : "sky"}>
        <div className="wrap">
          <p className="eyebrow">
            <Link href="/spieler" style={{ textDecoration: "none" }}>
              Spieler
            </Link>{" "}
            / Profil
          </p>
          <div className="player-head" style={{ marginTop: 16 }}>
            <img className="skin" src={skinUrl(p.uuid, 256, p.id)} alt={`Skin von ${p.name}`} width={180} height={200} />
            <div>
              <h1 className="t-1">{p.name}</h1>
              <div className="player-head__tags">
                {p.online ? (
                  <span className="tag" data-tone="grass">
                    <span className="dot" /> Online seit {p.sessionStart ? ago(p.sessionStart).replace("vor ", "") : "–"}
                  </span>
                ) : (
                  <span className="tag" data-tone="paper">
                    Offline · zuletzt {ago(p.lastSeen)}
                  </span>
                )}
                {p.online && p.afkSince && (
                  <span className="tag" data-tone="gold" title={p.afkFarm ? `Die Strecke steigt nicht, aber ${p.afkFarm === "mobs" ? "Mobs sterben" : "Blöcke fallen"} – eine AFK-Farm` : "Die gelaufene Strecke steigt seit mindestens fünf Minuten nicht"}>
                    AFK seit {ago(p.afkSince).replace("vor ", "")}
                    {p.afkFarm ? ` · ${p.afkFarm === "mobs" ? "farmt Mobs" : "baut Blöcke ab"}` : ""}
                  </span>
                )}
                {p.live && twitchUrl ? (
                  <a className="tag" data-tone="ink" href={twitchUrl} target="_blank" rel="noopener">
                    <span className="dot dot--live" /> Live · {num(p.live.viewers)} Zuschauer
                    {p.live.onServer === false ? " · nicht auf dem Server" : ""}
                  </a>
                ) : twitchUrl ? (
                  <a className="tag" data-tone="twitch" href={twitchUrl} target="_blank" rel="noopener" title="Twitch-Kanal öffnen (gerade nicht live)">
                    <Icon.twitch width={14} height={14} aria-hidden="true" /> twitch.tv/{twitchLogin}
                  </a>
                ) : (
                  <span className="tag" data-tone="paper">
                    Nicht live
                  </span>
                )}
                <span className="tag" data-tone="white">
                  Erfasst seit {dateTime(p.firstSeen)}
                </span>
              </div>
            </div>
          </div>
          {p.live && (
            <p style={{ marginTop: 20, fontWeight: 600 }} title={p.live.title}>
              „{p.live.title}“
            </p>
          )}
        </div>
      </section>

      {p.live && <TwitchEmbed login={p.live.login} name={p.name} />}

      <section className="block block--tight" data-tone="ink">
        <div className="wrap">
          <h2 className="sr-only">Statistiken</h2>
          <dl className="grid st-figs">
            {profileStatKeys.map((k) => {
              if (k === "followers") {
                return (
                  <div key={k} className="box st-fig st-fig--spark" data-tone="twitch">
                    <dt className="pstat">
                      <Link className="pstat__label pstat__link" href={graphHref(k)} title={`Follower von ${p.name} im Graphen der Statistik öffnen`}>
                        <Icon.users width={18} height={18} aria-hidden="true" />
                        <span>Follower-Zuwachs auf dem Server</span>
                        <span className="pstat__go" aria-hidden="true">↗</span>
                      </Link>
                      {followerRankIndex >= 0 && (
                        <span className="pstat__meta">
                          <span className="tag" data-tone="ink" title={`Platz ${followerRankIndex + 1} von ${followerBoard.length} in der Bestenliste für Follower-Zuwachs auf dem Server`}>
                            Platz {followerRankIndex + 1}
                            <span className="muted"> / {followerBoard.length}</span>
                          </span>
                        </span>
                      )}
                    </dt>
                    <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                      <FigValue>{p.followersAt ? num(p.followersOnServer) : "–"}</FigValue>
                    </Link>
                    <StatSpark points={history} k="followersOnServer" label="Follower-Zuwachs auf dem Server" href={graphHref(k)} />
                  </div>
                );
              }
              if (k === "twitchSubs") {
                return (
                  <div key={k} className="box st-fig st-fig--spark" data-tone="amethyst">
                    <dt className="pstat">
                      <Link className="pstat__label pstat__link" href={graphHref(k)} title={`Twitch-Subs von ${p.name} im Graphen der Statistik öffnen`}>
                        <Icon.gift width={18} height={18} aria-hidden="true" />
                        <span>Twitch Subs</span>
                        <span className="pstat__go" aria-hidden="true">↗</span>
                      </Link>
                      {subscriptionRankIndex >= 0 && (
                        <span className="pstat__meta">
                          <span
                            className="tag"
                            data-tone="ink"
                            title={`Platz ${subscriptionRankIndex + 1} von ${subscriptionBoard.length} in der Twitch-Subs-Bestenliste`}
                          >
                            Platz {subscriptionRankIndex + 1}
                            <span className="muted"> / {subscriptionBoard.length}</span>
                          </span>
                        </span>
                      )}
                    </dt>
                    <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                      <FigValue>{num(subscriptions.total)}</FigValue>
                    </Link>
                    <StatSpark
                      points={subscriptions.history.map((point) => ({
                        at: point.at,
                        online: false,
                        viewers: null,
                        playtimeSeconds: null,
                        deaths: null,
                        diamonds: null,
                        blocksBroken: null,
                        mobsKilled: null,
                        distance: null,
                        followersOnServer: null,
                        twitchSubs: point.value,
                      }))}
                      k="twitchSubs"
                      label="Twitch Subs"
                      href={graphHref(k)}
                    />
                    {p.live && (
                      <p className="muted" style={{ fontSize: ".75rem", marginTop: 4 }}>
                        Dieser Stream: {num(subscriptions.currentStream)}
                      </p>
                    )}
                  </div>
                );
              }
              const IconCmp = Icon[BOARD_ICON[k]];
              // Spielzeit gibt es von der API nur für die Top 10 – sonst geschätzt bzw. die vom Tracker gemessene Online-Zeit
              const isPlaytime = k === "playtimeSeconds";
              const v = isPlaytime ? (playtime.seconds > 0 ? playtime.seconds : undefined) : p.stats[k];
              const fromTracker = isPlaytime && playtime.source !== "api" && v !== undefined;
              const trackerTitle =
                playtime.source === "estimate"
                  ? "Von der API gibt es Spielzeit nur für die Top 10. Das hier ist der letzte API-Wert plus die seitdem vom Tracker gemessene Online-Zeit."
                  : "Von der API gibt es Spielzeit nur für die Top 10. Das hier ist die vom Tracker seit seinem Start gemessene Online-Zeit.";
              return (
                <div key={k} className="box st-fig st-fig--spark" data-tone={TONE[k]}>
                  <dt className="pstat">
                    <Link className="pstat__label pstat__link" href={graphHref(k)} title={`${LABEL[k]} von ${p.name} im Graphen der Statistik öffnen`}>
                      <IconCmp width={18} height={18} aria-hidden="true" />
                      <span>{LABEL[k]}</span>
                      <span className="pstat__go" aria-hidden="true">↗</span>
                    </Link>
                    {(ranks[k] || fromTracker) && (
                      <span className="pstat__meta">
                        {ranks[k] && (
                          <span className="tag" data-tone="ink" title={ranks[k].of ? `Platz ${ranks[k].rank} von ${ranks[k].of}` : `Platz ${ranks[k].rank} in der Top 10`}>
                            Platz {ranks[k].rank}
                            {ranks[k].of ? <span className="muted"> / {ranks[k].of}</span> : null}
                          </span>
                        )}
                        {fromTracker && (
                          <span className="tag" data-tone="ink" title={trackerTitle}>
                            {playtime.source === "estimate" ? "geschätzt" : "Tracker"}
                          </span>
                        )}
                      </span>
                    )}
                  </dt>
                  <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                    <FigValue>{v !== undefined ? boardValue(k, v) : "–"}</FigValue>
                  </Link>
                  <StatSpark points={history} k={k} label={LABEL[k]} href={graphHref(k)} />
                </div>
              );
            })}
          </dl>
          <p className="muted" style={{ marginTop: 16, fontSize: ".9375rem" }}>
            Tode, Diamanten, Blöcke, Mobs und Strecke kommen aus der Einzelstatistik der API (inklusive Rang unter allen
            Teilnehmenden). Die Spielzeit liefert die API nur für die Top 10. Steht „Tracker“ dabei, ist es die seit Tracker-Start gemessene Online-Zeit.
            Follower-Zuwachs zählt nur zwischen aufeinanderfolgenden Messungen, bei denen der Streamer auf dem Server war; globale Twitch-Followerstände werden nicht angezeigt. Ein Zuwachs von mehr als 20 Followern pro Minute auf dem Server erscheint als Ereignis. Twitch-Subs werden nur gezählt, wenn der Streamer während des Sub-Events auf dem Spielserver online war (auch AFK). Die Kurven zeigen den Verlauf seit Tracker-Start ({num(history.length)} Messpunkte). Mit der Maus über die Kurve fahren zeigt Zeitpunkt und Wert. Ein Klick auf Beschriftung oder Wert öffnet den großen Graphen auf der Statistik-Seite.
          </p>
        </div>
      </section>

      <PlayerInsights p={p} history={history} sessions={allSessions.filter((s) => s.player === id)} events={mine} rates={rates.players[id]} server={rates.server} now={now} />
      <PlayerActivity id={id} sessions={allSessions.filter((s) => s.player === id)} afk={afkSpans} ranks={rankHistory} now={now} />

      <section className="block" data-tone="paper">
        <div className="wrap">
          <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
            <div style={{ gridColumn: "span 2" }}>
              <div className="section-head">
                <h2 className="t-2">Verlauf</h2>
                <Link className="btn btn--small" data-tone="white" href={`/ereignisse?spieler=${encodeURIComponent(id)}`}>
                  Alle {num(mine.length)}
                </Link>
              </div>
              <EventFeed events={recent} showPlayer={false} empty={`Für ${p.name} wurde noch nichts aufgezeichnet.`} />
            </div>
            <aside className="stack" style={{ "--stack": "16px" } as React.CSSProperties}>
              <div className="box" data-tone="white">
                <p className="eyebrow" style={{ marginBottom: 10 }}>
                  Vom Tracker gemessen
                </p>
                <dl className="player-card__stats" style={{ borderTop: 0, paddingTop: 0 }}>
                  <dt>Sessions</dt>
                  <dd className="num">{num(p.sessions)}</dd>
                  <dt>Online-Zeit</dt>
                  <dd className="num">{duration(onlineSeconds)}</dd>
                  <dt title="Online-Zeit abzüglich AFK-Phasen">Aktiv (ohne AFK)</dt>
                  <dd className="num">{duration(activeSeconds)}</dd>
                  <dt>Tode gesehen</dt>
                  <dd className="num">{num(deaths)}</dd>
                  <dt>Längste Session</dt>
                  <dd className="num">{p.longestSession > 0 ? duration(p.longestSession) : "–"}</dd>
                  <dt title="Online, aber ohne Streckenzuwachs für mindestens fünf Minuten. Zählt zur Online-Zeit dazu.">AFK-Zeit</dt>
                  <dd className="num">
                    {afkSeconds > 0 ? duration(afkSeconds) : "–"}
                    {afkSeconds > 0 && onlineSeconds > 0 && <small className="muted"> {Math.round((afkSeconds / onlineSeconds) * 100)} %</small>}
                  </dd>
                  <dt title="AFK-Zeit, in der trotzdem mindestens zehn Mobs bzw. zehn Blöcke pro Minute fielen">AFK-Farmen</dt>
                  <dd className="num">
                    {afkFarm.mobs > 0 || afkFarm.blocks > 0 ? [afkFarm.mobs > 0 ? `Mobs ${duration(afkFarm.mobs)}` : null, afkFarm.blocks > 0 ? `Blöcke ${duration(afkFarm.blocks)}` : null].filter(Boolean).join(" · ") : "–"}
                  </dd>
                  <dt>Peak-Zuschauer</dt>
                  <dd className="num">{num(p.peakViewers)}</dd>
                  <dt title="Höchste Zuschauerzahl, während der Spieler gleichzeitig auf dem Server war">Peak auf dem Server</dt>
                  <dd className="num">{num(p.peakViewersOnServer ?? 0)}</dd>
                  {streamSeconds > 0 && (
                    <>
                      <dt title="Stream-Zeit, während der Spieler gleichzeitig auf dem Server war">Stream auf dem Server</dt>
                      <dd className="num">{duration(p.streamOnServerSeconds ?? 0)}</dd>
                      <dt title="Stream-Zeit, während der Spieler nicht auf dem Server war">Stream ohne Server</dt>
                      <dd className="num">{duration(p.streamOffServerSeconds ?? 0)}</dd>
                    </>
                  )}
                  <dt>Ereignisse</dt>
                  <dd className="num">{num(mine.length)}</dd>
                </dl>
                {history.some((h) => h.viewers !== null) && (
                  <div style={{ marginTop: 12 }}>
                    <p className="eyebrow" style={{ marginBottom: 6 }}>
                      <Link href={graphHref("viewers")} title="Zuschauer im Graphen der Statistik öffnen" style={{ textDecoration: "none" }}>
                        Zuschauer <span aria-hidden="true">↗</span>
                      </Link>
                    </p>
                    <StatSpark points={history} k="viewers" label="Zuschauer" height={48} href={graphHref("viewers")} />
                  </div>
                )}
              </div>
              <section className="box st-board" data-tone="sky" aria-labelledby="b-with">
                <header className="st-board__head">
                  <span className="st-board__icon">
                    <Icon.users aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="t-3" id="b-with">
                      Mitspieler
                    </h3>
                    <p className="st-board__sub">Meiste gemeinsame Online-Zeit</p>
                  </div>
                </header>
                <ol className="st-board__list">
                  {overlaps.length === 0 ? (
                    <li className="st-board__note">Noch keine Überschneidung gesehen.</li>
                  ) : (
                    overlaps.slice(0, 10).map((o, i) => (
                      <li key={o.player}>
                        <Link
                          className="st-board__row"
                          href={`/spieler/${encodeURIComponent(o.player)}`}
                          title={`${nameOf(o.player)}: ${duration(o.seconds)} gemeinsam online in ${num(o.sessions)} Sessions`}
                        >
                          <span className="st-board__rank num">{i + 1}</span>
                          <img className="head" src={headUrl(state.players[o.player]?.uuid, 28, o.player)} alt="" width={28} height={28} loading="lazy" />
                          <span className="st-board__name">
                            {nameOf(o.player)}
                            {o.now && <span className="dot" style={{ marginLeft: 8 }} title="gerade gemeinsam online" />}
                          </span>
                          <span className="st-board__val num">{duration(o.seconds)}</span>
                        </Link>
                      </li>
                    ))
                  )}
                </ol>
                <p className="muted" style={{ marginTop: 10, fontSize: ".875rem" }}>
                  Seit Tracker-Start, aus den Join/Leave-Ereignissen berechnet. Der grüne Punkt heißt: gerade gemeinsam online.
                </p>
              </section>
              <div className="box" data-tone="white">
                <p className="eyebrow" style={{ marginBottom: 10 }}>
                  Sessions &amp; Streams
                </p>
                {phases.length === 0 ? (
                  <p className="muted">Noch keine komplette Session gesehen.</p>
                ) : (
                  <ul className="sessions">
                    {phases.slice(0, 16).map((s) => {
                      const with_ = s.kind === "server" ? companionsOf(id, s.start, s.end, allSessions, now) : [];
                      const shown = with_.slice(0, 4);
                      const extra =
                        s.kind === "stream"
                          ? [s.peak ? `Peak ${num(s.peak)} Zuschauer` : null, s.overlap > 0 ? `davon ${duration(s.overlap)} auf dem Server` : "nicht auf dem Server"].filter(Boolean).join(" · ")
                          : s.overlap > 0
                            ? `davon ${duration(s.overlap)} live auf Twitch`
                            : null;
                      return (
                        <li key={`${s.kind}${s.start}`} className={`sessions__${s.kind}`}>
                          <span>
                            <span className="sessions__kind tag" data-tone={s.kind === "stream" ? "twitch" : "grass"}>
                              {s.kind === "stream" ? "Stream" : "Server"}
                            </span>{" "}
                            {dateTime(s.start)}
                            {s.end ? ` – ${dateTime(s.end).split(", ").pop()}` : " – jetzt"}
                            {extra && <span className="muted session-with">{extra}</span>}
                            {with_.length > 0 && (
                              <span
                                className="muted session-with"
                                title={with_.map((w) => `${nameOf(w.player)} (${duration(w.seconds)})`).join(", ")}
                              >
                                mit {shown.map((w) => nameOf(w.player)).join(", ")}
                                {with_.length > shown.length ? ` +${with_.length - shown.length}` : ""}
                              </span>
                            )}
                          </span>
                          <span className="num">{duration(s.seconds)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="muted" style={{ marginTop: 10, fontSize: ".875rem" }}>
                  Server-Sessions aus Join/Leave, Streams aus Stream-an/aus. Steht bei einem Eintrag „davon …“, überschneidet er sich mit der anderen Art.
                </p>
              </div>
            </aside>
          </div>
        </div>
      </section>
    </>
  );
}
