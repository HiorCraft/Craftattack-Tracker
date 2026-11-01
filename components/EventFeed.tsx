import Link from "next/link";
import { BOARD_KEYS, type BoardKey, type EventType, type TrackerEvent } from "@/lib/types";
import { EVENT_META, eventBadge, eventHref, isShownEvent, sharedChatPlayers } from "@/lib/events";
import { time } from "@/lib/format";
import { Head } from "./Head";
import { BOARD_ICON, EVENT_ICON, Icon } from "./Icons";
import { EXTRA_STATS } from "@/lib/playerStats";

const dayFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "Europe/Berlin",
});
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

function combineGiftSubscriptions(events: TrackerEvent[]): TrackerEvent[] {
  const combined: TrackerEvent[] = [];
  const giftIndexes = new Map<string, number>();

  for (const event of events) {
    const giver = event.meta?.giftGiverPlayerId;
    if (event.type !== "subscription_gift" || typeof giver !== "string") {
      combined.push(event);
      continue;
    }

    const key = JSON.stringify([
      event.player,
      event.meta?.channel,
      event.meta?.streamStartedAt,
      giver,
      Math.floor(Date.parse(event.at) / 60_000),
    ]);
    const existingIndex = giftIndexes.get(key);
    if (existingIndex === undefined) {
      giftIndexes.set(key, combined.length);
      combined.push(event);
      continue;
    }

    const existing = combined[existingIndex];
    const delta = (existing.delta ?? 0) + (event.delta ?? 0);
    combined[existingIndex] = {
      ...existing,
      delta,
      value: (existing.value ?? 0) + (event.value ?? event.delta ?? 0),
      meta: { ...existing.meta, giftCount: delta },
    };
  }

  return combined;
}

/** Ereignisse ohne Spieler: das Typ-Icon ersetzt den Kopf */
const SERVER_TYPES = new Set<EventType>(["server_online", "server_offline", "tracker_start", "record"]);

/** Spieler, der den Tod verursacht hat (aus Feed bzw. /api/player); Mobs und Stürze haben keinen */
function killerId(e: TrackerEvent): string | null {
  return e.type === "death" && typeof e.meta?.killerId === "string" && e.meta.killerId ? e.meta.killerId : null;
}

/** Todesnachricht ohne den Namen des Opfers vorn: "fiel aus zu großer Höhe" */
function deathCause(message: string, victim: unknown): string {
  return typeof victim === "string" && message.startsWith(`${victim} `) ? message.slice(victim.length + 1) : message;
}

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
      return killerId(e)
        ? null
        : typeof e.meta?.deathMessage === "string"
          ? deathCause(e.meta.deathMessage, e.meta.victimMinecraft)
          : e.meta?.unknown
          ? "unbekannt"
          : e.meta?.inferred
            ? "zugeordnet"
            : null;
    case "achievement":
      return typeof e.meta?.title === "string" ? e.meta.title : null;
    case "chat":
      return typeof e.meta?.message === "string" ? e.meta.message : null;
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

/**
 * Kompakte Kachel für ein Ereignis. Der volle Satz steht im Tooltip. Überall gleich aufgebaut: Kopf des Handelnden,
 * Pfeil bzw. Schwert zum zweiten Beteiligten, Icon und Wert. Nur der Kopf des Spielers, um den es auf der Seite geht
 * (`focus`), entfällt, wenn er selbst handelt – Beteiligte auf der anderen Seite bleiben immer sichtbar.
 * Ein Klick auf die Kachel zeigt alle Ereignisse dieser Art von diesem Spieler, mit diesem hervorgehoben.
 */
function EventTile({ e, focus, highlight }: { e: TrackerEvent; focus?: string; highlight?: boolean }) {
  const showPlayer = !focus || e.player !== focus;
  const meta = EVENT_META[e.type];
  // Meilensteine eines Zusatzwerts mit dem Icon ihres Werts
  const extraKey = String(e.meta?.board ?? "");
  const IconCmp = Icon[e.type === "milestone" && extraKey in EXTRA_STATS ? (EXTRA_STATS[extraKey as keyof typeof EXTRA_STATS].icon as keyof typeof Icon) : EVENT_ICON[e.type]];
  const sub = meta.sub?.(e);
  const text = meta.text(e);
  const estimated = e.meta?.estimated === true;
  const sentence = [e.player ? `${e.playerName ?? e.player} ${text}` : text, sub, estimated ? "Geschätzt (Datenlücke)" : null].filter(Boolean).join(" · ");
  const badge = e.type === "stream_title" ? null : eventBadge(e);
  const info = detail(e);
  const vod = typeof e.meta?.vodUrl === "string" ? e.meta.vodUrl : null;
  const liveUrl = typeof e.meta?.liveUrl === "string" ? e.meta.liveUrl : null;
  const link = liveUrl ? { href: liveUrl, title: "Läuft gerade – Stream auf Twitch ansehen", live: true } : vod ? { href: vod, title: e.type === "clip" ? "Clip auf Twitch ansehen" : e.type === "death" || e.type === "chat" ? "Diesen Moment im VOD ansehen" : "Aufzeichnung auf Twitch ansehen", live: false } : null;
  const isShared = e.type === "shared_chat_start" || e.type === "shared_chat_end";
  const withHead = Boolean(e.player) && !SERVER_TYPES.has(e.type) && !isShared;
  // Geteilter Chat: Köpfe aller beteiligten Spieler (höchstens vier), auf jeder Seite
  const sharedIds = isShared ? sharedChatPlayers(e) : [];
  const sharedUuids = isShared ? String(e.meta?.sharedChatUuids ?? "").split(",") : [];
  const sharedNames = isShared ? String(e.meta?.sharedChatNames ?? "").split(", ") : [];
  const offServer = e.type === "stream_start" && e.meta?.onServer === false;
  // Rang / Meilenstein: statt des Listennamens nur das Icon der Liste (Name steht im Tooltip)
  const board = (e.type === "rank" || e.type === "milestone") && BOARD_KEYS.includes(e.meta?.board as BoardKey) ? (e.meta!.board as BoardKey) : null;
  const BoardIcon = board ? Icon[BOARD_ICON[board]] : null;
  const killer = killerId(e);
  const killerName = typeof e.meta?.killerName === "string" ? e.meta.killerName : killer;

  return (
    <li className="tile" id={`ev-${e.id}`} data-tone={meta.tone} data-type={e.type} data-highlight={highlight || undefined} title={`${time(e.at)} · ${sentence}`}>
      <Link className="tile__hit" href={eventHref(e)} aria-label={`Alle „${meta.label}“${e.player ? ` von ${e.playerName ?? e.player}` : ""} zeigen`} />
      {withHead && showPlayer ? (
        <Link className="tile__head" href={`/spieler/${encodeURIComponent(e.player!)}`} aria-label={e.playerName ?? e.player}>
          <Head id={e.player!} uuid={e.uuid} name={e.playerName} size={32} className="" decorative />
        </Link>
      ) : null}
      {sharedIds.length > 0 && (
        <span className="tile__heads" aria-label={`Geteilter Chat: ${sharedNames.join(", ")}`}>
          {sharedIds.slice(0, 4).map((pid, i) => (
            <Link key={pid} className="tile__head" href={`/spieler/${encodeURIComponent(pid)}`} aria-label={sharedNames[i] ?? pid}>
              <Head id={pid} uuid={sharedUuids[i] || null} name={sharedNames[i]} size={32} className="" decorative />
            </Link>
          ))}
        </span>
      )}
      {e.type === "subscription_gift" && typeof e.meta?.giftGiverPlayerId === "string" && (
        <Link
          className="tile__head tile__head--gift"
          href={`/spieler/${encodeURIComponent(e.meta.giftGiverPlayerId)}`}
          aria-label={`Geschenk von ${String(e.meta.giftGiverName ?? e.meta.giftGiverPlayerId)}`}
        >
          <Head
            id={e.meta.giftGiverPlayerId}
            uuid={typeof e.meta.giftGiverUuid === "string" ? e.meta.giftGiverUuid : null}
            name={`Geschenk von ${String(e.meta.giftGiverName ?? e.meta.giftGiverPlayerId)}`}
            size={32}
            className=""
            decorative
          />
        </Link>
      )}
      {e.type === "raid" && typeof e.meta?.raidTargetPlayerId === "string" && (
        <span className="tile__raid-arrow" aria-hidden="true">
          <svg viewBox="0 0 16 10" width={12} height={8}>
            <path d="M0 4h11V1l5 4-5 4V6H0z" fill="currentColor" />
          </svg>
        </span>
      )}
      {e.type === "raid" && typeof e.meta?.raidTargetPlayerId === "string" && (
        <Link
          className="tile__head tile__head--raid-target"
          href={`/spieler/${encodeURIComponent(e.meta.raidTargetPlayerId)}`}
          aria-label={`Raid-Ziel: ${String(e.meta.raidTargetName ?? e.meta.raidTargetPlayerId)}`}
        >
          <Head
            id={e.meta.raidTargetPlayerId}
            uuid={typeof e.meta.raidTargetUuid === "string" ? e.meta.raidTargetUuid : null}
            name={`Raid-Ziel: ${String(e.meta.raidTargetName ?? e.meta.raidTargetPlayerId)}`}
            size={32}
            className=""
            decorative
          />
        </Link>
      )}
      {e.type === "chat" && typeof e.meta?.channelId === "string" && (
        <>
          <span className="tile__raid-arrow" aria-hidden="true">
            <svg viewBox="0 0 16 10" width={12} height={8}>
              <path d="M0 4h11V1l5 4-5 4V6H0z" fill="currentColor" />
            </svg>
          </span>
          <Link className="tile__head" href={`/spieler/${encodeURIComponent(e.meta.channelId)}`} aria-label={`Im Chat von ${String(e.meta.channelName ?? e.meta.channelId)}`}>
            <Head
              id={e.meta.channelId}
              uuid={typeof e.meta.channelUuid === "string" ? e.meta.channelUuid : null}
              name={`Im Chat von ${String(e.meta.channelName ?? e.meta.channelId)}`}
              size={32}
              className=""
              decorative
            />
          </Link>
        </>
      )}
      <span className="tile__icon" data-tone={meta.tone} aria-hidden="true">
        <IconCmp />
      </span>
      {badge && <span className="tile__val num">{badge}</span>}
      {estimated && (
        <span className="tile__est" title="Geschätzt (Datenlücke)" aria-label="geschätzt">
          ≈
        </span>
      )}
      {killer && (
        <>
          <span className="tile__raid-arrow tile__killed-by" aria-hidden="true">
            <Icon.sword width={14} height={14} />
          </span>
          <Link className="tile__head tile__head--killer" href={`/spieler/${encodeURIComponent(killer)}`} aria-label={`Getötet von ${killerName}`}>
            <Head id={killer} uuid={typeof e.meta?.killerUuid === "string" ? e.meta.killerUuid : null} name={`Getötet von ${killerName}`} size={32} className="" decorative />
          </Link>
        </>
      )}
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
  focus,
  highlight,
  empty = "Noch nichts passiert. Der Tracker braucht erst zwei Abfragen, um Unterschiede zu sehen.",
  getTimeState,
  isShown = isShownEvent,
}: {
  events: TrackerEvent[];
  /** Spieler, um den es auf der Seite geht: sein eigener Kopf entfällt, wenn er selbst handelt */
  focus?: string;
  /** Hervorgehobenes Ereignis (nach einem Klick auf eine Kachel) */
  highlight?: string;
  empty?: string;
  getTimeState?: (at: string) => { server: boolean; live: boolean; href?: string };
  /** Was im Feed erscheint (Standard: feste Schwellen; Seiten übergeben die Tages-Schwellen, lib/feedThresholds.ts) */
  isShown?: (e: TrackerEvent) => boolean;
}) {
  const shown = events.filter(isShown);
  if (shown.length === 0) return <p className="st-online__empty">{empty}</p>;
  const visibleEvents = combineGiftSubscriptions(shown);
  const out: React.ReactNode[] = [];
  let lastDay = "";
  let lastMin = "";
  let bucket: TrackerEvent[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const timeState = getTimeState?.(first.at);
    const presence = timeState ? (timeState.server && timeState.live ? "both" : timeState.server ? "server" : timeState.live ? "live" : "none") : undefined;
    const timeTitle = timeState
      ? `${timeState.server ? "Auf dem Server" : "Nicht auf dem Server"} · ${timeState.live ? "Live auf Twitch" : "Nicht live"}${timeState.href ? " · Im VOD ansehen" : ""}`
      : undefined;
    out.push(
      <li key={`m-${first.id}`} className="feed__min">
        {timeState?.href ? (
          <a className="feed__time" data-presence={presence} href={timeState.href} target="_blank" rel="noopener noreferrer" title={timeTitle} aria-label={`${time(first.at)} · ${timeTitle}`}>
            {time(first.at)}
          </a>
        ) : (
          <time className="feed__time" data-presence={presence} dateTime={first.at} title={timeTitle}>
            {time(first.at)}
          </time>
        )}
        <ul className="tiles">
          {bucket.map((e) => (
            <EventTile key={e.id} e={e} focus={focus} highlight={e.id === highlight} />
          ))}
        </ul>
      </li>,
    );
    bucket = [];
  };
  for (const e of visibleEvents) {
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
