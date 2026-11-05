import "server-only";
import { getDb } from "./db";
import type { PlayerState } from "./types";

/**
 * Follower-Zuwachs im laufenden Stream: Gesamtzahl jetzt minus Stand beim Start (wie bei Twitch selbst netto, also
 * nach Entfolgungen). Basis ist der vom Tracker beim Start gemerkte Stand; fehlt der (Stream begann vor dieser
 * Erfassung), der letzte Verlaufspunkt bis 30 Min vor dem Start oder der erste bis 15 Min danach.
 */
export async function getStreamFollowerGains(players: PlayerState[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: PlayerState[] = [];
  for (const p of players) {
    if (!p.live || !p.liveSince || p.followers === null) continue;
    if (p.followersLiveAtSample === p.liveSince && p.followersAtLiveStart !== null && p.followersAtLiveStart !== undefined) {
      out.set(p.id, p.followers - p.followersAtLiveStart);
    } else missing.push(p);
  }
  if (!missing.length) return out;
  const db = await getDb();
  const rows = await db.query<{ id: string; base: number | null }>(
    `SELECT w.id, coalesce(
       (SELECT h.followers_total FROM player_history h WHERE h.player = w.id AND h.followers_total IS NOT NULL
          AND h.at <= w.st AND h.at > w.st - interval '30 minutes' ORDER BY h.at DESC LIMIT 1),
       (SELECT h.followers_total FROM player_history h WHERE h.player = w.id AND h.followers_total IS NOT NULL
          AND h.at > w.st AND h.at <= w.st + interval '15 minutes' ORDER BY h.at LIMIT 1)) AS base
     FROM unnest($1::text[], $2::timestamptz[]) AS w(id, st)`,
    [missing.map((p) => p.id), missing.map((p) => new Date(p.liveSince!))],
  );
  const followers = new Map(missing.map((p) => [p.id, p.followers!]));
  for (const r of rows.rows) if (r.base !== null) out.set(r.id, followers.get(r.id)! - r.base);
  return out;
}
