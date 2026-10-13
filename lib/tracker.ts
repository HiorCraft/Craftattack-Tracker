import "server-only";
import { appendEvents, getState, recordPlayerPoints, saveState } from "./store";
import { fetchFollowerCounts, fetchLiveStreams, TWITCH_ENABLED, type TwitchFollowerChannel, type TwitchStream } from "./twitch";
import { trackedSecondsOf } from "./playtime";
import {
  BOARD_KEYS,
  type ApiExtPlayer,
  type ApiStats,
  type BoardEntry,
  type BoardKey,
  type EventType,
  type PlayerState,
  type TrackerEvent,
  type TrackerState,
  type AfkKind,
} from "./types";

export const STATS_URL = process.env.CA_STATS_URL ?? "https://craftattack.one/api/stats";
/**
 * Pro-Spieler-Endpunkt: liefert alle Zähler (außer Spielzeit) und den Rang – auch außerhalb der Top 10.
 * Erwartet den Twitch-Login (nicht die Spieler-ID), siehe `extLogins`.
 */
export const EXT_URL = process.env.CA_EXT_URL ?? "https://craftattack.one/api/ext";
export const POLL_INTERVAL_MS = Number(process.env.CA_POLL_INTERVAL_MS ?? 30_000);
export const FOLLOWER_POLL_INTERVAL_MS = 60_000;
/** Wie viele ext-Anfragen gleichzeitig laufen */
const EXT_CONCURRENCY = Number(process.env.CA_EXT_CONCURRENCY ?? 8);

/** Board-Keys, deren Anstieg als Ereignis protokolliert wird */
const COUNTER_EVENTS: Partial<Record<BoardKey, EventType>> = {
  deaths: "death",
  diamonds: "diamonds",
  blocksBroken: "blocksBroken",
  mobsKilled: "mobsKilled",
  distance: "distance",
};

/** Ab wann ein Spieler ohne Streckenzuwachs als AFK gilt */
export const AFK_MS = Number(process.env.CA_AFK_MINUTES ?? 5) * 60_000;
/** Ab so vielen Mobs bzw. Blöcken pro Minute (während AFK) gilt ein Abschnitt als AFK-Farm */
export const AFK_FARM_MIN = Number(process.env.CA_AFK_FARM_MIN ?? 10);
/** Mindestlänge eines Prüffensters für die Farm-Rate (kürzer wäre bei 30-s-Polls zu zufällig) */
export const AFK_FARM_WINDOW_MS = 60_000;

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
};

/** Meilensteine pro Zähler – beim Überschreiten gibt es ein Ereignis */
const MILESTONES: Partial<Record<BoardKey, number[]>> = {
  playtimeSeconds: [6, 12, 24, 48, 100, 200, 500].map((h) => h * 3600),
  deaths: [5, 10, 25, 50, 100],
  diamonds: [64, 128, 256, 512, 1000, 2000, 5000, 10000],
  blocksBroken: [1000, 5000, 10000, 50000, 100000, 500000],
  mobsKilled: [100, 500, 1000, 5000, 10000],
  distance: [10000, 50000, 100000, 500000, 1000000],
};
const BOARD_LABEL: Record<BoardKey, string> = {
  playtimeSeconds: "Dauerzocker",
  diamonds: "Diamantenbank",
  deaths: "Friedhof",
  blocksBroken: "Abrissbirne",
  mobsKilled: "Monsterjäger",
  distance: "Weltenbummler",
};

let seq = 0;
/**
 * Welche Zählerwerte in der letzten Abfrage wirklich frisch angekommen sind (Top-10 oder Einzelstatistik).
 * Fehlt ein Spieler in der ext-Antwort, bleibt sein alter Wert im State stehen – der darf dann weder als
 * Stillstand (AFK) zählen noch als unveränderte Strecke im Verlauf landen.
 */
export let freshStats = new Map<string, Set<BoardKey>>();
function eventId(at: string) {
  seq = (seq + 1) % 100000;
  return `${Date.parse(at).toString(36)}-${seq.toString(36)}`;
}

export async function fetchStats(): Promise<ApiStats> {
  const res = await fetch(STATS_URL, {
    headers: { accept: "application/json", "user-agent": "actracker/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ApiStats;
}

export type ExtPlayer = NonNullable<ApiExtPlayer["player"]>;

/** Holt die Einzelstatistik eines Spielers per Twitch-Login; `null`, wenn die API ihn nicht kennt. */
export async function fetchExtPlayer(login: string): Promise<ExtPlayer | null> {
  const res = await fetch(`${EXT_URL}/${encodeURIComponent(login)}`, {
    headers: { accept: "application/json", "user-agent": "actracker/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ApiExtPlayer;
  return data.player ?? null;
}

/**
 * Fragt alle Logins parallel (begrenzt) ab. Ergebnis ist nach Spieler-ID (aus der Antwort) abgelegt.
 * Fehlgeschlagene Spieler fehlen einfach im Ergebnis.
 */
export async function fetchExtAll(
  logins: Iterable<string>,
): Promise<{ players: Map<string, ExtPlayer>; loginOf: Map<string, string>; missing: Set<string>; failed: number }> {
  const queue = [...new Set(logins)];
  const players = new Map<string, ExtPlayer>();
  const loginOf = new Map<string, string>();
  /** Logins, die die API nicht kennt (im Gegensatz zu Fehlern/Timeouts) */
  const missing = new Set<string>();
  let failed = 0;
  const worker = async () => {
    for (let login = queue.shift(); login !== undefined; login = queue.shift()) {
      try {
        const p = await fetchExtPlayer(login);
        if (p) {
          players.set(p.id, p);
          loginOf.set(p.id, login);
        } else missing.add(login);
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, EXT_CONCURRENCY) }, worker));
  return { players, loginOf, missing, failed };
}

/** Alle Spieler-IDs, die der Tracker kennt oder die im aktuellen Snapshot vorkommen. */
export function knownPlayerIds(state: TrackerState, stats: ApiStats): Set<string> {
  const ids = new Set(Object.keys(state.players));
  for (const p of stats.online) ids.add(p.id);
  for (const l of stats.live ?? []) ids.add(l.id);
  for (const key of BOARD_KEYS) for (const e of stats.boards?.[key] ?? []) ids.add(e.id);
  return ids;
}

/**
 * Twitch-Logins für die ext-Abfrage: gespeicherter Login des Spielers, sonst der Login aus dem aktuellen
 * Live-Status, sonst die Spieler-ID (stimmt bei den meisten Spielern mit dem Login überein).
 */
export function extLogins(state: TrackerState, stats: ApiStats, ids: Iterable<string>): Map<string, string> {
  const liveLogin = new Map<string, string>();
  for (const l of stats.live ?? []) liveLogin.set(l.id, l.login);
  for (const p of stats.online) if (p.live?.login) liveLogin.set(p.id, p.live.login);
  const logins = new Map<string, string>();
  for (const id of ids) logins.set(id, state.players[id]?.twitchLogin ?? liveLogin.get(id) ?? KNOWN_LOGINS[id] ?? id);
  return logins;
}

/**
 * Spieler, denen nicht zuordenbare Tode per Ausschluss zugeschrieben werden könnten: gerade online,
 * nicht in der Tode-Top-10 und von /api/ext nicht gekannt (nicht bloß ein Timeout). Nur bei genau
 * einem Kandidaten ist die Zuordnung eindeutig.
 */
export function deathCandidates(state: TrackerState, stats: ApiStats, ext: Map<string, ExtPlayer>, extMissing: Set<string>): string[] {
  const inBoard = new Set((stats.boards?.deaths ?? []).map((e) => e.id));
  const logins = extLogins(state, stats, stats.online.map((p) => p.id));
  return stats.online.map((p) => p.id).filter((id) => !ext.has(id) && !inBoard.has(id) && extMissing.has(logins.get(id) ?? id));
}

/**
 * Feste Zuordnung Spieler-ID → Twitch-Login für Spieler, deren Login von der ID abweicht und die der
 * Tracker nicht von selbst lernt (weil sie selten streamen). Quelle: Teilnehmerseite craftattack.one.
 */
export const KNOWN_LOGINS: Record<string, string> = {
  balui: "baluilp",
  caravas: "caravasyt",
  larslp: "larslp_live",
  syou: "syoutv",
  thejocraft: "thejocraft_live",
  noway4u: "noway4u_sir",
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
      livePeakViewers: 0,
    };
    state.players[p.id] = ps;
    newPlayers.add(p.id);
  }
  ps.name = p.name || ps.name;
  ps.uuid = p.uuid || ps.uuid;
  if (!ps.twitchLogin && KNOWN_LOGINS[ps.id]) ps.twitchLogin = KNOWN_LOGINS[ps.id];
  return ps;
}

/** Vergleicht neuen Snapshot mit dem gespeicherten Zustand und erzeugt Ereignisse. */
export function diffSnapshot(
  state: TrackerState,
  stats: ApiStats,
  nowDate = new Date(),
  ext: Map<string, ExtPlayer> = new Map(),
  /** Live-Streams laut Twitch (Login → Stream); `null` = nicht abgefragt/fehlgeschlagen, dann zählt die API */
  twitch: Map<string, TwitchStream> | null = null,
  /** Twitch-Login je Spieler-ID, mit dem die ext-Abfrage erfolgreich war */
  extLoginOf: Map<string, string> = new Map(),
  /** Logins, die /api/ext nicht kennt (für die Zuordnung per Ausschluss, siehe `deathCandidates`) */
  extMissing: Set<string> = new Set(),
  followerCounts: Map<string, number> = new Map(),
): TrackerEvent[] {
  const now = nowDate.toISOString();
  const events: TrackerEvent[] = [];
  const push = (e: Omit<TrackerEvent, "id" | "at">) => events.push({ id: eventId(now), at: now, ...e });

  const first = state.latest === null;
  const onlineBeforePoll = new Map(Object.values(state.players).map((player) => [player.id, player.online]));

  // --- Server-Status
  if (state.serverOnline !== null && state.serverOnline !== stats.serverOnline) {
    push({
      type: stats.serverOnline ? "server_online" : "server_offline",
      where: "server",
      meta: { onlineCount: stats.onlineCount },
    });
  }
  state.serverOnline = stats.serverOnline;

  // Sekunden seit dem letzten erfolgreichen Poll (für Stream- und AFK-Zeit), gedeckelt auf 5 Min
  const sinceLast = state.lastOk ? Math.min(Math.max(0, (nowDate.getTime() - Date.parse(state.lastOk)) / 1000), 300) : 0;

  // --- Online-Spieler: Join / Leave
  newPlayers.clear();
  const onlineNow = new Set(stats.online.map((p) => p.id));
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

  // --- Twitch: Live-Status / Titel / Viewer
  // Quelle ist bevorzugt Twitch selbst (Helix `streams` für alle gespeicherten Logins); die Haupt-API kennt
  // nur Streams von Spielern, die gerade auf dem Server sind. Ohne Twitch-Zugangsdaten bleibt die API die Quelle.
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
      liveNow.set(ps.id, { id: ps.id, name: ps.name, login: st.login, title: st.title, viewers: st.viewers, startedAt: st.startedAt });
    }
    // Spieler, deren Login Twitch nicht kannte, aber die API als live meldet
    for (const l of apiLive.values()) {
      if (!liveNow.has(l.id) && !twitch.has((state.players[l.id]?.twitchLogin ?? l.login ?? l.id).toLowerCase())) liveNow.set(l.id, l);
    }
  } else {
    for (const l of apiLive.values()) liveNow.set(l.id, l);
  }
  for (const l of liveNow.values()) l.onServer = onlineNow.has(l.id);


  for (const l of liveNow.values()) {
    const ps = ensurePlayer(state, { id: l.id, name: l.name, uuid: state.players[l.id]?.uuid ?? "" }, now);
    const prev = ps.live;
    const onServer = onlineNow.has(l.id);
    ps.peakViewers = Math.max(ps.peakViewers, l.viewers);
    const newStream = !prev || Boolean(l.startedAt && prev.startedAt && l.startedAt !== prev.startedAt);
    ps.livePeakViewers = newStream ? l.viewers : Math.max(ps.livePeakViewers ?? 0, l.viewers);
    if (onServer) ps.peakViewersOnServer = Math.max(ps.peakViewersOnServer ?? 0, l.viewers);
    if (prev) {
      if (onServer) ps.streamOnServerSeconds = (ps.streamOnServerSeconds ?? 0) + sinceLast;
      else ps.streamOffServerSeconds = (ps.streamOffServerSeconds ?? 0) + sinceLast;
    }
    if (!prev) {
      ps.liveSince = l.startedAt && Date.parse(l.startedAt) < nowDate.getTime() ? new Date(l.startedAt).toISOString() : now;
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
    ps.live = { login: l.login, title: l.title, viewers: l.viewers, onServer, startedAt: l.startedAt };
    if (l.login) ps.twitchLogin = l.login;
  }
  for (const ps of Object.values(state.players)) {
    if (ps.live && !liveNow.has(ps.id)) {
      const since = ps.liveSince ? Date.parse(ps.liveSince) : nowDate.getTime();
      const streamSeconds = Math.max(0, Math.round((nowDate.getTime() - since) / 1000));
      push({
        type: "stream_end",
        player: ps.id,
        playerName: ps.name,
        uuid: ps.uuid,
        where: "twitch",
        meta: {
          login: ps.live.login,
          streamSeconds,
          peakViewers: ps.livePeakViewers ?? ps.peakViewers,
          peakViewersOnServer: ps.peakViewersOnServer ?? 0,
          startedAt: ps.liveSince,
        },
      });
      ps.live = null;
      ps.liveSince = null;
      ps.livePeakViewers = 0;
    }
  }
  // Zusammengeführten Live-Stand in den Snapshot schreiben, damit alle Seiten dieselbe Quelle sehen
  stats.live = [...liveNow.values()];
  for (const p of stats.online) {
    const l = liveNow.get(p.id);
    p.live = l ? { login: l.login, title: l.title, viewers: l.viewers, onServer: true, startedAt: l.startedAt } : null;
  }

  // --- Einzelstatistiken (/api/ext/<login>): Name und Ränge für alle abgefragten Spieler übernehmen
  for (const [id, x] of ext) {
    const ps = ensurePlayer(state, { id, name: x.name, uuid: state.players[id]?.uuid ?? "" }, now);
    ps.ranks = { ...x.ranks };
    // /api/ext wird per Twitch-Login abgefragt: eine erfolgreiche Antwort bestätigt den Login des Spielers
    const login = extLoginOf.get(id);
    if (login && !ps.twitchLogin) ps.twitchLogin = login;
  }

  // --- Twitch-Follower: nur Zuwächse zwischen zwei Messungen auf dem Server zählen
  for (const [id, value] of followerCounts) {
    const ps = state.players[id];
    if (!ps) continue;
    const previous = ps.followers;
    const elapsed = ps.followersAt ? nowDate.getTime() - Date.parse(ps.followersAt) : null;
    const isOnlineNow = onlineNow.has(id);
    const delta = previous === null ? 0 : value - previous;
    const gainedOnServer = delta > 0 && ps.followersOnlineAtSample && onlineBeforePoll.get(id) === true && isOnlineNow ? delta : 0;
    const currentStream = ps.live ? ps.liveSince : null;
    if (ps.followersLiveAtSample !== currentStream) ps.followersOnLiveStream = 0;
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

  // --- Boards: Zähler-Deltas
  freshStats = new Map();
  for (const key of BOARD_KEYS) {
    const list = stats.boards?.[key] ?? [];
    const prevList = state.latest?.boards?.[key] ?? [];
    // Wer neu in einer Top-10 auftaucht, lag vorher höchstens auf dem Wert des alten 10. Platzes
    // (bzw. bei 0, wenn die Liste noch nicht voll war). So wird z. B. der erste Tod eines Spielers
    // ihm zugeordnet statt als "unbekannt" zu landen.
    const floor = prevList.length >= 10 ? prevList[prevList.length - 1].value : 0;
    // Alle Spieler außerhalb der Top 10 kommen über die Einzelstatistik dazu (außer Spielzeit, die gibt es dort nicht).
    const inList = new Set(list.map((e) => e.id));
    const extEntries: (BoardEntry & { fromExt: true })[] = [];
    if (key !== "playtimeSeconds") {
      for (const [id, x] of ext) {
        if (inList.has(id)) continue;
        const value = x[key];
        if (typeof value !== "number") continue;
        extEntries.push({ id, name: x.name, uuid: state.players[id]?.uuid ?? "", value, fromExt: true });
      }
    }
    for (const entry of [...list, ...extEntries] as (BoardEntry & { fromExt?: true })[]) {
      const ps = ensurePlayer(state, entry, now);
      const known = ps.stats[key];
      ps.stats[key] = entry.value;
      (freshStats.get(entry.id) ?? freshStats.set(entry.id, new Set()).get(entry.id)!).add(key);
      // Frische Spielzeit: Bezugspunkt merken, damit sie außerhalb der Top 10 aus Join/Leave weitergerechnet werden kann
      if (key === "playtimeSeconds") ps.playtimeTracked = trackedSecondsOf(ps, nowDate.getTime());
      // Strecke gestiegen (oder erster Wert): der Spieler bewegt sich
      if (key === "distance" && (known === undefined || entry.value > known)) ps.lastMoveAt = now;
      const type = COUNTER_EVENTS[key];
      if (!type || first) continue;
      // Erster ext-Wert eines Spielers: nur merken, kein Ereignis (wir wissen nicht, wann das passiert ist)
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

  // --- AFK: online, aber die Strecke steigt seit AFK_MS nicht mehr. Nur möglich, wenn es Streckendaten gibt.
  if (!first) {
    for (const ps of Object.values(state.players)) {
      if (!ps.online || ps.stats.distance === undefined) continue;
      // Keine frische Strecke in dieser Abfrage (ext fehlgeschlagen/unbekannt): nichts bewerten. Läuft keine
      // AFK-Phase, startet die Bewegungsuhr neu, damit die Datenlücke nicht als Stillstand zählt.
      if (!freshStats.get(ps.id)?.has("distance")) {
        if (!ps.afkSince) ps.lastMoveAt = now;
        continue;
      }
      // War schon online, bevor es die Bewegungsuhr gab (oder kam mit unbekannter Strecke): jetzt starten
      if (!ps.lastMoveAt) {
        ps.lastMoveAt = now;
        continue;
      }
      const idle = nowDate.getTime() - Date.parse(ps.lastMoveAt);
      if (ps.afkSince) {
        ps.afkSeconds = (ps.afkSeconds ?? 0) + sinceLast;
        const farm = afkFarmDelta(ps);
        if (idle < AFK_MS) {
          // Bewegung: AFK-Phase ist vorbei
          const afk = Math.max(0, Math.round((nowDate.getTime() - Date.parse(ps.afkSince)) / 1000));
          const farmEnd = farmEndEvent(ps, nowDate.getTime(), false);
          if (farmEnd) push(farmEnd);
          push({ type: "afk_end", player: ps.id, playerName: ps.name, uuid: ps.uuid, where: "server", meta: { afkSeconds: afk, since: ps.afkSince, farm: ps.afkFarm, ...farm } });
          endAfk(ps);
        } else {
          // Steht still: Farm-Rate fensterweise prüfen. Nur Abschnitte mit ≥ AFK_FARM_MIN pro Minute sind Farm,
          // der Rest der Phase ist normales AFK (ohne neues AFK-Start-Ereignis).
          const check = ps.afkCheck ?? (ps.afkCheck = checkWindow(ps, now));
          const windowMs = nowDate.getTime() - Date.parse(check.at);
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
        }
      } else if (idle >= AFK_MS) {
        // AFK beginnt rückwirkend mit der letzten Bewegung
        ps.afkSince = ps.lastMoveAt;
        ps.afkSeconds = (ps.afkSeconds ?? 0) + idle / 1000;
        ps.afkFarm = null;
        ps.afkMobsAt = ps.stats.mobsKilled ?? null;
        ps.afkBlocksAt = ps.stats.blocksBroken ?? null;
        ps.afkCheck = null; // erst leeren, damit kein alter Farm-Beginn übernommen wird
        ps.afkCheck = checkWindow(ps, now);
        push({ type: "afk_start", player: ps.id, playerName: ps.name, uuid: ps.uuid, where: "server", meta: { since: ps.afkSince } });
      }
    }
  }

  // --- Totals: Tode, die keinem Spieler zugeordnet werden konnten
  // (z. B. Spieler, die der Tracker noch nie gesehen hat, oder wenn die ext-Abfrage fehlgeschlagen ist)
  if (!first && state.latest) {
    const prevDeaths = state.latest.totals?.deaths ?? 0;
    const explained = events.filter((e) => e.type === "death").reduce((s, e) => s + (e.delta ?? 0), 0);
    // Nicht sofort melden: oft liefert /api/ext den Tod erst einen Poll später (Timeout, Reihenfolge).
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

  // --- Verlauf
  // Globale Zuschauer: nur Streams von Spielern, die gerade auf dem Server sind
  const liveOnServer = [...liveNow.values()].filter((l) => l.onServer);
  const viewers = liveOnServer.reduce((s, l) => s + l.viewers, 0);
  state.history.push({
    at: now,
    onlineCount: stats.onlineCount,
    liveCount: liveOnServer.length,
    viewers,
    playtimeSeconds: stats.totals?.playtimeSeconds ?? 0,
    deaths: stats.totals?.deaths ?? 0,
  });

  // --- Rekorde (seit Tracker-Start)
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

  state.latest = stats;
  state.lastOk = now;
  state.eventCount += events.length;
  return events;
}

let polling = false;
export async function pollOnce(): Promise<{ ok: boolean; events: number; error?: string }> {
  if (polling) return { ok: false, events: 0, error: "busy" };
  polling = true;
  try {
    const state = await getState();
    const now = new Date();
    state.lastPoll = now.toISOString();
    state.polls += 1;
    try {
      const stats = await fetchStats();
      // Einzelstatistiken für alle bekannten Spieler – Fehler hier sind nicht fatal, dann gibt es eben nur die Top 10
      const logins = extLogins(state, stats, knownPlayerIds(state, stats));
      // Live-Status direkt bei Twitch für alle bekannten Logins; schlägt das fehl, zählt die Haupt-API
      const [ext, twitch, followers] = await Promise.all([
        fetchExtAll(logins.values()),
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
      if (ext.failed > 0) console.warn(`[tracker] ${ext.failed} ext-Anfragen fehlgeschlagen`);
      const first = state.latest === null;
      const events = diffSnapshot(state, stats, now, ext.players, twitch, ext.loginOf, ext.missing, followers);
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
      await appendEvents(events);
      await saveState(state);
      await recordPlayerPoints(Object.values(state.players), now.toISOString(), freshStats);
      return { ok: true, events: events.length };
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      await saveState(state);
      return { ok: false, events: 0, error: state.lastError };
    }
  } finally {
    polling = false;
  }
}

type Globals = typeof globalThis & { __acPollTimer?: ReturnType<typeof setInterval> };

/** Startet die Endlosschleife (einmal pro Prozess). */
export function startPolling() {
  const gl = globalThis as Globals;
  if (gl.__acPollTimer) return;
  const tick = () => {
    pollOnce().catch((e) => console.error("[tracker] poll failed", e));
  };
  tick();
  gl.__acPollTimer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[tracker] polling ${STATS_URL} alle ${POLL_INTERVAL_MS / 1000}s`);
}
