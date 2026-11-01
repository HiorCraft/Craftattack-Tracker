import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, cache } from "react";
import type { Metadata } from "next";
import { BOARD_TONE } from "@/lib/statTone";
import { loadTracker } from "@/lib/data";
import { chatVodLinks, eventPlayers, isShownEvent, sharedChatPlayers } from "@/lib/events";
import { thinHistory } from "@/lib/thinHistory";
import { BOARD_KEYS, type BoardKey, type TrackerEvent } from "@/lib/types";
import { ago, boardParts, dateTime, duration, eur, num, skinUrl } from "@/lib/format";
import { getPlayerEarnings, getStreamTotals } from "@/lib/earnings";
import { getStreamFollowerGains } from "@/lib/streamFollowers";
import type { PlayerPoint } from "@/lib/types";
import { EventFeed } from "@/components/EventFeed";
import { BOARD_ICON, Icon } from "@/components/Icons";
import { FigValue } from "@/components/FigValue";
import { StatSpark } from "@/components/StatSpark";
import { ClipGrid } from "@/components/ClipGrid";
import { getTopClips } from "@/lib/clips";
import { EstimatePlayer, PlayerEstimateSummary } from "@/components/Estimates";
import { getAllSessions, getFullBoard, getPlayerHistory, getPlayerSharedChatSessions, getPlayerTopHistory, getPlayerTwitchChat, getTwitchCheerProfile, getTwitchSubscriptionBoard, getTwitchSubscriptionProfile } from "@/lib/store";
import { SharedChatList } from "@/components/SharedChatList";
import { ChatFeed, ChatPartners } from "@/components/ChatFeed";
import { companionsOf, overlapsFor } from "@/lib/overlap";
import { TwitchEmbed } from "@/components/TwitchEmbed";
import { PlayerInsights } from "@/components/PlayerInsights";
import { getPlayerAfkSpans, getPlayerRates, getRankHistory, spanSeconds } from "@/lib/analytics";
import { PlayerActivity } from "@/components/PlayerActivity";
import { PlayerDetails } from "@/components/PlayerDetails";
import { playtimeOf, trackedSecondsOf } from "@/lib/playtime";
import { getPlayerEventTimeState } from "@/lib/playerEventStatus";
import { ChatSkeleton, DetailsSkeleton, HeadSkeleton, InsightsSkeleton, RanksSkeleton, TilesSkeleton, TimelineSkeleton } from "@/components/PlayerSkeletons";
import { METRIC_TONE } from "@/lib/statTone";
import { Head } from "@/components/Head";
import { TOP_CATEGORIES, boardHref, itemRanking, restRanking } from "@/lib/leaderboards";
import type { TopPlaces } from "@/components/PlayerDetails";
import { activeDays, dailyHighlights } from "@/lib/highlights";
import { DayHighlights } from "@/components/DayHighlights";
import { HowLink, PresenceLegend } from "@/components/HowLink";
import { graphHref, type Metric } from "@/lib/graphQuery";


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
  damageDealt: "Schaden",
  totemsUsed: "Totems",
  foodEaten: "Essen",
};
const TONE = BOARD_TONE;

type Params = PageProps<"/spieler/[id]">["params"];

/**
 * Die Seite öffnet sofort: Jeder Abschnitt lädt seine Daten selbst und erscheint, sobald sie da sind.
 * Bis dahin zeigt ein Platzhalter mit der echten Überschrift, was kommt, ohne dass das Layout springt.
 * Schnelles zuerst: Kopf und Kacheln brauchen fast nur den Tracker-Stand im Speicher.
 */
export default function Page(props: PageProps<"/spieler/[id]">) {
  const { params, searchParams } = props;
  return (
    <>
      <Suspense fallback={<HeadSkeleton />}>
        <HeadSection params={params} />
      </Suspense>
      <Suspense fallback={<TilesSkeleton />}>
        <StatsSection params={params} />
      </Suspense>
      <Suspense fallback={null}>
        <HighlightsSection params={params} searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={null}>
        <ClipsSection params={params} />
      </Suspense>
      <Suspense fallback={<InsightsSkeleton />}>
        <InsightsSection params={params} />
      </Suspense>
      <Suspense fallback={<RanksSkeleton />}>
        <ActivitySection params={params} />
      </Suspense>
      <Suspense fallback={<DetailsSkeleton />}>
        <DetailsSection params={params} />
      </Suspense>
      <Suspense fallback={<TimelineSkeleton />}>
        <TimelineSection params={params} />
      </Suspense>
      <Suspense fallback={<ChatSkeleton />}>
        <ChatSection params={params} />
      </Suspense>
    </>
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
/** Einzelner Verlauf als Messpunkte für StatSpark */
function sparkPoints(rows: { at: string; value: number }[], key: "twitchSubs" | "twitchBits" | "twitchEarnings"): PlayerPoint[] {
  return rows.map((point) => ({
    at: point.at,
    online: false,
    viewers: null,
    playtimeSeconds: null,
    deaths: null,
    diamonds: null,
    blocksBroken: null,
    mobsKilled: null,
    distance: null,
    damageDealt: null,
    totemsUsed: null,
    foodEaten: null,
    followersOnServer: null,
    followersTotal: null,
    ranks: {},
    streamGameId: null,
    streamGameName: null,
    [key]: point.value,
  }));
}

function streams(events: TrackerEvent[], live: boolean, liveSince: string | null, now: number, liveLogin?: string): (Session & { peak?: number; login?: string })[] {
  const out: (Session & { peak?: number; login?: string })[] = [];
  let open: string | null = null;
  let openEvent: TrackerEvent | null = null;
  for (const e of events) {
    if (e.type === "stream_start") {
      open = e.at;
      openEvent = e;
    }
    if (e.type === "stream_end") {
      const secs = Number(e.meta?.streamSeconds ?? 0);
      const start = (typeof e.meta?.startedAt === "string" && e.meta.startedAt) || openEvent?.at || open || new Date(Date.parse(e.at) - secs * 1000).toISOString();
      const login = (typeof e.meta?.login === "string" && e.meta.login) || (typeof openEvent?.meta?.login === "string" ? openEvent.meta.login : undefined);
      out.push({ start, end: e.at, seconds: secs || (Date.parse(e.at) - Date.parse(start)) / 1000, peak: Number(e.meta?.peakViewers ?? 0) || undefined, login });
      open = null;
      openEvent = null;
    }
  }
  if (live && liveSince) out.push({ start: liveSince, end: null, seconds: (now - Date.parse(liveSince)) / 1000, login: liveLogin });
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


/* ---------- Gemeinsame Daten je Anfrage (React cache: einmal je Seitenaufruf, von allen Abschnitten geteilt) ---------- */

const getCtx = cache(async (raw: string) => {
  const id = decodeURIComponent(raw).toLowerCase();
  const { state, events, now } = await loadTracker();
  const p = state.players[id];
  return { id, state, events, now, p };
});

async function ctxFor(params: Params) {
  const { id: raw } = await params;
  return getCtx(raw);
}

/** Alle Ereignisse, an denen der Spieler beteiligt ist (selbst, Raid-Ziel oder geteilter Chat) */
const getMine = cache(async (raw: string) => {
  const { id, events } = await getCtx(raw);
  return events.filter((e) => e.player === id || e.meta?.raidTargetPlayerId === id || sharedChatPlayers(e).includes(id));
});

/** Link auf den Graphen der Statistik-Seite für diese Kennzahl und diesen Spieler */
const graphHrefFor = (id: string) => (metric: string) => graphHref(metric as Metric, [id]);

/* ---------- Abschnitte ---------- */

async function HeadSection({ params }: { params: Params }) {
  const { p } = await ctxFor(params);
  if (!p) notFound();
  const twitchLogin = p.live?.login ?? p.twitchLogin;
  const twitchUrl = twitchLogin ? `https://www.twitch.tv/${encodeURIComponent(twitchLogin)}` : null;
  return (
    <>
    <section className="block page-head" data-tone="ender">
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
                <span className="tag" data-tone="idle" title={p.afkFarm ? `Die Strecke steigt nicht, aber ${p.afkFarm === "mobs" ? "Mobs sterben" : "Blöcke fallen"} – eine AFK-Farm` : "Der Server zählt den Spieler als AFK (ab 5 Minuten ohne Bewegung)"}>
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
    </>
  );
}

async function StatsSection({ params }: { params: Params }) {
  const { id, state, now, p } = await ctxFor(params);
  if (!p) return null;
  const streamStartedAt = p.live ? p.live.startedAt ?? p.liveSince ?? null : null;
  const [history, subscriptions, subscriptionBoard, followerBoard, cheers, earnings, streamTotals, followerGains] = await Promise.all([
    getPlayerHistory(id),
    getTwitchSubscriptionProfile(id, streamStartedAt),
    getTwitchSubscriptionBoard(),
    getFullBoard("followers"),
    getTwitchCheerProfile(id, streamStartedAt),
    getPlayerEarnings(id),
    getStreamTotals([{ player: id, startedAt: streamStartedAt }]),
    getStreamFollowerGains([p]),
  ]);
  const thisStream = streamTotals.get(id);
  const followerGain = followerGains.get(id) ?? null;
  // Für die Sparklines im Browser reichen ~300 Punkte; der volle Verlauf bleibt auf dem Server
  const sparkHistory = thinHistory(history);
  const playtime = playtimeOf(p, now);
  const graphHref = graphHrefFor(id);
  // Rang: bevorzugt aus /api/player/<id> (für alle Spieler), sonst Position in der Top 10 der Haupt-API
  const ranks = Object.fromEntries(
    BOARD_KEYS.map((k) => {
      const ext = p.ranks?.[k];
      if (ext) return [k, { rank: ext.rank, of: ext.of }];
      const pos = (state.latest?.boards?.[k] ?? []).findIndex((e) => e.id === id) + 1;
      return [k, pos > 0 ? { rank: pos, of: null } : null];
    }),
  ) as Record<BoardKey, { rank: number; of: number | null } | null>;
  const subscriptionRankIndex = subscriptionBoard.findIndex((entry) => entry.id === id);
  const followerRankIndex = followerBoard.findIndex((entry) => entry.id === id);
  const profileStatKeys = [...BOARD_KEYS, "followers", "twitchSubs", "twitchBits", "twitchEarnings"] as const;
  return (
    <EstimatePlayer id={id}>
    <section className="block block--tight" data-tone="ink">
      <div className="wrap">
        <h2 className="sr-only">Statistiken</h2>
        <PlayerEstimateSummary />
        <dl className="grid st-figs">
          {profileStatKeys.map((k) => {
            if (k === "followers") {
              return (
                <div key={k} className="box st-fig st-fig--spark" data-tone={METRIC_TONE.followers}>
                  <dt className="pstat">
                    <Link className="pstat__label pstat__link" href={graphHref(k)} title={`Follower von ${p.name} im Graphen der Statistik öffnen`}>
                      <Icon.users width={18} height={18} aria-hidden="true" />
                      <span>Follower</span>
                      <span className="pstat__go" aria-hidden="true">↗</span>
                    </Link>
                    {followerRankIndex >= 0 && (
                      <span className="pstat__meta">
                        <Link className="tag" data-tone="ink" href={boardHref("followers")} title={`Platz ${followerRankIndex + 1} von ${followerBoard.length} in der Bestenliste „Fanmagnet“ (Follower-Zuwachs auf dem Server)`}>
                          Platz {followerRankIndex + 1}
                          <span className="muted"> / {followerBoard.length}</span>
                        </Link>
                      </span>
                    )}
                  </dt>
                  <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                    <FigValue>{p.followersAt ? num(p.followersOnServer) : "–"}</FigValue>
                  </Link>
                  <StatSpark points={sparkHistory} k="followersOnServer" label="Follower" href={graphHref(k)} />
                  {p.live && followerGain !== null && (
                    <p className="muted" style={{ fontSize: ".75rem", marginTop: 4 }} title="Follower jetzt minus Follower beim Streamstart">
                      Dieser Stream: {followerGain > 0 ? "+" : ""}
                      {num(followerGain)}
                    </p>
                  )}
                </div>
              );
            }
            if (k === "twitchBits") {
              return (
                <div key={k} className="box st-fig st-fig--spark" data-tone={METRIC_TONE.twitchSubs}>
                  <dt className="pstat">
                    <Link className="pstat__label pstat__link" href={graphHref(k)} title="Bits aus Cheers im eigenen Kanal, während der Streamer auf dem Server war · im Graphen öffnen">
                      <Icon.bits width={18} height={18} aria-hidden="true" />
                      <span>Twitch Bits</span>
                      <span className="pstat__go" aria-hidden="true">↗</span>
                    </Link>
                  </dt>
                  <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                    <FigValue>{num(cheers.onServer)}</FigValue>
                  </Link>
                  <StatSpark points={sparkPoints(cheers.history, "twitchBits")} k="twitchBits" label="Twitch Bits" href={graphHref(k)} />
                  <p className="muted" style={{ fontSize: ".75rem", marginTop: 4 }}>
                    {cheers.count === 0
                      ? "Noch kein Cheer erfasst"
                      : cheers.biggest
                        ? `Größter Cheer: ${num(cheers.biggest.bits)} von ${cheers.biggest.fromName}`
                        : `${num(cheers.total)} Bits, nicht auf dem Server`}
                    {p.live && cheers.currentStream > 0 ? ` · Dieser Stream: ${num(cheers.currentStream)}` : ""}
                  </p>
                </div>
              );
            }
            if (k === "twitchSubs") {
              return (
                <div key={k} className="box st-fig st-fig--spark" data-tone={METRIC_TONE.twitchSubs}>
                  <dt className="pstat">
                    <Link className="pstat__label pstat__link" href={graphHref(k)} title={`Twitch-Subs von ${p.name} im Graphen der Statistik öffnen`}>
                      <Icon.gift width={18} height={18} aria-hidden="true" />
                      <span>Twitch Subs</span>
                      <span className="pstat__go" aria-hidden="true">↗</span>
                    </Link>
                    {subscriptionRankIndex >= 0 && (
                      <span className="pstat__meta">
                        <Link
                          className="tag"
                          data-tone="ink"
                          href={boardHref("twitchSubs")}
                          title={`Platz ${subscriptionRankIndex + 1} von ${subscriptionBoard.length} in der Twitch-Subs-Bestenliste`}
                        >
                          Platz {subscriptionRankIndex + 1}
                          <span className="muted"> / {subscriptionBoard.length}</span>
                        </Link>
                      </span>
                    )}
                  </dt>
                  <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                    <FigValue>{num(subscriptions.total)}</FigValue>
                  </Link>
                  <StatSpark points={sparkPoints(subscriptions.history, "twitchSubs")} k="twitchSubs" label="Twitch Subs" href={graphHref(k)} />
                  {p.live && thisStream && (
                    <p
                      className="muted"
                      style={{ fontSize: ".75rem", marginTop: 4 }}
                      title={thisStream.precise ? "Seit Streamstart, Community-Geschenke einmal gezählt" : "Stream begann vor der genauen Erfassung: nur Abos auf dem Server"}
                    >
                      Dieser Stream: {num(thisStream.subs)}
                      {thisStream.precise && thisStream.subsOnServer !== thisStream.subs ? ` (auf dem Server ${num(thisStream.subsOnServer)})` : ""}
                    </p>
                  )}
                </div>
              );
            }
            if (k === "twitchEarnings") {
              return (
                <div key={k} className="box st-fig st-fig--spark" data-tone={METRIC_TONE.twitchEarnings}>
                  <dt className="pstat">
                    <Link
                      className="pstat__label pstat__link"
                      href={graphHref(k)}
                      title="Geschätzt aus Abos und Bits, während der Streamer auf dem Server war; ohne Werbung. Im Graphen öffnen"
                    >
                      <Icon.coin width={18} height={18} aria-hidden="true" />
                      <span>Twitch-Einnahmen</span>
                      <span className="pstat__go" aria-hidden="true">↗</span>
                    </Link>
                    <span className="pstat__meta">
                      <span
                        className="tag"
                        data-tone="ink"
                        title={`Anteil des Streamers an bezahlten Abos, geschätzt aus ca. ${num(earnings.points)} Plus Points im Monat (Untergrenze). Prime zählt immer 50 %.`}
                      >
                        {earnings.share} %
                      </span>
                    </span>
                  </dt>
                  <Link className="pstat__val" href={graphHref(k)} tabIndex={-1} aria-hidden="true">
                    <FigValue>{eur(earnings.total)}</FigValue>
                  </Link>
                  <StatSpark points={sparkPoints(earnings.history, "twitchEarnings")} k="twitchEarnings" label="Twitch-Einnahmen" href={graphHref(k)} />
                  <p className="muted" style={{ fontSize: ".75rem", marginTop: 4 }}>
                    {earnings.perHour !== null ? `ca. ${eur(earnings.perHour)} je Stunde auf dem Server` : "Geschätzt, ohne Werbung"}
                    {p.live && thisStream ? ` · Dieser Stream: ${eur(thisStream.eur)}` : ""}
                  </p>
                </div>
              );
            }
            const IconCmp = Icon[BOARD_ICON[k]];
            // Spielzeit: letzter API-Wert, zwischen zwei Abfragen hochgerechnet, sonst die vom Tracker gemessene Online-Zeit
            const isPlaytime = k === "playtimeSeconds";
            const v = isPlaytime ? (playtime.seconds > 0 ? playtime.seconds : undefined) : p.stats[k];
            const fromTracker = isPlaytime && playtime.source !== "api" && v !== undefined;
            const trackerTitle =
              playtime.source === "estimate"
                ? "Letzter API-Wert plus die seitdem vom Tracker gemessene Online-Zeit. Die API wird je Spieler höchstens alle 15 Minuten abgefragt."
                : "Die API hat für diesen Spieler noch keine Spielzeit geliefert. Das hier ist die vom Tracker seit seinem Start gemessene Online-Zeit.";
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
                        <Link className="tag" data-tone="ink" href={boardHref(k)} title={ranks[k].of ? `Platz ${ranks[k].rank} von ${ranks[k].of} – Bestenliste öffnen` : `Platz ${ranks[k].rank} in der Top 10 – Bestenliste öffnen`}>
                          Platz {ranks[k].rank}
                          {ranks[k].of ? <span className="muted"> / {ranks[k].of}</span> : null}
                        </Link>
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
                  {v !== undefined ? <FigValue unit={boardParts(k, v).unit}>{boardParts(k, v).value}</FigValue> : <FigValue>–</FigValue>}
                </Link>
                <StatSpark points={sparkHistory} k={k} label={LABEL[k]} href={graphHref(k)} />
              </div>
            );
          })}
        </dl>
        <HowLink section="profil" />
      </div>
    </section>
    </EstimatePlayer>
  );
}

async function InsightsSection({ params }: { params: Params }) {
  const { id: raw } = await params;
  const { id, now, p } = await getCtx(raw);
  if (!p) return null;
  const [history, allSessions, rates, mine] = await Promise.all([getPlayerHistory(id), getAllSessions(), getPlayerRates(), getMine(raw)]);
  return (
    <>
    <PlayerInsights p={p} history={history} sessions={allSessions.filter((s) => s.player === id)} events={mine} rates={rates.players[id]} server={rates.server} now={now} />
    </>
  );
}

async function ActivitySection({ params }: { params: Params }) {
  const { id, now, p } = await ctxFor(params);
  if (!p) return null;
  const [allSessions, afkSpans, rankHistory] = await Promise.all([getAllSessions(), getPlayerAfkSpans(id), getRankHistory()]);
  const playtime = playtimeOf(p, now);
  return (
    <PlayerActivity
      id={id}
      sessions={allSessions.filter((s) => s.player === id)}
      afk={afkSpans}
      ranks={rankHistory}
      values={{ ...p.stats, ...(playtime.seconds > 0 ? { playtimeSeconds: playtime.seconds } : {}) }}
      apiRanks={p.ranks ?? {}}
      now={now}
    />
  );
}

/** Tageshighlights: gewählter Tag (?tag=), sonst heute bzw. der letzte Tag mit Aktivität */
async function HighlightsSection({ params, searchParams }: { params: Params; searchParams: PageProps<"/spieler/[id]">["searchParams"] }) {
  const [{ id, state, events, now, p }, sp] = await Promise.all([ctxFor(params), searchParams]);
  if (!p) return null;
  const days = activeDays(events, id);
  if (days.length === 0) return null;
  const wanted = typeof sp.tag === "string" ? sp.tag : null;
  const day = wanted && days.includes(wanted) ? wanted : days[0];
  const { highlights, summary } = dailyHighlights(events, id, day);
  return <DayHighlights id={id} name={p.name} day={day} days={days} highlights={highlights} summary={summary} players={state.players} now={now} />;
}

async function DetailsSection({ params }: { params: Params }) {
  const { id, state, now, p } = await ctxFor(params);
  if (!p) return null;
  const topHistory = await getPlayerTopHistory(id);
  // Platz in den Bestenlisten der eigenen Top-Items und der Vielfalt (gleiche Rechnung wie /bestenlisten)
  const all = Object.values(state.players);
  const places: TopPlaces = { items: {}, rest: {} };
  for (const c of TOP_CATEGORIES) {
    for (const e of p.detail?.tops[c] ?? []) {
      const ranking = itemRanking(all, c, e.key);
      places.items[`${c}|${e.key}`] = { rank: ranking.findIndex((r) => r.player.id === id) + 1, of: ranking.length };
    }
    const rest = restRanking(all, c);
    const at = rest.findIndex((r) => r.player.id === id);
    if (at >= 0) places.rest[c] = { rank: at + 1, of: rest.length };
  }
  return (
    <PlayerDetails
      id={id}
      detail={p.detail}
      name={p.name}
      now={now}
      topHistory={topHistory}
      totals={{ blocksBroken: p.stats.blocksBroken, mobsKilled: p.stats.mobsKilled }}
      places={places}
    />
  );
}

async function TimelineSection({ params }: { params: Params }) {
  const { id: raw } = await params;
  const { id, state, now, p, events } = await getCtx(raw);
  if (!p) return null;
  const [history, allSessions, afkSpans, mine] = await Promise.all([getPlayerHistory(id), getAllSessions(), getPlayerAfkSpans(id), getMine(raw)]);
  const sparkHistory = thinHistory(history);
  const graphHref = graphHrefFor(id);
  const overlaps = overlapsFor(id, allSessions, now);
  const nameOf = (pid: string) => state.players[pid]?.name ?? pid;
  const onlineSeconds = trackedSecondsOf(p, now);
  const streamSeconds = (p.streamOnServerSeconds ?? 0) + (p.streamOffServerSeconds ?? 0);
  // AFK-Zeit aus dem Spielerverlauf (rückwirkend, gleiche Quelle wie Zeitstrahl und Statistik)
  const afkSeconds = afkSpans.reduce((s, [a, b]) => s + (b - a) / 1000, 0);
  const afkFarm = { mobs: spanSeconds(afkSpans, "mobs"), blocks: spanSeconds(afkSpans, "blocks") };
  const activeSeconds = Math.max(0, onlineSeconds - afkSeconds);
  const sess = sessions(mine, p.online, p.sessionStart, now);
  const serverSessions = allSessions.filter((session) => session.player === id);
  const strm = streams(mine, Boolean(p.live), p.liveSince, now, p.live?.login);
  // Sessions und Streams gemeinsam, neueste zuerst; die Überschneidung mit der anderen Art steht dabei
  const phases: Phase[] = [
    ...sess.map((s) => ({ ...s, kind: "server" as const, overlap: overlapSeconds(s, strm, now) })),
    ...strm.map((s) => ({ ...s, kind: "stream" as const, overlap: overlapSeconds(s, sess, now) })),
  ].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  // Verlauf: alles, woran der Spieler beteiligt ist – auch als Täter, Raid-Ziel, Schenker oder Kanal
  const shown = events.filter((e) => isShownEvent(e) && eventPlayers(e).includes(id));
  const recent = [...shown].reverse().slice(0, 150);
  const getTimeState = await getPlayerEventTimeState({
    playerEvents: mine.filter((event) => event.player === id),
    displayEvents: recent,
    serverSessions,
    liveSince: p.liveSince,
    liveLogin: p.live?.login ?? p.twitchLogin,
    now,
  });
  const deaths = mine.filter((e) => e.type === "death").reduce((s, e) => s + (e.delta ?? 0), 0);
  return (
    <EstimatePlayer id={id}>
    <section className="block" data-tone="paper">
      <div className="wrap">
        <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
          <div style={{ gridColumn: "span 2" }}>
            <div className="section-head">
              <h2 className="t-2">Verlauf</h2>
              <Link className="btn btn--small" data-tone="white" href={`/ereignisse?spieler=${encodeURIComponent(id)}`}>
                Alle {num(shown.length)}
              </Link>
            </div>
            <EventFeed events={recent} focus={id} empty={`Für ${p.name} wurde noch nichts aufgezeichnet.`} getTimeState={getTimeState} />
            <PresenceLegend />
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
                <dt title="Laut Server: online, aber mindestens 5 Minuten keine Bewegung. Zählt zur Online-Zeit dazu.">AFK-Zeit</dt>
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
                  <StatSpark points={sparkHistory} k="viewers" label="Zuschauer" height={48} href={graphHref("viewers")} />
                </div>
              )}
            </div>
            <section className="box st-board" data-tone={METRIC_TONE.tracked} aria-labelledby="b-with">
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
                        <Head id={o.player} uuid={state.players[o.player]?.uuid} name={nameOf(o.player)} decorative />
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
                Punkt: gerade gemeinsam online.
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
                    const shown = with_.slice(0, 8);
                    const extra =
                      s.kind === "stream"
                        ? [s.peak ? `Peak ${num(s.peak)} Zuschauer` : null, s.overlap > 0 ? `davon ${duration(s.overlap)} auf dem Server` : "nicht auf dem Server"].filter(Boolean).join(" · ")
                        : s.overlap > 0
                          ? `davon ${duration(s.overlap)} live auf Twitch`
                          : null;
                    return (
                      <li key={`${s.kind}${s.start}`} className={`sessions__${s.kind}`}>
                        <span>
                          <span className="sessions__kind tag" data-tone={s.kind === "stream" ? METRIC_TONE.liveCount : METRIC_TONE.onlineCount}>
                            {s.kind === "stream" ? "Stream" : "Server"}
                          </span>{" "}
                          {dateTime(s.start)}
                          {s.end ? ` – ${dateTime(s.end).split(", ").pop()}` : " – jetzt"}
                          {extra && <span className="muted session-with">{extra}</span>}
                          {with_.length > 0 && (
                            <span className="muted session-with session-with--heads">
                              mit
                              {shown.map((w) => (
                                <Head key={w.player} id={w.player} uuid={state.players[w.player]?.uuid} name={`${nameOf(w.player)} · ${duration(w.seconds)}`} size={20} src={32} />
                              ))}
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
            </div>
          </aside>
        </div>
      </div>
    </section>
    </EstimatePlayer>
  );
}

async function ChatSection({ params }: { params: Params }) {
  const { id, state, events, now, p } = await ctxFor(params);
  if (!p) return null;
  const [chat, sharedSessions] = await Promise.all([getPlayerTwitchChat(id, 20), getPlayerSharedChatSessions(id)]);
  const chatVods = chatVodLinks(events);
  return (
    <>
    {(chat.sentTotal > 0 || chat.receivedTotal > 0 || sharedSessions.length > 0) && (
      <section className="block block--tight" data-tone="paper" aria-labelledby="chat-h">
        <div className="wrap">
          <div className="section-head">
            <h2 className="t-2" id="chat-h">
              Chat
            </h2>
            <p className="muted">Nachrichten zwischen {p.name} und anderen Spielern in Twitch-Chats.</p>
          </div>
          {sharedSessions.length > 0 && (
            <div className="box chatbox sharedbox" data-tone="white">
              <div className="chatbox__head">
                <p className="eyebrow">
                  Geteilter Chat · Stream Together <span className="num">({num(sharedSessions.length)})</span>
                </p>
              </div>
              <SharedChatList sessions={sharedSessions} self={id} players={state.players} now={now} />
            </div>
          )}
          {(chat.sentTotal > 0 || chat.receivedTotal > 0) && (
            <div className="chatpair">
              <div className="box chatbox" data-tone="white">
                <div className="chatbox__head">
                  <p className="eyebrow">
                    Schreibt bei anderen <span className="num">({num(chat.sentTotal)})</span>
                  </p>
                  <ChatPartners partners={chat.writesIn} label={`In wessen Chat ${p.name} schreibt`} />
                </div>
                <div className="chatbox__scroll">
                  <ChatFeed
                    messages={chat.sent}
                    uuidOf={(pid) => state.players[pid]?.uuid}
                    nameOf={(pid) => state.players[pid]?.name ?? pid}
                    now={now}
                    empty={`${p.name} hat noch in keinem Spieler-Chat geschrieben.`}
                    vodOf={(mid) => chatVods.get(mid)}
                    label={`Nachrichten von ${p.name}`}
                  />
                </div>
              </div>
              <div className="box chatbox" data-tone="white">
                <div className="chatbox__head">
                  <p className="eyebrow">
                    Im eigenen Chat <span className="num">({num(chat.receivedTotal)})</span>
                  </p>
                  <ChatPartners partners={chat.visitors} label={`Wer im Chat von ${p.name} schreibt`} />
                </div>
                <div className="chatbox__scroll">
                  <ChatFeed
                    messages={chat.received}
                    uuidOf={(pid) => state.players[pid]?.uuid}
                    nameOf={(pid) => state.players[pid]?.name ?? pid}
                    now={now}
                    empty={`Im Chat von ${p.name} hat noch kein Spieler geschrieben.`}
                    vodOf={(mid) => chatVods.get(mid)}
                    label={`Nachrichten im Chat von ${p.name}`}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    )}
    </>
  );
}

/** Beliebteste Clips des Spielers über die ganze Staffel, dazu die besten der letzten 24 Stunden */
async function ClipsSection({ params }: { params: Params }) {
  const { id } = await ctxFor(params);
  const [season, recent] = await Promise.all([getTopClips({ player: id, limit: 6 }), getTopClips({ player: id, hours: 24, limit: 3 })]);
  if (!season.length) return null;
  const fresh = recent.filter((c) => !season.some((s) => s.id === c.id));
  return (
    <section className="block block--tight" data-tone="paper" aria-labelledby="clips-h">
      <div className="wrap">
        <div className="section-head">
          <h2 className="t-2" id="clips-h">
            Beliebteste Clips
          </h2>
          <Link className="btn btn--small" data-tone="white" href={`/ereignisse?t=clip&spieler=${encodeURIComponent(id)}`}>
            Alle Clips
          </Link>
        </div>
        <ClipGrid clips={season} showPlayer={false} />
        {fresh.length > 0 && (
          <>
            <h3 className="t-3" style={{ marginTop: 24 }}>
              Neu in den letzten 24 Stunden
            </h3>
            <ClipGrid clips={fresh} showPlayer={false} />
          </>
        )}
      </div>
    </section>
  );
}
