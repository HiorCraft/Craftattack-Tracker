import "server-only";
import { findVodAt, vodLink } from "@/lib/twitch";
import type { TrackerEvent } from "@/lib/types";
import type { StoredSession } from "@/lib/store";

interface StreamSession {
  start: string;
  end: string | null;
  login: string | null;
}

interface PlayerEventTimeState {
  server: boolean;
  live: boolean;
  href?: string;
}

export async function getPlayerEventTimeState({
  playerEvents,
  displayEvents,
  serverSessions,
  liveSince,
  liveLogin,
  now,
}: {
  playerEvents: TrackerEvent[];
  displayEvents: TrackerEvent[];
  serverSessions: StoredSession[];
  liveSince: string | null;
  liveLogin: string | null;
  now: number;
}): Promise<(at: string) => PlayerEventTimeState> {
  const streams: StreamSession[] = [];
  let open: TrackerEvent | null = null;

  for (const event of playerEvents) {
    if (event.type === "stream_start") {
      open = event;
    } else if (event.type === "stream_end") {
      const seconds = Number(event.meta?.streamSeconds ?? 0);
      const start =
        (typeof event.meta?.startedAt === "string" && event.meta.startedAt) ||
        open?.at ||
        new Date(Date.parse(event.at) - seconds * 1000).toISOString();
      const login =
        (typeof event.meta?.login === "string" && event.meta.login) ||
        (typeof open?.meta?.login === "string" ? open.meta.login : null);
      streams.push({ start, end: event.at, login });
      open = null;
    }
  }

  if (liveSince) streams.push({ start: liveSince, end: null, login: liveLogin });

  const displayTimes = [...new Set(displayEvents.map((event) => event.at))].map(Date.parse);
  const streamsInFeed = streams.flatMap((stream) => {
    const login = stream.login ?? liveLogin;
    if (!login) return [];
    const start = Date.parse(stream.start);
    const end = stream.end ? Date.parse(stream.end) : now;
    const at = displayTimes.find((time) => time >= start && time < end);
    return at === undefined ? [] : [{ stream, login, at }];
  });
  const hits = await Promise.all(
    streamsInFeed.map(async ({ stream, login, at }) => {
      try {
        const hit = await findVodAt(login, at);
        return hit ? { start: stream.start, at, vodId: hit.vodId, offset: hit.offset } : null;
      } catch (err) {
        console.warn("[spieler] VOD-Zeitpunkt konnte nicht ermittelt werden:", err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  const vodHits = new Map<string, { at: number; vodId: string; offset: number }>();
  for (const hit of hits) {
    if (hit) vodHits.set(hit.start, hit);
  }

  return (iso: string) => {
    const at = Date.parse(iso);
    const server = serverSessions.some((session) => at >= Date.parse(session.start) && at < (session.end ? Date.parse(session.end) : now));
    const stream = streams.find((session) => at >= Date.parse(session.start) && at < (session.end ? Date.parse(session.end) : now));
    const hit = stream ? vodHits.get(stream.start) : undefined;
    return {
      server,
      live: Boolean(stream),
      href: hit ? vodLink(hit.vodId, hit.offset + (at - hit.at) / 1000) : undefined,
    };
  };
}
