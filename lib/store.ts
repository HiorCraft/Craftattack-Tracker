import "server-only";
import { connection } from "next/server";
import { getDb, type Db } from "./db";
import { playtimeOf } from "./playtime";
import type { BoardKey, PlayerPoint, PlayerState, TotalsPoint, TrackerEvent, TrackerRecords, TrackerState, AfkKind, AfkCheck } from "./types";

const MAX_EVENTS_IN_MEMORY = 20000;
const MAX_HISTORY_POINTS = 2880; // 24 h bei 30 s

type Globals = typeof globalThis & {
  __acTracker?: {
    state: TrackerState | null;
    events: TrackerEvent[];
    loaded: Promise<void> | null;
    /** Anzahl History-Punkte, die bereits in der DB liegen */
    historySaved: number;
  };
};

function g() {
  const gl = globalThis as Globals;
  if (!gl.__acTracker) gl.__acTracker = { state: null, events: [], loaded: null, historySaved: 0 };
  return gl.__acTracker;
}

export function freshState(): TrackerState {
  return {
    startedAt: new Date().toISOString(),
    lastPoll: null,
    lastOk: null,
    lastError: null,
    polls: 0,
    serverOnline: null,
    latest: null,
    players: {},
    history: [],
    eventCount: 0,
    records: { peakOnline: null, peakViewers: null, peakLive: null },
    pendingDeaths: 0,
    pendingSince: null,
    pendingCandidates: [],
  };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

/* ---------- Zeilen ↔ Objekte ---------- */

interface MetaRow {
  started_at: Date;
  last_poll: Date | null;
  last_ok: Date | null;
  last_error: string | null;
  polls: number;
  server_online: boolean | null;
  latest: TrackerState["latest"];
  event_count: number;
  records: TrackerRecords | null;
  pending_deaths: number | null;
  pending_since: Date | null;
  pending_candidates: string[] | null;
}

interface PlayerRow {
  id: string;
  name: string;
  uuid: string;
  online: boolean;
  live: PlayerState["live"];
  stats: PlayerState["stats"];
  ranks: PlayerState["ranks"] | null;
  twitch_login: string | null;
  first_seen: Date;
  last_seen: Date;
  session_start: Date | null;
  tracked_seconds: number;
  sessions: number;
  live_since: Date | null;
  peak_viewers: number;
  longest_session: number;
  peak_viewers_on_server: number | null;
  stream_on_server_seconds: number | null;
  stream_off_server_seconds: number | null;
  last_move_at: Date | null;
  afk_since: Date | null;
  afk_seconds: number | null;
  afk_farm: AfkKind | null;
  afk_mobs_at: number | null;
  afk_blocks_at: number | null;
  afk_check: AfkCheck | null;
  playtime_tracked: number | null;
}

interface EventRow {
  id: string;
  at: Date;
  type: TrackerEvent["type"];
  player: string | null;
  player_name: string | null;
  uuid: string | null;
  where: TrackerEvent["where"];
  delta: number | null;
  value: number | null;
  meta: TrackerEvent["meta"] | null;
}

interface HistoryRow {
  at: Date;
  online_count: number;
  live_count: number;
  viewers: number;
  playtime_seconds: number | string;
  deaths: number;
}

function rowToPlayer(r: PlayerRow): PlayerState {
  return {
    id: r.id,
    name: r.name,
    uuid: r.uuid,
    online: r.online,
    live: r.live,
    stats: r.stats ?? {},
    ranks: r.ranks ?? {},
    twitchLogin: r.twitch_login ?? null,
    firstSeen: iso(r.first_seen)!,
    lastSeen: iso(r.last_seen)!,
    sessionStart: iso(r.session_start),
    trackedSeconds: r.tracked_seconds,
    playtimeTracked: r.playtime_tracked ?? null,
    sessions: r.sessions,
    liveSince: iso(r.live_since),
    peakViewers: r.peak_viewers,
    peakViewersOnServer: r.peak_viewers_on_server ?? 0,
    streamOnServerSeconds: r.stream_on_server_seconds ?? 0,
    streamOffServerSeconds: r.stream_off_server_seconds ?? 0,
    longestSession: r.longest_session ?? 0,
    lastMoveAt: iso(r.last_move_at),
    afkSince: iso(r.afk_since),
    afkSeconds: r.afk_seconds ?? 0,
    afkFarm: r.afk_farm ?? null,
    afkMobsAt: r.afk_mobs_at ?? null,
    afkBlocksAt: r.afk_blocks_at ?? null,
    afkCheck: r.afk_check ?? null,
  };
}

function rowToEvent(r: EventRow): TrackerEvent {
  const e: TrackerEvent = { id: r.id, at: iso(r.at)!, type: r.type, where: r.where };
  if (r.player) e.player = r.player;
  if (r.player_name) e.playerName = r.player_name;
  if (r.uuid) e.uuid = r.uuid;
  if (r.delta !== null) e.delta = Number(r.delta);
  if (r.value !== null) e.value = Number(r.value);
  if (r.meta) e.meta = r.meta;
  return e;
}

function rowToPoint(r: HistoryRow): TotalsPoint {
  return {
    at: iso(r.at)!,
    onlineCount: r.online_count,
    liveCount: r.live_count,
    viewers: r.viewers,
    playtimeSeconds: Number(r.playtime_seconds),
    deaths: r.deaths,
  };
}

/* ---------- Laden ---------- */

async function loadFromDb() {
  const store = g();
  const db = await getDb();

  const meta = (await db.query<MetaRow>(`SELECT * FROM tracker_meta WHERE id = 1`)).rows[0];
  const state = freshState();
  if (meta) {
    state.startedAt = iso(meta.started_at)!;
    state.lastPoll = iso(meta.last_poll);
    state.lastOk = iso(meta.last_ok);
    state.lastError = meta.last_error;
    state.polls = meta.polls;
    state.serverOnline = meta.server_online;
    state.latest = meta.latest;
    state.eventCount = meta.event_count;
    if (meta.records) state.records = { ...state.records, ...meta.records };
    state.pendingDeaths = meta.pending_deaths ?? 0;
    state.pendingSince = iso(meta.pending_since);
    state.pendingCandidates = meta.pending_candidates === null ? null : Array.isArray(meta.pending_candidates) ? meta.pending_candidates : [];
  }

  const players = (await db.query<PlayerRow>(`SELECT * FROM players`)).rows;
  for (const r of players) state.players[r.id] = rowToPlayer(r);

  const hist = (
    await db.query<HistoryRow>(`SELECT * FROM history ORDER BY at DESC LIMIT $1`, [MAX_HISTORY_POINTS])
  ).rows;
  state.history = hist.reverse().map(rowToPoint);
  store.historySaved = state.history.length;

  // Altes Sammel-Ereignis „afk_farm“ (bis 11.10.2026) in die heutigen Start-Ereignisse je Art überführen;
  // das passende Ende trägt der Nachtrag (lib/backfill.ts) aus dem Spielerverlauf nach.
  await db.query(
    `UPDATE events SET type = CASE WHEN meta->>'kind' = 'blocks' THEN 'afk_blocks_start' ELSE 'afk_mobs_start' END
      WHERE type = 'afk_farm'`,
  );

  const events = (
    await db.query<EventRow>(`SELECT * FROM events ORDER BY at DESC, id DESC LIMIT $1`, [MAX_EVENTS_IN_MEMORY])
  ).rows;
  store.events = events.reverse().map(rowToEvent);

  const total = (await db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM events`)).rows[0];
  state.eventCount = Math.max(state.eventCount, Number(total?.n ?? 0));

  store.state = state;
}

export async function ensureLoaded() {
  const store = g();
  if (!store.loaded) store.loaded = loadFromDb();
  await store.loaded;
}

export async function getState(): Promise<TrackerState> {
  await ensureLoaded();
  const state = g().state!;
  // Felder, die nach einem Update neu dazugekommen sind, bei altem In-Memory-Zustand nachziehen
  state.records ??= { peakOnline: null, peakViewers: null, peakLive: null };
  for (const p of Object.values(state.players)) {
    p.longestSession ??= 0;
    p.ranks ??= {};
    p.twitchLogin ??= p.live?.login ?? null;
  }
  return state;
}

export async function getEvents(): Promise<TrackerEvent[]> {
  await ensureLoaded();
  return g().events;
}

/* ---------- Speichern ---------- */

export async function saveState(state: TrackerState) {
  await ensureLoaded();
  const store = g();
  const db = await getDb();

  if (state.history.length > MAX_HISTORY_POINTS) {
    const drop = state.history.length - MAX_HISTORY_POINTS;
    state.history = state.history.slice(drop);
    store.historySaved = Math.max(0, store.historySaved - drop);
  }
  store.state = state;

  await db.query(
    `INSERT INTO tracker_meta (id, started_at, last_poll, last_ok, last_error, polls, server_online, latest, event_count, records, pending_deaths, pending_since, pending_candidates)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       started_at = EXCLUDED.started_at, last_poll = EXCLUDED.last_poll, last_ok = EXCLUDED.last_ok,
       last_error = EXCLUDED.last_error, polls = EXCLUDED.polls, server_online = EXCLUDED.server_online,
       latest = EXCLUDED.latest, event_count = EXCLUDED.event_count, records = EXCLUDED.records,
       pending_deaths = EXCLUDED.pending_deaths, pending_since = EXCLUDED.pending_since, pending_candidates = EXCLUDED.pending_candidates`,
    [
      toDate(state.startedAt),
      toDate(state.lastPoll),
      toDate(state.lastOk),
      state.lastError,
      state.polls,
      state.serverOnline,
      state.latest ? JSON.stringify(state.latest) : null,
      state.eventCount,
      JSON.stringify(state.records),
      state.pendingDeaths ?? 0,
      toDate(state.pendingSince ?? null),
      JSON.stringify(state.pendingCandidates),
    ],
  );

  // Spieler: alle upserten (≈100 Zeilen, ein Statement pro Spieler ist hier völlig ausreichend)
  for (const p of Object.values(state.players)) {
    await db.query(
      `INSERT INTO players (id, name, uuid, online, live, stats, first_seen, last_seen, session_start,
                            tracked_seconds, sessions, live_since, peak_viewers, longest_session, ranks, twitch_login,
                            peak_viewers_on_server, stream_on_server_seconds, stream_off_server_seconds,
                            last_move_at, afk_since, afk_seconds, afk_farm, afk_mobs_at, afk_blocks_at, playtime_tracked, afk_check)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, uuid = EXCLUDED.uuid, online = EXCLUDED.online, live = EXCLUDED.live,
         stats = EXCLUDED.stats, first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen,
         session_start = EXCLUDED.session_start, tracked_seconds = EXCLUDED.tracked_seconds,
         sessions = EXCLUDED.sessions, live_since = EXCLUDED.live_since, peak_viewers = EXCLUDED.peak_viewers,
         longest_session = EXCLUDED.longest_session, ranks = EXCLUDED.ranks,
         twitch_login = EXCLUDED.twitch_login, peak_viewers_on_server = EXCLUDED.peak_viewers_on_server,
         stream_on_server_seconds = EXCLUDED.stream_on_server_seconds, stream_off_server_seconds = EXCLUDED.stream_off_server_seconds,
         last_move_at = EXCLUDED.last_move_at, afk_since = EXCLUDED.afk_since, afk_seconds = EXCLUDED.afk_seconds,
         afk_farm = EXCLUDED.afk_farm, afk_mobs_at = EXCLUDED.afk_mobs_at, afk_blocks_at = EXCLUDED.afk_blocks_at,
         playtime_tracked = EXCLUDED.playtime_tracked, afk_check = EXCLUDED.afk_check`,
      [
        p.id,
        p.name,
        p.uuid,
        p.online,
        p.live ? JSON.stringify(p.live) : null,
        JSON.stringify(p.stats),
        toDate(p.firstSeen),
        toDate(p.lastSeen),
        toDate(p.sessionStart),
        p.trackedSeconds,
        p.sessions,
        toDate(p.liveSince),
        p.peakViewers,
        p.longestSession,
        JSON.stringify(p.ranks ?? {}),
        p.twitchLogin ?? null,
        p.peakViewersOnServer,
        Math.round(p.streamOnServerSeconds),
        Math.round(p.streamOffServerSeconds),
        toDate(p.lastMoveAt ?? null),
        toDate(p.afkSince ?? null),
        Math.round(p.afkSeconds ?? 0),
        p.afkFarm ?? null,
        p.afkMobsAt ?? null,
        p.afkBlocksAt ?? null,
        p.playtimeTracked === null || p.playtimeTracked === undefined ? null : Math.round(p.playtimeTracked),
        p.afkCheck ? JSON.stringify(p.afkCheck) : null,
      ],
    );
  }

  // Verlauf: nur neue Punkte anhängen
  const fresh = state.history.slice(store.historySaved);
  for (const h of fresh) {
    await db.query(
      `INSERT INTO history (at, online_count, live_count, viewers, playtime_seconds, deaths)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (at) DO NOTHING`,
      [toDate(h.at), h.onlineCount, h.liveCount, h.viewers, h.playtimeSeconds, h.deaths],
    );
  }
  store.historySaved = state.history.length;
}

export async function appendEvents(events: TrackerEvent[]) {
  if (events.length === 0) return;
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  store.events.push(...events);
  if (store.events.length > MAX_EVENTS_IN_MEMORY) {
    store.events = store.events.slice(-MAX_EVENTS_IN_MEMORY);
  }
  for (const e of events) await insertEventRow(db, e);
}

/** Fügt ein Ereignis in die DB ein; false, wenn es die ID schon gab. */
async function insertEventRow(db: Db, e: TrackerEvent): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [
      e.id,
      toDate(e.at),
      e.type,
      e.player ?? null,
      e.playerName ?? null,
      e.uuid ?? null,
      e.where,
      e.delta ?? null,
      e.value ?? null,
      e.meta ? JSON.stringify(e.meta) : null,
    ],
  );
  return r.rows.length > 0;
}

/**
 * Trägt rückwirkend erzeugte Ereignisse (Zeitpunkt in der Vergangenheit) ein. Über ihre feste ID sind sie
 * idempotent; neu eingefügte werden im Speicher zeitlich einsortiert. Liefert die Zahl der neuen Ereignisse.
 */
export async function insertPastEvents(events: TrackerEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  let added = 0;
  for (const e of events) {
    if (await insertEventRow(db, e)) {
      added++;
      store.events.push(e);
    }
  }
  if (added > 0) {
    store.events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    if (store.events.length > MAX_EVENTS_IN_MEMORY) store.events = store.events.slice(-MAX_EVENTS_IN_MEMORY);
    if (store.state) store.state.eventCount += added;
  }
  return added;
}

/** Entfernt alle rückwirkend nachgetragenen Ereignisse (meta.backfilled) aus DB und Speicher, z. B. vor einem Neuaufbau. */
export async function deleteBackfilledEvents(): Promise<number> {
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  const gone = (await db.query<{ id: string }>(`DELETE FROM events WHERE meta->>'backfilled' = 'true' RETURNING id`)).rows.length;
  if (gone > 0) {
    store.events = store.events.filter((e) => e.meta?.backfilled !== true);
    if (store.state) store.state.eventCount = Math.max(0, store.state.eventCount - gone);
  }
  return gone;
}

/** Löscht alle Ereignisse der genannten Typen außer den IDs in `keep` – in DB und Speicher. */
export async function deleteEvents(types: string[], keep: string[] = []): Promise<number> {
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  const ids = (
    await db.query<{ id: string }>(`DELETE FROM events WHERE type = ANY($1::text[]) AND NOT (id = ANY($2::text[])) RETURNING id`, [types, keep])
  ).rows.map((r) => r.id);
  if (ids.length > 0) {
    const gone = new Set(ids);
    store.events = store.events.filter((e) => !gone.has(e.id));
    if (store.state) store.state.eventCount = Math.max(0, store.state.eventCount - ids.length);
  }
  return ids.length;
}

/** Ordnet ein bisher spielerloses Ereignis (z. B. unbekannter Tod) nachträglich einem Spieler zu – in DB und Speicher. */
export async function assignEventPlayer(id: string, p: { id: string; name: string; uuid: string }, patch: NonNullable<TrackerEvent["meta"]>) {
  await ensureLoaded();
  const db = await getDb();
  await db.query(
    `UPDATE events SET player = $2, player_name = $3, uuid = $4, value = NULL,
            meta = (COALESCE(meta, '{}'::jsonb) - 'unknown') || $5::jsonb WHERE id = $1`,
    [id, p.id, p.name, p.uuid, JSON.stringify(patch)],
  );
  const e = g().events.find((x) => x.id === id);
  if (e) {
    e.player = p.id;
    e.playerName = p.name;
    e.uuid = p.uuid;
    delete e.value;
    const meta = { ...(e.meta ?? {}), ...patch };
    delete meta.unknown;
    e.meta = meta;
  }
}

/** Ergänzt `meta` eines Ereignisses (im Speicher und in der DB), z. B. um einen VOD-Link. */
export async function updateEventMeta(e: TrackerEvent, patch: NonNullable<TrackerEvent["meta"]>) {
  e.meta = { ...(e.meta ?? {}), ...patch };
  const db = await getDb();
  await db.query(`UPDATE events SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [e.id, JSON.stringify(patch)]);
}

/* ---------- Spieler-Zeitreihe ---------- */

const PLAYER_POINT_MAX_GAP_MS = 5 * 60_000;
const lastPoint = new Map<string, { at: number; sig: string }>();

function pointSignature(p: PlayerPoint) {
  return [p.online, p.viewers, p.playtimeSeconds, p.deaths, p.diamonds, p.blocksBroken, p.mobsKilled, p.distance].join("|");
}

/** Schreibt pro Spieler einen Punkt, wenn sich etwas geändert hat oder der letzte Punkt zu alt ist. */
/**
 * Einen Messpunkt je Spieler anhängen. `fresh` sagt, welche Zähler in dieser Abfrage wirklich geliefert wurden:
 * Strecke, Mobs und Blöcke werden sonst als unbekannt (null) gespeichert, damit eine Datenlücke später nicht
 * wie Stillstand aussieht (AFK-Erkennung).
 */
export async function recordPlayerPoints(players: PlayerState[], at: string, fresh?: Map<string, Set<BoardKey>>) {
  await ensureLoaded();
  const db = await getDb();
  const t = Date.parse(at);
  for (const p of players) {
    const hasData = p.online || p.live || Object.keys(p.stats).length > 0;
    if (!hasData) continue;
    const isFresh = (key: BoardKey) => !fresh || (fresh.get(p.id)?.has(key) ?? false);
    const point: PlayerPoint = {
      at,
      online: p.online,
      viewers: p.live ? p.live.viewers : null,
      // Spielzeit außerhalb der Top 10: letzter API-Wert plus seitdem gemessene Online-Zeit (statt des stehenden Werts)
      playtimeSeconds: p.stats.playtimeSeconds === undefined ? null : isFresh("playtimeSeconds") ? p.stats.playtimeSeconds : Math.round(playtimeOf(p, t).seconds),
      deaths: p.stats.deaths ?? null,
      diamonds: p.stats.diamonds ?? null,
      blocksBroken: isFresh("blocksBroken") ? (p.stats.blocksBroken ?? null) : null,
      mobsKilled: isFresh("mobsKilled") ? (p.stats.mobsKilled ?? null) : null,
      distance: isFresh("distance") ? (p.stats.distance ?? null) : null,
    };
    const sig = pointSignature(point);
    const last = lastPoint.get(p.id);
    if (last && last.sig === sig && t - last.at < PLAYER_POINT_MAX_GAP_MS) continue;
    await db.query(
      `INSERT INTO player_history (player, at, online, viewers, playtime_seconds, deaths, diamonds, blocks_broken, mobs_killed, distance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (player, at) DO NOTHING`,
      [p.id, toDate(at), point.online, point.viewers, point.playtimeSeconds, point.deaths, point.diamonds, point.blocksBroken, point.mobsKilled, point.distance],
    );
    lastPoint.set(p.id, { at: t, sig });
  }
}

interface PlayerPointRow {
  at: Date;
  online: boolean;
  viewers: number | null;
  playtime_seconds: number | null;
  deaths: number | null;
  diamonds: number | null;
  blocks_broken: number | null;
  mobs_killed: number | null;
  distance: number | null;
}

export async function getPlayerHistory(id: string, limit = 3000): Promise<PlayerPoint[]> {
  await ensureLoaded();
  const db = await getDb();
  const rows = (
    await db.query<PlayerPointRow>(`SELECT * FROM player_history WHERE player = $1 ORDER BY at DESC LIMIT $2`, [id, limit])
  ).rows;
  return rows.reverse().map((r) => ({
    at: iso(r.at)!,
    online: r.online,
    viewers: r.viewers,
    playtimeSeconds: r.playtime_seconds,
    deaths: r.deaths,
    diamonds: r.diamonds,
    blocksBroken: r.blocks_broken,
    mobsKilled: r.mobs_killed,
    distance: r.distance === null ? null : Number(r.distance),
  }));
}

/* ---------- Komplette Bestenlisten (alle bekannten Spieler) ---------- */

export interface FullBoardEntry {
  id: string;
  name: string;
  uuid: string;
  value: number;
  /** Zeitpunkt, zu dem der Wert zuletzt in der API zu sehen war */
  at: string;
  online: boolean;
}

const COLUMN: Record<string, string> = {
  playtimeSeconds: "playtime_seconds",
  deaths: "deaths",
  diamonds: "diamonds",
  blocksBroken: "blocks_broken",
  mobsKilled: "mobs_killed",
  distance: "distance",
};

/** Letzter bekannter Wert pro Spieler für ein Board, absteigend sortiert. */
export async function getFullBoard(key: string): Promise<FullBoardEntry[]> {
  const col = COLUMN[key];
  if (!col) return [];
  await ensureLoaded();
  const db = await getDb();
  const rows = (
    await db.query<{ player: string; at: Date; value: number | string }>(
      `SELECT DISTINCT ON (player) player, at, ${col} AS value
         FROM player_history
        WHERE ${col} IS NOT NULL
        ORDER BY player, at DESC`,
    )
  ).rows;
  const players = g().state?.players ?? {};
  return rows
    .map((r) => {
      const p = players[r.player];
      return {
        id: r.player,
        name: p?.name ?? r.player,
        uuid: p?.uuid ?? "",
        value: Number(r.value),
        at: iso(r.at)!,
        online: p?.online ?? false,
      };
    })
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "de"));
}

/* ---------- Sessions aller Spieler (aus Join/Leave-Ereignissen) ---------- */

export interface StoredSession {
  player: string;
  start: string;
  end: string | null;
}

/**
 * Baut aus allen Join/Leave-Ereignissen in der DB die Sessions aller Spieler.
 * Laufende Sessions (Spieler gerade online) haben `end = null`.
 */
export async function getAllSessions(): Promise<StoredSession[]> {
  await ensureLoaded();
  const db = await getDb();
  const rows = (
    await db.query<{ player: string; at: Date; type: string; meta: TrackerEvent["meta"] | null }>(
      `SELECT player, at, type, meta FROM events
        WHERE type IN ('join', 'first_join', 'leave') AND player IS NOT NULL
        ORDER BY at ASC, id ASC`,
    )
  ).rows;
  const open = new Map<string, string>();
  const out: StoredSession[] = [];
  for (const r of rows) {
    const at = iso(r.at)!;
    if (r.type === "leave") {
      const secs = Number(r.meta?.sessionSeconds ?? 0);
      const start = open.get(r.player) ?? new Date(Date.parse(at) - secs * 1000).toISOString();
      out.push({ player: r.player, start, end: at });
      open.delete(r.player);
    } else {
      open.set(r.player, at);
    }
  }
  const players = g().state?.players ?? {};
  for (const [player, start] of open) {
    const p = players[player];
    // Nur wirklich noch laufende Sessions bleiben offen; sonst Ende unbekannt → beim letzten Gesehen-Zeitpunkt
    out.push({ player, start, end: p?.online ? null : (p?.lastSeen ?? start) });
  }
  // Spieler, die beim Tracker-Start schon online waren (kein Join-Ereignis), über sessionStart ergänzen
  for (const p of Object.values(players)) {
    if (p.online && p.sessionStart && !out.some((s) => s.player === p.id && s.end === null)) {
      out.push({ player: p.id, start: p.sessionStart, end: null });
    }
  }
  return out;
}

/* ---------- Statistik-Seite: alle Daten, gebündelt ---------- */

const statsCache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  await connection(); // dynamisch: Date.now() ist hier sonst beim Prerendern verboten
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  statsCache.set(key, { at: Date.now(), value });
  return value;
}

/** Bündelgröße so wählen, dass es höchstens ~`target` Punkte gibt (mindestens `minMinutes`). */
function bucketMinutes(firstAt: Date | null, target: number, minMinutes: number) {
  if (!firstAt) return minMinutes;
  const spanMin = (Date.now() - firstAt.getTime()) / 60_000;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  return steps.find((s) => s >= minMinutes && spanMin / s <= target) ?? 1440;
}

/** Kompletter Server-Verlauf (Online, Live, Zuschauer, Spielzeit, Tode), auf ~1500 Punkte gebündelt (Maximum pro Bündel). */
export async function getHistoryAll(): Promise<{ points: TotalsPoint[]; bucketMinutes: number }> {
  return cached("historyAll", 60_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const first = (await db.query<{ at: Date }>(`SELECT min(at) AS at FROM history`)).rows[0]?.at ?? null;
    const minutes = bucketMinutes(first, 1500, 1);
    const rows = (
      await db.query<HistoryRow>(
        `SELECT to_timestamp(floor(extract(epoch FROM at) / ($1 * 60)) * ($1 * 60)) AS at,
                max(online_count) AS online_count, max(live_count) AS live_count, max(viewers) AS viewers,
                max(playtime_seconds) AS playtime_seconds, max(deaths) AS deaths
           FROM history GROUP BY 1 ORDER BY 1`,
        [minutes],
      )
    ).rows;
    return { points: rows.map(rowToPoint), bucketMinutes: minutes };
  });
}

export interface TotalsSeriesPoint {
  at: string;
  diamonds: number;
  blocksBroken: number;
  mobsKilled: number;
  distance: number;
}

/** Summe aller Spieler je Zähler über die Zeit (letzter Wert je Spieler wird fortgeschrieben). */
export async function getBoardTotalsOverTime(): Promise<{ points: TotalsSeriesPoint[]; bucketMinutes: number }> {
  return cached("boardTotals", 120_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const first = (await db.query<{ at: Date }>(`SELECT min(at) AS at FROM player_history`)).rows[0]?.at ?? null;
    const minutes = bucketMinutes(first, 800, 5);
    const rows = (
      await db.query<{ player: string; bucket: Date; diamonds: number | null; blocks_broken: number | null; mobs_killed: number | null; distance: number | string | null }>(
        `SELECT DISTINCT ON (player, bucket) player, bucket, diamonds, blocks_broken, mobs_killed, distance
           FROM (SELECT player, at, diamonds, blocks_broken, mobs_killed, distance,
                        to_timestamp(floor(extract(epoch FROM at) / ($1 * 60)) * ($1 * 60)) AS bucket
                   FROM player_history
                  WHERE diamonds IS NOT NULL OR blocks_broken IS NOT NULL OR mobs_killed IS NOT NULL OR distance IS NOT NULL) x
          ORDER BY player, bucket, at DESC`,
        [minutes],
      )
    ).rows;
    // Nach Bündel sortieren und je Spieler den letzten Stand fortschreiben
    rows.sort((a, b) => a.bucket.getTime() - b.bucket.getTime());
    const last = new Map<string, TotalsSeriesPoint>();
    const points: TotalsSeriesPoint[] = [];
    let i = 0;
    while (i < rows.length) {
      const t = rows[i].bucket.getTime();
      for (; i < rows.length && rows[i].bucket.getTime() === t; i++) {
        const r = rows[i];
        const prev = last.get(r.player);
        last.set(r.player, {
          at: "",
          diamonds: r.diamonds ?? prev?.diamonds ?? 0,
          blocksBroken: r.blocks_broken ?? prev?.blocksBroken ?? 0,
          mobsKilled: r.mobs_killed ?? prev?.mobsKilled ?? 0,
          distance: r.distance === null ? (prev?.distance ?? 0) : Number(r.distance),
        });
      }
      const sum: TotalsSeriesPoint = { at: new Date(t).toISOString(), diamonds: 0, blocksBroken: 0, mobsKilled: 0, distance: 0 };
      for (const v of last.values()) {
        sum.diamonds += v.diamonds;
        sum.blocksBroken += v.blocksBroken;
        sum.mobsKilled += v.mobsKilled;
        sum.distance += v.distance;
      }
      points.push(sum);
    }
    return { points, bucketMinutes: minutes };
  });
}

export interface DayCount {
  day: string; // YYYY-MM-DD (Europe/Berlin)
  value: number;
}

/** Summe eines Zähler-Ereignistyps pro Tag (z. B. Tode), inkl. Tage ohne Wert = 0. */
export async function getDailyEventSum(type: TrackerEvent["type"]): Promise<DayCount[]> {
  return cached(`daily:${type}`, 60_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const rows = (
      await db.query<{ day: string; value: number | string }>(
        `SELECT to_char(at AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD') AS day, coalesce(sum(delta), 0) AS value
           FROM events WHERE type = $1 GROUP BY 1 ORDER BY 1`,
        [type],
      )
    ).rows;
    return rows.map((r) => ({ day: r.day, value: Number(r.value) }));
  });
}

/** Die größten Einzel-Ereignisse eines Typs (z. B. größter Diamanten-Fund auf einmal). */
export async function getBiggestEvents(type: TrackerEvent["type"], limit = 1): Promise<TrackerEvent[]> {
  return cached(`biggest:${type}:${limit}`, 60_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const rows = (
      await db.query<EventRow>(`SELECT * FROM events WHERE type = $1 AND player IS NOT NULL ORDER BY delta DESC NULLS LAST LIMIT $2`, [type, limit])
    ).rows;
    return rows.map(rowToEvent);
  });
}

/* ---------- Eigener Graph: beliebige Zeitreihen ---------- */

export const SERIES_METRICS = [
  "onlineCount",
  "liveCount",
  "viewers",
  "playtimeSeconds",
  "deaths",
  "diamonds",
  "blocksBroken",
  "mobsKilled",
  "distance",
  "online",
  "afkSeconds",
  "afkMobsSeconds",
  "afkBlocksSeconds",
] as const;
export type SeriesMetric = (typeof SERIES_METRICS)[number];

export interface SeriesLine {
  id: string;
  name: string;
  points: { at: string; v: number }[];
}

export interface SeriesQuery {
  metric: SeriesMetric;
  /** Leer = Server bzw. alle Spieler zusammen */
  players: string[];
  from: number | null;
  to: number | null;
  /** null = automatisch */
  bucketMinutes: number | null;
  /** "wert": Stand zum Zeitpunkt, "zuwachs": Differenz zum vorherigen Bündel */
  mode: "wert" | "zuwachs";
}

const HISTORY_COL: Partial<Record<SeriesMetric, string>> = {
  onlineCount: "online_count",
  liveCount: "live_count",
  viewers: "viewers",
  playtimeSeconds: "playtime_seconds",
  deaths: "deaths",
  online: "online_count",
};
const PLAYER_COL: Partial<Record<SeriesMetric, string>> = {
  viewers: "viewers",
  playtimeSeconds: "playtime_seconds",
  deaths: "deaths",
  diamonds: "diamonds",
  blocksBroken: "blocks_broken",
  mobsKilled: "mobs_killed",
  distance: "distance",
  online: "(CASE WHEN online THEN 1 ELSE 0 END)",
};

function toDelta(points: { at: string; v: number }[]) {
  const out: { at: string; v: number }[] = [];
  for (let i = 1; i < points.length; i++) out.push({ at: points[i].at, v: Math.max(0, points[i].v - points[i - 1].v) });
  return out;
}

/** Zeitreihe(n) für den Graph-Baukasten auf der Statistik-Seite. */
export async function getSeries(q: SeriesQuery): Promise<{ series: SeriesLine[]; bucketMinutes: number }> {
  await ensureLoaded();
  const db = await getDb();
  const players = g().state?.players ?? {};
  const perPlayer = q.players.length > 0 && PLAYER_COL[q.metric] !== undefined;
  const table = perPlayer || HISTORY_COL[q.metric] === undefined ? "player_history" : "history";

  const firstRow = (await db.query<{ at: Date | null }>(`SELECT min(at) AS at FROM ${table}`)).rows[0];
  const firstAt = firstRow?.at ? new Date(firstRow.at) : null;
  const from = new Date(q.from ?? firstAt?.getTime() ?? Date.now());
  const to = new Date(q.to ?? Date.now());
  const minutes = q.bucketMinutes ?? bucketMinutes(from, 600, table === "history" ? 1 : 5);
  const bucket = `to_timestamp(floor(extract(epoch FROM at) / ($1 * 60)) * ($1 * 60))`;
  const finish = (series: SeriesLine[]) => ({
    series: q.mode === "zuwachs" ? series.map((s) => ({ ...s, points: toDelta(s.points) })) : series,
    bucketMinutes: minutes,
  });

  // Server-Verlauf (eine Linie)
  if (table === "history") {
    const col = HISTORY_COL[q.metric]!;
    const rows = (
      await db.query<{ at: Date; v: number | string }>(
        `SELECT ${bucket} AS at, max(${col}) AS v FROM history WHERE at >= $2 AND at <= $3 GROUP BY 1 ORDER BY 1`,
        [minutes, from, to],
      )
    ).rows;
    return finish([{ id: "server", name: "Server", points: rows.map((r) => ({ at: iso(r.at)!, v: Number(r.v) })) }]);
  }

  const col = PLAYER_COL[q.metric]!;

  // Einzelne Spieler (eine Linie je Spieler)
  if (perPlayer) {
    const ph = q.players.map((_, i) => `$${i + 4}`).join(", ");
    const rows = (
      await db.query<{ player: string; at: Date; v: number | string | null }>(
        `SELECT player, ${bucket} AS at, max(${col}) AS v FROM player_history
          WHERE at >= $2 AND at <= $3 AND player IN (${ph}) GROUP BY 1, 2 ORDER BY 1, 2`,
        [minutes, from, to, ...q.players],
      )
    ).rows;
    const byPlayer = new Map<string, SeriesLine>();
    for (const id of q.players) byPlayer.set(id, { id, name: players[id]?.name ?? id, points: [] });
    for (const r of rows) {
      if (r.v === null) continue;
      byPlayer.get(r.player)?.points.push({ at: iso(r.at)!, v: Number(r.v) });
    }
    return finish([...byPlayer.values()]);
  }

  // Alle Spieler zusammen: letzter Stand je Spieler wird fortgeschrieben und summiert
  const rows = (
    await db.query<{ player: string; at: Date; v: number | string | null }>(
      `SELECT player, ${bucket} AS at, max(${col}) AS v FROM player_history
        WHERE at >= $2 AND at <= $3 AND ${col} IS NOT NULL GROUP BY 1, 2 ORDER BY 2, 1`,
      [minutes, from, to],
    )
  ).rows;
  const last = new Map<string, number>();
  const points: { at: string; v: number }[] = [];
  let i = 0;
  while (i < rows.length) {
    const t = rows[i].at.getTime();
    for (; i < rows.length && rows[i].at.getTime() === t; i++) last.set(rows[i].player, Number(rows[i].v));
    let sum = 0;
    for (const v of last.values()) sum += v;
    points.push({ at: new Date(t).toISOString(), v: sum });
  }
  return finish([{ id: "alle", name: "Alle Spieler", points }]);
}
