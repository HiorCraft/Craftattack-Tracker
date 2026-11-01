import "server-only";
import { getDb } from "./db";
import { insertPastEvents } from "./store";
import { helixPage, parseDuration, TWITCH_ENABLED, userId } from "./twitch";
import type { TrackerEvent } from "./types";

/**
 * Twitch-Verlauf aus der offiziellen Helix-API, auch rückwirkend: Archiv-VODs (wann wurde gestreamt, wie lange, mit
 * welchem Titel) und Clips (Momente mit Zeitpunkt, Titel und Aufrufen). Läuft nur im Tracker, alle paar Stunden.
 *
 * Daraus entstehen echte Ereignisse, die der Tracker selbst nicht sehen konnte:
 * - Stream-Beginn und -Ende in Tracker-Lücken und vor dem Tracker-Start (Quelle VOD). Ein Stream-Ende, das der
 *   Tracker erst nach der Lücke bemerkt hat, wird auf das echte Ende laut VOD gesetzt.
 * - Die beliebtesten Clips jedes Kanals (je Tag die CLIPS_PER_DAY meistgesehenen ab CLIP_MIN_VIEWS Aufrufen) als
 *   Ereignis „Clip“ mit Link, über die ganze Staffel. Relativ je Kanal, damit nicht nur große Streamer auftauchen.
 * Ohne VOD (z. B. VODs abgeschaltet oder schon gelöscht) bleibt alles wie bisher.
 */

/** Beginn der Staffel: ältere VODs und Clips sind uninteressant */
const SEASON_START = Date.parse(process.env.CA_SEASON_START ?? "2026-10-10T10:00:00Z");
const SYNC_MS = 3 * 3600_000;
/** Clip-Ereignisse: je Kanal und Tag die meistgesehenen, mindestens so viele Aufrufe */
const CLIPS_PER_DAY = 3;
const CLIP_MIN_VIEWS = Number(process.env.CA_CLIP_MIN_VIEWS ?? 100);
/** Lücke im globalen Verlauf, ab der der Tracker als aus gilt (wie scripts/estimate.mjs) */
const GAP_MS = 4 * 60_000;
/** Aufeinanderfolgende VODs mit so wenig Abstand gelten als ein Stream (Twitch teilt 24/7-Streams nach 48 h) */
const SPLIT_MS = 5 * 60_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface VodRow {
  id: string;
  player: string;
  login: string;
  created_at: Date;
  duration_s: number;
  title: string;
}

/** Alle Archiv-VODs und Clips der Spieler seit Staffelbeginn holen und speichern */
async function fetchHistory(): Promise<{ vods: number; clips: number }> {
  const db = await getDb();
  const players = (await db.query<{ id: string; twitch_login: string }>(`SELECT id, twitch_login FROM players WHERE twitch_login IS NOT NULL AND twitch_login <> ''`)).rows;
  const lastClip = new Map(
    (await db.query<{ player: string; at: Date }>(`SELECT player, max(created_at) AS at FROM twitch_clips GROUP BY player`)).rows.map((r) => [r.player, r.at.getTime()]),
  );
  let vods = 0;
  let clips = 0;
  for (const p of players) {
    const uid = await userId(p.twitch_login).catch(() => null);
    if (!uid) continue;
    // VODs: neueste zuerst, bis vor den Staffelbeginn
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: { data: { id: string; created_at: string; duration: string; title: string; view_count: number }[]; cursor: string | null } = await helixPage<{ id: string; created_at: string; duration: string; title: string; view_count: number }>("videos", {
        user_id: uid,
        type: "archive",
        first: "100",
        ...(cursor ? { after: cursor } : {}),
      });
      const keep = res.data.filter((v) => Date.parse(v.created_at) + parseDuration(v.duration) * 1000 >= SEASON_START);
      for (const v of keep) {
        await db.query(
          `INSERT INTO twitch_vods (id, player, login, created_at, duration_s, title, view_count, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (id) DO UPDATE SET duration_s = EXCLUDED.duration_s, title = EXCLUDED.title, view_count = EXCLUDED.view_count, fetched_at = now()`,
          [v.id, p.id, p.twitch_login.toLowerCase(), new Date(v.created_at), parseDuration(v.duration), v.title, v.view_count],
        );
        vods++;
      }
      cursor = res.cursor;
      if (!cursor || keep.length < res.data.length) break;
      await pause(150);
    }
    // Clips: ab dem letzten bekannten (zwei Tage zurück, Aufrufe ändern sich noch) bzw. ab Staffelbeginn
    const from = Math.max(SEASON_START, (lastClip.get(p.id) ?? 0) - 2 * 86400_000);
    cursor = null;
    for (let page = 0; page < 60; page++) {
      const res: { data: ClipApi[]; cursor: string | null } = await helixPage<ClipApi>("clips", {
        broadcaster_id: uid,
        started_at: new Date(from).toISOString(),
        ended_at: new Date().toISOString(),
        first: "100",
        ...(cursor ? { after: cursor } : {}),
      });
      for (const c of res.data) {
        await db.query(
          `INSERT INTO twitch_clips (id, player, created_at, title, view_count, creator_name, vod_id, vod_offset, duration, url, thumbnail, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (id) DO UPDATE SET view_count = EXCLUDED.view_count, title = EXCLUDED.title, fetched_at = now()`,
          [c.id, p.id, new Date(c.created_at), c.title, c.view_count, c.creator_name || null, c.video_id || null, c.vod_offset ?? null, c.duration, c.url, c.thumbnail_url || null],
        );
        clips++;
      }
      cursor = res.cursor;
      if (!cursor || res.data.length === 0) break;
      await pause(150);
    }
    await pause(150);
  }
  return { vods, clips };
}

interface ClipApi {
  id: string;
  url: string;
  created_at: string;
  title: string;
  view_count: number;
  creator_name: string;
  video_id: string;
  vod_offset: number | null;
  duration: number;
  thumbnail_url: string;
}

/** Zeiträume ohne Tracker: Lücken im globalen Verlauf und alles vor dem ersten Punkt */
async function trackerGaps(): Promise<[number, number][]> {
  const db = await getDb();
  const rows = (
    await db.query<{ a: Date; b: Date }>(
      `SELECT p AS a, at AS b FROM (SELECT at, lag(at) OVER (ORDER BY at) AS p FROM history) h WHERE at - p > make_interval(secs => $1)`,
      [GAP_MS / 1000],
    )
  ).rows.map((r) => [r.a.getTime(), r.b.getTime()] as [number, number]);
  const first = (await db.query<{ at: Date | null }>(`SELECT min(at) AS at FROM history`)).rows[0]?.at;
  return first ? [[SEASON_START - 86400_000, first.getTime()], ...rows] : rows;
}

/** Stream-Beginn/-Ende aus VODs, wo der Tracker nichts gesehen hat */
async function streamEventsFromVods(): Promise<{ added: number; corrected: number }> {
  const db = await getDb();
  const gaps = await trackerGaps();
  const gapOf = (t: number) => gaps.find(([a, b]) => t > a && t < b) ?? null;
  const vods = (await db.query<VodRow>(`SELECT id, player, login, created_at, duration_s, title FROM twitch_vods ORDER BY player, created_at`)).rows;
  const players = new Map((await db.query<{ id: string; name: string; uuid: string }>(`SELECT id, name, uuid FROM players`)).rows.map((p) => [p.id, p]));
  // Zu Streams zusammenfassen
  const sessions: { player: string; login: string; start: number; end: number; first: VodRow; last: VodRow }[] = [];
  for (const v of vods) {
    const start = v.created_at.getTime();
    const end = start + v.duration_s * 1000;
    const prev = sessions[sessions.length - 1];
    if (prev && prev.player === v.player && start - prev.end < SPLIT_MS) {
      prev.end = Math.max(prev.end, end);
      prev.last = v;
    } else sessions.push({ player: v.player, login: v.login, start, end, first: v, last: v });
  }
  const now = Date.now();
  const add: TrackerEvent[] = [];
  let corrected = 0;
  for (const s of sessions) {
    const p = players.get(s.player);
    if (!p || s.end < SEASON_START) continue;
    const near = async (type: string, t: number, ms: number) =>
      (
        await db.query<{ id: string; at: Date; meta: Record<string, unknown> | null }>(
          `SELECT id, at, meta FROM events WHERE player = $1 AND type = $2 AND at BETWEEN $3 AND $4 ORDER BY at`,
          [s.player, type, new Date(t - ms), new Date(t + ms)],
        )
      ).rows;
    const vodUrl = `https://www.twitch.tv/videos/${s.first.id}`;
    const base = { player: s.player, playerName: p.name, uuid: p.uuid, where: "twitch" as const };
    if (gapOf(s.start)) {
      const known = (await near("stream_start", s.start, 30 * 60_000)).some((e) => {
        const st = typeof e.meta?.startedAt === "string" ? Date.parse(e.meta.startedAt) : e.at.getTime();
        return Math.abs(st - s.start) < 10 * 60_000;
      });
      if (!known)
        add.push({
          ...base,
          id: `vod-start-${s.first.id}`,
          at: new Date(s.start).toISOString(),
          type: "stream_start",
          meta: { title: s.first.title, login: s.login, startedAt: new Date(s.start).toISOString(), vodId: s.first.id, vodUrl, source: "vod" },
        });
    }
    const gap = gapOf(s.end);
    // Laufende Streams haben noch kein Ende
    if (gap && s.end < now - 10 * 60_000) {
      const exact = await near("stream_end", s.end, 10 * 60_000);
      if (!exact.length) {
        // Ende erst nach der Lücke bemerkt: Zeitpunkt und Dauer korrigieren
        const late = (await near("stream_end", gap[1], 5 * 60_000)).find((e) => {
          const st = typeof e.meta?.startedAt === "string" ? Date.parse(e.meta.startedAt) : NaN;
          return !Number.isNaN(st) ? Math.abs(st - s.start) < 15 * 60_000 : true;
        });
        const streamSeconds = Math.round((s.end - s.start) / 1000);
        if (late) {
          await db.query(`UPDATE events SET at = $2, meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb WHERE id = $1`, [
            late.id,
            new Date(s.end),
            JSON.stringify({ streamSeconds, vodId: s.last.id, vodUrl: `https://www.twitch.tv/videos/${s.last.id}`, correctedFromVod: true, noticedAt: late.at.toISOString() }),
          ]);
          corrected++;
        } else
          add.push({
            ...base,
            id: `vod-end-${s.last.id}`,
            at: new Date(s.end).toISOString(),
            type: "stream_end",
            meta: { login: s.login, streamSeconds, startedAt: new Date(s.start).toISOString(), vodId: s.last.id, vodUrl: `https://www.twitch.tv/videos/${s.last.id}`, source: "vod" },
          });
      }
    }
  }
  const added = await insertPastEvents(add);
  return { added, corrected };
}

/**
 * Auf dem Server? Der Clip zeigt die Sekunden vor seinem Erstellen: zählt, wenn der Streamer in diesem Moment laut
 * Verlauf online war. Neue Clips und die der letzten zwei Tage (Verlauf kann nachträglich ergänzt werden).
 */
async function markOnServer(): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE twitch_clips c SET on_server = EXISTS (
       SELECT 1 FROM player_history h
        WHERE h.player = c.player AND h.online
          AND h.at BETWEEN c.created_at - make_interval(secs => greatest(c.duration, 30) + 120) AND c.created_at + interval '1 minute')
      WHERE c.on_server IS NULL OR c.created_at > now() - interval '2 days'`,
  );
  // Clip-Ereignisse von Clips abseits des Servers entfernen (auch ältere, vor dieser Regel angelegte)
  await db.query(`DELETE FROM events e USING twitch_clips c WHERE e.type = 'clip' AND e.id = 'clip-' || c.id AND c.on_server IS NOT TRUE`);
}

/** Beliebte Clips als Ereignis (mit Link zum Clip), nur aus der Zeit auf dem Server */
async function clipEvents(): Promise<number> {
  const db = await getDb();
  await markOnServer();
  const rows = (
    await db.query<{ id: string; player: string; created_at: Date; title: string; view_count: number; creator_name: string | null; url: string; name: string; uuid: string; duration: number }>(
      `SELECT * FROM (
         SELECT c.id, c.player, c.created_at, c.title, c.view_count, c.creator_name, c.url, c.duration, p.name, p.uuid,
                row_number() OVER (PARTITION BY c.player, (c.created_at AT TIME ZONE 'Europe/Berlin')::date ORDER BY c.view_count DESC) AS n
           FROM twitch_clips c JOIN players p ON p.id = c.player
          WHERE c.view_count >= $1 AND c.created_at >= $2 AND c.on_server) x
        WHERE n <= $3`,
      [CLIP_MIN_VIEWS, new Date(SEASON_START), CLIPS_PER_DAY],
    )
  ).rows;
  // Aufrufe neu eingetragener Clips wachsen weiter: bestehende Ereignisse nachziehen
  for (const r of rows) await db.query(`UPDATE events SET value = $2 WHERE id = $1 AND value IS DISTINCT FROM $2`, [`clip-${r.id}`, r.view_count]);
  return insertPastEvents(
    rows.map((r) => ({
      id: `clip-${r.id}`,
      at: r.created_at.toISOString(),
      type: "clip",
      player: r.player,
      playerName: r.name,
      uuid: r.uuid,
      where: "twitch",
      value: r.view_count,
      meta: { title: r.title, creatorName: r.creator_name, vodUrl: r.url, clipSeconds: Math.round(r.duration) },
    })),
  );
}

export async function syncTwitchHistory() {
  if (!TWITCH_ENABLED) return;
  const t0 = Date.now();
  const fetched = await fetchHistory();
  const streams = await streamEventsFromVods();
  const clips = await clipEvents();
  console.log(
    `[twitch] Verlauf: ${fetched.vods} VODs, ${fetched.clips} Clips abgeglichen · ${streams.added} Stream-Ereignisse aus VODs, ${streams.corrected} Stream-Enden korrigiert · ${clips} neue Clip-Ereignisse (${Math.round((Date.now() - t0) / 1000)} s)`,
  );
}

export function startTwitchHistorySync() {
  const gl = globalThis as typeof globalThis & { __acTwitchHistory?: boolean };
  if (gl.__acTwitchHistory || !TWITCH_ENABLED) return;
  gl.__acTwitchHistory = true;
  const run = () => void syncTwitchHistory().catch((err: unknown) => console.warn("[twitch] Verlauf-Abgleich fehlgeschlagen:", err instanceof Error ? err.message : err));
  setTimeout(run, 3 * 60_000).unref();
  setInterval(run, SYNC_MS).unref();
}
