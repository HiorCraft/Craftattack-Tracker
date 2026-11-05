import "server-only";
import { EVENT_MIN_DELTA } from "./events";
import { createHash } from "node:crypto";
import { appendEvents, appendFeedItems, deathFeedMeta, enrichDeathEvents, getState, recordPlayerPoints, recordTopSnapshots, saveState } from "./store";
import { fetchFollowerCounts, fetchLiveStreams, TWITCH_ENABLED, type TwitchFollowerChannel, type TwitchStream } from "./twitch";
import { fetchCraftAttack, getCraftAttackPauseMs, maxCraftAttackTimerDelay, USER_AGENT } from "./craftattackFetch";
import { expireChatSessions, syncSharedChatFromApi } from "./sharedChat";
import { trackedSecondsOf } from "./playtime";
import {
  BOARD_KEYS,
  type ApiPlayerDetail,
  type PlayerDetail,
  type PlayerRank,
  type ApiFeed,
  type ApiStats,
  type FeedItem,
  type BoardEntry,
  type BoardKey,
  type EventType,
  type PlayerState,
  type TrackerEvent,
  type TrackerState,
  type AfkKind,
} from "./types";

const STATS_URL = process.env.CA_STATS_URL ?? "https://craftattack.one/api/stats";
/** Einzelstatistik je Spieler-ID (ersetzt /api/ext/<twitch-login>) */
const PLAYER_URL = process.env.CA_PLAYER_URL ?? "https://craftattack.one/api/player";
const FEED_URL = process.env.CA_FEED_URL ?? "https://craftattack.one/api/feed";
export const POLL_INTERVAL_MS = Number(process.env.CA_POLL_INTERVAL_MS ?? 60_000);
const POLL_JITTER_RATIO = 0.25;
const MIN_POLL_INTERVAL_MS = Math.floor(POLL_INTERVAL_MS * (1 - POLL_JITTER_RATIO));
const MAX_POLL_INTERVAL_MS = Math.ceil(POLL_INTERVAL_MS * (1 + POLL_JITTER_RATIO));
const FOLLOWER_POLL_INTERVAL_MS = 60_000;
const envNumber = (name: string, fallback: number, min: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
};
/**
 * Einzelstatistik: nur Spieler, die online sind (oder es im vorigen Poll waren), werden abgefragt, je Spieler
 * höchstens alle CA_PLAYER_INTERVAL_MS (Standard 5 Min), die ältesten zuerst; so verteilen sich die Anfragen über
 * die Polls. Jeden Poll alle (~40 Anfragen pro Minute) führte dazu, dass Cloudflare vor craftattack.one die IP
 * sperrte. Offline können sich die Werte nicht ändern; der zuletzt gespeicherte Stand bleibt gültig.
 */
const EXT_ONLINE_TTL_MS = envNumber("CA_PLAYER_INTERVAL_MS", 5 * 60_000, 30_000);
/** So lange bleibt eine Antwort verwendbar, wenn sie nicht rechtzeitig erneuert werden konnte */
const EXT_CACHE_TTL_MS = 15 * 60_000;
const EXT_REQUEST_INTERVAL_MS = envNumber("CA_PLAYER_REQUEST_INTERVAL_MS", 500, 250);
const EXT_MAX_PER_POLL = envNumber("CA_PLAYER_MAX_PER_POLL", 80, 1);
/** Cache je Spieler-ID */
const extCache = new Map<string, { player: ExtPlayer | null; at: number; failed: boolean }>();
/**
 * Spieler, die schon gespielt haben (`played`), aber seit Tracker-Start nie online waren: einmalig abfragen, damit
 * sie Profil, Verlauf und Plätze in den Bestenlisten bekommen. Je Poll nur wenige, damit der Poll kurz bleibt.
 */
const CATCH_UP_PER_POLL = envNumber("CA_CATCH_UP_PER_POLL", 10, 0);
/** Schon nachgeholt (oder der API unbekannt) – in diesem Prozess nicht erneut versuchen */
const caughtUp = new Set<string>();

function catchUpIds(state: TrackerState, stats: ApiStats, online: Set<string>): string[] {
  return (stats.played ?? [])
    .filter((id) => typeof id === "string" && !online.has(id) && !caughtUp.has(id) && !state.players[id]?.detail)
    .slice(0, CATCH_UP_PER_POLL);
}

/** Board-Keys, deren Anstieg als Ereignis protokolliert wird */
const COUNTER_EVENTS: Partial<Record<BoardKey, EventType>> = {
  deaths: "death",
  diamonds: "diamonds",
  blocksBroken: "blocksBroken",
  mobsKilled: "mobsKilled",
  distance: "distance",
  damageDealt: "damageDealt",
  totemsUsed: "totemsUsed",
  foodEaten: "foodEaten",
};

/**
 * Ab wann ein Spieler ohne Streckenzuwachs als AFK gilt (nur Ersatz, wenn die Quelle keinen AFK-Zähler liefert).
 * 5 Min wie der Server: gegen dessen Zähler abgeglichen trifft die Strecke allein ~97 % der AFK-Zeit.
 */
export const AFK_MS = Number(process.env.CA_AFK_MINUTES ?? 5) * 60_000;
/** Ab so vielen Mobs bzw. Blöcken pro Minute (während AFK) gilt ein Abschnitt als AFK-Farm */
const AFK_FARM_MIN = Number(process.env.CA_AFK_FARM_MIN ?? 10);
/**
 * Mindestlänge eines Prüffensters für die Farm-Rate. 3 Min: Eine Farm muss die Rate so lange halten; einzelne
 * Minuten mit vielen Blöcken oder Mobs (z. B. kurz Mobs am AFK-Platz) ergaben sonst Farm-Ereignisse von 1–2 Min.
 */
export const AFK_FARM_WINDOW_MS = 3 * 60_000;

/** Farm-Art eines Zeitabschnitts: mindestens AFK_FARM_MIN Mobs bzw. Blöcke pro Minute (Mobs haben Vorrang) */
export function farmKindOf(mobs: number, blocks: number, ms: number): AfkKind | null {
  const need = (AFK_FARM_MIN * ms) / 60_000;
  return mobs > 0 && mobs >= need ? "mobs" : blocks > 0 && blocks >= need ? "blocks" : null;
}

const gainedSince = (now: number | undefined, at: number | null | undefined) => (now === undefined || at === null || at === undefined ? 0 : Math.max(0, now - at));
/** Was der Spieler seit Beginn der laufenden AFK-Phase trotzdem gemacht hat */
function afkFarmDelta(ps: PlayerState): { mobs: number; blocks: number } {
  return { mobs: gainedSince(ps.stats.mobsKilled, ps.afkMobsAt), blocks: gainedSince(ps.stats.blocksBroken, ps.afkBlocksAt) };
}
/** Neues Prüffenster ab jetzt mit den aktuellen Zählern (Farm-Beginn bleibt erhalten) */
function checkWindow(ps: PlayerState, now: string): NonNullable<PlayerState["afkCheck"]> {
  return { at: now, mobs: ps.stats.mobsKilled ?? null, blocks: ps.stats.blocksBroken ?? null, farmSince: ps.afkCheck?.farmSince ?? null, farmAt: ps.afkCheck?.farmAt ?? null };
}
/** Ende einer AFK-Farm: eigenes Ereignis je Art, mit Dauer und gefarmter Menge der Farm (nicht der ganzen AFK-Phase) */
function farmEndEvent(ps: PlayerState, endMs: number, byLeave: boolean, stillAfk = false): Omit<TrackerEvent, "id" | "at"> | null {
  if (!ps.afkFarm) return null;
  const since = ps.afkCheck?.farmSince ?? ps.afkSince;
  const cur = ps.afkFarm === "mobs" ? ps.stats.mobsKilled : ps.stats.blocksBroken;
  const start = ps.afkCheck?.farmAt ?? (ps.afkFarm === "mobs" ? ps.afkMobsAt : ps.afkBlocksAt);
  const value = gainedSince(cur, start);
  const seconds = since ? Math.max(0, Math.round((endMs - Date.parse(since)) / 1000)) : 0;
  return {
    type: ps.afkFarm === "mobs" ? "afk_mobs_end" : "afk_blocks_end",
    player: ps.id,
    playerName: ps.name,
    uuid: ps.uuid,
    where: "server",
    value,
    meta: { kind: ps.afkFarm, afkSeconds: seconds, since, afkSince: ps.afkSince, byLeave, ...(stillAfk ? { stillAfk: true } : {}), [ps.afkFarm]: value },
  };
}
function endAfk(ps: PlayerState) {
  ps.afkSince = null;
  ps.afkFarm = null;
  ps.afkMobsAt = null;
  ps.afkBlocksAt = null;
  ps.afkCheck = null;
}

/** Wartezeit, bevor nicht zuordenbare Tode als „unbekannt“ gemeldet werden */
export const UNKNOWN_DEATH_GRACE_MS = Number(process.env.CA_UNKNOWN_DEATH_GRACE_MS ?? 10 * 60_000);

/** Mindest-Delta, ab dem ein Zähler-Ereignis entsteht (sonst zu viel Rauschen) */
const MIN_DELTA: Partial<Record<BoardKey, number>> = {
  distance: 500, // Meter
  blocksBroken: 100,
  mobsKilled: 10,
  // Essen: mehr als 2; Schaden: mehr als 20 Herzen (siehe EVENT_MIN_DELTA in lib/events.ts)
  ...EVENT_MIN_DELTA,
};

/** Meilensteine pro Zähler – beim Überschreiten gibt es ein Ereignis */
const MILESTONES: Partial<Record<BoardKey, number[]>> = {
  playtimeSeconds: [6, 12, 24, 48, 100, 200, 500].map((h) => h * 3600),
  deaths: [5, 10, 25, 50, 100],
  diamonds: [64, 128, 256, 512, 1000, 2000, 5000, 10000],
  blocksBroken: [1000, 5000, 10000, 50000, 100000, 500000],
  mobsKilled: [100, 500, 1000, 5000, 10000],
  distance: [10000, 50000, 100000, 500000, 1000000],
  damageDealt: [200, 1000, 2000, 10000, 20000],
  totemsUsed: [1, 5, 10, 25, 50, 100],
  foodEaten: [100, 500, 1000, 5000, 10000],
};
const BOARD_LABEL: Record<BoardKey, string> = {
  playtimeSeconds: "Dauerzocker",
  diamonds: "Diamantenbank",
  deaths: "Friedhof",
  blocksBroken: "Abrissbirne",
  mobsKilled: "Monsterjäger",
  distance: "Weltenbummler",
  damageDealt: "Kampfmaschine",
  totemsUsed: "Unsterblich",
  foodEaten: "Vielfraß",
};

let seq = 0;
/**
 * Welche Zählerwerte in der letzten Abfrage wirklich frisch angekommen sind (Top-10 oder Einzelstatistik).
 * Fehlt ein Spieler in der ext-Antwort, bleibt sein alter Wert im State stehen – der darf dann weder als
 * Stillstand (AFK) zählen noch als unveränderte Strecke im Verlauf landen.
 */
let freshStats = new Map<string, Set<BoardKey>>();
/** Spieler, deren Zusatzwerte (/api/player) im letzten Poll frisch abgefragt wurden */
let freshDetail = new Set<string>();
function eventId(at: string) {
  seq = (seq + 1) % 100000;
  return `${Date.parse(at).toString(36)}-${seq.toString(36)}`;
}

async function fetchStats(): Promise<ApiStats> {
  const res = await fetchCraftAttack(STATS_URL, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ApiStats;
}

async function fetchFeed(): Promise<ApiFeed> {
  const res = await fetchCraftAttack(FEED_URL, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ApiFeed;
}

function feedItemKey(item: FeedItem): string {
  return item.type === "death"
    ? JSON.stringify([item.type, item.at, item.victim.id, item.message])
    : JSON.stringify([item.type, item.at, item.player.id, item.advancement]);
}

function feedEventId(item: FeedItem): string {
  return `feed-${createHash("sha256").update(feedItemKey(item)).digest("hex")}`;
}

/**
 * Feed-Einträge, die dieser Prozess schon gespeichert hat. Spart die Inserts für Einträge, die bei jedem Poll
 * wieder geliefert werden; nach einem Neustart entdoppelt die DB über die Ereignis-ID.
 */
const seenFeedIds = new Set<string>();
const MAX_SEEN_FEED_IDS = 50_000;

/** Noch nicht gespeicherte Einträge aus /api/feed und den `events` von /api/player, nach Inhalt entdoppelt */
function unseenFeedItems(items: FeedItem[]): { id: string; item: FeedItem }[] {
  const unseen = new Map<string, FeedItem>();
  for (const item of items) {
    const id = feedEventId(item);
    if (!seenFeedIds.has(id)) unseen.set(id, item);
  }
  return [...unseen].map(([id, item]) => ({ id, item }));
}

function markFeedSeen(items: { id: string }[]) {
  for (const { id } of items) seenFeedIds.add(id);
  // Älteste zuerst verwerfen (Set behält die Einfügereihenfolge)
  for (const id of seenFeedIds) {
    if (seenFeedIds.size <= MAX_SEEN_FEED_IDS) break;
    seenFeedIds.delete(id);
  }
}

/**
 * Ereignisse aus Feed-Einträgen (/api/feed und `events` von /api/player), auch aus der Zeit vor dem Tracker-Start.
 * Jeder Erfolg wird ein Ereignis. Tode zählt der Tracker selbst über den Todeszähler; aus dem Feed entsteht ein
 * Tod nur, wenn er vor dem ersten bekannten Stand des Spielers liegt (`firstSeen`) – den konnte der Zähler nie
 * melden. Spätere Tode ergänzt `enrichDeathEvents` nur um Nachricht und Mörder.
 */
function feedEvents(state: TrackerState, items: { id: string; item: FeedItem }[]): TrackerEvent[] {
  const events: TrackerEvent[] = [];
  for (const { id, item } of items) {
    if (item.type === "achievement") {
      events.push({
        id,
        at: item.at,
        type: "achievement",
        player: item.player.id,
        playerName: item.player.name,
        uuid: item.player.uuid,
        where: "server",
        meta: {
          playerMinecraft: item.player.minecraft,
          playerTwitch: item.player.twitch,
          feedAt: item.at,
          advancement: item.advancement,
          frame: item.frame,
          title: item.title,
          message: item.message,
        },
      });
      continue;
    }
    const firstSeen = state.players[item.victim.id]?.firstSeen;
    if (!firstSeen || Date.parse(item.at) >= Date.parse(firstSeen)) continue;
    events.push({
      id,
      at: item.at,
      type: "death",
      player: item.victim.id,
      playerName: item.victim.name,
      uuid: item.victim.uuid,
      where: "server",
      delta: 1,
      // Vor der Erfassung: zählt nicht in Raten, die durch vom Tracker gemessene Online-Zeit teilen
      meta: { beforeTracking: true, ...deathFeedMeta(item) },
    });
  }
  return events;
}

/** Einzelstatistik eines Spielers, aufbereitet aus /api/player/<id> */
interface ExtPlayer {
  id: string;
  name: string;
  /** Minecraft-UUID aus den Ereignissen des Spielers (die Antwort selbst enthält keine); "" = unbekannt */
  uuid: string;
  online: boolean;
  /** Twitch-Login laut API; null, wenn dort keiner hinterlegt ist */
  twitch: string | null;
  /** Werte für die Board-Keys */
  stats: Partial<Record<BoardKey, number>>;
  ranks: Partial<Record<BoardKey, PlayerRank>>;
  /** Alle übrigen Werte und Top-Listen */
  detail: PlayerDetail;
  /** Letzte Erfolge und Tode des Spielers (`events`), reicht weiter zurück als /api/feed */
  feed: FeedItem[];
  /** In diesem Poll abgefragt (nicht aus dem Cache) */
  fresh: boolean;
}

const BOARD_KEY_SET = new Set<string>(BOARD_KEYS);

/** Teilt die API-Antwort in Board-Werte (für Ereignisse und Verlauf) und Zusatzwerte (nur Profil). */
function toExtPlayer(data: ApiPlayerDetail, fetchedAt: string): ExtPlayer | null {
  if (!data.participant || !data.player) return null;
  const stats: Partial<Record<BoardKey, number>> = {};
  const ranks: Partial<Record<BoardKey, PlayerRank>> = {};
  const extraStats: Record<string, number> = {};
  const extraRanks: Record<string, PlayerRank> = {};
  for (const [key, value] of Object.entries(data.player.stats ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (BOARD_KEY_SET.has(key)) stats[key as BoardKey] = value;
    else extraStats[key] = value;
  }
  for (const [key, rank] of Object.entries(data.player.ranks ?? {})) {
    if (!rank || typeof rank.rank !== "number") continue;
    const clean = { rank: rank.rank, of: rank.of };
    if (BOARD_KEY_SET.has(key)) ranks[key as BoardKey] = clean;
    else extraRanks[key] = clean;
  }
  const feed = playerFeedItems(data.events, data.participant.id);
  const own = feed.map((item) => (item.type === "death" ? item.victim : item.player)).find((p) => typeof p?.uuid === "string" && p.uuid);
  return {
    id: data.participant.id,
    name: data.participant.name,
    uuid: own?.uuid ?? "",
    online: data.player.online,
    twitch: data.participant.twitch ?? null,
    stats,
    ranks,
    detail: {
      fetchedAt,
      firstJoin: data.player.firstJoin ?? null,
      lastSeen: data.player.lastSeen ?? null,
      stats: extraStats,
      ranks: extraRanks,
      tops: data.player.tops ?? {},
    },
    feed,
    fresh: true,
  };
}

/** Nur gültige Einträge, die wirklich diesen Spieler betreffen (Erfolg von ihm, Tod von ihm) */
function playerFeedItems(items: unknown, id: string): FeedItem[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is FeedItem => {
    if (!item || typeof item.at !== "string" || Number.isNaN(Date.parse(item.at))) return false;
    if (item.type === "achievement") return item.player?.id === id && typeof item.advancement === "string";
    if (item.type === "death") return item.victim?.id === id && typeof item.message === "string";
    return false;
  });
}

/** Holt die Einzelstatistik eines Spielers per Spieler-ID; `null`, wenn die API ihn nicht kennt (HTTP 404). */
async function fetchExtPlayer(id: string): Promise<ExtPlayer | null> {
  const res = await fetchCraftAttack(`${PLAYER_URL}/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return toExtPlayer((await res.json()) as ApiPlayerDetail, new Date().toISOString());
}

/**
 * Fragt die übergebenen (Online-)Spieler einzeln ab, die älteste Antwort zuerst.
 * Ergebnis ist nach Spieler-ID abgelegt; `loginOf` enthält den Twitch-Login laut API.
 */
async function fetchExtAll(
  ids: Iterable<string>,
): Promise<{ players: Map<string, ExtPlayer>; loginOf: Map<string, string>; missing: Set<string>; failed: number }> {
  const all = [...new Set(ids)];
  const now = Date.now();
  const age = (id: string) => now - (extCache.get(id)?.at ?? 0);
  const queue = all
    .filter((id) => age(id) >= EXT_ONLINE_TTL_MS)
    .sort((a, b) => age(b) - age(a))
    .slice(0, EXT_MAX_PER_POLL);
  const fetched = new Set<string>();
  const players = new Map<string, ExtPlayer>();
  const loginOf = new Map<string, string>();
  /** Spieler-IDs, die die API nicht kennt (im Gegensatz zu Fehlern/Timeouts) */
  const missing = new Set<string>();
  let failed = 0;
  for (const [index, id] of queue.entries()) {
    if (getCraftAttackPauseMs(PLAYER_URL) > 0) break;
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, EXT_REQUEST_INTERVAL_MS));
    try {
      const player = await fetchExtPlayer(id);
      extCache.set(id, { player, at: Date.now(), failed: false });
      fetched.add(id);
    } catch {
      failed += 1;
      extCache.set(id, { player: null, at: Date.now(), failed: true });
    }
  }

  for (const id of all) {
    const cached = extCache.get(id);
    if (!cached || Date.now() - cached.at >= EXT_CACHE_TTL_MS) continue;
    if (cached.failed) {
      continue;
    } else if (cached.player) {
      players.set(cached.player.id, { ...cached.player, fresh: fetched.has(id) });
      if (cached.player.twitch) loginOf.set(cached.player.id, cached.player.twitch);
    } else {
      missing.add(id);
    }
  }
  return { players, loginOf, missing, failed };
}

/** Alle Spieler-IDs, die der Tracker kennt oder die im aktuellen Snapshot vorkommen. */
function knownPlayerIds(state: TrackerState, stats: ApiStats): Set<string> {
  const ids = new Set(Object.keys(state.players));
  for (const p of stats.online) ids.add(p.id);
  for (const l of stats.live ?? []) ids.add(l.id);
  for (const key of BOARD_KEYS) for (const e of stats.boards?.[key] ?? []) ids.add(e.id);
  return ids;
}

/**
 * Twitch-Logins für Live-Status und Follower: gespeicherter Login des Spielers, sonst der Login aus dem
 * aktuellen Live-Status, sonst die Spieler-ID (stimmt bei den meisten Spielern mit dem Login überein).
 */
function extLogins(state: TrackerState, stats: ApiStats, ids: Iterable<string>): Map<string, string> {
  const liveLogin = new Map<string, string>();
  for (const l of stats.live ?? []) liveLogin.set(l.id, l.login);
  for (const p of stats.online) if (p.live?.login) liveLogin.set(p.id, p.live.login);
  const logins = new Map<string, string>();
  for (const id of ids) logins.set(id, state.players[id]?.twitchLogin ?? liveLogin.get(id) ?? KNOWN_LOGINS[id] ?? id);
  return logins;
}

/**
 * Spieler, denen nicht zuordenbare Tode per Ausschluss zugeschrieben werden könnten: gerade online,
 * nicht in der Tode-Top-10 und von /api/player nicht gekannt (nicht bloß ein Timeout). Nur bei genau
 * einem Kandidaten ist die Zuordnung eindeutig.
 */
function deathCandidates(state: TrackerState, stats: ApiStats, ext: Map<string, ExtPlayer>, extMissing: Set<string>): string[] {
  const inBoard = new Set((stats.boards?.deaths ?? []).map((e) => e.id));
  return stats.online.map((p) => p.id).filter((id) => !ext.has(id) && !inBoard.has(id) && extMissing.has(id));
}

/**
 * Feste Zuordnung Spieler-ID → Twitch-Login für Spieler, die die API ohne Twitch-Login liefert oder deren Login
 * der Tracker nicht von selbst lernt (weil sie selten streamen). Quelle: Teilnehmerseite craftattack.one, für die
 * letzten drei Twitch selbst (Kanalname, Streamtitel, gleiche Handles auf TikTok/Minecraft).
 */
export const KNOWN_LOGINS: Record<string, string> = {
  iicrimax: "icrimax",
  tridanyt: "yttridan",
  noriskk: "norisk",
  askation: "tobifas",
  syou:	"syoutv",
  sintica: "sinticalive",
  letshugo: "letshugotv",
  niek: "niekbeats",
  dersterzik: "sterzik",
  thejocraft: "thejocraft_live",
  gamerstime: "gtimetv",
  eisteelepeach: "eisteelepeach_1",
  willygaminghd: "niklaswilson",
  gambo: "notgambo",
  rohaze: "xrohat",
  caravas: "caravasyt",
  balui: "baluilp",
  larslp: "larslp_live",
  dienessyy: "nessyssary",
  crocodileandy: "crocodileandytv",
  noway4u: "noway4u_sir",
  henkenbergen: "henke",
  rgbpixel: "rgbpixl",
  // Ohne Twitch in der API: benx streamte Craft Attack 13 dort; toobadyoutube = sein TikTok- und Minecraft-Name
  benx: "benx",
  toobad: "toobadyoutube",
  einfachgustaf: "einfachgustaf",
};

const newPlayers = new Set<string>();

function ensurePlayer(
  state: TrackerState,
  p: { id: string; name: string; uuid: string },
  now: string,
): PlayerState {
  let ps = state.players[p.id];
  if (!ps) {
    ps = {
      id: p.id,
      name: p.name,
      uuid: p.uuid,
      online: false,
      live: null,
      stats: {},
      firstSeen: now,
      lastSeen: now,
      sessionStart: null,
      trackedSeconds: 0,
      playtimeTracked: null,
      sessions: 0,
      liveSince: null,
      peakViewers: 0,
      peakViewersOnServer: 0,
      streamOnServerSeconds: 0,
      streamOffServerSeconds: 0,
      longestSession: 0,
      lastMoveAt: null,
      afkSince: null,
      afkSeconds: 0,
      afkFarm: null,
      afkMobsAt: null,
      afkBlocksAt: null,
      afkCheck: null,
      ranks: {},
      twitchLogin: null,
      followers: null,
      followersAt: null,
      followersOnlineAtSample: false,
      followersOnServer: 0,
      followersOnLiveStream: 0,
      followersLiveAtSample: null,
      followersAtLiveStart: null,
      livePeakViewers: 0,
      detail: null,
    };
    state.players[p.id] = ps;
    newPlayers.add(p.id);
  }
  ps.name = p.name || ps.name;
  ps.uuid = p.uuid || ps.uuid;
  if (!ps.twitchLogin && KNOWN_LOGINS[ps.id]) ps.twitchLogin = KNOWN_LOGINS[ps.id];
  return ps;
}

/** Gemeinsamer Stand eines Polls, den alle Abschnitte von `diffSnapshot` lesen */
interface DiffContext {
  state: TrackerState;
  stats: ApiStats;
  nowDate: Date;
  now: string;
  /** Erster Poll ohne gespeicherten Stand: Zustand aufbauen, keine Ereignisse melden */
  first: boolean;
  /** Sekunden seit dem letzten erfolgreichen Poll (für Stream- und AFK-Zeit), gedeckelt auf 5 Min */
  sinceLast: number;
  onlineNow: Set<string>;
  events: TrackerEvent[];
  push: (e: Omit<TrackerEvent, "id" | "at">) => void;
  pushAt: (at: string, e: Omit<TrackerEvent, "id" | "at">) => void;
}

/** Server-Status */
function diffServerStatus(ctx: DiffContext) {
  const { state, stats, push } = ctx;
  if (state.serverOnline !== null && state.serverOnline !== stats.serverOnline) {
    push({
      type: stats.serverOnline ? "server_online" : "server_offline",
      where: "server",
      meta: { onlineCount: stats.onlineCount },
    });
  }
  state.serverOnline = stats.serverOnline;
}

/** Online-Spieler: Join / Leave */
function diffJoinLeave(ctx: DiffContext) {
  const { state, stats, nowDate, now, first, sinceLast, onlineNow, push } = ctx;
  for (const p of stats.online) {
    const ps = ensurePlayer(state, p, now);
    ps.lastSeen = now;
    if (!ps.online) {
      ps.online = true;
      ps.sessionStart = now;
      ps.sessions += 1;
      ps.lastMoveAt = now;
      ps.afkSince = null;
      if (!first) {
        push({
          type: newPlayers.has(p.id) ? "first_join" : "join",
          player: p.id,
          playerName: p.name,
          uuid: p.uuid,
          where: "server",
        });
      }
    }
  }
  for (const ps of Object.values(state.players)) {
    if (ps.online && !onlineNow.has(ps.id)) {
      ps.online = false;
      const started = ps.sessionStart ? Date.parse(ps.sessionStart) : nowDate.getTime();
      const dur = Math.max(0, Math.round((nowDate.getTime() - started) / 1000));
      ps.trackedSeconds += dur;
      ps.longestSession = Math.max(ps.longestSession ?? 0, dur);
      ps.sessionStart = null;
      if (ps.afkSince) {
        const afk = Math.max(0, Math.round((nowDate.getTime() - Date.parse(ps.afkSince)) / 1000));
        ps.afkSeconds = (ps.afkSeconds ?? 0) + sinceLast;
        const farmEnd = farmEndEvent(ps, nowDate.getTime(), true);
        if (farmEnd) push(farmEnd);
        push({ type: "afk_end", player: ps.id, playerName: ps.name, uuid: ps.uuid, where: "server", meta: { afkSeconds: afk, since: ps.afkSince, byLeave: true, farm: ps.afkFarm, ...afkFarmDelta(ps) } });
        endAfk(ps);
      }
      ps.lastMoveAt = null;
      push({
        type: "leave",
        player: ps.id,
        playerName: ps.name,
        uuid: ps.uuid,
        where: "server",
        meta: { sessionSeconds: dur },
      });
    }
  }
}

/**
 * Live-Stand je Spieler aus Twitch und API zusammenführen.
 * Quelle ist bevorzugt Twitch selbst (Helix `streams` für alle gespeicherten Logins); die Haupt-API kennt
 * nur Streams von Spielern, die gerade auf dem Server sind. Ohne Twitch-Zugangsdaten bleibt die API die Quelle.
 */
function mergeLiveSources(ctx: DiffContext, twitch: Map<string, TwitchStream> | null): Map<string, ApiStats["live"][number]> {
  const { state, stats, now, onlineNow } = ctx;
  const liveNow = new Map<string, ApiStats["live"][number]>();
  const apiLive = new Map<string, ApiStats["live"][number]>();
  for (const l of stats.live ?? []) apiLive.set(l.id, l);
  for (const p of stats.online) {
    if (p.live && !apiLive.has(p.id)) apiLive.set(p.id, { ...p.live, id: p.id, name: p.name });
  }
  // Logins aus der API merken, damit Twitch-Login und Spieler-ID zusammenfinden
  for (const l of apiLive.values()) {
    if (l.login) ensurePlayer(state, { id: l.id, name: l.name, uuid: state.players[l.id]?.uuid ?? "" }, now).twitchLogin = l.login;
  }
  if (twitch) {
    const byLogin = new Map<string, PlayerState>();
    for (const ps of Object.values(state.players)) byLogin.set((ps.twitchLogin ?? ps.id).toLowerCase(), ps);
    for (const [login, st] of twitch) {
      const ps = byLogin.get(login);
      if (!ps) continue;
      liveNow.set(ps.id, {
        id: ps.id,
        name: ps.name,
        login: st.login,
        title: st.title,
        viewers: st.viewers,
        startedAt: st.startedAt,
        gameId: st.gameId,
        gameName: st.gameName,
      });
    }
    // Spieler, deren Login Twitch nicht kannte, aber die API als live meldet
    for (const l of apiLive.values()) {
      if (!liveNow.has(l.id) && !twitch.has((state.players[l.id]?.twitchLogin ?? l.login ?? l.id).toLowerCase())) liveNow.set(l.id, l);
    }
  } else {
    for (const l of apiLive.values()) liveNow.set(l.id, l);
  }
  for (const l of liveNow.values()) l.onServer = onlineNow.has(l.id);
  return liveNow;
}

/** Stream-Ende eines Spielers; `endMs` = Zeitpunkt des Endes */
function streamEndEvent(ps: PlayerState, endMs: number): Omit<TrackerEvent, "id" | "at"> {
  const since = ps.liveSince ? Date.parse(ps.liveSince) : endMs;
  return {
    type: "stream_end",
    player: ps.id,
    playerName: ps.name,
    uuid: ps.uuid,
    where: "twitch",
    meta: {
      login: ps.live?.login ?? null,
      streamSeconds: Math.max(0, Math.round((endMs - since) / 1000)),
      peakViewers: ps.livePeakViewers ?? ps.peakViewers,
      peakViewersOnServer: ps.peakViewersOnServer ?? 0,
      startedAt: ps.liveSince,
    },
  };
}

/** Twitch: Stream-Beginn, -Ende, Titelwechsel, Zuschauer-Spitzen und Stream-Zeit je Spieler */
function diffStreams(ctx: DiffContext, liveNow: Map<string, ApiStats["live"][number]>) {
  const { state, nowDate, now, first, sinceLast, onlineNow, push, pushAt } = ctx;
  for (const l of liveNow.values()) {
    const ps = ensurePlayer(state, { id: l.id, name: l.name, uuid: state.players[l.id]?.uuid ?? "" }, now);
    const prev = ps.live;
    const onServer = onlineNow.has(l.id);
    ps.peakViewers = Math.max(ps.peakViewers, l.viewers);
    const startedAt = l.startedAt && Date.parse(l.startedAt) < nowDate.getTime() ? new Date(l.startedAt).toISOString() : null;
    // Neuer Stream, ohne dass der Tracker das Ende gesehen hat (Neustart zwischen zwei Polls oder während der
    // Tracker aus war): Twitch meldet einen späteren Beginn als `liveSince`. Sonst zählten "aktueller Stream"-
    // Werte (Subs, Follower) über alle Streams seitdem weiter.
    const restarted = Boolean(prev && startedAt && (!ps.liveSince || Date.parse(ps.liveSince) < Date.parse(startedAt) - 5 * 60_000));
    if (restarted) {
      pushAt(startedAt!, streamEndEvent(ps, Date.parse(startedAt!)));
    }
    const newStream = !prev || restarted;
    ps.livePeakViewers = newStream ? l.viewers : Math.max(ps.livePeakViewers ?? 0, l.viewers);
    if (onServer) ps.peakViewersOnServer = Math.max(ps.peakViewersOnServer ?? 0, l.viewers);
    if (prev) {
      if (onServer) ps.streamOnServerSeconds = (ps.streamOnServerSeconds ?? 0) + sinceLast;
      else ps.streamOffServerSeconds = (ps.streamOffServerSeconds ?? 0) + sinceLast;
    }
    if (newStream) {
      ps.liveSince = startedAt ?? now;
      if (!first) {
        push({
          type: "stream_start",
          player: l.id,
          playerName: l.name,
          uuid: ps.uuid,
          where: "twitch",
          value: l.viewers,
          meta: { title: l.title, login: l.login, onServer, startedAt: ps.liveSince },
        });
      }
    } else if (prev.title !== l.title) {
      push({
        type: "stream_title",
        player: l.id,
        playerName: l.name,
        uuid: ps.uuid,
        where: "twitch",
        value: l.viewers,
        meta: { title: l.title, previousTitle: prev.title, login: l.login },
      });
    }
    ps.live = {
      login: l.login,
      title: l.title,
      viewers: l.viewers,
      onServer,
      startedAt: l.startedAt,
      ...(l.gameId ? { gameId: l.gameId } : {}),
      ...(l.gameName ? { gameName: l.gameName } : {}),
    };
    if (l.login) ps.twitchLogin = l.login;
  }
  for (const ps of Object.values(state.players)) {
    if (ps.live && !liveNow.has(ps.id)) {
      push(streamEndEvent(ps, nowDate.getTime()));
      ps.live = null;
      ps.liveSince = null;
      ps.livePeakViewers = 0;
    }
  }
}

/** Zusammengeführten Live-Stand in den Snapshot schreiben, damit alle Seiten dieselbe Quelle sehen */
function writeLiveToSnapshot(stats: ApiStats, liveNow: Map<string, ApiStats["live"][number]>) {
  stats.live = [...liveNow.values()];
  for (const p of stats.online) {
    const l = liveNow.get(p.id);
    p.live = l
      ? {
          login: l.login,
          title: l.title,
          viewers: l.viewers,
          onServer: true,
          startedAt: l.startedAt,
          ...(l.gameId ? { gameId: l.gameId } : {}),
          ...(l.gameName ? { gameName: l.gameName } : {}),
        }
      : null;
  }
}

/** Einzelstatistiken (/api/player/<id>): Name, Ränge und Zusatzwerte für alle abgefragten Spieler übernehmen */
function applyPlayerDetails(ctx: DiffContext, ext: Map<string, ExtPlayer>, extLoginOf: Map<string, string>) {
  const { state, now } = ctx;
  freshDetail = new Set([...ext.values()].filter((x) => x.fresh).map((x) => x.id));
  for (const [id, x] of ext) {
    const ps = ensurePlayer(state, { id, name: x.name, uuid: state.players[id]?.uuid || x.uuid }, now);
    ps.ranks = { ...x.ranks };
    // Offline (z. B. einmalig nachgeholt): zuletzt gesehen laut API statt „jetzt“
    if (!ps.online && x.detail.lastSeen) ps.lastSeen = x.detail.lastSeen;
    ps.detail = x.detail;
    // Die API kennt den Twitch-Login, wenn der Spieler einen hinterlegt hat
    const login = extLoginOf.get(id);
    if (login && !ps.twitchLogin) ps.twitchLogin = login;
  }
}

/** Twitch-Follower: nur Zuwächse zwischen zwei Messungen auf dem Server zählen */
function diffFollowers(ctx: DiffContext, followerCounts: Map<string, number>, onlineBeforePoll: Map<string, boolean>) {
  const { state, nowDate, now, first, onlineNow, push } = ctx;
  for (const [id, value] of followerCounts) {
    const ps = state.players[id];
    if (!ps) continue;
    const previous = ps.followers;
    const elapsed = ps.followersAt ? nowDate.getTime() - Date.parse(ps.followersAt) : null;
    const isOnlineNow = onlineNow.has(id);
    const delta = previous === null ? 0 : value - previous;
    const gainedOnServer = delta > 0 && ps.followersOnlineAtSample && onlineBeforePoll.get(id) === true && isOnlineNow ? delta : 0;
    const currentStream = ps.live ? ps.liveSince : null;
    if (ps.followersLiveAtSample !== currentStream) {
      ps.followersOnLiveStream = 0;
      // Basis für den Zuwachs im ganzen Stream: die Messung vor dem Start (höchstens ein Poll-Abstand alt), sonst diese
      ps.followersAtLiveStart = currentStream ? (previous ?? value) : null;
    }
    if (currentStream && ps.followersLiveAtSample === currentStream) ps.followersOnLiveStream += gainedOnServer;
    ps.followersLiveAtSample = currentStream;
    ps.followersOnServer = (ps.followersOnServer ?? 0) + gainedOnServer;
    ps.followers = value;
    ps.followersAt = now;
    ps.followersOnlineAtSample = isOnlineNow;
    if (first || gainedOnServer === 0 || elapsed === null || elapsed <= 0) continue;
    if (gainedOnServer * 60_000 > 20 * elapsed) {
      push({
        type: "follower_burst",
        player: id,
        playerName: ps.name,
        uuid: ps.uuid,
        where: "twitch",
        delta: gainedOnServer,
        value: ps.followersOnServer,
        meta: { windowSeconds: Math.round(elapsed / 1000), followerGainOnServer: ps.followersOnServer },
      });
    }
  }
}

/** Boards: Zähler-Deltas, Meilensteine und Rang-Aufstiege in den Top 3 */
function diffBoards(ctx: DiffContext, ext: Map<string, ExtPlayer>) {
  const { state, stats, nowDate, now, first, push } = ctx;
  freshStats = new Map();
  for (const key of BOARD_KEYS) {
    const list = stats.boards?.[key] ?? [];
    const prevList = state.latest?.boards?.[key] ?? [];
    // Wer neu in einer Top-10 auftaucht, lag vorher höchstens auf dem Wert des alten 10. Platzes
    // (bzw. bei 0, wenn die Liste noch nicht voll war). So wird z. B. der erste Tod eines Spielers
    // ihm zugeordnet statt als "unbekannt" zu landen.
    const floor = prevList.length >= 10 ? prevList[prevList.length - 1].value : 0;
    // Alle Spieler außerhalb der Top 10 kommen über die Einzelstatistik dazu.
    const inList = new Set(list.map((e) => e.id));
    const extEntries: (BoardEntry & { fromExt: true })[] = [];
    for (const [id, x] of ext) {
      if (inList.has(id)) continue;
      // Spielzeit nur aus frischen Antworten: ein Cache-Treffer würde den Bezugspunkt für die Hochrechnung
      // (playtimeTracked) bei jedem Poll auf "jetzt" setzen, obwohl der Wert bis zu 15 Minuten alt ist.
      if (key === "playtimeSeconds" && !x.fresh) continue;
      const value = x.stats[key];
      if (typeof value !== "number") continue;
      extEntries.push({ id, name: x.name, uuid: state.players[id]?.uuid || x.uuid, value, fromExt: true });
    }
    for (const entry of [...list, ...extEntries] as (BoardEntry & { fromExt?: true })[]) {
      const ps = ensurePlayer(state, entry, now);
      const known = ps.stats[key];
      // Zähler steigen nur. Ein älterer Cache-Wert (z. B. direkt nach dem Herausfallen aus der Top 10) darf den
      // Stand nicht senken, sonst würde der nächste frische Wert denselben Zuwachs ein zweites Mal melden.
      if (entry.fromExt && known !== undefined && entry.value < known) continue;
      ps.stats[key] = entry.value;
      (freshStats.get(entry.id) ?? freshStats.set(entry.id, new Set()).get(entry.id)!).add(key);
      // Frische Spielzeit: Bezugspunkt merken, damit sie außerhalb der Top 10 aus Join/Leave weitergerechnet werden kann
      if (key === "playtimeSeconds") ps.playtimeTracked = trackedSecondsOf(ps, nowDate.getTime());
      // Strecke gestiegen (oder erster Wert): der Spieler bewegt sich
      if (key === "distance" && (known === undefined || entry.value > known)) ps.lastMoveAt = now;
      const type = COUNTER_EVENTS[key];
      if (!type || first) continue;
      // Erster Wert aus der Einzelstatistik: nur merken, kein Ereignis (wir wissen nicht, wann das passiert ist)
      if (entry.fromExt && known === undefined) continue;
      const prev = known ?? floor;
      const delta = entry.value - prev;
      if (delta <= 0) continue;
      for (const m of MILESTONES[key] ?? []) {
        if (prev < m && entry.value >= m) {
          push({
            type: "milestone",
            player: entry.id,
            playerName: entry.name,
            uuid: entry.uuid,
            where: "server",
            value: m,
            meta: { board: key, label: BOARD_LABEL[key] },
          });
        }
      }
      if (delta < (MIN_DELTA[key] ?? 1)) continue;
      push({
        type,
        player: entry.id,
        playerName: entry.name,
        uuid: entry.uuid,
        where: "server",
        delta,
        value: entry.value,
        // Tod während eines Streams: merken, damit später der VOD-Link gesetzt werden kann
        ...(type === "death" && ps.live ? { meta: { live: true, twitchLogin: ps.live.login, streamStartedAt: ps.liveSince } } : {}),
      });
    }
    // Rang-Wechsel in den Top 3 (nur Aufstiege)
    if (!first) {
      for (let i = 0; i < Math.min(3, list.length); i++) {
        const entry = list[i];
        const before = prevList.findIndex((e) => e.id === entry.id);
        if (before === i) continue;
        if (before !== -1 && before < i) continue;
        push({
          type: "rank",
          player: entry.id,
          playerName: entry.name,
          uuid: entry.uuid,
          where: "server",
          value: i + 1,
          meta: { board: key, label: BOARD_LABEL[key], before: before === -1 ? null : before + 1, score: entry.value },
        });
      }
    }
  }
}

/** Letzter AFK-Zählerstand der Quelle je Spieler (ms, Sekunden), Grundlage für `sourceAfkVerdict` */
const sourceAfkPrev = new Map<string, { at: number; v: number }>();
/** Zuwachs knapp unter der Intervalllänge zählt als ganz AFK (Zähler der Quelle in 30-s-Schritten) */
const SOURCE_AFK_SLACK_MS = 45_000;

type AfkVerdict = { afk: true; since: number } | { afk: false; endAt: number };

/**
 * AFK laut Quelle: Der Server zählt `afkSeconds` hoch, solange ein Spieler AFK ist. Steigt der Zähler seit der
 * vorigen Abfrage, ist der Spieler AFK, und zwar seit (jetzt − Zuwachs); stockt er, endete die Phase nach dem Zuwachs.
 * `undefined` = die Quelle kennt den Zähler nicht (eigene Erkennung), `null` = in dieser Abfrage keine Aussage.
 */
function sourceAfkVerdict(ps: PlayerState, t: number): AfkVerdict | null | undefined {
  const v = ps.detail?.stats.afkSeconds;
  if (typeof v !== "number") return undefined;
  if (!freshDetail.has(ps.id)) return null;
  const prev = sourceAfkPrev.get(ps.id);
  sourceAfkPrev.set(ps.id, { at: t, v });
  if (!prev || t - prev.at > 15 * 60_000 || t <= prev.at) return null;
  const dt = t - prev.at;
  // Beim AFK-Beginn bucht der Server die 5 Min Stillstand rückwirkend um: der Zuwachs darf größer als dt sein
  const gain = Math.min(dt + 10 * 60_000, Math.max(0, (v - prev.v) * 1000));
  if (gain === 0) return { afk: false, endAt: prev.at };
  if (!ps.afkSince) return { afk: true, since: t - gain };
  return gain >= dt - SOURCE_AFK_SLACK_MS ? { afk: true, since: Date.parse(ps.afkSince) } : { afk: false, endAt: prev.at + gain };
}

/** Eigene Erkennung (ohne AFK-Zähler der Quelle): online, aber seit AFK_MS keine Aktivität. */
function ownAfkVerdict(ps: PlayerState, now: string, t: number): AfkVerdict | null {
  if (ps.stats.distance === undefined) return null;
  // Keine frische Strecke in dieser Abfrage (ext fehlgeschlagen/unbekannt): nichts bewerten. Läuft keine
  // AFK-Phase, startet die Bewegungsuhr neu, damit die Datenlücke nicht als Stillstand zählt.
  if (!freshStats.get(ps.id)?.has("distance")) {
    if (!ps.afkSince) ps.lastMoveAt = now;
    return null;
  }
  // War schon online, bevor es die Bewegungsuhr gab (oder kam mit unbekannter Strecke): jetzt starten
  if (!ps.lastMoveAt) {
    ps.lastMoveAt = now;
    return null;
  }
  // AFK beginnt rückwirkend mit der letzten Bewegung
  return t - Date.parse(ps.lastMoveAt) >= AFK_MS ? { afk: true, since: Date.parse(ps.lastMoveAt) } : { afk: false, endAt: t };
}

/** Zählerstände seit der letzten Bewegung je Spieler (`at` = lastMoveAt, `t0` = Zeitpunkt der Zählerstände) */
const moveCounters = new Map<string, { at: string; t0: number; mobs: number | null; blocks: number | null }>();

/**
 * Stillstehend farmen: Der Server zählt Blöcke abbauen als Aktivität (gegen seinen Zähler geprüft: bei ≥ 10 Blöcken
 * pro Minute 0 % AFK), eine AFK-Blockfarm ist für ihn also nie AFK. Steht ein Spieler seit AFK_MS still und farmt
 * seitdem mit mindestens AFK_FARM_MIN pro Minute, gilt das trotzdem als AFK-Farm. Eine laufende Phase hält das,
 * solange die Farm läuft. Nach einem Neustart zählt die Rate ab den ersten bekannten Zählerständen.
 */
function stationaryFarmVerdict(ps: PlayerState, t: number): AfkVerdict | null {
  if (!ps.lastMoveAt || !freshStats.get(ps.id)?.has("distance")) return null;
  const mark = moveCounters.get(ps.id);
  if (!mark || mark.at !== ps.lastMoveAt) {
    moveCounters.set(ps.id, { at: ps.lastMoveAt, t0: t, mobs: ps.stats.mobsKilled ?? null, blocks: ps.stats.blocksBroken ?? null });
    return { afk: false, endAt: t };
  }
  const since = Date.parse(ps.lastMoveAt);
  if (t - since < AFK_MS || t - mark.t0 < AFK_FARM_WINDOW_MS) return { afk: false, endAt: t };
  if (ps.afkSince) return ps.afkFarm ? { afk: true, since: Date.parse(ps.afkSince) } : { afk: false, endAt: t };
  const kind = farmKindOf(gainedSince(ps.stats.mobsKilled, mark.mobs), gainedSince(ps.stats.blocksBroken, mark.blocks), t - mark.t0);
  return kind ? { afk: true, since } : { afk: false, endAt: t };
}

/**
 * AFK: bevorzugt der AFK-Zähler der Quelle, sonst die eigene Erkennung über Stillstand. Stillstehend farmen
 * (`stationaryFarmVerdict`) zählt zusätzlich, auch wenn die Quelle den Spieler für aktiv hält.
 */
function diffAfk(ctx: DiffContext) {
  const { state, nowDate, now, first, sinceLast, push, pushAt } = ctx;
  for (const ps of Object.values(state.players)) {
    if (!ps.online) {
      sourceAfkPrev.delete(ps.id);
      moveCounters.delete(ps.id);
      continue;
    }
    const t = nowDate.getTime();
    const src = sourceAfkVerdict(ps, t);
    const farm = stationaryFarmVerdict(ps, t);
    if (first) continue;
    const base = src === undefined ? ownAfkVerdict(ps, now, t) : src;
    // Ohne Aussage der Quelle in dieser Abfrage beendet „farmt nicht“ allein keine Phase
    const verdict = base?.afk ? base : farm?.afk ? farm : base;
    if (!verdict) continue;
    if (ps.afkSince) {
      if (!verdict.afk) {
        // Aktiv: AFK-Phase ist vorbei
        const endAt = Math.max(Date.parse(ps.afkSince), Math.min(t, verdict.endAt));
        ps.afkSeconds = (ps.afkSeconds ?? 0) + Math.max(0, sinceLast - (t - endAt) / 1000);
        const afk = Math.max(0, Math.round((endAt - Date.parse(ps.afkSince)) / 1000));
        const end = new Date(endAt).toISOString();
        const farmEnd = farmEndEvent(ps, endAt, false);
        if (farmEnd) pushAt(end, farmEnd);
        pushAt(end, { type: "afk_end", player: ps.id, playerName: ps.name, uuid: ps.uuid, where: "server", meta: { afkSeconds: afk, since: ps.afkSince, farm: ps.afkFarm, ...afkFarmDelta(ps) } });
        endAfk(ps);
        continue;
      }
      ps.afkSeconds = (ps.afkSeconds ?? 0) + sinceLast;
      // Weiter AFK: Farm-Rate fensterweise prüfen. Nur Abschnitte mit ≥ AFK_FARM_MIN pro Minute sind Farm,
      // der Rest der Phase ist normales AFK (ohne neues AFK-Start-Ereignis).
      const check = ps.afkCheck ?? (ps.afkCheck = checkWindow(ps, now));
      const windowMs = t - Date.parse(check.at);
      const fresh = freshStats.get(ps.id);
      // Ohne frische Zähler würde die Rate zu niedrig ausfallen: Fenster einfach weiterlaufen lassen
      if (windowMs >= AFK_FARM_WINDOW_MS && fresh?.has("mobsKilled") && fresh.has("blocksBroken")) {
        const m = gainedSince(ps.stats.mobsKilled, check.mobs);
        const b = gainedSince(ps.stats.blocksBroken, check.blocks);
        const kind = farmKindOf(m, b, windowMs);
        if (kind !== ps.afkFarm) {
          // Die alte Farm endete mit Beginn dieses Fensters (dort fiel die Rate unter die Schwelle)
          const farmEnd = farmEndEvent(ps, Date.parse(check.at), false, true);
          if (farmEnd) push(farmEnd);
          ps.afkFarm = kind;
          check.farmSince = kind ? check.at : null;
          check.farmAt = kind ? (kind === "mobs" ? check.mobs : check.blocks) : null;
          if (kind) {
            const value = kind === "mobs" ? m : b;
            push({
              type: kind === "mobs" ? "afk_mobs_start" : "afk_blocks_start",
              player: ps.id,
              playerName: ps.name,
              uuid: ps.uuid,
              where: "server",
              value,
              meta: { kind, since: check.at, afkSince: ps.afkSince, windowSeconds: Math.round(windowMs / 1000), [kind]: value },
            });
          }
        }
        ps.afkCheck = checkWindow(ps, now);
      }
    } else if (verdict.afk) {
      // AFK beginnt rückwirkend (Quelle: um den Zählerzuwachs, eigene Erkennung: mit der letzten Bewegung)
      ps.afkSince = new Date(Math.min(t, verdict.since)).toISOString();
      ps.afkSeconds = (ps.afkSeconds ?? 0) + (t - Date.parse(ps.afkSince)) / 1000;
      ps.afkFarm = null;
      ps.afkMobsAt = ps.stats.mobsKilled ?? null;
      ps.afkBlocksAt = ps.stats.blocksBroken ?? null;
      ps.afkCheck = null; // erst leeren, damit kein alter Farm-Beginn übernommen wird
      ps.afkCheck = checkWindow(ps, now);
      pushAt(ps.afkSince, { type: "afk_start", player: ps.id, playerName: ps.name, uuid: ps.uuid, where: "server", meta: { since: ps.afkSince } });
      // Beginn durch stillstehendes Farmen: Farm gilt sofort (sonst endete die Phase vor dem ersten Prüffenster)
      const mark = moveCounters.get(ps.id);
      if (verdict === farm && mark) {
        const m = gainedSince(ps.stats.mobsKilled, mark.mobs);
        const b = gainedSince(ps.stats.blocksBroken, mark.blocks);
        const kind = farmKindOf(m, b, t - mark.t0);
        if (kind) {
          ps.afkFarm = kind;
          ps.afkMobsAt = mark.mobs;
          ps.afkBlocksAt = mark.blocks;
          ps.afkCheck.farmSince = ps.afkSince;
          ps.afkCheck.farmAt = kind === "mobs" ? mark.mobs : mark.blocks;
          const value = kind === "mobs" ? m : b;
          pushAt(ps.afkSince, {
            type: kind === "mobs" ? "afk_mobs_start" : "afk_blocks_start",
            player: ps.id,
            playerName: ps.name,
            uuid: ps.uuid,
            where: "server",
            value,
            meta: { kind, since: ps.afkSince, afkSince: ps.afkSince, windowSeconds: Math.round((t - mark.t0) / 1000), [kind]: value },
          });
        }
      }
    }
  }
}

/** Totals: Tode, die keinem Spieler zugeordnet werden konnten (z. B. Spieler, die der Tracker noch nie gesehen hat, oder wenn die ext-Abfrage fehlgeschlagen ist) */
function diffUnknownDeaths(ctx: DiffContext, ext: Map<string, ExtPlayer>, extMissing: Set<string>) {
  const { state, stats, nowDate, now, first, events, push } = ctx;
  if (first || !state.latest) return;
  const prevDeaths = state.latest.totals?.deaths ?? 0;
  const explained = events.filter((e) => e.type === "death").reduce((s, e) => s + (e.delta ?? 0), 0);
  // Nicht sofort melden: oft liefert /api/player den Tod erst einen Poll später (Timeout, Reihenfolge, Cache).
  // Offene Tode werden gesammelt und mit später erklärten verrechnet; erst was nach der Wartezeit übrig
  // bleibt, wird als „unbekannt“ gemeldet.
  const unexplained = (stats.totals?.deaths ?? 0) - prevDeaths - explained;
  state.pendingDeaths = Math.max(0, (state.pendingDeaths ?? 0) + unexplained);
  if (state.pendingDeaths === 0) {
    state.pendingSince = null;
    state.pendingCandidates = [];
  } else if (!state.pendingSince) {
    state.pendingSince = now;
    // Wer kommt in Frage? Wird beim Auftauchen des Todes festgehalten, nicht erst nach der Wartezeit.
    state.pendingCandidates = deathCandidates(state, stats, ext, extMissing);
  } else if (nowDate.getTime() - Date.parse(state.pendingSince) >= UNKNOWN_DEATH_GRACE_MS) {
    const candidates = state.pendingCandidates ?? [];
    const only = candidates.length === 1 ? state.players[candidates[0]] : undefined;
    if (only) {
      // Genau ein Spieler ohne Einzelstatistik war online: ihm werden die Tode per Ausschluss zugeordnet
      push({
        type: "death",
        player: only.id,
        playerName: only.name,
        uuid: only.uuid,
        where: "server",
        delta: state.pendingDeaths,
        meta: { inferred: true, ...(only.live ? { live: true, twitchLogin: only.live.login, streamStartedAt: only.liveSince } : {}) },
      });
    } else {
      push({
        type: "death",
        where: "server",
        delta: state.pendingDeaths,
        value: stats.totals.deaths,
        meta: { unknown: true, candidates: candidates.length },
      });
    }
    state.pendingDeaths = 0;
    state.pendingSince = null;
    state.pendingCandidates = [];
  }
}

/** Verlauf: ein Messpunkt je Poll. Liefert die Live-Streams auf dem Server und ihre Zuschauer. */
function recordHistory(ctx: DiffContext, liveNow: Map<string, ApiStats["live"][number]>): { liveOnServer: ApiStats["live"]; viewers: number } {
  const { state, stats, now } = ctx;
  // Globale Zuschauer: nur Streams von Spielern, die gerade auf dem Server sind
  const liveOnServer = [...liveNow.values()].filter((l) => l.onServer);
  const viewers = liveOnServer.reduce((s, l) => s + l.viewers, 0);
  state.history.push({
    at: now,
    onlineCount: stats.onlineCount,
    playerCount: stats.playerCount,
    liveCount: liveOnServer.length,
    viewers,
    playtimeSeconds: stats.totals?.playtimeSeconds ?? 0,
    deaths: stats.totals?.deaths ?? 0,
  });
  return { liveOnServer, viewers };
}

/** Rekorde (seit Tracker-Start) */
function diffRecords(ctx: DiffContext, liveOnServer: ApiStats["live"], viewers: number) {
  const { state, stats, now, first, push } = ctx;
  const rec = state.records;
  const bump = (key: keyof typeof rec, value: number, label: string, notify: (prev: number) => boolean) => {
    const prev = rec[key]?.value ?? -1;
    if (value <= prev) return;
    const had = rec[key] !== null;
    rec[key] = { value, at: now };
    if (!first && had && notify(prev)) {
      push({ type: "record", where: "server", value, delta: value - prev, meta: { key, label } });
    }
  };
  bump("peakOnline", stats.onlineCount, "Spieler gleichzeitig online", () => true);
  bump("peakLive", liveOnServer.length, "Streams gleichzeitig live", () => true);
  bump("peakViewers", viewers, "Zuschauer gesamt", (prev) => Math.floor(viewers / 10000) > Math.floor(prev / 10000));
}

/** Vergleicht neuen Snapshot mit dem gespeicherten Zustand und erzeugt Ereignisse. */
function diffSnapshot(
  state: TrackerState,
  stats: ApiStats,
  feed: ApiFeed,
  nowDate = new Date(),
  ext: Map<string, ExtPlayer> = new Map(),
  /** Live-Streams laut Twitch (Login → Stream); `null` = nicht abgefragt/fehlgeschlagen, dann zählt die API */
  twitch: Map<string, TwitchStream> | null = null,
  /** Twitch-Login je Spieler-ID laut /api/player */
  extLoginOf: Map<string, string> = new Map(),
  /** Spieler-IDs, die /api/player nicht kennt (für die Zuordnung per Ausschluss, siehe `deathCandidates`) */
  extMissing: Set<string> = new Set(),
  followerCounts: Map<string, number> = new Map(),
): TrackerEvent[] {
  const now = nowDate.toISOString();
  const events: TrackerEvent[] = [];
  const pushAt = (at: string, e: Omit<TrackerEvent, "id" | "at">) => events.push({ id: eventId(at), at, ...e });
  const push = (e: Omit<TrackerEvent, "id" | "at">) => pushAt(now, e);

  const first = state.latest === null;
  const onlineBeforePoll = new Map(Object.values(state.players).map((player) => [player.id, player.online]));
  const sinceLast = state.lastOk ? Math.min(Math.max(0, (nowDate.getTime() - Date.parse(state.lastOk)) / 1000), 300) : 0;
  newPlayers.clear();
  const onlineNow = new Set(stats.online.map((p) => p.id));
  const ctx: DiffContext = { state, stats, nowDate, now, first, sinceLast, onlineNow, events, push, pushAt };

  diffServerStatus(ctx);
  diffJoinLeave(ctx);
  const liveNow = mergeLiveSources(ctx, twitch);
  diffStreams(ctx, liveNow);
  writeLiveToSnapshot(stats, liveNow);
  applyPlayerDetails(ctx, ext, extLoginOf);
  diffFollowers(ctx, followerCounts, onlineBeforePoll);
  diffBoards(ctx, ext);
  diffAfk(ctx);
  diffUnknownDeaths(ctx, ext, extMissing);
  state.latestFeed = feed.feed.slice(0, 10);
  const { liveOnServer, viewers } = recordHistory(ctx, liveNow);
  diffRecords(ctx, liveOnServer, viewers);

  state.latest = stats;
  state.lastOk = now;
  state.eventCount += events.length;
  return events;
}

let polling = false;
let lastPollStartedAt = 0;
/**
 * Ereignisse, deren Speichern fehlschlug (z. B. Datenbank kurz nicht erreichbar). Der Spielerstand im Speicher ist
 * da schon weiter, der nächste Abgleich fände sie also nicht noch einmal: Sie gehen beim nächsten Poll mit.
 */
let unsavedEvents: TrackerEvent[] = [];
const MAX_UNSAVED_EVENTS = 50_000;
export async function pollOnce(): Promise<{ ok: boolean; events: number; error?: string }> {
  if (polling) return { ok: false, events: 0, error: "busy" };
  if (Date.now() - lastPollStartedAt < MIN_POLL_INTERVAL_MS) {
    return { ok: false, events: 0, error: "cooldown" };
  }
  const pauseMs = getCraftAttackPauseMs(STATS_URL);
  if (pauseMs > 0) {
    return { ok: false, events: 0, error: `paused until ${new Date(Date.now() + pauseMs).toISOString()}` };
  }
  lastPollStartedAt = Date.now();
  polling = true;
  try {
    const state = await getState();
    const now = new Date();
    state.lastPoll = now.toISOString();
    state.polls += 1;
    let snapshotApplied = false;
    try {
      const stats = await fetchStats();
      const feed = await fetchFeed();
      // Einzelstatistiken für alle bekannten Spieler – Fehler hier sind nicht fatal, dann gibt es eben nur die Top 10
      const ids = knownPlayerIds(state, stats);
      const logins = extLogins(state, stats, ids);
      // Einzelwerte nur für Spieler auf dem Server: jetzt oder beim vorigen Poll online (fängt die letzte Minute
      // vor dem Leave ab). Offline ändern sich die Werte nicht.
      const onlineIds = new Set([...stats.online, ...(state.latest?.online ?? [])].map((p) => p.id));
      // Live-Status direkt bei Twitch für alle bekannten Logins; schlägt das fehl, zählt die Haupt-API
      const catchUp = catchUpIds(state, stats, onlineIds);
      const [ext, twitch, followers] = await Promise.all([
        fetchExtAll([...onlineIds, ...catchUp]),
        TWITCH_ENABLED
          ? fetchLiveStreams(logins.values()).catch((err: unknown) => {
              console.warn("[tracker] Twitch-Live-Abfrage fehlgeschlagen:", err instanceof Error ? err.message : err);
              return null;
            })
          : Promise.resolve(null),
        fetchFollowerCounts(
          [...logins]
            .filter(([id]) => {
              const sampledAt = state.players[id]?.followersAt;
              return !sampledAt || now.getTime() - Date.parse(sampledAt) >= FOLLOWER_POLL_INTERVAL_MS;
            })
            .map(([id, login]): TwitchFollowerChannel => ({ id, login })),
        ),
      ]);
      if (ext.failed > 0) console.warn(`[tracker] ${ext.failed} Spieler-Anfragen (/api/player) fehlgeschlagen`);
      for (const id of catchUp) if (ext.players.has(id) || ext.missing.has(id)) caughtUp.add(id);
      if (catchUp.length) console.log(`[tracker] ${catchUp.filter((id) => ext.players.has(id)).length} Offline-Spieler einmalig nachgeholt`);
      const first = state.latest === null;
      const events = diffSnapshot(state, stats, feed, now, ext.players, twitch, ext.loginOf, ext.missing, followers);
      snapshotApplied = true;
      // Geteilter Chat (Stream Together): mit Twitch-API je Session abfragen, sonst aus Chat erschlossene beenden.
      // Fehler hier sind nicht fatal.
      try {
        const shared = twitch
          ? await syncSharedChatFromApi(
              [...logins]
                .map(([id, login]) => ({ playerId: id, broadcasterId: twitch.get(login.toLowerCase())?.userId }))
                .filter((l): l is { playerId: string; broadcasterId: string } => Boolean(l.broadcasterId)),
              state.players,
              now.toISOString(),
            )
          : await expireChatSessions(state.players, now.toISOString());
        events.push(...shared);
        state.eventCount += shared.length;
      } catch (err) {
        console.warn("[tracker] Geteilter Chat nicht abgefragt:", err instanceof Error ? err.message : err);
      }
      if (first) {
        events.unshift({
          id: eventId(now.toISOString()),
          at: now.toISOString(),
          type: "tracker_start",
          where: "tracker",
          meta: { online: stats.onlineCount, live: stats.live?.length ?? 0 },
        });
        state.eventCount += 1;
      }
      state.lastError = null;
      // Erfolge und Tode: /api/feed (letzte zehn serverweit) plus `events` jeder frischen Einzelstatistik
      const feedItems = [...feed.feed.slice(0, 10), ...[...ext.players.values()].filter((x) => x.fresh).flatMap((x) => x.feed)];
      const unseen = unseenFeedItems(feedItems);
      const fromFeed = feedEvents(state, unseen);
      await appendFeedItems(unseen);
      unsavedEvents = [...unsavedEvents, ...events, ...fromFeed].slice(-MAX_UNSAVED_EVENTS);
      const retried = unsavedEvents.length - events.length - fromFeed.length;
      const inserted = await appendEvents(unsavedEvents);
      if (retried > 0) console.log(`[tracker] ${retried} zuvor nicht gespeicherte Ereignisse nachgetragen`);
      unsavedEvents = [];
      state.eventCount += fromFeed.filter((e) => inserted.has(e.id)).length;
      markFeedSeen(unseen);
      await enrichDeathEvents(feedItems.filter((item): item is Extract<FeedItem, { type: "death" }> => item.type === "death"));
      await saveState(state);
      await recordPlayerPoints(Object.values(state.players), now.toISOString(), freshStats, freshDetail);
      await recordTopSnapshots(Object.values(state.players), now.toISOString(), freshDetail);
      return { ok: true, events: events.length };
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      await saveState(state, { savePlayers: snapshotApplied });
      return { ok: false, events: 0, error: state.lastError };
    }
  } finally {
    polling = false;
  }
}

const POLL_STUCK_MS = 10 * 60_000;

type Globals = typeof globalThis & { __acPollTimer?: ReturnType<typeof setTimeout>; __acPollStarted?: boolean };

/** Startet die Endlosschleife (einmal pro Prozess). */
export function startPolling() {
  const gl = globalThis as Globals;
  if (gl.__acPollStarted) return;
  gl.__acPollStarted = true;
  const tick = async () => {
    const startedAt = Date.now();
    try {
      await pollOnce();
    } catch (e) {
      console.error("[tracker] poll failed", e);
    }
    const interval = MIN_POLL_INTERVAL_MS + Math.floor(Math.random() * (MAX_POLL_INTERVAL_MS - MIN_POLL_INTERVAL_MS + 1));
    const intervalDelay = Math.max(0, interval - (Date.now() - startedAt));
    const delay = Math.max(intervalDelay, getCraftAttackPauseMs(STATS_URL));
    gl.__acPollTimer = setTimeout(() => void tick(), maxCraftAttackTimerDelay(delay));
  };
  void tick();
  // Wächter: Hängt ein Poll trotz Zeitlimits, beendet sich der Prozess und Render startet ihn neu. Der Stand liegt in
  // der Datenbank, verloren geht nur der hängende Poll.
  setInterval(() => {
    if (polling && Date.now() - lastPollStartedAt > POLL_STUCK_MS) {
      console.error(`[tracker] Poll hängt seit ${Math.round((Date.now() - lastPollStartedAt) / 60_000)} Min, Neustart`);
      process.exit(1);
    }
  }, 60_000).unref();
  console.log(`[tracker] polling ${STATS_URL} alle ${MIN_POLL_INTERVAL_MS / 1000}–${MAX_POLL_INTERVAL_MS / 1000}s (Jitter)`);
}
