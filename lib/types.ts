export type BoardKey =
  | "playtimeSeconds"
  | "diamonds"
  | "deaths"
  | "blocksBroken"
  | "mobsKilled"
  | "distance"
  | "damageDealt"
  | "totemsUsed"
  | "foodEaten";

export const BOARD_KEYS: BoardKey[] = [
  "playtimeSeconds",
  "diamonds",
  "deaths",
  "blocksBroken",
  "mobsKilled",
  "distance",
  "damageDealt",
  "totemsUsed",
  "foodEaten",
];

export interface LiveInfo {
  login: string;
  title: string;
  viewers: number;
  gameId?: string;
  gameName?: string;
  /** Streamt gerade und ist dabei auf dem Server (nur bei vom Tracker zusammengeführten Live-Daten gesetzt) */
  onServer?: boolean;
  /** Streambeginn laut Twitch (ISO), falls bekannt */
  startedAt?: string;
}

export interface ApiPlayer {
  id: string;
  name: string;
  uuid: string;
  live: LiveInfo | null;
}

export interface BoardEntry {
  id: string;
  name: string;
  uuid: string;
  value: number;
}

/** Rang eines Spielers in einer Liste laut /api/player/<id> */
export interface PlayerRank {
  rank: number;
  of: number;
}


/** Eintrag einer Top-Liste je Spieler (z. B. meistabgebaute Blöcke) laut /api/player/<id> */
export interface PlayerTopEntry {
  key: string;
  name: string;
  count: number;
}

/** Antwort von https://craftattack.one/api/player/<spieler-id> (404 mit `{ error: "unknown player" }`, wenn unbekannt) */
export interface ApiPlayerDetail {
  updatedAt: string;
  serverOnline: boolean;
  participant: { id: string; name: string; twitch: string | null } | null;
  live: LiveInfo | null;
  player: {
    online: boolean;
    lastSeen: string | null;
    firstJoin: string | null;
    stats: Record<string, number>;
    ranks: Record<string, PlayerRank>;
    tops?: Record<string, PlayerTopEntry[]>;
  } | null;
  /** Letzte Erfolge und Tode dieses Spielers, gleiches Format wie /api/feed (reicht weiter zurück als der Feed) */
  events?: FeedItem[];
}

/**
 * Zusätzliche Werte aus /api/player/<id>, die über die Board-Keys hinausgehen (platzierte Blöcke, Sprünge, …).
 * Die Keys kommen unverändert aus der API, damit neue Werte ohne Codeänderung gespeichert werden.
 */
export interface PlayerDetail {
  /** Zeitpunkt der Abfrage */
  fetchedAt: string;
  firstJoin: string | null;
  lastSeen: string | null;
  stats: Record<string, number>;
  ranks: Record<string, PlayerRank>;
  tops: Record<string, PlayerTopEntry[]>;
}

export interface ApiStats {
  updatedAt: string;
  serverOnline: boolean;
  onlineCount: number;
  playerCount: number;
  totals: { playtimeSeconds: number; deaths: number };
  boards: Record<BoardKey, BoardEntry[]>;
  online: ApiPlayer[];
  live: (LiveInfo & { id: string; name: string })[];
  /** IDs aller Spieler, die schon einmal auf dem Server waren */
  played?: string[];
}

export interface Player {
  id: string;
  name: string;
  uuid: string;
  minecraft: string;
  twitch: string | null;
}

export interface AchievementFeedItem {
  type: "achievement";
  at: string;
  player: Player;
  advancement: string;
  frame: string;
  title: string;
  message: string;
}

export interface DeathFeedItem {
  type: "death";
  at: string;
  victim: Player;
  killer: Player | null;
  message: string;
}

export type FeedItem = AchievementFeedItem | DeathFeedItem;

export interface ApiFeed {
  updatedAt: string;
  feed: FeedItem[];
}

export type EventType =
  | "join"
  | "leave"
  | "death"
  | "achievement"
  | "diamonds"
  | "blocksBroken"
  | "mobsKilled"
  | "distance"
  | "damageDealt"
  | "totemsUsed"
  | "foodEaten"
  | "stream_start"
  | "stream_end"
  | "stream_title"
  | "subscription"
  | "subscription_gift"
  | "cheer"
  | "clip"
  | "follower_burst"
  | "raid"
  | "chat"
  | "shared_chat_start"
  | "shared_chat_end"
  | "server_online"
  | "server_offline"
  | "tracker_start"
  | "first_join"
  | "rank"
  | "milestone"
  | "stat"
  | "record"
  | "afk_start"
  | "afk_end"
  | "afk_mobs_start"
  | "afk_mobs_end"
  | "afk_blocks_start"
  | "afk_blocks_end";

/** Was ein Spieler während einer AFK-Phase trotzdem tut: Mobs farmen oder Blöcke abbauen */
export type AfkKind = "mobs" | "blocks";

/**
 * Laufende Farm-Prüfung einer AFK-Phase: Die Rate wird fensterweise (≥ 1 Minute) gemessen. Nur wer in jedem
 * Fenster mindestens AFK_FARM_MIN Mobs bzw. Blöcke pro Minute schafft, farmt; sonst ist es normales AFK.
 */
export interface AfkCheck {
  /** Beginn des laufenden Prüffensters (ISO) und Zählerstände zu diesem Zeitpunkt */
  at: string;
  mobs: number | null;
  blocks: number | null;
  /** Beginn der laufenden Farm (ISO) und Zählerstand ihrer Art zu diesem Zeitpunkt; null = keine Farm */
  farmSince: string | null;
  farmAt: number | null;
}

export interface TrackerEvent {
  id: string;
  at: string; // ISO
  type: EventType;
  /** Spieler-ID (slug) – fehlt bei Server-Events */
  player?: string;
  playerName?: string;
  uuid?: string;
  /** Wo: "server" oder "twitch" */
  where: "server" | "twitch" | "tracker";
  /** Delta bei Zählern (z. B. +3 Tode) */
  delta?: number;
  /** Neuer Gesamtwert */
  value?: number;
  /** Zusatzinfos (Streamtitel, Viewer, …) */
  meta?: Record<string, string | number | boolean | null>;
}

export interface PlayerState {
  id: string;
  name: string;
  uuid: string;
  online: boolean;
  live: LiveInfo | null;
  /** Letzter bekannter Stand aus den Boards bzw. /api/player/<id> */
  stats: Partial<Record<BoardKey, number>>;
  /** Ränge laut /api/player/<id> (leer, solange der Spieler dort noch nie abgefragt wurde) */
  ranks: Partial<Record<BoardKey, PlayerRank>>;
  /**
   * Twitch-Login des Spielers; weicht bei einigen Spielern von der ID ab (z. B. rohaze → xrohat). Wird für
   * Twitch-Live-Status und Follower gebraucht und gemerkt, sobald der Spieler einmal live war oder
   * /api/player/<id> ihn liefert.
   */
  twitchLogin: string | null;
  /** Zuletzt von Twitch gelieferte Follower-Gesamtzahl als Delta-Basis */
  followers: number | null;
  followersAt: string | null;
  /** Ob der Streamer bei seiner vorigen Follower-Messung auf dem Server war */
  followersOnlineAtSample: boolean;
  /** Seit Trackerstart gemessene Follower-Zuwächse während aufeinanderfolgender Server-Messungen */
  followersOnServer: number;
  /** Follower-Zuwachs auf dem Server im aktuellen Stream */
  followersOnLiveStream: number;
  /** Stream, zu dem die letzte Follower-Messung gehörte */
  followersLiveAtSample: string | null;
  /** Follower-Gesamtzahl zu Beginn des aktuellen Streams (letzte Messung davor); Zuwachs im Stream = jetzt − diese */
  followersAtLiveStart?: number | null;
  firstSeen: string;
  lastSeen: string;
  /** Beginn der aktuellen Online-Session */
  sessionStart: string | null;
  /** Summe abgeschlossener Sessions in Sekunden (vom Tracker gemessen) */
  trackedSeconds: number;
  /**
   * Stand der gemessenen Online-Zeit (inkl. laufender Session), als die API zuletzt eine frische Spielzeit
   * lieferte. Spielzeit außerhalb der Top 10 = letzter API-Wert + (Online-Zeit jetzt − dieser Stand). null = unbekannt.
   */
  playtimeTracked: number | null;
  sessions: number;
  liveSince: string | null;
  peakViewers: number;
  /** Höchste Zuschauerzahl im aktuell laufenden Stream */
  livePeakViewers: number;
  /** Höchste Zuschauerzahl, während der Spieler gleichzeitig auf dem Server war */
  peakViewersOnServer: number;
  /** Vom Tracker gemessene Stream-Zeit (Sekunden), während der Spieler auf dem Server war */
  streamOnServerSeconds: number;
  /** Vom Tracker gemessene Stream-Zeit (Sekunden), während der Spieler nicht auf dem Server war */
  streamOffServerSeconds: number;
  /** Längste vom Tracker gemessene Session in Sekunden */
  longestSession: number;
  /** Letzter Zeitpunkt, zu dem die Strecke gestiegen ist (null = keine Streckendaten) */
  lastMoveAt: string | null;
  /** Seit wann der Spieler als AFK gilt (Strecke seit ≥ AFK-Schwelle unverändert); null = nicht AFK */
  afkSince: string | null;
  /** Vom Tracker gemessene AFK-Zeit in Sekunden (zählt zur Online-Zeit dazu, wird nicht abgezogen) */
  afkSeconds: number;
  /** Spieler farmt gerade (innerhalb der AFK-Phase): Mobs oder Blöcke, mindestens AFK_FARM_MIN pro Minute */
  afkFarm: AfkKind | null;
  /** Mobs/Blöcke-Zähler zu Beginn der laufenden AFK-Phase */
  afkMobsAt: number | null;
  afkBlocksAt: number | null;
  /** Laufende Farm-Prüfung (Fenster und Farm-Beginn); null = keine AFK-Phase */
  afkCheck: AfkCheck | null;
  /** Zusatzwerte der letzten /api/player/<id>-Abfrage; null = noch nie abgefragt */
  detail: PlayerDetail | null;
}

export interface RecordValue {
  value: number;
  at: string;
}
export interface TrackerRecords {
  peakOnline: RecordValue | null;
  peakViewers: RecordValue | null;
  peakLive: RecordValue | null;
}

/** Ein Messpunkt pro Spieler (nur gespeichert, wenn sich etwas geändert hat oder 5 Min vergangen sind) */
export interface PlayerPoint {
  at: string;
  online: boolean;
  viewers: number | null;
  playtimeSeconds: number | null;
  deaths: number | null;
  diamonds: number | null;
  blocksBroken: number | null;
  mobsKilled: number | null;
  distance: number | null;
  damageDealt: number | null;
  totemsUsed: number | null;
  foodEaten: number | null;
  followersOnServer: number | null;
  followersTotal: number | null;
  ranks: Partial<Record<BoardKey, PlayerRank>>;
  streamGameId: string | null;
  streamGameName: string | null;
  /** Zusatzwerte aus /api/player/<id> zu diesem Zeitpunkt (API-Keys); leer = nicht frisch abgefragt */
  extra?: Record<string, number>;
  /** Vom Tracker gezählte Twitch-Abos; separate Ereignis-Zeitreihe kann dieses Feld ergänzen */
  twitchSubs?: number | null;
  twitchBits?: number | null;
  /** Geschätzte Twitch-Einnahmen auf dem Server, aufsummiert (Euro) */
  twitchEarnings?: number | null;
}

export interface TotalsPoint {
  at: string;
  onlineCount: number;
  playerCount?: number | null;
  liveCount: number;
  viewers: number;
  playtimeSeconds: number;
  deaths: number;
}

export interface TrackerState {
  startedAt: string;
  lastPoll: string | null;
  lastOk: string | null;
  lastError: string | null;
  polls: number;
  serverOnline: boolean | null;
  latest: ApiStats | null;
  latestFeed: FeedItem[] | null;
  players: Record<string, PlayerState>;
  history: TotalsPoint[];
  eventCount: number;
  records: TrackerRecords;
  /** Tode laut Gesamtzähler, die noch keinem Spieler zugeordnet werden konnten (werden erst nach Wartezeit gemeldet) */
  pendingDeaths: number;
  pendingSince: string | null;
  /** Spieler, die für die offenen Tode in Frage kommen (online, ohne Einzelstatistik); genau einer → Zuordnung */
  pendingCandidates: string[];
}
