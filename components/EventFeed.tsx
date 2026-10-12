import Link from "next/link";
import { BOARD_KEYS, type BoardKey, type EventType, type TrackerEvent } from "@/lib/types";
import { EVENT_META, eventBadge } from "@/lib/events";
import { headUrl, time } from "@/lib/format";
import { BOARD_ICON, EVENT_ICON, Icon } from "./Icons";

const dayFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Europe/Berlin",
});
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

/** Ereignisse ohne Spieler: das Typ-Icon ersetzt den Kopf */
const SERVER_TYPES = new Set<EventType>(["server_online", "server_offline", "tracker_start", "record"]);

/** Kurzer Zusatz rechts neben dem Wert, nur wenn er woanders nicht steht */
function detail(e: TrackerEvent): string | null {
  switch (e.type) {
    case "stream_start":
    case "stream_title":
      return e.meta?.title ? String(e.meta.title) : null;
    case "record":
      return e.meta?.label ? String(e.meta.label) : null;
    case "server_online":
      return "Server online";
    case "server_offline":
      return "Server offline";
    case "tracker_start":
      return "Tracker gestartet";
    case "first_join":
      return "Neu";
    case "death":
      return e.meta?.unknown ? "unbekannt" : e.meta?.inferred ? "zugeordnet" : null;
    // Zähler: die kleinen Icons sind nicht eindeutig, daher ein Wort dazu
    case "diamonds":
      return "Diamanten";
    case "blocksBroken":
      return "Blöcke abgebaut";
    case "mobsKilled":
      return "Mobs";
    case "distance":
      return "gelaufen";
    case "afk_start":
      return "AFK";
    case "afk_mobs_start":
      return "AFK Mobs";
    case "afk_mobs_end":
      return "AFK Mobs Ende";
    case "afk_blocks_start":
      return "AFK Blöcke";
    case "afk_blocks_end":
      return "AFK Blöcke Ende";
    default:
      return null;
  }
}

/** Kompakte Kachel für ein Ereignis. Der volle Satz steht im Tooltip. */
export function EventTile({ e, showPlayer = true }: { e: TrackerEvent; showPlayer?: boolean }) {
  const meta = EVENT_META[e.type];
  const IconCmp = Icon[EVENT_ICON[e.type]];
  const sub = meta.sub?.(e);
  const text = meta.text(e);
  const sentence = [e.player ? `${e.playerName ?? e.player} ${text}` : text, sub].filter(Boolean).join(" · ");
  const badge = e.type === "stream_title" ? null : eventBadge(e);
  const info = detail(e);
  const vod = typeof e.meta?.vodUrl === "string" ? e.meta.vodUrl : null;
  const liveUrl = typeof e.meta?.liveUrl === "string" ? e.meta.liveUrl : null;
  const link = liveUrl ? { href: liveUrl, title: "Läuft gerade – Stream auf Twitch ansehen", live: true } : vod ? { href: vod, title: e.type === "death" ? "Diesen Moment im VOD ansehen" : "Aufzeichnung auf Twitch ansehen", live: false } : null;
  const withHead = Boolean(e.player) && !SERVER_TYPES.has(e.type);
  const offServer = e.type === "stream_start" && e.meta?.onServer === false;
  // Rang / Meilenstein: statt des Listennamens nur das Icon der Liste (Name steht im Tooltip)
  const board = (e.type === "rank" || e.type === "milestone") && BOARD_KEYS.includes(e.meta?.board as BoardKey) ? (e.meta!.board as BoardKey) : null;
  const BoardIcon = board ? Icon[BOARD_ICON[board]] : null;

  return (
    <li className="tile" data-tone={meta.tone} data-type={e.type} title={`${time(e.at)} · ${sentence}`}>
      {withHead && showPlayer ? (
        <Link className="tile__head" href={`/spieler/${encodeURIComponent(e.player!)}`} aria-label={e.playerName ?? e.player}>
          <img src={headUrl(e.uuid, 32, e.player)} alt="" width={32} height={32} loading="lazy" decoding="async" />
        </Link>
      ) : null}
      {e.type === "subscription_gift" && showPlayer && typeof e.meta?.giftGiverPlayerId === "string" && (
        <Link
          className="tile__head tile__head--gift"
          href={`/spieler/${encodeURIComponent(e.meta.giftGiverPlayerId)}`}
          aria-label={`Geschenk von ${String(e.meta.giftGiverName ?? e.meta.giftGiverPlayerId)}`}
          title={`Geschenk von ${String(e.meta.giftGiverName ?? e.meta.giftGiverPlayerId)}`}
        >
          <img
            src={headUrl(typeof e.meta.giftGiverUuid === "string" ? e.meta.giftGiverUuid : undefined, 32, e.meta.giftGiverPlayerId)}
            alt=""
            width={32}
            height={32}
            loading="lazy"
            decoding="async"
          />
        </Link>
      )}
      <Link className="tile__icon" data-tone={meta.tone} href={`/ereignisse?t=${e.type}`} aria-label={meta.label} title={`Nur „${meta.label}“ zeigen`}>
        <IconCmp aria-hidden="true" />
      </Link>
      {badge && <span className="tile__val num">{badge}</span>}
      {info && <span className="tile__info">{info}</span>}
      {BoardIcon && (
        <span className="tile__board" title={e.meta?.label ? String(e.meta.label) : undefined}>
          <BoardIcon aria-hidden="true" />
        </span>
      )}
      {offServer && (
        <span className="tile__flag" title="Nicht auf dem Server">
          ⌂
        </span>
      )}
      {link && (
        <a className="tile__link" href={link.href} target="_blank" rel="noopener" title={link.title} aria-label={link.title}>
          {link.live ? <span className="dot dot--live" /> : <Icon.twitch aria-hidden="true" />}
        </a>
      )}
      <span className="sr-only">{sentence}</span>
    </li>
  );
}

/** Feed: links die Minute, rechts alle Ereignisse dieser Minute als Kacheln. */
export function EventFeed({
  events,
  showPlayer = true,
  empty = "Noch nichts passiert. Der Tracker braucht erst zwei Abfragen, um Unterschiede zu sehen.",
}: {
  events: TrackerEvent[];
  showPlayer?: boolean;
  empty?: string;
}) {
  if (events.length === 0) return <p className="st-online__empty">{empty}</p>;
  const out: React.ReactNode[] = [];
  let lastDay = "";
  let lastMin = "";
  let bucket: TrackerEvent[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    out.push(
      <li key={`m-${first.id}`} className="feed__min">
        <time className="feed__time" dateTime={first.at}>
          {time(first.at)}
        </time>
        <ul className="tiles">
          {bucket.map((e) => (
            <EventTile key={e.id} e={e} showPlayer={showPlayer} />
          ))}
        </ul>
      </li>,
    );
    bucket = [];
  };
  for (const e of events) {
    const d = new Date(e.at);
    const k = dayKey.format(d);
    const m = `${k} ${time(e.at)}`;
    if (m !== lastMin) {
      flush();
      lastMin = m;
    }
    if (k !== lastDay) {
      lastDay = k;
      out.push(
        <li key={`day-${k}`} className="feed__day" aria-hidden="true">
          {dayFmt.format(d)}
        </li>,
      );
    }
    bucket.push(e);
  }
  flush();
  return <ol className="feed">{out}</ol>;
}
