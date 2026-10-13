import "server-only";
import path from "node:path";

/**
 * Datenbank-Anbindung.
 * - `DATABASE_URL` gesetzt → echtes PostgreSQL über `pg`
 * - sonst → PGlite (eingebettetes PostgreSQL, Dateien unter `data/pglite`)
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  kind: "postgres" | "pglite";
}

type Globals = typeof globalThis & { __acDb?: Promise<Db> };

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  let db: Db;
  if (url) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 5 });
    db = {
      kind: "postgres",
      query: async (sql, params) => {
        const r = await pool.query(sql, params as never[]);
        return { rows: r.rows as never[] };
      },
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = path.join(process.cwd(), "data", "pglite");
    const lite = await PGlite.create(dir);
    db = {
      kind: "pglite",
      query: async (sql, params) => {
        const r = await lite.query(sql, params as never[]);
        return { rows: r.rows as never[] };
      },
    };
  }
  await migrate(db);
  console.log(`[tracker] Datenbank: ${db.kind}`);
  return db;
}

export function getDb(): Promise<Db> {
  const gl = globalThis as Globals;
  if (!gl.__acDb) gl.__acDb = connect();
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
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS records jsonb`);
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
  await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS live_peak_viewers integer NOT NULL DEFAULT 0`);
  // Stand der einmaligen Verlaufs-Korrekturen (siehe lib/backfill.ts)
  await db.query(`ALTER TABLE tracker_meta ADD COLUMN IF NOT EXISTS history_fix integer NOT NULL DEFAULT 0`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_at_idx ON events (at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_player_at_idx ON events (player, at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS events_type_at_idx ON events (type, at)`);
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
      followers_on_server integer,
      PRIMARY KEY (player, at)
    )`);
  await db.query(`ALTER TABLE player_history ADD COLUMN IF NOT EXISTS followers_on_server integer`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS history (
      at               timestamptz PRIMARY KEY,
      online_count     integer NOT NULL,
      live_count       integer NOT NULL,
      viewers          integer NOT NULL,
      playtime_seconds bigint NOT NULL,
      deaths           integer NOT NULL
    )`);
}
