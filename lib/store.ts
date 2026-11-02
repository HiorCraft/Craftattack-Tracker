import "server-only";
import { connection } from "next/server";
import { getDb, type Db } from "./db";
import { playtimeOf } from "./playtime";
import { createSwrCache } from "./swrCache";
import { getEarningsSeries } from "./earnings";
import { runsTracker } from "./mode";
import { ESTIMATE } from "./estimateMode";
import { EXTRA_HISTORY_KEYS, EXTRA_KEY_OF_METRIC, EXTRA_METRICS, extraStatSql, type ExtraMetric } from "./playerStats";
import type { BoardKey, DeathFeedItem, FeedItem, PlayerPoint, PlayerState, TotalsPoint, TrackerEvent, TrackerRecords, TrackerState, AfkKind, AfkCheck } from "./types";

const MAX_EVENTS_IN_MEMORY = 20000;
/**
 * Seltene Ereignisarten bleiben unabhängig von MAX_EVENTS_IN_MEMORY für die ganze Staffel im Speicher (zusammen
 * gut 10.000). Sonst verdrängen die häufigen Zähler-Ereignisse (Strecke, Blöcke, Abos …) nach zwei Tagen alle Tode
 * aus der Ereignisliste, und ältere Tode und Streams bekommen keinen VOD-Link mehr.
 */
const KEEP_IN_MEMORY = new Set<TrackerEvent["type"]>([
  "death",
  "raid",
  "achievement",
  "milestone",
  "rank",
  "record",
  "first_join",
  "diamonds",
  "totemsUsed",
  "stream_start",
  "stream_end",
  "shared_chat_start",
  "shared_chat_end",
  "chat",
  "cheer",
  "clip",
  "blocksPlaced",
  "damageTaken",
  "raidsWon",
  "itemsCrafted",
  "itemsEnchanted",
  "tradedWithVillagers",
  "animalsKilled",
  "animalsBred",
  "fishCaught",
  "bellsRung",
  "server_online",
  "server_offline",
  "tracker_start",
]);

/** Kürzt die (chronologisch sortierte) Liste auf die letzten MAX_EVENTS_IN_MEMORY, seltene Arten bleiben alle */
function trimEvents(events: TrackerEvent[]): TrackerEvent[] {
  if (events.length <= MAX_EVENTS_IN_MEMORY) return events;
  const cut = events.length - MAX_EVENTS_IN_MEMORY;
  return events.filter((e, i) => i >= cut || KEEP_IN_MEMORY.has(e.type));
}
const MAX_HISTORY_POINTS = 2880; // 24 h bei 30 s
const MAX_BULK_INSERT_ROWS = 500;
const MIN_VISIBLE_SUBSCRIPTION_COUNT = 10;

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

function freshState(): TrackerState {
  return {
    startedAt: new Date().toISOString(),
    lastPoll: null,
    lastOk: null,
    lastError: null,
    polls: 0,
    serverOnline: null,
    latest: null,
    latestFeed: null,
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

async function insertRows(
  db: Db,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
  returning?: string,
): Promise<{ id: string }[]> {
  const inserted: { id: string }[] = [];
  for (let offset = 0; offset < rows.length; offset += MAX_BULK_INSERT_ROWS) {
    const batch = rows.slice(offset, offset + MAX_BULK_INSERT_ROWS);
    const values = batch
      .map((_, rowIndex) => {
        const placeholders = columns.map((__, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`);
        return `(${placeholders.join(", ")})`;
      })
      .join(", ");
    const result = await db.query<{ id: string }>(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ${conflict}${returning ? ` RETURNING ${returning}` : ""}`,
      batch.flat(),
    );
    inserted.push(...result.rows);
  }
  return inserted;
}

/* ---------- Zeilen ↔ Objekte ---------- */

interface MetaRow {
  started_at: Date;
  last_poll: Date | null;
  last_ok: Date | null;
  last_error: string | null;
  polls: number;
  server_online: boolean | null;
  latest: TrackerState["latest"];
  latest_feed: FeedItem[] | null;
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
  followers: number | null;
  followers_at: Date | null;
  followers_online_at_sample: boolean;
  followers_on_server: number;
  followers_on_live_stream: number;
  followers_live_at_sample: string | null;
  followers_at_live_start: number | null;
  first_seen: Date;
  last_seen: Date;
  session_start: Date | null;
  tracked_seconds: number;
  sessions: number;
  live_since: Date | null;
  peak_viewers: number;
  live_peak_viewers: number;
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
  detail: PlayerState["detail"] | null;
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
  player_count?: number | null;
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
    detail: r.detail ?? null,
    twitchLogin: r.twitch_login ?? null,
    followers: r.followers ?? null,
    followersAt: iso(r.followers_at),
    followersOnlineAtSample: r.followers_online_at_sample,
    followersOnServer: r.followers_on_server,
    followersOnLiveStream: r.followers_on_live_stream,
    followersLiveAtSample: r.followers_live_at_sample,
    followersAtLiveStart: r.followers_at_live_start ?? null,
    firstSeen: iso(r.first_seen)!,
    lastSeen: iso(r.last_seen)!,
    sessionStart: iso(r.session_start),
    trackedSeconds: r.tracked_seconds,
    playtimeTracked: r.playtime_tracked ?? null,
    sessions: r.sessions,
    liveSince: iso(r.live_since),
    peakViewers: r.peak_viewers,
    livePeakViewers: r.live_peak_viewers,
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
    ...(r.player_count === null || r.player_count === undefined ? {} : { playerCount: r.player_count }),
    liveCount: r.live_count,
    viewers: r.viewers,
    playtimeSeconds: Number(r.playtime_seconds),
    deaths: r.deaths,
  };
}

/* ---------- Laden ---------- */

function applyMeta(state: TrackerState, meta: MetaRow) {
  state.startedAt = iso(meta.started_at)!;
  state.lastPoll = iso(meta.last_poll);
  state.lastOk = iso(meta.last_ok);
  state.lastError = meta.last_error;
  state.polls = meta.polls;
  state.serverOnline = meta.server_online;
  state.latest = meta.latest;
  state.latestFeed = Array.isArray(meta.latest_feed) ? meta.latest_feed : null;
  state.eventCount = meta.event_count;
  if (meta.records) state.records = { ...state.records, ...meta.records };
  state.pendingDeaths = meta.pending_deaths ?? 0;
  state.pendingSince = iso(meta.pending_since);
  state.pendingCandidates = Array.isArray(meta.pending_candidates) ? meta.pending_candidates : [];
}

async function loadFromDb() {
  const store = g();
  const db = await getDb();

  const meta = (await db.query<MetaRow>(`SELECT * FROM tracker_meta WHERE id = 1`)).rows[0];
  const state = freshState();
  if (meta) applyMeta(state, meta);

  const players = (await db.query<PlayerRow>(`SELECT * FROM players`)).rows;
  for (const r of players) state.players[r.id] = rowToPlayer(r);

  const hist = (
    await db.query<HistoryRow>(`SELECT * FROM history ORDER BY at DESC LIMIT $1`, [MAX_HISTORY_POINTS])
  ).rows;
  state.history = hist.reverse().map(rowToPoint);
  store.historySaved = state.history.length;

  // Altes Sammel-Ereignis „afk_farm“ (bis 11.10.2026) in die heutigen Start-Ereignisse je Art überführen;
  // das passende Ende trägt der Nachtrag (lib/backfill.ts) aus dem Spielerverlauf nach.
  if (!ESTIMATE) {
    await db.query(
      `UPDATE events SET type = CASE WHEN meta->>'kind' = 'blocks' THEN 'afk_blocks_start' ELSE 'afk_mobs_start' END
        WHERE type = 'afk_farm'`,
    );
  }

  // Die letzten MAX_EVENTS_IN_MEMORY Ereignisse plus alle älteren der seltenen Arten
  const events = (
    await db.query<EventRow>(
      `SELECT * FROM (SELECT * FROM events ORDER BY at DESC, id DESC LIMIT $1) recent
       UNION
       SELECT * FROM events WHERE type = ANY($2)
       ORDER BY at, id`,
      [MAX_EVENTS_IN_MEMORY, [...KEEP_IN_MEMORY]],
    )
  ).rows;
  store.events = events.map(rowToEvent);

  const total = (await db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM events`)).rows[0];
  state.eventCount = Math.max(state.eventCount, Number(total?.n ?? 0));

  store.state = state;
}

export async function ensureLoaded() {
  const store = g();
  if (!store.loaded) {
    // Schlägt das erste Laden fehl (DB nicht erreichbar), beim nächsten Aufruf neu versuchen statt den Fehler zu behalten
    store.loaded = loadFromDb().catch((err: unknown) => {
      store.loaded = null;
      throw err;
    });
    refreshedAt.full = refreshedAt.light = Date.now();
  }
  await store.loaded;
  // Nur Website (TRACKER_MODE=web): Ein anderer Prozess schreibt die Daten. Den Stand im Speicher regelmäßig
  // aus der DB nachziehen; die Anfrage wartet nicht darauf, sie bekommt den aktuellen Stand im Speicher.
  if (!runsTracker()) maybeRefreshFromDb();
}

/* ---------- Nur Website: Stand aus der DB nachziehen ---------- */

/** Leichter Abgleich höchstens so oft (nur bei Anfragen, eine ruhige Seite fragt die DB nicht ab) */
const WEB_REFRESH_MS = 30_000;
/** Vollständiges Neuladen (fängt auch gelöschte oder umgeschriebene ältere Ereignisse) */
const WEB_FULL_RELOAD_MS = 6 * 3600_000;
/** So weit zurück werden Ereignisse beim leichten Abgleich neu gelesen: der Tracker ergänzt Ereignisse nachträglich
 * (VOD-Links, Abo-Minuten, Todesursachen) */
const WEB_EVENT_WINDOW_MS = 2 * 3600_000;
const refreshedAt = { light: 0, full: 0 };
let refreshing: Promise<void> | null = null;

function maybeRefreshFromDb() {
  const now = Date.now();
  if (refreshing || now - refreshedAt.light < WEB_REFRESH_MS) return;
  const full = now - refreshedAt.full >= WEB_FULL_RELOAD_MS;
  refreshing = (full ? reloadAllFromDb() : refreshRecentFromDb())
    .catch((err: unknown) => console.warn("[web] Abgleich mit der DB fehlgeschlagen:", err instanceof Error ? err.message : err))
    .finally(() => {
      refreshedAt.light = Date.now();
      if (full) refreshedAt.full = Date.now();
      refreshing = null;
    });
}

async function reloadAllFromDb() {
  await loadFromDb();
}

async function refreshRecentFromDb() {
  const store = g();
  const state = store.state;
  if (!state) return;
  const db = await getDb();
  const lastHistoryAt = state.history.length ? state.history[state.history.length - 1].at : null;
  const lastEventAt = store.events.length ? Date.parse(store.events[store.events.length - 1].at) : 0;
  const since = new Date(Math.max(0, lastEventAt - WEB_EVENT_WINDOW_MS));
  const [meta, players, hist, events, total] = await Promise.all([
    db.query<MetaRow>(`SELECT * FROM tracker_meta WHERE id = 1`).then((r) => r.rows[0]),
    db.query<PlayerRow>(`SELECT * FROM players`).then((r) => r.rows),
    db.query<HistoryRow>(`SELECT * FROM history WHERE at > $1 ORDER BY at`, [lastHistoryAt ? new Date(lastHistoryAt) : new Date(0)]).then((r) => r.rows),
    db.query<EventRow>(`SELECT * FROM events WHERE at >= $1 ORDER BY at, id`, [since]).then((r) => r.rows),
    db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM events`).then((r) => r.rows[0]),
  ]);
  if (meta) applyMeta(state, meta);
  const nextPlayers: TrackerState["players"] = {};
  for (const r of players) nextPlayers[r.id] = rowToPlayer(r);
  state.players = nextPlayers;
  if (hist.length) {
    state.history = [...state.history, ...hist.map(rowToPoint)].slice(-MAX_HISTORY_POINTS);
    store.historySaved = state.history.length;
  }
  // Ereignisse im Zeitfenster ersetzen (neue und nachträglich geänderte), ältere bleiben
  const cutoff = since.getTime();
  const keep = store.events.filter((e) => Date.parse(e.at) < cutoff);
  store.events = trimEvents([...keep, ...events.map(rowToEvent)]);
  state.eventCount = Math.max(state.eventCount, Number(total?.n ?? 0));
}

export async function getState(): Promise<TrackerState> {
  await ensureLoaded();
  const state = g().state!;
  // Felder, die nach einem Update neu dazugekommen sind, bei altem In-Memory-Zustand nachziehen
  state.records ??= { peakOnline: null, peakViewers: null, peakLive: null };
  for (const p of Object.values(state.players)) {
    p.longestSession ??= 0;
    p.ranks ??= {};
    p.detail ??= null;
    p.twitchLogin ??= p.live?.login ?? null;
    p.followers ??= null;
    p.followersAt ??= null;
    p.followersOnlineAtSample ??= false;
    p.followersOnServer ??= 0;
    p.followersOnLiveStream ??= 0;
    p.followersLiveAtSample ??= null;
    p.followersAtLiveStart ??= null;
    p.livePeakViewers ??= 0;
  }
  return state;
}

export async function getEvents(): Promise<TrackerEvent[]> {
  await ensureLoaded();
  return g().events.filter(
    (event) =>
      event.type === "subscription_gift"
        ? event.meta?.serverOnline === true
        : event.type !== "subscription" ||
          (event.meta?.serverOnline === true && (event.value ?? 0) >= MIN_VISIBLE_SUBSCRIPTION_COUNT),
  );
}

/* ---------- Speichern ---------- */

export async function saveState(state: TrackerState, { savePlayers = true }: { savePlayers?: boolean } = {}) {
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
    `INSERT INTO tracker_meta (id, started_at, last_poll, last_ok, last_error, polls, server_online, latest, latest_feed, event_count, records, pending_deaths, pending_since, pending_candidates)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       started_at = EXCLUDED.started_at, last_poll = EXCLUDED.last_poll, last_ok = EXCLUDED.last_ok,
       last_error = EXCLUDED.last_error, polls = EXCLUDED.polls, server_online = EXCLUDED.server_online,
       latest = EXCLUDED.latest, latest_feed = EXCLUDED.latest_feed, event_count = EXCLUDED.event_count, records = EXCLUDED.records,
       pending_deaths = EXCLUDED.pending_deaths, pending_since = EXCLUDED.pending_since, pending_candidates = EXCLUDED.pending_candidates`,
    [
      toDate(state.startedAt),
      toDate(state.lastPoll),
      toDate(state.lastOk),
      state.lastError,
      state.polls,
      state.serverOnline,
      state.latest ? JSON.stringify(state.latest) : null,
      state.latestFeed === null ? null : JSON.stringify(state.latestFeed),
      state.eventCount,
      JSON.stringify(state.records),
      state.pendingDeaths ?? 0,
      toDate(state.pendingSince ?? null),
      JSON.stringify(state.pendingCandidates ?? []),
    ],
  );

  if (savePlayers) {
    const players = Object.values(state.players);
    await insertRows(
      db,
      "players",
      [
        "id", "name", "uuid", "online", "live", "stats", "first_seen", "last_seen", "session_start",
        "tracked_seconds", "sessions", "live_since", "peak_viewers", "longest_session", "ranks", "twitch_login",
        "peak_viewers_on_server", "stream_on_server_seconds", "stream_off_server_seconds", "last_move_at", "afk_since",
        "afk_seconds", "afk_farm", "afk_mobs_at", "afk_blocks_at", "playtime_tracked", "afk_check", "followers",
        "followers_at", "followers_online_at_sample", "followers_on_server", "followers_on_live_stream",
        "followers_live_at_sample", "followers_at_live_start", "live_peak_viewers", "detail",
      ],
      players.map((p) => [
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
        p.followers,
        toDate(p.followersAt),
        p.followersOnlineAtSample,
        p.followersOnServer,
        p.followersOnLiveStream,
        p.followersLiveAtSample,
        p.followersAtLiveStart ?? null,
        p.livePeakViewers,
        p.detail ? JSON.stringify(p.detail) : null,
      ]),
      `ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, uuid = EXCLUDED.uuid, online = EXCLUDED.online, live = EXCLUDED.live,
       stats = EXCLUDED.stats, first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen,
       session_start = EXCLUDED.session_start, tracked_seconds = EXCLUDED.tracked_seconds,
       sessions = EXCLUDED.sessions, live_since = EXCLUDED.live_since, peak_viewers = EXCLUDED.peak_viewers,
       longest_session = EXCLUDED.longest_session, ranks = EXCLUDED.ranks,
       twitch_login = EXCLUDED.twitch_login, peak_viewers_on_server = EXCLUDED.peak_viewers_on_server,
       stream_on_server_seconds = EXCLUDED.stream_on_server_seconds, stream_off_server_seconds = EXCLUDED.stream_off_server_seconds,
       last_move_at = EXCLUDED.last_move_at, afk_since = EXCLUDED.afk_since, afk_seconds = EXCLUDED.afk_seconds,
       afk_farm = EXCLUDED.afk_farm, afk_mobs_at = EXCLUDED.afk_mobs_at, afk_blocks_at = EXCLUDED.afk_blocks_at,
       playtime_tracked = EXCLUDED.playtime_tracked, afk_check = EXCLUDED.afk_check,
       followers = EXCLUDED.followers, followers_at = EXCLUDED.followers_at,
       followers_online_at_sample = EXCLUDED.followers_online_at_sample, followers_on_server = EXCLUDED.followers_on_server,
       followers_on_live_stream = EXCLUDED.followers_on_live_stream, followers_live_at_sample = EXCLUDED.followers_live_at_sample,
       followers_at_live_start = EXCLUDED.followers_at_live_start, live_peak_viewers = EXCLUDED.live_peak_viewers, detail = EXCLUDED.detail`,
    );
  }

  // Verlauf: nur neue Punkte anhängen
  const fresh = state.history.slice(store.historySaved);
  await insertRows(
    db,
    "history",
    ["at", "online_count", "player_count", "live_count", "viewers", "playtime_seconds", "deaths"],
    fresh.map((h) => [toDate(h.at), h.onlineCount, h.playerCount ?? null, h.liveCount, h.viewers, h.playtimeSeconds, h.deaths]),
    "ON CONFLICT (at) DO NOTHING",
  );
  store.historySaved = state.history.length;
}

/** Speichert Ereignisse; bereits vorhandene IDs werden übersprungen. Liefert die IDs, die neu dazukamen. */
export async function appendEvents(events: TrackerEvent[]): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  const inserted = await insertRows(
    db,
    "events",
    ["id", "at", "type", "player", "player_name", "uuid", `"where"`, "delta", "value", "meta"],
    events.map((e) => [
      e.id, toDate(e.at), e.type, e.player ?? null, e.playerName ?? null, e.uuid ?? null,
      e.where, e.delta ?? null, e.value ?? null, e.meta ? JSON.stringify(e.meta) : null,
    ]),
    "ON CONFLICT (id) DO NOTHING",
    "id",
  );
  const insertedIds = new Set(inserted.map((row) => row.id));
  // Nur wirklich neue Ereignisse in den Speicher, sonst stünden erneut gelieferte Feed-Einträge doppelt darin
  store.events.push(...events.filter((e) => insertedIds.has(e.id)));
  store.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  store.events = trimEvents(store.events);
  return insertedIds;
}

export async function appendFeedItems(items: { id: string; item: FeedItem }[]) {
  if (items.length === 0) return;
  await ensureLoaded();
  const db = await getDb();
  await insertRows(
    db,
    "feed_items",
    ["id", "at", "type", "player", "data"],
    items.map(({ id, item }) => [
      id,
      toDate(item.at),
      item.type,
      item.type === "death" ? item.victim.id : item.player.id,
      JSON.stringify(item),
    ]),
    "ON CONFLICT (id) DO NOTHING",
  );
}

/** Todesnachricht und Mörder aus einem Feed-Eintrag (/api/feed oder `events` von /api/player) */
export function deathFeedMeta(item: DeathFeedItem): Record<string, string | null> {
  return {
    deathMessage: item.message,
    feedAt: item.at,
    victimMinecraft: item.victim.minecraft,
    victimTwitch: item.victim.twitch,
    killerId: item.killer?.id ?? null,
    killerName: item.killer?.name ?? null,
    killerUuid: item.killer?.uuid ?? null,
    killerMinecraft: item.killer?.minecraft ?? null,
    killerTwitch: item.killer?.twitch ?? null,
  };
}

/**
 * Ergänzt vom Tracker gezählte Tode (Zähler-Anstieg, ohne Ursache) um Nachricht und Mörder aus dem Feed:
 * nächstgelegener Tod desselben Spielers, höchstens 2 Min vor bis 15 Min nach dem Feed-Zeitpunkt.
 * Schon ergänzte Tode werden übersprungen, damit derselbe Eintrag bei jedem Poll keinen Schreibzugriff auslöst.
 */
export async function enrichDeathEvents(items: DeathFeedItem[]) {
  if (items.length === 0) return;
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  const victims = new Set(items.map((item) => item.victim.id));
  const deathsOf = new Map<string, TrackerEvent[]>();
  for (const e of store.events) {
    if (e.type !== "death" || !e.player || !victims.has(e.player)) continue;
    (deathsOf.get(e.player) ?? deathsOf.set(e.player, []).get(e.player)!).push(e);
  }
  const usedEventIds = new Set<string>();

  for (const item of items) {
    const candidates = deathsOf.get(item.victim.id) ?? [];
    if (candidates.some((candidate) => candidate.meta?.feedAt === item.at)) continue;
    const feedAt = Date.parse(item.at);
    // Der Zähler steigt erst, wenn die Einzelstatistik neu abgefragt wird (bis zu 15 Min Cache): der vom
    // Tracker gezählte Tod liegt daher meist nach dem echten Zeitpunkt, kaum davor
    const event = candidates
      .filter((candidate) => !usedEventIds.has(candidate.id) && !candidate.meta?.feedAt)
      .map((candidate) => ({ candidate, offset: Date.parse(candidate.at) - feedAt }))
      .filter(({ offset }) => offset >= -2 * 60_000 && offset <= 15 * 60_000)
      .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0]?.candidate;
    if (!event) continue;

    usedEventIds.add(event.id);
    const meta = { ...event.meta, ...deathFeedMeta(item) };
    await db.query(`UPDATE events SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [
      event.id,
      JSON.stringify(meta),
    ]);
    event.meta = meta;
  }
}

/** Speichert ein von einer Live-Quelle geliefertes Ereignis und aktualisiert den Ereigniszähler. */
export async function appendLiveEvent(event: TrackerEvent): Promise<boolean> {
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  if (!(await insertEventRow(db, event))) return false;
  store.events.push(event);
  store.events = trimEvents(store.events);
  if (store.state) store.state.eventCount += 1;
  return true;
}

/** Erhöht das minutenweise Twitch-Abo-Ereignis atomar und aktualisiert den aktuellen Feed-Eintrag. */
export async function incrementLiveSubscriptionEvent(event: TrackerEvent): Promise<void> {
  if (event.type !== "subscription" || !event.value || event.value < 1 || event.meta?.serverOnline !== true) {
    throw new Error("Ungültiges Twitch-Abo-Ereignis.");
  }
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  const result = await db.query<{ value: number; delta: number; inserted: boolean }>(
    `INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       delta = COALESCE(events.delta, 0) + EXCLUDED.delta,
       value = COALESCE(events.value, 0) + EXCLUDED.value
     RETURNING value, delta, (xmax = 0) AS inserted`,
    [
      event.id,
      toDate(event.at),
      event.type,
      event.player ?? null,
      event.playerName ?? null,
      event.uuid ?? null,
      event.where,
      event.value,
      event.meta ? JSON.stringify(event.meta) : null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Twitch-Abo-Ereignis konnte nicht gespeichert werden.");

  const existing = store.events.find((item) => item.id === event.id);
  if (existing) {
    existing.value = Number(row.value);
    existing.delta = Number(row.delta);
  } else {
    event.value = Number(row.value);
    event.delta = Number(row.delta);
    store.events.push(event);
    store.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    store.events = trimEvents(store.events);
  }
  if (row.inserted && store.state) store.state.eventCount += 1;
}

interface TwitchSubscriptionPoint {
  at: string;
  value: number;
}

export interface TwitchChatMessage {
  id: string;
  at: string;
  senderId: string;
  senderName: string;
  channelId: string;
  channelName: string;
  message: string;
  /** Geteilter Chat: weitere Spieler-Kanäle, in denen dieselbe Nachricht erschien */
  sharedWith?: string[];
}

/** Länge, bis zu der eine Chat-Nachricht im Ereignis steht (die volle Nachricht bleibt im Chat-Verlauf) */
const CHAT_EVENT_MAX_LENGTH = 300;

/**
 * Chat-Nachricht eines Spielers im Kanal eines anderen als Ereignis. Die ID hängt an der Nachricht, damit
 * Kopien aus dem geteilten Chat und der Nachtrag beim Start dasselbe Ereignis treffen. `channelLogin` braucht
 * `attachVods`, um die Stelle im VOD des Kanals zu verlinken.
 */
export function chatEvent(message: TwitchChatMessage, players: TrackerState["players"]): TrackerEvent {
  const text = message.message.length > CHAT_EVENT_MAX_LENGTH ? `${message.message.slice(0, CHAT_EVENT_MAX_LENGTH - 1)}…` : message.message;
  return {
    id: `chat-${message.id}`,
    at: message.at,
    type: "chat",
    player: message.senderId,
    playerName: message.senderName,
    uuid: players[message.senderId]?.uuid,
    where: "twitch",
    meta: {
      channelId: message.channelId,
      channelName: message.channelName,
      channelUuid: players[message.channelId]?.uuid ?? null,
      channelLogin: players[message.channelId]?.twitchLogin ?? message.channelId,
      message: text,
    },
  };
}

/** Ereignisse für gespeicherte Chat-Nachrichten, die noch keins haben (einmal beim Start). */
export async function backfillChatEvents(): Promise<number> {
  await ensureLoaded();
  const store = g();
  const db = await getDb();
  const rows = (await db.query<ChatRow>(`SELECT id, at, sender_id, sender_name, channel_id, channel_name, message, shared_with FROM twitch_chat_messages ORDER BY at`)).rows;
  if (rows.length === 0 || !store.state) return 0;
  const inserted = await appendEvents(rows.map((row) => chatEvent(chatFromRow(row), store.state!.players)));
  store.state.eventCount += inserted.size;
  return inserted.size;
}

/**
 * Speichert eine Chat-Nachricht genau einmal. Im geteilten Chat (Stream Together) kommt dieselbe Nachricht in
 * jedem beteiligten Kanal an; alle Kopien haben dieselbe ID. Spätere Kopien ergänzen nur `shared_with`.
 * Liefert `true`, wenn die Nachricht neu war.
 */
export async function saveTwitchChatMessage(message: TwitchChatMessage): Promise<boolean> {
  const db = await getDb();
  const shared = message.sharedWith ?? [];
  const inserted = await db.query(
    `INSERT INTO twitch_chat_messages (id, at, sender_id, sender_name, channel_id, channel_name, message, shared_with)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [message.id, toDate(message.at), message.senderId, message.senderName, message.channelId, message.channelName, message.message, shared.length ? shared : null],
  );
  if (inserted.rows.length === 0) {
    if (shared.length) {
      await db.query(
        `UPDATE twitch_chat_messages
            SET shared_with = ARRAY(SELECT DISTINCT unnest(COALESCE(shared_with, '{}') || $2::text[]))
          WHERE id = $1 AND NOT (COALESCE(shared_with, '{}') @> $2::text[])`,
        [message.id, shared],
      );
    }
    return false;
  }
  return true;
}

type ChatRow = {
  id: string;
  at: Date;
  sender_id: string;
  sender_name: string;
  channel_id: string;
  channel_name: string;
  message: string;
  shared_with: string[] | null;
};
const chatFromRow = (row: ChatRow): TwitchChatMessage => ({
  id: row.id,
  at: iso(row.at)!,
  senderId: row.sender_id,
  senderName: row.sender_name,
  channelId: row.channel_id,
  channelName: row.channel_name,
  message: row.message,
  sharedWith: row.shared_with ?? [],
});

interface ChatPartner {
  id: string;
  name: string;
  count: number;
}

interface PlayerChat {
  /** Nachrichten des Spielers in fremden Chats */
  sent: TwitchChatMessage[];
  /** Nachrichten anderer Spieler im Chat dieses Spielers */
  received: TwitchChatMessage[];
  sentTotal: number;
  receivedTotal: number;
  /** In wessen Chat schreibt der Spieler am meisten? */
  writesIn: ChatPartner[];
  /** Wer schreibt am meisten in seinem Chat? */
  visitors: ChatPartner[];
}

/** Chat eines Spielers fürs Profil: beide Richtungen plus die häufigsten Partner. Nutzt die Indizes auf sender_id/channel_id. */
export async function getPlayerTwitchChat(id: string, limit = 30): Promise<PlayerChat> {
  const db = await getDb();
  const cols = "id, at, sender_id, sender_name, channel_id, channel_name, message, shared_with";
  const [sent, received, writesIn, visitors] = await Promise.all([
    db.query<ChatRow>(`SELECT ${cols} FROM twitch_chat_messages WHERE sender_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, [id, limit]),
    db.query<ChatRow>(`SELECT ${cols} FROM twitch_chat_messages WHERE channel_id = $1 ORDER BY at DESC, id DESC LIMIT $2`, [id, limit]),
    db.query<{ id: string; name: string; count: string }>(
      `SELECT channel_id AS id, max(channel_name) AS name, count(*) AS count FROM twitch_chat_messages
        WHERE sender_id = $1 GROUP BY channel_id ORDER BY count(*) DESC, max(at) DESC`,
      [id],
    ),
    db.query<{ id: string; name: string; count: string }>(
      `SELECT sender_id AS id, max(sender_name) AS name, count(*) AS count FROM twitch_chat_messages
        WHERE channel_id = $1 GROUP BY sender_id ORDER BY count(*) DESC, max(at) DESC`,
      [id],
    ),
  ]);
  const partners = (rows: { id: string; name: string; count: string }[]) => rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) }));
  const w = partners(writesIn.rows);
  const v = partners(visitors.rows);
  return {
    sent: sent.rows.map(chatFromRow),
    received: received.rows.map(chatFromRow),
    sentTotal: w.reduce((sum, p) => sum + p.count, 0),
    receivedTotal: v.reduce((sum, p) => sum + p.count, 0),
    writesIn: w.slice(0, 6),
    visitors: v.slice(0, 6),
  };
}

/* ---------- Top-Listen je Spieler (Verlauf) ---------- */

/** Kompakter Stand: Liste → Item-Key → Anzahl */
export type TopSnapshot = Record<string, Record<string, number>>;
/** Spätestens nach dieser Zeit wird statt einer Änderung wieder ein vollständiger Stand gespeichert (Anker) */
const TOP_FULL_INTERVAL_MS = 60 * 60_000;
/** Letzter gespeicherter Stand je Spieler (vollständig rekonstruiert) und Zeit des letzten Ankers */
const lastTopSnapshot = new Map<string, { fullAt: number; counts: TopSnapshot }>();

/**
 * Speichert die Top-Listen frisch abgefragter (also online) Spieler bei jedem Poll, aber platzsparend:
 * - nur wenn sich etwas geändert hat,
 * - meist nur die geänderten Einträge (`anchor = false`, oft unter 100 Byte),
 * - höchstens stündlich und nach jedem Neustart ein vollständiger Stand als Anker (`anchor = true`, ~1 KB).
 * Ohne Anzeigenamen (die stehen im aktuellen `players.detail`).
 */
export async function recordTopSnapshots(players: PlayerState[], at: string, freshDetail: Set<string>) {
  const t = Date.parse(at);
  const rows: unknown[][] = [];
  const written: { id: string; fullAt: number; counts: TopSnapshot }[] = [];
  for (const p of players) {
    if (!p.detail || !freshDetail.has(p.id)) continue;
    const snapshot: TopSnapshot = {};
    for (const [list, entries] of Object.entries(p.detail.tops)) {
      if (entries.length) snapshot[list] = Object.fromEntries(entries.map((e) => [e.key, e.count]));
    }
    if (Object.keys(snapshot).length === 0) continue;
    const last = lastTopSnapshot.get(p.id);
    const changes: TopSnapshot = {};
    let changed = 0;
    for (const [list, items] of Object.entries(snapshot)) {
      for (const [key, count] of Object.entries(items)) {
        if (last?.counts[list]?.[key] === count) continue;
        (changes[list] ??= {})[key] = count;
        changed += 1;
      }
    }
    if (last && changed === 0) continue;
    const full = !last || t - last.fullAt >= TOP_FULL_INTERVAL_MS;
    rows.push([p.id, toDate(at), JSON.stringify(full ? snapshot : changes), full]);
    // Auch nach einer Änderung bleibt der Gesamtstand bekannt: alte Werte plus Änderungen
    const counts: TopSnapshot = full ? snapshot : { ...last!.counts };
    if (!full) for (const [list, items] of Object.entries(changes)) counts[list] = { ...(counts[list] ?? {}), ...items };
    written.push({ id: p.id, fullAt: full ? t : last!.fullAt, counts });
  }
  if (rows.length === 0) return;
  const db = await getDb();
  await insertRows(db, "player_top_history", ["player", "at", "tops", "anchor"], rows, "ON CONFLICT (player, at) DO NOTHING");
  for (const { id, fullAt, counts } of written) lastTopSnapshot.set(id, { fullAt, counts });
}

/**
 * Stand der Top-Listen aller Spieler zu einem früheren Zeitpunkt: letzter Anker davor plus alle Änderungen bis dahin.
 * Für die ▲▼-Anzeige der Bestenlisten einzelner Blöcke/Mobs und der Vielfalt.
 */
export async function getTopSnapshotsAt(cutoff: Date): Promise<Map<string, TopSnapshot>> {
  const db = await getDb();
  const rows = (
    await db.query<{ player: string; tops: TopSnapshot; anchor: boolean }>(
      `SELECT t.player, t.tops, t.anchor
         FROM player_top_history t
         JOIN (SELECT player, max(at) AS anchor_at FROM player_top_history WHERE anchor AND at <= $1 GROUP BY player) a
           ON a.player = t.player AND t.at >= a.anchor_at
        WHERE t.at <= $1
        ORDER BY t.player, t.at`,
      [cutoff],
    )
  ).rows;
  const out = new Map<string, TopSnapshot>();
  for (const r of rows) {
    const state = out.get(r.player);
    if (r.anchor || !state) {
      out.set(r.player, r.tops);
      continue;
    }
    const merged: TopSnapshot = { ...state };
    for (const [list, items] of Object.entries(r.tops)) merged[list] = { ...(merged[list] ?? {}), ...items };
    out.set(r.player, merged);
  }
  return out;
}

/**
 * Verlauf der Top-Listen eines Spielers über die letzten `hours` Stunden, älteste zuerst.
 * Ab dem letzten Anker vor dem Zeitfenster werden die Änderungen aufaddiert; zurück kommt je
 * `bucketMinutes` der letzte Gesamtstand, damit das Profil nicht tausende Minutenpunkte verarbeiten muss.
 */
export async function getPlayerTopHistory(id: string, hours = 25, bucketMinutes = 30): Promise<{ at: string; tops: TopSnapshot }[]> {
  const db = await getDb();
  const since = new Date(Date.now() - hours * 3600_000);
  const rows = (
    await db.query<{ at: Date; tops: TopSnapshot; anchor: boolean }>(
      `SELECT at, tops, anchor FROM player_top_history
        WHERE player = $1
          AND at >= COALESCE(
                (SELECT max(at) FROM player_top_history WHERE player = $1 AND anchor AND at <= $2),
                (SELECT min(at) FROM player_top_history WHERE player = $1 AND anchor),
                $2)
        ORDER BY at`,
      [id, since],
    )
  ).rows;
  const bucketMs = bucketMinutes * 60_000;
  const out: { at: string; tops: TopSnapshot }[] = [];
  let state: TopSnapshot | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.anchor) state = r.tops;
    else if (state) {
      const merged: TopSnapshot = { ...state };
      for (const [list, items] of Object.entries(r.tops)) merged[list] = { ...(merged[list] ?? {}), ...items };
      state = merged;
    }
    // Änderungen ohne vorherigen Anker lassen sich nicht einordnen
    if (!state) continue;
    const t = new Date(r.at).getTime();
    const next = rows[i + 1] ? new Date(rows[i + 1].at).getTime() : null;
    // Letzter Stand je Bündel (und immer der allerletzte)
    if (next === null || Math.floor(next / bucketMs) !== Math.floor(t / bucketMs)) out.push({ at: iso(r.at)!, tops: state });
  }
  return out;
}

export async function getRecentTwitchChatMessages(limit = 50): Promise<TwitchChatMessage[]> {
  const db = await getDb();
  const rows = await db.query<ChatRow>(
    `SELECT id, at, sender_id, sender_name, channel_id, channel_name, message, shared_with
       FROM twitch_chat_messages ORDER BY at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return rows.rows.map(chatFromRow);
}

/* ---------- Geteilter Chat (Stream Together) ---------- */

export interface SharedChatSession {
  key: string;
  sessionId: string | null;
  /** "api": von Twitch bestätigt, "chat": aus geteilten Nachrichten erschlossen */
  source: "api" | "chat";
  /** Beteiligte erfasste Spieler (IDs) */
  participants: string[];
  /** Weitere beteiligte Kanäle, die keine erfassten Spieler sind */
  otherCount: number;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
}

type SharedRow = { key: string; session_id: string | null; source: string; participants: string[]; other_count: number; started_at: Date; last_seen_at: Date; ended_at: Date | null };
const sharedFromRow = (r: SharedRow): SharedChatSession => ({
  key: r.key,
  sessionId: r.session_id,
  source: r.source === "api" ? "api" : "chat",
  participants: r.participants,
  otherCount: r.other_count,
  startedAt: iso(r.started_at)!,
  lastSeenAt: iso(r.last_seen_at)!,
  endedAt: iso(r.ended_at),
});

export async function saveSharedChatSession(s: SharedChatSession): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO shared_chat_sessions (key, session_id, source, participants, other_count, started_at, last_seen_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (key) DO UPDATE SET participants = EXCLUDED.participants, other_count = EXCLUDED.other_count,
       last_seen_at = EXCLUDED.last_seen_at, ended_at = EXCLUDED.ended_at`,
    [s.key, s.sessionId, s.source, s.participants, s.otherCount, toDate(s.startedAt), toDate(s.lastSeenAt), toDate(s.endedAt)],
  );
}

/** Noch laufende geteilte Chats (für den Neustart des Trackers und die Anzeige) */
export async function getActiveSharedChatSessions(): Promise<SharedChatSession[]> {
  const db = await getDb();
  return (await db.query<SharedRow>(`SELECT * FROM shared_chat_sessions WHERE ended_at IS NULL ORDER BY started_at DESC`)).rows.map(sharedFromRow);
}

/** Geteilte Chats eines Spielers, neueste zuerst */
export async function getPlayerSharedChatSessions(id: string, limit = 20): Promise<SharedChatSession[]> {
  const db = await getDb();
  return (
    await db.query<SharedRow>(`SELECT * FROM shared_chat_sessions WHERE $1 = ANY(participants) ORDER BY started_at DESC LIMIT $2`, [id, limit])
  ).rows.map(sharedFromRow);
}

/* ---------- Cheers (Bits) ---------- */

export interface TwitchCheer {
  id: string;
  at: string;
  /** Spieler, in dessen Kanal gecheert wurde */
  channelId: string;
  fromLogin: string;
  fromName: string;
  bits: number;
  /** Streamer war beim Cheer auf dem Server */
  onServer: boolean;
}

/** Speichert einen Cheer; `false`, wenn es ihn schon gab (gleiche Twitch-Nachrichten-ID). */
export async function saveTwitchCheer(c: TwitchCheer): Promise<boolean> {
  const db = await getDb();
  const r = await db.query(
    `INSERT INTO twitch_cheers (id, at, channel_id, from_login, from_name, bits, on_server)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [c.id, toDate(c.at), c.channelId, c.fromLogin, c.fromName, c.bits, c.onServer],
  );
  return r.rows.length > 0;
}

export interface TwitchSub {
  id: string;
  at: string;
  channelId: string;
  /** Twitch `msg-id`, z. B. sub, resub, subgift, submysterygift */
  kind: string;
  /** 1000, 2000, 3000 oder Prime */
  plan: string | null;
  months: number | null;
  /** Anzahl bei Community-Geschenken */
  giftCount: number | null;
  /** Verbindet ein Community-Geschenk mit seinen Einzelmeldungen */
  giftGroup: string | null;
  fromLogin: string | null;
  onServer: boolean;
}

/** Speichert eine Abo-Meldung einzeln (für die interne Einnahmen-Schätzung). */
export async function saveTwitchSub(s: TwitchSub): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO twitch_subs (id, at, channel_id, kind, plan, months, gift_count, gift_group, from_login, on_server)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
    [s.id, toDate(s.at), s.channelId, s.kind, s.plan, s.months, s.giftCount, s.giftGroup, s.fromLogin, s.onServer],
  );
}

export interface TwitchCheerProfile {
  /** Bits, während der Streamer auf dem Server war */
  onServer: number;
  /** Alle erfassten Bits */
  total: number;
  count: number;
  /** Größter einzelner Cheer auf dem Server */
  biggest: { bits: number; fromName: string; at: string } | null;
  /** Bits auf dem Server über die Zeit (aufsummiert, stündlich) */
  history: { at: string; value: number }[];
  /** Bits im laufenden Stream (ab `streamStartedAt`) */
  currentStream: number;
}

export async function getTwitchCheerProfile(id: string, streamStartedAt: string | null): Promise<TwitchCheerProfile> {
  const db = await getDb();
  const [sum, top] = await Promise.all([
    db.query<{ on_server: string | null; total: string | null; count: number; current: string | null }>(
      `SELECT sum(bits) FILTER (WHERE on_server) AS on_server, sum(bits) AS total, count(*)::int AS count,
              sum(bits) FILTER (WHERE $2::timestamptz IS NOT NULL AND at >= $2) AS current
         FROM twitch_cheers WHERE channel_id = $1`,
      [id, toDate(streamStartedAt)],
    ),
    db.query<{ bits: number; from_name: string; at: Date }>(
      `SELECT bits, from_name, at FROM twitch_cheers WHERE channel_id = $1 AND on_server ORDER BY bits DESC, at LIMIT 1`,
      [id],
    ),
  ]);
  const s = sum.rows[0];
  const t = top.rows[0];
  // Verlauf: Bits auf dem Server, aufsummiert je Stunde
  const hist = (
    await db.query<{ at: Date; v: string }>(
      `SELECT at, SUM(b) OVER (ORDER BY at) AS v FROM (
         SELECT date_trunc('hour', at) AS at, SUM(bits) AS b FROM twitch_cheers WHERE channel_id = $1 AND on_server GROUP BY 1
       ) h ORDER BY at`,
      [id],
    )
  ).rows;
  return {
    onServer: Number(s?.on_server ?? 0),
    total: Number(s?.total ?? 0),
    count: s?.count ?? 0,
    biggest: t ? { bits: t.bits, fromName: t.from_name, at: iso(t.at)! } : null,
    currentStream: Number(s?.current ?? 0),
    history: hist.map((r) => ({ at: iso(r.at)!, value: Number(r.v) })),
  };
}

interface TwitchSubscriptionProfile {
  total: number;
  currentStream: number;
  history: TwitchSubscriptionPoint[];
}

/** Twitch-Abos seit Beginn der Erfassung sowie zeitlicher Verlauf und aktueller Stream. */
export async function getTwitchSubscriptionProfile(
  player: string,
  streamStartedAt: string | null,
): Promise<TwitchSubscriptionProfile> {
  await ensureLoaded();
  const db = await getDb();
  const [buckets, stream] = await Promise.all([
    db.query<{ at: Date; count: number | string }>(
      `SELECT date_trunc('minute', at) AS at, SUM(delta) AS count
         FROM events
        WHERE type IN ('subscription', 'subscription_gift') AND player = $1 AND meta->>'serverOnline' = 'true'
        GROUP BY date_trunc('minute', at)
        ORDER BY date_trunc('minute', at)`,
      [player],
    ),
    streamStartedAt
      ? db.query<{ count: number | string }>(
          `SELECT COALESCE(SUM(delta), 0) AS count
             FROM events
            WHERE type IN ('subscription', 'subscription_gift') AND player = $1 AND at >= $2
              AND meta->>'serverOnline' = 'true'`,
          [player, toDate(streamStartedAt)],
        )
      : Promise.resolve({ rows: [{ count: 0 }] }),
  ]);
  let total = 0;
  const history = buckets.rows.map((row) => {
    total += Number(row.count);
    return { at: iso(row.at)!, value: total };
  });
  return { total, currentStream: Number(stream.rows[0]?.count ?? 0), history };
}

export async function getTwitchSubscriptionBoard(): Promise<FullBoardEntry[]> {
  await ensureLoaded();
  const db = await getDb();
  const rows = await db.query<{
    player: string;
    name: string;
    uuid: string;
    value: number | string;
    at: Date;
  }>(
    `SELECT player, MAX(player_name) AS name, MAX(uuid) AS uuid, SUM(delta) AS value, MAX(at) AS at
       FROM events
      WHERE type IN ('subscription', 'subscription_gift') AND player IS NOT NULL AND meta->>'serverOnline' = 'true'
      GROUP BY player
      HAVING SUM(delta) > 0
      ORDER BY SUM(delta) DESC, MAX(player_name)`,
  );
  return rows.rows.map((row) => ({
    id: row.player,
    name: row.name,
    uuid: row.uuid,
    value: Number(row.value),
    at: iso(row.at)!,
    online: g().state?.players[row.player]?.online ?? false,
  }));
}

interface TwitchSubscriptionMinuteRecord {
  id: string;
  name: string;
  uuid: string;
  value: number;
  at: string;
}

export async function getTwitchSubscriptionMinuteRecord(): Promise<TwitchSubscriptionMinuteRecord | null> {
  await ensureLoaded();
  const db = await getDb();
  const row = (
    await db.query<{ player: string; name: string; uuid: string; value: number | string; at: Date }>(
      `SELECT player, MAX(player_name) AS name, MAX(uuid) AS uuid, SUM(delta) AS value, MAX(at) AS at
         FROM events
        WHERE type IN ('subscription', 'subscription_gift') AND player IS NOT NULL
          AND meta->>'serverOnline' = 'true' AND meta->>'bucket' = 'minute'
        GROUP BY player, meta->>'channel', meta->>'streamStartedAt', date_trunc('minute', at)
        ORDER BY SUM(delta) DESC, MAX(at) ASC
        LIMIT 1`,
    )
  ).rows[0];
  return row
    ? { id: row.player, name: row.name, uuid: row.uuid, value: Number(row.value), at: iso(row.at)! }
    : null;
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
  const inserted = await insertRows(
    db,
    "events",
    ["id", "at", "type", "player", "player_name", "uuid", `"where"`, "delta", "value", "meta"],
    events.map((e) => [
      e.id, toDate(e.at), e.type, e.player ?? null, e.playerName ?? null, e.uuid ?? null,
      e.where, e.delta ?? null, e.value ?? null, e.meta ? JSON.stringify(e.meta) : null,
    ]),
    "ON CONFLICT (id) DO NOTHING",
    "id",
  );
  const addedById = new Map(events.map((event) => [event.id, event]));
  const addedEvents = inserted.flatMap(({ id }) => {
    const event = addedById.get(id);
    return event ? [event] : [];
  });
  const added = addedEvents.length;
  store.events.push(...addedEvents);
  if (added > 0) {
    store.events.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    store.events = trimEvents(store.events);
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
  // Schätzung liest nur Sichten; der Link bleibt dort nur im Speicher
  if (ESTIMATE) return;
  const db = await getDb();
  await db.query(`UPDATE events SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [e.id, JSON.stringify(patch)]);
}

/* ---------- Spieler-Zeitreihe ---------- */

const PLAYER_POINT_MAX_GAP_MS = 5 * 60_000;
/** Zusatzwerte landen höchstens so oft im Verlauf (Speicherplatz); für Graph und Rang-Verlauf reicht das */
const EXTRA_HISTORY_INTERVAL_MS = 5 * 60_000;
const lastPoint = new Map<string, { at: number; sig: string }>();
const lastExtraAt = new Map<string, number>();

function pointSignature(p: PlayerPoint) {
  return [
    p.online,
    p.viewers,
    p.playtimeSeconds,
    p.deaths,
    p.diamonds,
    p.blocksBroken,
    p.mobsKilled,
    p.distance,
    p.damageDealt,
    p.totemsUsed,
    p.foodEaten,
    p.followersOnServer,
    p.followersTotal,
    p.streamGameId,
    p.streamGameName,
    JSON.stringify(p.extra ?? {}),
  ].join("|");
}

/** Schreibt pro Spieler einen Punkt, wenn sich etwas geändert hat oder der letzte Punkt zu alt ist. */
/**
 * Einen Messpunkt je Spieler anhängen. `fresh` sagt, welche Zähler in dieser Abfrage wirklich geliefert wurden.
 * Zähler ohne frische Daten werden als unbekannt (null) gespeichert, damit eine Datenlücke nicht wie Stillstand aussieht.
 * `freshDetail` enthält die Spieler, deren Zusatzwerte (/api/player) in dieser Abfrage frisch kamen.
 */
export async function recordPlayerPoints(players: PlayerState[], at: string, fresh?: Map<string, Set<BoardKey>>, freshDetail?: Set<string>) {
  await ensureLoaded();
  const db = await getDb();
  const t = Date.parse(at);
  const rows: unknown[][] = [];
  const signatures: { id: string; sig: string }[] = [];
  for (const p of players) {
    const hasData = p.online || p.live || p.followersAt !== null || Object.keys(p.stats).length > 0;
    if (!hasData) continue;
    const isFresh = (key: BoardKey) => !fresh || (fresh.get(p.id)?.has(key) ?? false);
    // Zusatzwerte nur aus frischer Abfrage und höchstens alle 5 Minuten, als integer[] in fester Reihenfolge
    let extraStats: (number | null)[] | null = null;
    const extra: Record<string, number> = {};
    if (p.detail && (!freshDetail || freshDetail.has(p.id)) && t - (lastExtraAt.get(p.id) ?? 0) >= EXTRA_HISTORY_INTERVAL_MS) {
      extraStats = EXTRA_HISTORY_KEYS.map((key) => {
        const v = p.detail!.stats[key];
        if (typeof v !== "number" || !Number.isFinite(v)) return null;
        extra[key] = v;
        return Math.max(-2147483648, Math.min(2147483647, Math.round(v)));
      });
      if (extraStats.every((v) => v === null)) extraStats = null;
    }
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
      damageDealt: isFresh("damageDealt") ? (p.stats.damageDealt ?? null) : null,
      totemsUsed: isFresh("totemsUsed") ? (p.stats.totemsUsed ?? null) : null,
      foodEaten: isFresh("foodEaten") ? (p.stats.foodEaten ?? null) : null,
      followersOnServer: p.followersAt ? p.followersOnServer : null,
      followersTotal: p.followers,
      ranks: p.ranks ?? {},
      streamGameId: p.live?.gameId ?? null,
      streamGameName: p.live?.gameName ?? null,
      extra,
    };
    const sig = pointSignature(point);
    const last = lastPoint.get(p.id);
    // Weder auf dem Server noch live: nichts kann sich ändern. Nur der Wechsel (z. B. der Leave) wird gespeichert,
    // keine Auffrischung alle 5 Minuten; nach einem Neustart gar nichts, der letzte Stand liegt schon in der DB.
    // Ausnahme: frisch abgefragte Offline-Spieler (einmalig nachgeholt) bekommen ihren ersten Punkt.
    if (!p.online && !p.live && (last ? last.sig === sig : !freshDetail?.has(p.id))) continue;
    if (last && last.sig === sig && t - last.at < PLAYER_POINT_MAX_GAP_MS) continue;
    rows.push([
        p.id,
        toDate(at),
        point.online,
        point.viewers,
        point.playtimeSeconds,
        point.deaths,
        point.diamonds,
        point.blocksBroken,
        point.mobsKilled,
        point.distance,
        point.damageDealt,
        point.totemsUsed,
        point.foodEaten,
        point.followersOnServer,
        point.followersTotal,
        // Ränge werden nicht mehr je Messpunkt gespeichert: niemand liest sie, der Rang-Verlauf wird aus den
        // Werten berechnet. Das spart gut 400 Byte pro Zeile; alte Zeilen behalten ihre Werte.
        null,
        point.streamGameId,
        point.streamGameName,
        extraStats,
    ]);
    signatures.push({ id: p.id, sig });
    if (extraStats) lastExtraAt.set(p.id, t);
  }
  await insertRows(
    db,
    "player_history",
    [
      "player", "at", "online", "viewers", "playtime_seconds", "deaths", "diamonds", "blocks_broken",
      "mobs_killed", "distance", "damage_dealt", "totems_used", "food_eaten", "followers_on_server", "followers_total", "ranks", "stream_game_id", "stream_game_name", "extra_stats",
    ],
    rows,
    "ON CONFLICT (player, at) DO NOTHING",
  );
  for (const { id, sig } of signatures) lastPoint.set(id, { at: t, sig });
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
  damage_dealt: number | string | null;
  totems_used: number | null;
  food_eaten: number | null;
  followers_on_server: number | null;
  followers_total?: number | null;
  ranks?: PlayerPoint["ranks"] | null;
  stream_game_id?: string | null;
  stream_game_name?: string | null;
  extra_stats?: (number | null)[] | null;
}

/** integer[] aus `player_history.extra_stats` → {key: wert} */
function decodeExtraStats(values: (number | null)[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!values) return out;
  EXTRA_HISTORY_KEYS.forEach((key, i) => {
    const v = values[i];
    if (v !== null && v !== undefined) out[key] = Number(v);
  });
  return out;
}

export async function getPlayerHistory(id: string, limit = 3000): Promise<PlayerPoint[]> {
  return cached(`playerHistory:${id}:${limit}`, 30000, async () => {
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
      damageDealt: r.damage_dealt === null ? null : Number(r.damage_dealt),
      totemsUsed: r.totems_used,
      foodEaten: r.food_eaten,
      followersOnServer: r.followers_on_server,
      followersTotal: r.followers_total ?? null,
      ranks: r.ranks ?? {},
      streamGameId: r.stream_game_id ?? null,
      streamGameName: r.stream_game_name ?? null,
      extra: decodeExtraStats(r.extra_stats),
    }));
  });
}

/* ---------- Komplette Bestenlisten (alle bekannten Spieler) ---------- */

interface FullBoardEntry {
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
  damageDealt: "damage_dealt",
  totemsUsed: "totems_used",
  foodEaten: "food_eaten",
  followers: "followers_on_server",
};

/** Letzter bekannter Wert pro Spieler für ein Board, absteigend sortiert. */
export async function getFullBoard(key: string): Promise<FullBoardEntry[]> {
  return cached(`fullBoard:${key}`, 60000, async () => {
    const col = COLUMN[key];
    if (!col) return [];
    await ensureLoaded();
    const db = await getDb();
    const rows = (
      await db.query<{ player: string; at: Date; value: number | string }>(
        // Je Spieler der letzte Wert über den Index (player, at), statt den ganzen Verlauf zu sortieren (~30× schneller)
        `SELECT p.id AS player, h.at, h.value
           FROM players p
           CROSS JOIN LATERAL (
             SELECT at, ${col} AS value FROM player_history
              WHERE player = p.id AND ${col} IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) h`,
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
  });
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
/** Sessions aller Spieler direkt aus der DB (ohne Zwischenspeicher, auch außerhalb von Anfragen nutzbar). */
export async function loadAllSessions(): Promise<StoredSession[]> {
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

/** Sessions aller Spieler für Seiten: 60 s zwischengespeichert, gleichzeitige Aufrufe teilen sich die Abfrage. */
export async function getAllSessions(): Promise<StoredSession[]> {
  return cached("allSessions", 60_000, loadAllSessions);
}

/* ---------- Statistik-Seite: alle Daten, gebündelt ---------- */

const statsSwr = createSwrCache();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  await connection(); // dynamisch: Date.now() ist hier sonst beim Prerendern verboten
  return statsSwr(key, ttlMs, load);
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
                max(online_count) AS online_count, max(player_count) AS player_count,
                max(live_count) AS live_count, max(viewers) AS viewers,
                max(playtime_seconds) AS playtime_seconds, max(deaths) AS deaths
           FROM history GROUP BY 1 ORDER BY 1`,
        [minutes],
      )
    ).rows;
    return { points: rows.map(rowToPoint), bucketMinutes: minutes };
  });
}

interface TotalsSeriesPoint {
  at: string;
  diamonds: number;
  blocksBroken: number;
  mobsKilled: number;
  distance: number;
  damageDealt: number;
  totemsUsed: number;
  foodEaten: number;
}

/** Summe aller Spieler je Zähler über die Zeit (letzter Wert je Spieler wird fortgeschrieben). */
export async function getBoardTotalsOverTime(): Promise<{ points: TotalsSeriesPoint[]; bucketMinutes: number }> {
  return cached("boardTotals", 120_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const first = (await db.query<{ at: Date }>(`SELECT min(at) AS at FROM player_history`)).rows[0]?.at ?? null;
    const minutes = bucketMinutes(first, 800, 5);
    const rows = (
      await db.query<{ player: string; bucket: Date; diamonds: number | null; blocks_broken: number | null; mobs_killed: number | null; distance: number | string | null; damage_dealt: number | string | null; totems_used: number | null; food_eaten: number | null }>(
        `SELECT DISTINCT ON (player, bucket) player, bucket, diamonds, blocks_broken, mobs_killed, distance, damage_dealt, totems_used, food_eaten
           FROM (SELECT player, at, diamonds, blocks_broken, mobs_killed, distance, damage_dealt, totems_used, food_eaten,
                        to_timestamp(floor(extract(epoch FROM at) / ($1 * 60)) * ($1 * 60)) AS bucket
                   FROM player_history
                  WHERE diamonds IS NOT NULL OR blocks_broken IS NOT NULL OR mobs_killed IS NOT NULL OR distance IS NOT NULL
                     OR damage_dealt IS NOT NULL OR totems_used IS NOT NULL OR food_eaten IS NOT NULL) x
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
          damageDealt: r.damage_dealt === null ? (prev?.damageDealt ?? 0) : Number(r.damage_dealt),
          totemsUsed: r.totems_used ?? prev?.totemsUsed ?? 0,
          foodEaten: r.food_eaten ?? prev?.foodEaten ?? 0,
        });
      }
      const sum: TotalsSeriesPoint = { at: new Date(t).toISOString(), diamonds: 0, blocksBroken: 0, mobsKilled: 0, distance: 0, damageDealt: 0, totemsUsed: 0, foodEaten: 0 };
      for (const v of last.values()) {
        sum.diamonds += v.diamonds;
        sum.blocksBroken += v.blocksBroken;
        sum.mobsKilled += v.mobsKilled;
        sum.distance += v.distance;
        sum.damageDealt += v.damageDealt;
        sum.totemsUsed += v.totemsUsed;
        sum.foodEaten += v.foodEaten;
      }
      points.push(sum);
    }
    return { points, bucketMinutes: minutes };
  });
}

interface DayCount {
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

const BASE_SERIES_METRICS = [
  "onlineCount",
  "liveCount",
  "viewers",
  "playtimeSeconds",
  "deaths",
  "diamonds",
  "blocksBroken",
  "mobsKilled",
  "distance",
  "damageDealt",
  "totemsUsed",
  "foodEaten",
  "followers",
  "twitchSubs",
  "twitchBits",
  "twitchEarnings",
  "online",
  "afkSeconds",
  "afkMobsSeconds",
  "afkBlocksSeconds",
] as const;
export type SeriesMetric = (typeof BASE_SERIES_METRICS)[number] | ExtraMetric;
export const SERIES_METRICS: readonly SeriesMetric[] = [...BASE_SERIES_METRICS, ...EXTRA_METRICS];

interface SeriesLine {
  id: string;
  name: string;
  points: { at: string; v: number }[];
}

interface SeriesQuery {
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
  damageDealt: "damage_dealt",
  totemsUsed: "totems_used",
  foodEaten: "food_eaten",
  followers: "followers_on_server",
  online: "(CASE WHEN online THEN 1 ELSE 0 END)",
  // Zusatzwerte: Keys stammen aus der festen Liste in lib/playerStats.ts, nie aus der Anfrage
  ...Object.fromEntries(EXTRA_METRICS.map((m) => [m, extraStatSql(EXTRA_KEY_OF_METRIC[m])])),
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
  const twitch = q.metric === "twitchSubs" || q.metric === "twitchBits" || q.metric === "twitchEarnings";
  const perPlayer = q.players.length > 0 && (PLAYER_COL[q.metric] !== undefined || twitch);
  const table = q.metric === "twitchBits" ? "twitch_cheers" : twitch ? "events" : perPlayer || HISTORY_COL[q.metric] === undefined ? "player_history" : "history";

  const firstRow = (await db.query<{ at: Date | null }>(
    q.metric === "twitchBits"
      ? `SELECT min(at) AS at FROM twitch_cheers WHERE on_server`
      : twitch
        ? `SELECT min(at) AS at FROM events WHERE type IN ('subscription', 'subscription_gift') AND meta->>'serverOnline' = 'true'`
        : `SELECT min(at) AS at FROM ${table}`,
  )).rows[0];
  const firstAt = firstRow?.at ? new Date(firstRow.at) : null;
  const from = new Date(q.from ?? firstAt?.getTime() ?? Date.now());
  const to = new Date(q.to ?? Date.now());
  const minutes = q.bucketMinutes ?? bucketMinutes(from, 600, table === "history" ? 1 : 5);
  const bucket = `to_timestamp(floor(extract(epoch FROM at) / ($1 * 60)) * ($1 * 60))`;
  const finish = (series: SeriesLine[]) => ({
    series: q.mode === "zuwachs" ? series.map((s) => ({ ...s, points: toDelta(s.points) })) : series,
    bucketMinutes: minutes,
  });

  if (q.metric === "twitchEarnings") {
    const lines = await getEarningsSeries(q.players, from.getTime(), to.getTime(), minutes);
    return finish(lines.map((l) => ({ id: l.id, name: l.id === "alle" ? "Alle Spieler" : (players[l.id]?.name ?? l.id), points: l.points })));
  }

  if (q.metric === "twitchBits") {
    // Bits auf dem Server, summiert über die Zeit (je Kanal bzw. alle zusammen)
    const ids = perPlayer ? q.players : null;
    const rows = (
      await db.query<{ player: string; at: Date; v: number | string }>(
        `WITH buckets AS (
           SELECT ${ids ? "channel_id" : "'alle'"} AS player, ${bucket} AS at, SUM(bits) AS delta
             FROM twitch_cheers
            WHERE on_server AND at <= $3 ${ids ? "AND channel_id = ANY($5)" : ""}
            GROUP BY 1, 2
         ), cumulative AS (
           SELECT player, at, SUM(delta) OVER (PARTITION BY player ORDER BY at) AS v FROM buckets
         )
         SELECT player, at, v FROM cumulative
          WHERE at >= $2 OR (
            $4 = 'zuwachs' AND at = (SELECT max(previous.at) FROM cumulative previous WHERE previous.player = cumulative.player AND previous.at < $2)
          )
          ORDER BY player, at`,
        [minutes, from, to, q.mode, ...(ids ? [ids] : [])],
      )
    ).rows;
    const lines = new Map<string, SeriesLine>();
    for (const id of ids ?? ["alle"]) lines.set(id, { id, name: id === "alle" ? "Alle Spieler" : (players[id]?.name ?? id), points: [] });
    for (const row of rows) lines.get(row.player)?.points.push({ at: iso(row.at)!, v: Number(row.v) });
    return finish([...lines.values()]);
  }

  if (q.metric === "twitchSubs") {
    if (perPlayer) {
      const placeholders = q.players.map((_, index) => `$${index + 4}`).join(", ");
      const rows = (
        await db.query<{ player: string; at: Date; v: number | string }>(
          `WITH buckets AS (
             SELECT player, ${bucket} AS at, SUM(delta) AS delta
               FROM events
              WHERE type IN ('subscription', 'subscription_gift') AND meta->>'serverOnline' = 'true'
                AND at <= $3 AND player IN (${placeholders})
              GROUP BY player, 2
           ), cumulative AS (
             SELECT player, at, SUM(delta) OVER (PARTITION BY player ORDER BY at) AS v
               FROM buckets
           )
           SELECT player, at, v FROM cumulative
            WHERE at >= $2 OR (
              $${q.players.length + 4} = 'zuwachs'
              AND at = (SELECT max(previous.at) FROM cumulative previous
                         WHERE previous.player = cumulative.player AND previous.at < $2)
            )
            ORDER BY player, at`,
          [minutes, from, to, ...q.players, q.mode],
        )
      ).rows;
      const byPlayer = new Map<string, SeriesLine>();
      for (const id of q.players) byPlayer.set(id, { id, name: players[id]?.name ?? id, points: [] });
      for (const row of rows) {
        byPlayer.get(row.player)?.points.push({ at: iso(row.at)!, v: Number(row.v) });
      }
      return finish([...byPlayer.values()]);
    }

    const rows = (
      await db.query<{ at: Date; v: number | string }>(
        `WITH buckets AS (
           SELECT ${bucket} AS at, SUM(delta) AS delta
             FROM events
            WHERE type IN ('subscription', 'subscription_gift') AND meta->>'serverOnline' = 'true' AND at <= $3
            GROUP BY 1
         ), cumulative AS (
           SELECT at, SUM(delta) OVER (ORDER BY at) AS v FROM buckets
         )
         SELECT at, v FROM cumulative
          WHERE at >= $2 OR (
            $4 = 'zuwachs' AND at = (SELECT max(previous.at) FROM cumulative previous WHERE previous.at < $2)
          )
          ORDER BY at`,
        [minutes, from, to, q.mode],
      )
    ).rows;
    return finish([{ id: "alle", name: "Alle Spieler", points: rows.map((row) => ({ at: iso(row.at)!, v: Number(row.v) })) }]);
  }

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
    if (q.metric === "viewers") {
      // Zuschauer: nicht live = 0. Offline und nicht live speichert der Tracker keine Zeilen (nur den Wechsel);
      // jedes Bündel, in dem der Tracker lief (Server-Verlauf hat einen Punkt), bekommt daher 0, wenn der Spieler
      // dort keinen Wert hat. Echte Lücken (Tracker aus) bleiben leer.
      const buckets = (
        await db.query<{ at: Date }>(`SELECT DISTINCT ${bucket} AS at FROM history WHERE at >= $2 AND at <= $3 ORDER BY 1`, [minutes, from, to])
      ).rows.map((r) => iso(r.at)!);
      const values = new Map<string, Map<string, number>>();
      for (const r of rows) {
        if (r.v === null) continue;
        (values.get(r.player) ?? values.set(r.player, new Map()).get(r.player)!).set(iso(r.at)!, Number(r.v));
      }
      for (const [id, line] of byPlayer) line.points = buckets.map((at) => ({ at, v: values.get(id)?.get(at) ?? 0 }));
      return finish([...byPlayer.values()]);
    }
    for (const r of rows) {
      if (r.v === null) continue;
      byPlayer.get(r.player)?.points.push({ at: iso(r.at)!, v: Number(r.v) });
    }
    // Zähler ändern sich offline nicht: Wer zu Beginn des Zeitraums nicht online war, hat dort trotzdem einen Stand
    // (den letzten davor). Ohne diesen Startpunkt begänne seine Linie erst mitten im Graphen.
    if (q.metric !== "online") {
      const before = (
        await db.query<{ player: string; v: number | string }>(
          `SELECT p.id AS player, h.v FROM unnest($1::text[]) AS p(id)
             CROSS JOIN LATERAL (
               SELECT ${col} AS v FROM player_history
                WHERE player = p.id AND at < $2 AND ${col} IS NOT NULL
                ORDER BY at DESC LIMIT 1
             ) h`,
          [q.players, from],
        )
      ).rows;
      for (const b of before) {
        const line = byPlayer.get(b.player);
        if (!line) continue;
        if (!line.points.length || Date.parse(line.points[0].at) > from.getTime()) line.points.unshift({ at: from.toISOString(), v: Number(b.v) });
      }
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

/**
 * Verlauf eines einzelnen Blocks/Mobs/Tiers aus den Top-Listen (`player_top_history`) für den Graphen.
 * Ohne gewählte Spieler: die fünf, die es aktuell am häufigsten in den eigenen Top 10 haben.
 * Fällt das Item aus den Top 10 eines Spielers, fehlt dort der Wert (Lücke statt Null).
 */
export async function getItemSeries(q: {
  category: string;
  key: string;
  players: string[];
  from: number | null;
  to: number | null;
  bucketMinutes: number | null;
  mode: "wert" | "zuwachs";
}): Promise<{ series: SeriesLine[]; bucketMinutes: number }> {
  await ensureLoaded();
  const db = await getDb();
  const players = g().state?.players ?? {};
  const ids = q.players.length
    ? q.players
    : Object.values(players)
        .map((p) => ({ id: p.id, count: p.detail?.tops[q.category]?.find((e) => e.key === q.key)?.count ?? 0 }))
        .filter((p) => p.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((p) => p.id);
  if (ids.length === 0) return { series: [], bucketMinutes: q.bucketMinutes ?? 60 };
  const first = (await db.query<{ at: Date | null }>(`SELECT min(at) AS at FROM player_top_history`)).rows[0]?.at ?? null;
  const from = new Date(q.from ?? first?.getTime() ?? Date.now());
  const to = new Date(q.to ?? Date.now());
  const minutes = q.bucketMinutes ?? bucketMinutes(from, 600, 5);
  const rows = (
    await db.query<{ player: string; at: Date; tops: TopSnapshot; anchor: boolean }>(
      `SELECT t.player, t.at, t.tops, t.anchor FROM player_top_history t
        WHERE t.player = ANY($1::text[]) AND t.at <= $3
          AND t.at >= COALESCE((SELECT max(at) FROM player_top_history WHERE player = t.player AND anchor AND at <= $2), $2)
        ORDER BY t.player, t.at`,
      [ids, from, to],
    )
  ).rows;
  const bucketMs = minutes * 60_000;
  const byPlayer = new Map<string, { at: string; v: number }[]>();
  let state: TopSnapshot | null = null;
  let current = "";
  for (const r of rows) {
    if (r.player !== current) {
      current = r.player;
      state = null;
    }
    if (r.anchor || !state) state = r.tops;
    else {
      const merged: TopSnapshot = { ...state };
      for (const [list, items] of Object.entries(r.tops)) merged[list] = { ...(merged[list] ?? {}), ...items };
      state = merged;
    }
    const t = new Date(r.at).getTime();
    const v = state[q.category]?.[q.key];
    if (t < from.getTime() || typeof v !== "number") continue;
    // Je Bündel der letzte Stand
    const at = new Date(Math.floor(t / bucketMs) * bucketMs).toISOString();
    const points = byPlayer.get(r.player) ?? byPlayer.set(r.player, []).get(r.player)!;
    if (points.length && points[points.length - 1].at === at) points[points.length - 1].v = v;
    else points.push({ at, v });
  }
  const series = ids.map((id) => {
    const points = byPlayer.get(id) ?? [];
    return { id, name: players[id]?.name ?? id, points: q.mode === "zuwachs" ? toDelta(points) : points };
  });
  return { series, bucketMinutes: minutes };
}
