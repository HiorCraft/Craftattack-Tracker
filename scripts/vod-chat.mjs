#!/usr/bin/env node
/**
 * Twitch-Chat aus VODs nachtragen (Dauerdienst, langsam im Hintergrund).
 *
 *   DATABASE_URL=… node scripts/vod-chat.mjs [--deadline 2026-11-30T00:00:00Z] [--once]
 *
 * Liest die Chat-Wiedergabe der Archiv-VODs (twitch_vods, siehe lib/twitchHistory.ts) über die GQL-Schnittstelle der
 * Twitch-Website, die der Tracker auch für Follower-Zahlen nutzt. Nur Seiten nach Zeitpunkt (Seiten per Cursor
 * verlangen eine Integritätsprüfung, die wird nicht umgangen). Ältestes zuerst, alle Kanäle zeitlich gleichauf.
 *
 * Gelesen wird nur, was der Live-Chat (lib/twitchIrc.ts) nicht hat: alles vor CHAT_START (Chat zwischen Spielern
 * erst ab da, Abos ab dem 14.10.) und danach Zeitfenster, in denen der Live-Chat nichts aufgezeichnet hat.
 *
 * Aus den Zeilen der Wiedergabe:
 * - „X subscribed at Tier 1 / with Prime. They've subscribed for N months!“ → twitch_subs (sub/resub)
 * - „X is gifting N Tier 1 Subs to …'s community!“ und „X gifted a Tier 1 sub to Y!“ → twitch_subs (Geschenke)
 * - Cheermotes („Cheer100“) → twitch_cheers
 * - „N raiders from X have joined!“ → Raid-Ereignis mit Zuschauerzahl (nur Raids zwischen Spielern, wie live)
 * - Nachrichten von Spielern im Chat eines anderen Spielers → twitch_chat_messages und Chat-Ereignis
 * Auf dem Server (Zuschauer-Abo-Minuten, Cheer-Ereignisse) gilt, wenn der Streamer laut Verlauf online war.
 * Doppelte gegenüber dem Live-Chat werden über Inhalt und Zeitnähe erkannt und übersprungen.
 *
 * Tempo: so schnell wie vertretbar (MIN_DELAY_MS zwischen zwei Anfragen), damit nichts verloren geht, bevor Twitch
 * oder der Streamer das VOD löscht. Bei Fehlern lange Pausen, bei 429 wird der Abstand größer. Fortschritt in
 * vod_chat_progress. Die Frist dient nur noch der Anzeige.
 *
 * Reihenfolge nach Ablaufrisiko: zuerst Kanäle, die VODs schon vorzeitig gelöscht haben (verschwinden oft nach einem
 * Tag), dann Kanäle mit kurzer Aufbewahrung (7 Tage), dann alle übrigen nach Ablaufdatum (Partner: 60 Tage).
 */
import pg from "pg";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEADLINE = Date.parse(opt("deadline", process.env.VOD_CHAT_DEADLINE ?? "2026-11-30T00:00:00Z"));
const ONCE = args.includes("--once");
/** Zum Ausprobieren: nach so vielen Anfragen aufhören */
const MAX_REQUESTS = Number(opt("max", "0"));
const SEASON_START = Date.parse(process.env.CA_SEASON_START ?? "2026-10-10T10:00:00Z");
/** Ab hier zeichnet der Live-Chat Nachrichten zwischen Spielern auf (vorher alles aus der Wiedergabe) */
const CHAT_START = Date.parse(process.env.VOD_CHAT_FULL_UNTIL ?? "2026-10-19T10:06:00Z");
/** Ohne Live-Aufzeichnung so lange (global, über alle Kanäle) gilt der Live-Chat als aus */
const IRC_GAP_MS = 30 * 60_000;
/** Neueste Stunden noch nicht lesen (Live-Chat ist dort zuständig, VODs wachsen noch) */
const RECENT_MS = 3 * 3600_000;
const MIN_DELAY_MS = Number(process.env.VOD_CHAT_MIN_DELAY_MS ?? 1_000);
/** Aufbewahrung von VODs bei Twitch: Partner (und Turbo/Prime) 60 Tage, sonst 7 */
const DAY_MS = 86400_000;
const LONG_KEEP_MS = 60 * DAY_MS;
const SHORT_KEEP_MS = 7 * DAY_MS;
/** VOD gilt als nicht mehr gelistet, wenn die VOD-Liste (alle 30 Min) es so lange nicht mehr gesehen hat */
const UNLISTED_MS = 3 * 3600_000;
const MAX_DELAY_MS = 60_000;
const GQL_URL = "https://gql.twitch.tv/gql";
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const CHEER_EVENT_MIN_BITS = Number(process.env.CA_CHEER_EVENT_MIN ?? 1000);
const CHAT_EVENT_MAX_LENGTH = 300;
/** Bekannte Cheermote-Präfixe (Twitch); Wort = Präfix + Zahl */
const CHEERMOTE = /^(cheer|doodlecheer|biblethump|cheerwhal|corgo|scoops|uni|showlove|party|seemsgood|pride|kappa|frankerz|heyguys|dansgame|elegiggle|trihard|kreygasm|4head|swiftrage|notlikethis|failfish|vohiyo|pjsalt|mrdestructoid|bday|ripcheer|shamrock|bitboss|streamlabs|muxy|holidaycheer|goal|anon|charity|hypecheer)(\d+)$/i;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL fehlt");
const ssl = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : { rejectUnauthorized: false };
const db = new pg.Pool({ connectionString: url, ssl, max: 2, application_name: "actracker-vod-chat" });
const q = (sql, params) => db.query(sql, params);
const log = (...a) => console.log(`[vod-chat]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

await q(`ALTER TABLE IF EXISTS vod_chat_progress ADD COLUMN IF NOT EXISTS read_s integer NOT NULL DEFAULT 0`);
await q(`
  CREATE TABLE IF NOT EXISTS vod_chat_progress (
    vod_id     text PRIMARY KEY,
    player     text NOT NULL,
    position_s integer NOT NULL DEFAULT 0,
    done       boolean NOT NULL DEFAULT false,
    requests   integer NOT NULL DEFAULT 0,
    read_s     integer NOT NULL DEFAULT 0,
    comments   integer NOT NULL DEFAULT 0,
    found      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

/* ---------- Was gelesen werden muss ---------- */

/** Zeitfenster ohne Live-Chat nach CHAT_START (keine Abo-, Chat- oder Raid-Zeile aus dem Live-Chat) */
async function ircOutages() {
  // Ereignisse aus dem Live-Chat (Abo-Minuten gibt es seit dem 14.10., die Einzel-Abos erst seit dem 29.10.)
  const rows = (
    await q(
      `SELECT at AS t FROM events
        WHERE type IN ('subscription', 'subscription_gift', 'cheer', 'raid', 'chat') AND at >= $1
          AND coalesce(meta->>'source', '') <> 'vod' AND coalesce(meta->>'estimated', '') <> 'true'
        ORDER BY at`,
      [new Date(CHAT_START)],
    )
  ).rows.map((r) => r.t.getTime());
  const out = [];
  let prev = CHAT_START;
  for (const t of [...rows, Date.now() - RECENT_MS]) {
    if (t - prev > IRC_GAP_MS) out.push([prev, t]);
    prev = Math.max(prev, t);
  }
  return out;
}

/** Je VOD die Abschnitte (Sekunden ab VOD-Beginn), die gelesen werden müssen */
async function plan() {
  const outages = await ircOutages();
  // Je Kanal: Aufbewahrung (ältestes noch gelistetes VOD) und ob schon VODs vorzeitig verschwunden sind
  const channels = new Map(
    (
      await q(
        `SELECT player,
                max(extract(epoch FROM now() - created_at)) FILTER (WHERE fetched_at > now() - make_interval(secs => $1)) AS oldest_listed_s,
                bool_or(fetched_at <= now() - make_interval(secs => $1) AND created_at > now() - interval '50 days') AS deletes
           FROM twitch_vods GROUP BY player`,
        [UNLISTED_MS / 1000],
      )
    ).rows.map((r) => [r.player, { long: Number(r.oldest_listed_s ?? 0) >= 8 * 86400, deletes: r.deletes === true }]),
  );
  const vods = (
    await q(
      `SELECT v.id, v.player, v.login, v.created_at, v.duration_s, coalesce(p.position_s, 0) AS position_s, coalesce(p.done, false) AS done
         FROM twitch_vods v LEFT JOIN vod_chat_progress p ON p.vod_id = v.id
        WHERE v.created_at + make_interval(secs => v.duration_s) >= $1
        ORDER BY v.created_at`,
      [new Date(SEASON_START)],
    )
  ).rows;
  const limit = Date.now() - RECENT_MS;
  const work = [];
  for (const v of vods) {
    if (v.done) continue;
    const start = v.created_at.getTime();
    const end = Math.min(start + v.duration_s * 1000, limit);
    const ranges = [];
    // Chat vor dem Staffelbeginn (Stunden vor 12 Uhr) ist uninteressant
    if (start < CHAT_START) ranges.push([Math.max(start, SEASON_START - 2 * 3600_000), Math.min(end, CHAT_START)]);
    for (const [a, b] of outages) if (b > start && a < end) ranges.push([Math.max(a, start, CHAT_START), Math.min(b, end)]);
    const sec = ranges
      .filter(([a, b]) => b > a)
      .map(([a, b]) => [Math.floor((a - start) / 1000), Math.ceil((b - start) / 1000)])
      .map(([a, b]) => [Math.max(a, v.position_s), b])
      .filter(([a, b]) => b > a);
    const finished = start + v.duration_s * 1000 < limit;
    const ch = channels.get(v.player) ?? { long: false, deletes: false };
    // Spätester sicherer Zeitpunkt: löschfreudige Kanäle sofort nach dem Ende, sonst nach Aufbewahrung
    const expires = ch.deletes ? start + v.duration_s * 1000 + DAY_MS / 2 : start + (ch.long ? LONG_KEEP_MS : SHORT_KEEP_MS);
    work.push({ ...v, start, ranges: sec, finished, expires, risk: ch.deletes ? 0 : ch.long ? 2 : 1 });
  }
  return work;
}

/* ---------- Spieler und Zustand ---------- */

let players = new Map();
let byLogin = new Map();
async function loadPlayers() {
  const rows = (await q(`SELECT id, name, uuid, twitch_login FROM players`)).rows;
  players = new Map(rows.map((r) => [r.id, r]));
  byLogin = new Map(rows.filter((r) => r.twitch_login).map((r) => [r.twitch_login.toLowerCase(), r]));
  for (const r of rows) if (!byLogin.has(r.id.toLowerCase())) byLogin.set(r.id.toLowerCase(), r);
}

/** War der Streamer zu dem Zeitpunkt auf dem Server? (letzter Verlaufspunkt davor, höchstens 3 Min alt) */
const onlineCache = new Map();
async function onServer(player, t) {
  const key = `${player}|${Math.floor(t / 60_000)}`;
  if (onlineCache.has(key)) return onlineCache.get(key);
  const r = (await q(`SELECT at, online FROM player_history WHERE player = $1 AND at <= $2 ORDER BY at DESC LIMIT 1`, [player, new Date(t)])).rows[0];
  const v = Boolean(r && r.online && t - r.at.getTime() <= 3 * 60_000);
  if (onlineCache.size > 50_000) onlineCache.clear();
  onlineCache.set(key, v);
  return v;
}

/** Laufender Stream laut VOD (für streamStartedAt der Abo-Minuten) */
async function streamStart(player, t) {
  const r = (await q(`SELECT created_at FROM twitch_vods WHERE player = $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1`, [player, new Date(t)])).rows[0];
  return r ? r.created_at.toISOString() : null;
}

/* ---------- Twitch ---------- */

class Blocked extends Error {}

async function fetchComments(vodId, offset) {
  const body = {
    query: `query { video(id: "${vodId}") { comments(contentOffsetSeconds: ${Math.max(0, Math.floor(offset))}) { edges { node { id createdAt contentOffsetSeconds commenter { login displayName } message { fragments { text } } } } } } }`,
  };
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Client-ID": GQL_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
  if (!res.ok) throw new Blocked(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.errors?.length) {
    const msg = j.errors.map((e) => e.message).join("; ");
    if (/integrity|forbidden|unauthori/i.test(msg)) throw new Blocked(msg);
    throw Object.assign(new Error(msg), { retry: true });
  }
  if (!j.data?.video) return null; // VOD gelöscht
  return j.data.video.comments?.edges?.map((e) => e.node) ?? [];
}

/* ---------- Auswertung einer Zeile ---------- */

const SUB_RE = /^(\S+) subscribed (?:at Tier (\d)|with Prime)\.(?: They've subscribed for (\d+) months?)?/;
const MYSTERY_RE = /^(\S+) is gifting (\d+) Tier (\d) Subs? to /;
const GIFT_RE = /^(\S+) gifted a Tier (\d) sub to (\S+?)!/;
const RAID_RE = /^(\d+) raiders? from (\S+) have joined/;

/** Gruppe des letzten Community-Geschenks je Kanal und Schenker (für die Einzelmeldungen danach) */
const giftGroups = new Map();

async function exists(sql, params) {
  return (await q(sql, params)).rows.length > 0;
}

async function addSubMinute(owner, at, count, extraMeta = {}) {
  const minute = Math.floor(at / 60_000) * 60_000;
  // Hat der Live-Chat in dieser Minute Abos im Kanal gezählt, lief er und hat dieses Abo schon mitgezählt
  if (await exists(`SELECT 1 FROM events WHERE player = $1 AND type IN ('subscription', 'subscription_gift') AND id NOT LIKE 'vod-%' AND at BETWEEN $2 AND $3 LIMIT 1`, [owner.id, new Date(minute - 60_000), new Date(minute + 120_000)])) return;
  const started = await streamStart(owner.id, at);
  await q(
    `INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta)
     VALUES ($1, $2, 'subscription', $3, $4, $5, 'twitch', $6, $6, $7)
     ON CONFLICT (id) DO UPDATE SET delta = COALESCE(events.delta, 0) + EXCLUDED.delta, value = COALESCE(events.value, 0) + EXCLUDED.value`,
    [`vod-subs-${owner.id}-${minute}`, new Date(minute), owner.id, owner.name, owner.uuid, count, JSON.stringify({ channel: owner.twitch_login ?? owner.id, bucket: "minute", streamStartedAt: started, serverOnline: true, source: "vod", ...extraMeta })],
  );
}

async function handle(owner, n, found) {
  const text = (n.message?.fragments ?? []).map((f) => f.text).join("").trim();
  const login = n.commenter?.login?.toLowerCase() ?? "";
  const at = Date.parse(n.createdAt);
  if (!text || !Number.isFinite(at)) return;
  const near = (ms) => [new Date(at - ms), new Date(at + ms)];
  let m;

  if ((m = text.match(MYSTERY_RE))) {
    const gifter = login || m[1].toLowerCase();
    const count = Number(m[2]);
    if (await exists(`SELECT 1 FROM twitch_subs WHERE channel_id = $1 AND kind LIKE '%submysterygift' AND coalesce(from_login, '') = $2 AND at BETWEEN $3 AND $4 LIMIT 1`, [owner.id, gifter, ...near(5 * 60_000)])) return;
    const group = `vod-${n.id}`;
    giftGroups.set(`${owner.id}|${gifter}`, { group, at, left: count });
    const on = await onServer(owner.id, at);
    await q(`INSERT INTO twitch_subs (id, at, channel_id, kind, plan, months, gift_count, gift_group, from_login, on_server) VALUES ($1, $2, $3, 'submysterygift', $4, NULL, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`, [
      `vod-${n.id}`, new Date(at), owner.id, `${m[3]}000`, count, group, gifter, on,
    ]);
    if (on) {
      const giver = byLogin.get(gifter);
      const liveCounted = await exists(`SELECT 1 FROM events WHERE player = $1 AND type IN ('subscription', 'subscription_gift') AND id NOT LIKE 'vod-%' AND at BETWEEN $2 AND $3 LIMIT 1`, [owner.id, new Date(at - 120_000), new Date(at + 120_000)]);
      if (liveCounted) {
        /* Live-Chat hat das Geschenk schon gezählt */
      } else if (giver && giver.id !== owner.id)
        await q(
          `INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta) VALUES ($1, $2, 'subscription_gift', $3, $4, $5, 'twitch', $6, $6, $7) ON CONFLICT (id) DO NOTHING`,
          [`vod-gift-${n.id}`, new Date(at), owner.id, owner.name, owner.uuid, count, JSON.stringify({ channel: owner.twitch_login ?? owner.id, bucket: "minute", serverOnline: true, giftGiverPlayerId: giver.id, giftGiverName: giver.name, giftGiverUuid: giver.uuid, giftCount: count, source: "vod" })],
        );
      else await addSubMinute(owner, at, count);
    }
    found.gifts = (found.gifts ?? 0) + count;
    return;
  }
  if ((m = text.match(GIFT_RE))) {
    const gifter = login || m[1].toLowerCase();
    const g = giftGroups.get(`${owner.id}|${gifter}`);
    const inGroup = g && at - g.at < 5 * 60_000 && g.left > 0;
    if (inGroup) g.left--;
    if (!inGroup && (await exists(`SELECT 1 FROM twitch_subs WHERE channel_id = $1 AND kind LIKE '%subgift' AND coalesce(from_login, '') = $2 AND id NOT LIKE 'vod-%' AND at BETWEEN $3 AND $4 LIMIT 1`, [owner.id, gifter, ...near(5 * 60_000)]))) return;
    const on = await onServer(owner.id, at);
    await q(`INSERT INTO twitch_subs (id, at, channel_id, kind, plan, months, gift_count, gift_group, from_login, on_server) VALUES ($1, $2, $3, 'subgift', $4, NULL, NULL, $5, $6, $7) ON CONFLICT (id) DO NOTHING`, [
      `vod-${n.id}`, new Date(at), owner.id, `${m[2]}000`, inGroup ? g.group : null, gifter, on,
    ]);
    // Einzelmeldungen eines Community-Geschenks zählen nicht noch einmal
    if (!inGroup && on) await addSubMinute(owner, at, 1);
    if (!inGroup) found.gifts = (found.gifts ?? 0) + 1;
    return;
  }
  if ((m = text.match(SUB_RE))) {
    const months = m[3] ? Number(m[3]) : 1;
    const kind = months > 1 ? "resub" : "sub";
    if (await exists(`SELECT 1 FROM twitch_subs WHERE channel_id = $1 AND kind IN ('sub', 'resub') AND from_login = $2 AND at BETWEEN $3 AND $4 LIMIT 1`, [owner.id, login, ...near(3 * 60_000)])) return;
    const on = await onServer(owner.id, at);
    await q(`INSERT INTO twitch_subs (id, at, channel_id, kind, plan, months, gift_count, gift_group, from_login, on_server) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8) ON CONFLICT (id) DO NOTHING`, [
      `vod-${n.id}`, new Date(at), owner.id, kind, m[2] ? `${m[2]}000` : "Prime", months, login, on,
    ]);
    if (on) await addSubMinute(owner, at, 1);
    found.subs = (found.subs ?? 0) + 1;
    return;
  }
  if ((m = text.match(RAID_RE))) {
    const raider = byLogin.get(m[2].toLowerCase());
    if (!raider || raider.id === owner.id) return;
    if (await exists(`SELECT 1 FROM events WHERE type = 'raid' AND player = $1 AND meta->>'raidTargetPlayerId' = $2 AND at BETWEEN $3 AND $4 LIMIT 1`, [raider.id, owner.id, ...near(30 * 60_000)])) return;
    await q(`INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta) VALUES ($1, $2, 'raid', $3, $4, $5, 'twitch', NULL, $6, $7) ON CONFLICT (id) DO NOTHING`, [
      `vod-raid-${n.id}`, new Date(at), raider.id, raider.name, raider.uuid, Number(m[1]),
      JSON.stringify({ raidLogin: raider.twitch_login ?? raider.id, raidTargetPlayerId: owner.id, raidTargetName: owner.name, raidTargetUuid: owner.uuid, raidTargetLogin: owner.twitch_login ?? owner.id, source: "vod" }),
    ]);
    found.raids = (found.raids ?? 0) + 1;
    return;
  }
  // Cheers: Cheermotes im Text
  const bits = text.split(/\s+/).reduce((s, w) => {
    const c = w.match(CHEERMOTE);
    return s + (c ? Number(c[2]) : 0);
  }, 0);
  if (bits > 0 && login) {
    if (!(await exists(`SELECT 1 FROM twitch_cheers WHERE channel_id = $1 AND from_login = $2 AND bits = $3 AND at BETWEEN $4 AND $5 LIMIT 1`, [owner.id, login, bits, ...near(3 * 60_000)]))) {
      const on = await onServer(owner.id, at);
      const id = `vod-cheer-${n.id}`;
      const fromName = n.commenter?.displayName || login;
      await q(`INSERT INTO twitch_cheers (id, at, channel_id, from_login, from_name, bits, on_server) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`, [id, new Date(at), owner.id, login, fromName, bits, on]);
      if (on && bits >= CHEER_EVENT_MIN_BITS) {
        const cheerer = byLogin.get(login);
        await q(`INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta) VALUES ($1, $2, 'cheer', $3, $4, $5, 'twitch', $6, $6, $7) ON CONFLICT (id) DO NOTHING`, [
          id, new Date(at), owner.id, owner.name, owner.uuid, bits,
          JSON.stringify({ bits, fromName, fromLogin: login, channel: owner.twitch_login ?? owner.id, source: "vod", ...(cheerer && cheerer.id !== owner.id ? { fromPlayerId: cheerer.id, fromPlayerName: cheerer.name, fromPlayerUuid: cheerer.uuid } : {}) }),
        ]);
      }
      found.bits = (found.bits ?? 0) + bits;
    }
  }
  // Nachricht eines Spielers im Chat eines anderen Spielers
  const sender = byLogin.get(login);
  if (!sender || sender.id === owner.id) return;
  if (await exists(`SELECT 1 FROM twitch_chat_messages WHERE sender_id = $1 AND channel_id = $2 AND message = $3 AND at BETWEEN $4 AND $5 LIMIT 1`, [sender.id, owner.id, text, ...near(2 * 60_000)])) return;
  const id = `twitch-chat-vod-${hash(n.id)}`;
  const r = await q(
    `INSERT INTO twitch_chat_messages (id, at, sender_id, sender_name, channel_id, channel_name, message, shared_with) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}') ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, new Date(at), sender.id, sender.name, owner.id, owner.name, text],
  );
  if (r.rows.length) {
    const short = text.length > CHAT_EVENT_MAX_LENGTH ? `${text.slice(0, CHAT_EVENT_MAX_LENGTH - 1)}…` : text;
    await q(`INSERT INTO events (id, at, type, player, player_name, uuid, "where", delta, value, meta) VALUES ($1, $2, 'chat', $3, $4, $5, 'twitch', NULL, NULL, $6) ON CONFLICT (id) DO NOTHING`, [
      `chat-${id}`, new Date(at), sender.id, sender.name, sender.uuid,
      JSON.stringify({ channelId: owner.id, channelName: owner.name, channelUuid: owner.uuid, channelLogin: owner.twitch_login ?? owner.id, message: short, source: "vod" }),
    ]);
    found.chat = (found.chat ?? 0) + 1;
  }
}

/* ---------- Ablauf ---------- */

/** Anfragen je VOD-Stunde (gemessen, Startwert grob) für die Tempo-Rechnung */
async function density() {
  const r = (await q(`SELECT sum(requests) AS req, sum(read_s) AS sec FROM vod_chat_progress WHERE requests > 0`)).rows[0];
  const sec = Number(r?.sec ?? 0);
  return sec > 3 * 3600 ? (Number(r.req) / sec) * 3600 : 80;
}

async function main() {
  await loadPlayers();
  let delay = MIN_DELAY_MS;
  let lastPlan = 0;
  let work = [];
  let errors = 0;
  let requestsDone = 0;
  for (;;) {
    if (Date.now() - lastPlan > 30 * 60_000 || !work.length) {
      await loadPlayers();
      work = (await plan()).filter((w) => w.ranges.length || w.finished);
      // VODs ohne Abschnitte (alles vom Live-Chat abgedeckt, fertig gesendet) gleich als erledigt markieren
      for (const w of work.filter((x) => !x.ranges.length && x.finished))
        await q(`INSERT INTO vod_chat_progress (vod_id, player, position_s, done) VALUES ($1, $2, $3, true) ON CONFLICT (vod_id) DO UPDATE SET done = true, updated_at = now()`, [w.id, w.player, w.duration_s]);
      work = work.filter((x) => x.ranges.length);
      const remainingSec = work.reduce((s, w) => s + w.ranges.reduce((t, [a, b]) => t + (b - a), 0), 0);
      const dens = await density();
      const remainingReq = (remainingSec / 3600) * dens;
      // So schnell wie vertretbar; nach 429 langsamer, mit der Zeit wieder schneller
      delay = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, delay * 0.8));
      lastPlan = Date.now();
      const etaH = (remainingReq * (delay + 400)) / 3600_000;
      const atRisk = work.filter((w) => w.risk < 2).length;
      log(`${work.length} VODs offen (${atRisk} gefährdet), ${Math.round(remainingSec / 3600)} VOD-Stunden, ~${Math.round(remainingReq)} Anfragen (${dens.toFixed(0)}/h), ${(delay / 1000).toFixed(1)} s Abstand, fertig in ~${etaH < 48 ? `${Math.round(etaH)} Std` : `${Math.round(etaH / 24)} Tagen`}${Date.now() + etaH * 3600_000 > DEADLINE ? ` (nach der Frist ${new Date(DEADLINE).toISOString().slice(0, 10)})` : ""}`);
      if (!work.length) {
        if (ONCE) break;
        await sleep(3 * 3600_000);
        continue;
      }
    }
    // Zuerst, was am ehesten verschwindet; bei gleichem Risiko zeitlich gleichauf (frühester offener Zeitpunkt)
    work.sort((a, b) => a.risk - b.risk || a.expires - b.expires || a.start + a.ranges[0][0] * 1000 - (b.start + b.ranges[0][0] * 1000));
    const w = work[0];
    const owner = players.get(w.player);
    const [from, to] = w.ranges[0];
    let comments;
    try {
      comments = await fetchComments(w.id, from);
      errors = 0;
    } catch (err) {
      errors++;
      // Zu schnell (429): Abstand dauerhaft vergrößern, damit es nicht wieder passiert
      if (/HTTP 429/.test(err.message)) delay = Math.min(MAX_DELAY_MS, delay * 2);
      const wait = err instanceof Blocked ? 6 * 3600_000 : Math.min(3600_000, 60_000 * 2 ** Math.min(6, errors));
      log(`Fehler (${err.message}), Pause ${Math.round(wait / 60_000)} Min`);
      await sleep(wait);
      continue;
    }
    const found = {};
    let next;
    if (comments === null) {
      log(`VOD ${w.id} (${w.player}) nicht mehr verfügbar`);
      next = Infinity;
    } else {
      for (const n of comments) if (owner && n.contentOffsetSeconds >= from && n.contentOffsetSeconds <= to) await handle(owner, n, found).catch((e) => log("Zeile übersprungen:", e.message));
      const last = comments[comments.length - 1];
      // Weiter ab dem letzten Zeitpunkt; lauter Kommentare in derselben Sekunde oder keine neuen: eine Sekunde weiter
      next = !last || last.contentOffsetSeconds <= from ? from + (comments.length ? 1 : 60) : last.contentOffsetSeconds;
      if (comments.length && comments[0].contentOffsetSeconds === last.contentOffsetSeconds) next = last.contentOffsetSeconds + 1;
    }
    if (next >= to) w.ranges.shift();
    else w.ranges[0] = [next, to];
    const position = w.ranges.length ? w.ranges[0][0] : w.duration_s;
    const done = comments === null || (!w.ranges.length && w.finished);
    await q(
      `INSERT INTO vod_chat_progress (vod_id, player, position_s, done, requests, read_s, comments, found) VALUES ($1, $2, $3, $4, 1, $7, $5, $6)
       ON CONFLICT (vod_id) DO UPDATE SET position_s = GREATEST(vod_chat_progress.position_s, EXCLUDED.position_s), done = EXCLUDED.done,
         requests = vod_chat_progress.requests + 1, read_s = vod_chat_progress.read_s + EXCLUDED.read_s, comments = vod_chat_progress.comments + EXCLUDED.comments,
         found = COALESCE((SELECT jsonb_object_agg(k, coalesce((vod_chat_progress.found->>k)::int, 0) + coalesce((EXCLUDED.found->>k)::int, 0))
                    FROM (SELECT jsonb_object_keys(vod_chat_progress.found || EXCLUDED.found) AS k) keys), '{}'::jsonb),
         updated_at = now()`,
      [w.id, w.player, Math.min(position, w.duration_s), done, comments?.length ?? 0, JSON.stringify(found), Math.max(0, Math.min(next, to) - from)],
    );
    if (!w.ranges.length) work.shift();
    if (MAX_REQUESTS && ++requestsDone >= MAX_REQUESTS) break;
    await sleep(MAX_REQUESTS ? 300 : delay * (0.8 + Math.random() * 0.4));
  }
  await db.end();
}

process.on("SIGTERM", () => {
  log("beendet");
  process.exit(0);
});
await main();
