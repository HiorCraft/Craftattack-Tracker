import "server-only";
import { getDb } from "./db";
import { emptyLink, type LinkCounts } from "./connectionWeights";
import { mentionMatcher, titleSeconds } from "./titleMentions";
import { berlinDay, splitByBerlinDay } from "./berlin";
import type { DailyNetwork } from "./dailyNetwork";
import { loadTracker } from "./data";

/** Zeiträume für die Netz-Seiten */
export const NETWORK_RANGES: { key: string; label: string; hours: number | null }[] = [
  { key: "24h", label: "24 Std", hours: 24 },
  { key: "7d", label: "7 Tage", hours: 7 * 24 },
  { key: "alle", label: "Staffel", hours: null },
];

export interface NetworkNode {
  id: string;
  name: string;
  uuid: string;
  online: boolean;
  live: boolean;
}

/** Verbindung zweier Spieler über Twitch: Raids, geteilte Chats, Namen im Stream-Titel und Nachrichten im Chat des anderen. */
export interface ConnectionEdge extends LinkCounts {
  last: string;
}

/** Raids, geteilte Chats und Chat-Nachrichten seit `hours` Stunden (null = gesamte Erfassung), zu Paaren zusammengefasst. */
export async function getConnections(hours: number | null): Promise<ConnectionEdge[]> {
  const db = await getDb();
  const since = hours === null ? new Date(0) : new Date(Date.now() - hours * 3600_000);
  const [raids, chats, messages, streams, players] = await Promise.all([
    db.query<{ src: string; dst: string; n: number; last: Date }>(
      `SELECT player AS src, meta->>'raidTargetPlayerId' AS dst, count(*)::int AS n, max(at) AS last
         FROM events
        WHERE type = 'raid' AND at >= $1 AND player IS NOT NULL AND meta->>'raidTargetPlayerId' IS NOT NULL
        GROUP BY 1, 2`,
      [since],
    ),
    db.query<{ participants: string[]; started_at: Date; last_seen_at: Date; ended_at: Date | null }>(
      `SELECT participants, started_at, last_seen_at, ended_at
         FROM shared_chat_sessions
        WHERE coalesce(ended_at, now()) >= $1 AND cardinality(participants) > 1`,
      [since],
    ),
    // Nur der Kanal, in dem geschrieben wurde; Kopien im geteilten Chat (shared_with) zählen nicht extra
    db.query<{ src: string; dst: string; n: number; last: Date }>(
      `SELECT sender_id AS src, channel_id AS dst, count(*)::int AS n, max(at) AS last
         FROM twitch_chat_messages
        WHERE at >= $1 AND sender_id <> channel_id
        GROUP BY 1, 2`,
      [since],
    ),
    // Titel ab Stream-Start und bei jedem Wechsel; ein Abschnitt vor `since` kann noch hineinreichen (bis 72 Std)
    db.query<{ player: string; at: Date; title: string | null }>(
      `SELECT player, at, CASE WHEN type = 'stream_end' THEN NULL ELSE coalesce(meta->>'title', '') END AS title
         FROM events
        WHERE type IN ('stream_start', 'stream_title', 'stream_end') AND player IS NOT NULL AND at >= $1`,
      [new Date(since.getTime() - 72 * 3600_000)],
    ),
    db.query<{ id: string; name: string; twitch_login: string | null; live: boolean }>(`SELECT id, name, twitch_login, live IS NOT NULL AS live FROM players`),
  ]);

  const pairs = new Map<string, ConnectionEdge>();
  const pair = (x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const key = `${a}|${b}`;
    let e = pairs.get(key);
    if (!e)
      pairs.set(
        key,
        (e = { ...emptyLink(a, b), last: new Date(0).toISOString() }),
      );
    return e;
  };
  const touch = (e: ConnectionEdge, at: Date) => {
    if (at.toISOString() > e.last) e.last = at.toISOString();
  };

  for (const r of raids.rows) {
    if (r.src === r.dst) continue;
    const e = pair(r.src, r.dst);
    if (r.src === e.a) e.raidsAB += r.n;
    else e.raidsBA += r.n;
    touch(e, r.last);
  }
  for (const s of chats.rows) {
    const ids = [...new Set(s.participants)].sort();
    // Bei aus dem Chat erschlossenen Sessions ist last_seen_at der letzte Hinweis; laufende zählen bis jetzt
    const end = s.ended_at ?? new Date();
    const seconds = Math.max(0, Math.round((end.getTime() - Math.max(s.started_at.getTime(), since.getTime())) / 1000));
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const e = pair(ids[i], ids[j]);
        e.chats++;
        e.chatSeconds += seconds;
        if (!s.ended_at) e.now = true;
        touch(e, s.last_seen_at);
      }
  }
  const match = mentionMatcher(players.rows.map((p) => ({ id: p.id, name: p.name, twitchLogin: p.twitch_login })));
  const live = new Set(players.rows.filter((p) => p.live).map((p) => p.id));
  const titles = titleSeconds(
    streams.rows.map((r) => ({ player: r.player, at: r.at.getTime(), title: r.title })),
    match,
    since.getTime(),
    Date.now(),
    live,
  );
  for (const [key, t] of titles) {
    const [src, dst] = key.split("|");
    const e = pair(src, dst);
    if (src === e.a) e.titleAB += t.seconds;
    else e.titleBA += t.seconds;
    touch(e, new Date(t.last));
  }
  for (const m of messages.rows) {
    const e = pair(m.src, m.dst);
    if (m.src === e.a) e.msgsAB += m.n;
    else e.msgsBA += m.n;
    touch(e, m.last);
  }
  return [...pairs.values()];
}

/**
 * Netz für die Seiten: nur erfasste Spieler, an den Browser gehen nur die Zählwerte (gewichtet wird dort).
 * `nodes` enthält alle erfassten Spieler, auch ohne Verbindung (für Suche und „alle Spieler“-Ansichten).
 */
export async function getNetwork(hours: number | null): Promise<{ nodes: NetworkNode[]; edges: LinkCounts[] }> {
  const [{ state }, all] = await Promise.all([loadTracker(), getConnections(hours)]);
  const edges: LinkCounts[] = all
    .filter((e) => state.players[e.a] && state.players[e.b])
    .map((e) => {
      const { last, ...counts } = e;
      void last;
      return counts;
    });
  const nodes = Object.values(state.players).map((p) => ({ id: p.id, name: p.name, uuid: p.uuid, online: p.online, live: Boolean(p.live) }));
  return { nodes, edges };
}

export async function getDailyNetwork(): Promise<{ nodes: NetworkNode[]; daily: DailyNetwork }> {
  const db = await getDb();
  const [{ state }, raids, chats, messages, streams, players] = await Promise.all([
    loadTracker(),
    db.query<{ src: string; dst: string; day: string; n: number }>(
      `SELECT player AS src, meta->>'raidTargetPlayerId' AS dst, to_char(at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM events
        WHERE type = 'raid' AND player IS NOT NULL AND meta->>'raidTargetPlayerId' IS NOT NULL
        GROUP BY 1, 2, 3`,
    ),
    db.query<{ participants: string[]; started_at: Date; ended_at: Date | null }>(
      `SELECT participants, started_at, ended_at FROM shared_chat_sessions WHERE cardinality(participants) > 1`,
    ),
    db.query<{ src: string; dst: string; day: string; n: number }>(
      `SELECT sender_id AS src, channel_id AS dst, to_char(at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS day, count(*)::int AS n
         FROM twitch_chat_messages
        WHERE sender_id <> channel_id
        GROUP BY 1, 2, 3`,
    ),
    db.query<{ player: string; at: Date; title: string | null }>(
      `SELECT player, at, CASE WHEN type = 'stream_end' THEN NULL ELSE coalesce(meta->>'title', '') END AS title
         FROM events
        WHERE type IN ('stream_start', 'stream_title', 'stream_end') AND player IS NOT NULL`,
    ),
    db.query<{ id: string; name: string; twitch_login: string | null; live: boolean }>(`SELECT id, name, twitch_login, live IS NOT NULL AS live FROM players`),
  ]);
  const known = (id: string) => Boolean(state.players[id]);
  // Zeile je Tag und Paar
  const rows = new Map<string, LinkCounts & { day: string }>();
  const row = (day: string, x: string, y: string) => {
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = `${day}|${a}|${b}`;
    return rows.get(k) ?? rows.set(k, { ...emptyLink(a, b), day }).get(k)!;
  };
  for (const r of raids.rows) {
    if (r.src === r.dst || !known(r.src) || !known(r.dst)) continue;
    const e = row(r.day, r.src, r.dst);
    if (r.src === e.a) e.raidsAB += r.n;
    else e.raidsBA += r.n;
  }
  for (const m of messages.rows) {
    if (!known(m.src) || !known(m.dst)) continue;
    const e = row(m.day, m.src, m.dst);
    if (m.src === e.a) e.msgsAB += m.n;
    else e.msgsBA += m.n;
  }
  const nowPairs: [string, string][] = [];
  for (const s of chats.rows) {
    const ids = [...new Set(s.participants)].filter(known).sort();
    const end = (s.ended_at ?? new Date()).getTime();
    const start = s.started_at.getTime();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        row(berlinDay(start), ids[i], ids[j]).chats++;
        splitByBerlinDay(start, end, (day, a, b) => {
          row(day, ids[i], ids[j]).chatSeconds += Math.round((b - a) / 1000);
        });
        if (!s.ended_at) nowPairs.push([ids[i], ids[j]]);
      }
  }
  const match = mentionMatcher(players.rows.map((p) => ({ id: p.id, name: p.name, twitchLogin: p.twitch_login })));
  const live = new Set(players.rows.filter((p) => p.live).map((p) => p.id));
  titleSeconds(
    streams.rows.map((r) => ({ player: r.player, at: r.at.getTime(), title: r.title })),
    match,
    0,
    Date.now(),
    live,
    (key, day, seconds) => {
      const [src, dst] = key.split("|");
      if (!known(src) || !known(dst)) return;
      const e = row(day, src, dst);
      if (src === e.a) e.titleAB += seconds;
      else e.titleBA += seconds;
    },
  );
  const days = [...new Set([...rows.values()].map((r) => r.day))].sort();
  const ids = Object.keys(state.players).sort();
  const dayIx = new Map(days.map((d, i) => [d, i]));
  const idIx = new Map(ids.map((id, i) => [id, i]));
  const daily: DailyNetwork = {
    days,
    ids,
    rows: [...rows.values()].map((r) => [
      dayIx.get(r.day)!,
      idIx.get(r.a)!,
      idIx.get(r.b)!,
      r.raidsAB,
      r.raidsBA,
      r.chats,
      r.chatSeconds,
      Math.round(r.titleAB),
      Math.round(r.titleBA),
      r.msgsAB,
      r.msgsBA,
    ]),
    now: nowPairs.map(([a, b]) => [idIx.get(a)!, idIx.get(b)!]),
  };
  const nodes = Object.values(state.players).map((p) => ({ id: p.id, name: p.name, uuid: p.uuid, online: p.online, live: Boolean(p.live) }));
  return { nodes, daily };
}
