import "server-only";
import { runsTracker } from "./mode";
import { ESTIMATE } from "./estimateMode";

/**
 * Datenbank-Anbindung.
 * `DATABASE_URL` enthält die PostgreSQL-Verbindung.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  kind: "postgres";
}

type Globals = typeof globalThis & { __acDb?: Promise<Db> };

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required to connect to PostgreSQL.");
  }

  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    // Hängende Abfragen abbrechen, statt Poller oder Chat-Verarbeitung für immer zu blockieren. Die Website bekommt
    // weniger Zeit, damit teure Seitenabfragen die gemeinsame Datenbank nicht für den Tracker auslasten.
    statement_timeout: runsTracker() ? 120_000 : 45_000,
    query_timeout: runsTracker() ? 130_000 : 50_000,
    // Nicht ewig auf eine nicht erreichbare DB warten; Verbindungen über das Internet wach halten
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    // Schätzung: zuerst die Sichten mit gefüllten Lücken (scripts/estimate.mjs), alles andere aus den echten Tabellen
    ...(ESTIMATE ? { options: "-c search_path=approx,public" } : {}),
  });
  // Bricht eine ungenutzte Verbindung ab (z. B. Neustart der DB), meldet pg das als "error" am Pool.
  // Ohne Handler beendet Node.js deshalb den ganzen Prozess. Der Pool baut bei der nächsten Abfrage neu auf.
  pool.on("error", (err) => console.warn("[tracker] DB-Verbindung abgebrochen:", err.message));
  const db: Db = {
    kind: "postgres",
    query: async (sql, params) => {
      const r = await pool.query(sql, params as never[]);
      return { rows: r.rows as never[] };
    },
  };
  // Die Schätzung liest nur; das Schema pflegt die normale Website bzw. der Tracker
  if (!ESTIMATE) await migrate(db);
  console.log(`[tracker] Datenbank: ${db.kind}${ESTIMATE ? " (Schätzung)" : ""}`);
  return db;
}

export function getDb(): Promise<Db> {
  const gl = globalThis as Globals;
  if (!gl.__acDb) {
    // Fehlgeschlagenen Verbindungsaufbau nicht merken: sonst bliebe jede weitere Anfrage kaputt, bis der
    // Prozess neu startet, auch wenn die DB längst wieder läuft. Der nächste Aufruf versucht es erneut.
    gl.__acDb = connect().catch((err: unknown) => {
      gl.__acDb = undefined;
      throw err;
    });
  }
  return gl.__acDb;
}

async function migrate(db: Db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tracker_meta (
      id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      started_at    timestamptz NOT NULL,
      last_poll     timestamptz,
      last_ok       timestamptz,
      last_error    text,
      polls         integer NOT NULL DEFAULT 0,
      server_online boolean,
      latest        jsonb,
      event_count   integer NOT NULL DEFAULT 0
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      id              text PRIMARY KEY,
      name            text NOT NULL,
      uuid            text NOT NULL DEFAULT '',
      online          boolean NOT NULL DEFAULT false,
      live            jsonb,
      stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
      first_seen      timestamptz NOT NULL,
      last_seen       timestamptz NOT NULL,
      session_start   timestamptz,
      tracked_seconds integer NOT NULL DEFAULT 0,
      sessions        integer NOT NULL DEFAULT 0,
      live_since      timestamptz,
      peak_viewers    integer NOT NULL DEFAULT 0
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS events (
      id          text PRIMARY KEY,
      at          timestamptz NOT NULL,
      type        text NOT NULL,
      player      text,
      player_name text,
      uuid        text,
      "where"     text NOT NULL,
      delta       double precision,
      value       double precision,
      meta        jsonb
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS feed_items (
      id     text PRIMARY KEY,
      at     timestamptz NOT NULL,
      type   text NOT NULL,
      player text NOT NULL,
      data   jsonb NOT NULL
    )`);
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS records jsonb`);
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS latest_feed jsonb`);
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS pending_deaths integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS pending_since timestamptz`);
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS pending_candidates jsonb`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS longest_session integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ranks jsonb`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS twitch_login text`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS peak_viewers_on_server integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stream_on_server_seconds integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS stream_off_server_seconds integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_move_at timestamptz`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS afk_since timestamptz`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS afk_seconds integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS afk_farm text`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS afk_mobs_at integer`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS afk_blocks_at integer`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS afk_check jsonb`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS playtime_tracked integer`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers integer`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers_at timestamptz`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers_online_at_sample boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers_on_server integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers_on_live_stream integer NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers_live_at_sample text`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS followers_at_live_start integer`);
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS live_peak_viewers integer NOT NULL DEFAULT 0`);
  // Zusatzwerte aus /api/player/<id> (platzierte Blöcke, Sprünge, Top-Blöcke, …)
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS detail jsonb`);
  // Stand der einmaligen Verlaufs-Korrekturen (siehe lib/backfill.ts)
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS history_fix integer NOT NULL DEFAULT 0`);
  // Stand der AFK-Neubewertung (siehe AFK_HISTORY_VERSION in lib/backfill.ts)
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS afk_history_version integer NOT NULL DEFAULT 0`);
  // Bis wohin Ereignisse aus den Zusatzwerten angelegt sind (lib/extraEvents.ts)
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS extra_events_until timestamptz`);
  // Früher ein gemeinsamer Typ „stat“ für alle Zusatzwerte, jetzt je Wert ein eigener
  await db.query(`UPDATE events SET type = meta->>'key' WHERE type = 'stat' AND meta->>'key' IS NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_at_idx ON events (at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_player_at_idx ON events (player, at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_type_at_idx ON events (type, at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS feed_items_type_at_idx ON feed_items (type, at)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS twitch_chat_messages (
      id           text PRIMARY KEY,
      at           timestamptz NOT NULL,
      sender_id    text NOT NULL,
      sender_name  text NOT NULL,
      channel_id   text NOT NULL,
      channel_name text NOT NULL,
      message      text NOT NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_chat_messages_at_idx ON twitch_chat_messages (at DESC, id DESC)`);
  // Geteilter Chat (Stream Together): weitere Spieler, in deren Chat dieselbe Nachricht ebenfalls erschien
  await db.query(`ALTER TABLE twitch_chat_messages ADD COLUMN IF NOT EXISTS shared_with text[]`);
  // Aufräumen aus der Zeit vor der Erkennung: Im geteilten Chat wurde dieselbe Nachricht (gleicher Absender, Text
  // und Zeitstempel auf die Millisekunde) je Kanal einmal gespeichert. Daraus wird eine Zeile mit `shared_with`.
  // War der Absender selbst einer der Kanäle, schrieb er im eigenen Chat: dann zählt die Nachricht gar nicht.
  // Ohne solche Gruppen ändert sich nichts.
  await db.query(`
    WITH g AS (
      SELECT sender_id, message, at, min(id) AS keep_id, array_agg(channel_id) AS chans
        FROM twitch_chat_messages GROUP BY sender_id, message, at HAVING count(*) > 1
    ), own AS (
      DELETE FROM twitch_chat_messages t USING g
       WHERE t.sender_id = g.sender_id AND t.message = g.message AND t.at = g.at AND g.sender_id = ANY(g.chans)
    ), keep AS (
      UPDATE twitch_chat_messages t
         SET shared_with = ARRAY(SELECT DISTINCT c FROM unnest(g.chans || COALESCE(t.shared_with, '{}')) AS c WHERE c <> t.channel_id)
        FROM g
       WHERE t.id = g.keep_id AND NOT (g.sender_id = ANY(g.chans))
    )
    DELETE FROM twitch_chat_messages t USING g
     WHERE t.sender_id = g.sender_id AND t.message = g.message AND t.at = g.at
       AND t.id <> g.keep_id AND NOT (g.sender_id = ANY(g.chans))`);
  // Geteilte Chats (Stream Together) zwischen Kanälen: aus der Twitch-API (session_id) oder, ohne API-Zugang,
  // aus geteilten Chat-Nachrichten erschlossen. participants = erfasste Spieler, other_count = weitere Kanäle.
  await db.query(`
    CREATE TABLE IF NOT EXISTS shared_chat_sessions (
      key          text PRIMARY KEY,
      session_id   text,
      source       text NOT NULL,
      participants text[] NOT NULL,
      other_count  integer NOT NULL DEFAULT 0,
      started_at   timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL,
      ended_at     timestamptz
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS shared_chat_sessions_started_idx ON shared_chat_sessions (started_at DESC)`);
  // Offizielle Termine von craftattack.one/events/: holt der Tracker stündlich, die Website liest nur von hier
  // (eine Zeile; bei einem Fehler bleibt der letzte gute Stand, nur `error` wird gesetzt).
  await db.query(`
    CREATE TABLE IF NOT EXISTS official_events (
      id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      events     jsonb NOT NULL DEFAULT '[]'::jsonb,
      fetched_at timestamptz,
      error      text,
      error_at   timestamptz
    )`);
  // Chat je Spieler im Profil (Tabelle ist auf 10.000 Nachrichten begrenzt, die Indizes bleiben klein)
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_chat_messages_sender_idx ON twitch_chat_messages (sender_id, at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_chat_messages_channel_idx ON twitch_chat_messages (channel_id, at DESC)`);
  // Cheers (Bits) in den Kanälen der Spieler, ohne Nachrichtentext. on_server: Streamer war dabei auf dem Server.
  await db.query(`
    CREATE TABLE IF NOT EXISTS twitch_cheers (
      id         text PRIMARY KEY,
      at         timestamptz NOT NULL,
      channel_id text NOT NULL,
      from_login text NOT NULL,
      from_name  text NOT NULL,
      bits       integer NOT NULL,
      on_server  boolean NOT NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_cheers_channel_idx ON twitch_cheers (channel_id, at DESC)`);
  // Jede Abo-Meldung einzeln mit Stufe (die Ereignisse fassen nur Anzahlen je Minute zusammen). gift_group verbindet
  // ein Community-Geschenk mit den Einzelmeldungen je Empfänger, damit es nicht doppelt zählt. Für die interne
  // Einnahmen-Schätzung; ohne Nachrichtentext und ohne Empfänger.
  await db.query(`
    CREATE TABLE IF NOT EXISTS twitch_subs (
      id         text PRIMARY KEY,
      at         timestamptz NOT NULL,
      channel_id text NOT NULL,
      kind       text NOT NULL,
      plan       text,
      months     integer,
      gift_count integer,
      gift_group text,
      from_login text,
      on_server  boolean NOT NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_subs_channel_idx ON twitch_subs (channel_id, at)`);
  // Köpfe und Skins (craftattack.one, mc-heads.net): bleiben über Deploys erhalten und werden ausgeliefert, wenn die
  // Quelle gerade nicht erreichbar ist (z. B. Cloudflare-Sperre). Ein paar hundert kleine Bilder.
  await db.query(`
    CREATE TABLE IF NOT EXISTS image_cache (
      key          text PRIMARY KEY,
      content_type text NOT NULL,
      body         bytea NOT NULL,
      fetched_at   timestamptz NOT NULL
    )`);
  // Chat-Spuren der Zuschauerwanderung (lib/chatMoves.ts): nur Summen je 5-Minuten-Abschnitt und Kanalpaar
  await db.query(`
    CREATE TABLE IF NOT EXISTS viewer_chat_moves (
      bin     integer NOT NULL,
      from_id text NOT NULL,
      to_id   text NOT NULL,
      n       integer NOT NULL DEFAULT 0,
      stay    integer NOT NULL DEFAULT 0,
      back    integer NOT NULL DEFAULT 0,
      PRIMARY KEY (bin, from_id, to_id)
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_history (
      player           text NOT NULL,
      at               timestamptz NOT NULL,
      online           boolean NOT NULL DEFAULT false,
      viewers          integer,
      playtime_seconds integer,
      deaths           integer,
      diamonds         integer,
      blocks_broken    integer,
      mobs_killed      integer,
      distance         double precision,
      damage_dealt     double precision,
      totems_used      integer,
      food_eaten       integer,
      followers_on_server integer,
      PRIMARY KEY (player, at)
    )`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS followers_on_server integer`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS damage_dealt double precision`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS totems_used integer`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS food_eaten integer`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS followers_total integer`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS ranks jsonb`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS stream_game_id text`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS stream_game_name text`);
  // Zusatzwerte aus /api/player/<id> als kompaktes integer[] (Reihenfolge: EXTRA_HISTORY_KEYS in lib/playerStats.ts),
  // höchstens alle 5 Minuten je Spieler gesetzt, sonst NULL (kostet dann nur ein Bit)
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS extra_stats integer[]`);
  // Top-Listen je Spieler (meistabgebaute Blöcke usw.): jede Minute, aber nur Änderungen; stündlich ein
  // vollständiger Stand als Anker. Kompakt als {"liste": {"item": anzahl}} ohne Anzeigenamen
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_top_history (
      player text NOT NULL,
      at     timestamptz NOT NULL,
      tops   jsonb NOT NULL,
      PRIMARY KEY (player, at)
    )`);
  // anchor = vollständiger Stand; false = nur die seit dem vorigen Stand geänderten Einträge.
  // Alte Zeilen waren immer vollständig. („full" wäre ein reserviertes Wort in PostgreSQL.)
  await db.query(`ALTER TABLE player_top_history ADD COLUMN IF NOT EXISTS anchor boolean NOT NULL DEFAULT true`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS history (
      at               timestamptz PRIMARY KEY,
      online_count     integer NOT NULL,
      player_count     integer,
      live_count       integer NOT NULL,
      viewers          integer NOT NULL,
      playtime_seconds bigint NOT NULL,
      deaths           integer NOT NULL
    )`);
  await db.query(`ALTER TABLE history ADD COLUMN IF NOT EXISTS player_count integer`);
  // Twitch-Verlauf aus der Helix-API (auch rückwirkend, z. B. für Tracker-Lücken): Archiv-VODs = Stream-Zeiten mit
  // Titel, Clips = Momente mit Zeitpunkt. Holt nur der Tracker (lib/twitchHistory.ts).
  await db.query(`
    CREATE TABLE IF NOT EXISTS twitch_vods (
      id         text PRIMARY KEY,
      player     text NOT NULL,
      login      text NOT NULL,
      created_at timestamptz NOT NULL,
      duration_s integer NOT NULL,
      title      text NOT NULL,
      view_count integer NOT NULL DEFAULT 0,
      fetched_at timestamptz NOT NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_vods_player_idx ON twitch_vods (player, created_at)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS twitch_clips (
      id           text PRIMARY KEY,
      player       text NOT NULL,
      created_at   timestamptz NOT NULL,
      title        text NOT NULL,
      view_count   integer NOT NULL DEFAULT 0,
      creator_name text,
      vod_id       text,
      vod_offset   integer,
      duration     real,
      url          text NOT NULL,
      thumbnail    text,
      fetched_at   timestamptz NOT NULL
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_clips_player_idx ON twitch_clips (player, created_at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS twitch_clips_views_idx ON twitch_clips (view_count DESC)`);
  // Clip entstand, während der Streamer auf dem Server war (gesetzt von lib/twitchHistory.ts; NULL = noch offen)
  await db.query(`ALTER TABLE twitch_clips ADD COLUMN IF NOT EXISTS on_server boolean`);
  // Früher: Tabelle user_files für das entfernte Konto-Feature. Bestehende (leere) Tabellen bleiben unangetastet.
}
