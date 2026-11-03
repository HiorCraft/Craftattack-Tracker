import "server-only";
import { getDb } from "./db";
import { createSwrCache } from "./swrCache";
import { ON_SERVER_GAP as COVER_GAP, onServerSql } from "./onServer";

/**
 * Geschätzte Twitch-Einnahmen aus Abos und Bits. Werbung ist nicht sichtbar und fehlt.
 *
 * Grundlage ist die Zeit auf dem Server: Die alten Abo-Ereignisse zählen nur, während der Streamer auf CraftAttack war,
 * also werden auch die Stunden nur dort gezählt. Ab Beginn der Einzelerfassung (Tabelle twitch_subs) sind Stufe, Prime
 * und Community-Geschenke bekannt; ältere Einträge werden mit dem dort gemessenen Wert je Eintrag umgerechnet.
 *
 * Anteil je Kanal (Twitch Plus Program, Stand 2024): wiederkehrende bezahlte Abos geben Plus Points (Stufe 1 = 1,
 * Stufe 2 = 2, Stufe 3 = 6; Prime und Geschenke 0). Ab 100 Punkten 60 %, ab 300 Punkten 70 %, ohne Obergrenze.
 * Geschenke werden zum erhöhten Satz bezahlt, Prime nicht. Gemessen werden nur geteilte Abo-Meldungen, also eine
 * Untergrenze der Punkte; Sonderverträge großer Kanäle sind nicht sichtbar.
 *
 * Was fehlt (die Werte sind eher eine Untergrenze): Verlängerungen, die nicht im Chat geteilt werden, Werbung,
 * Sponsoren, Spenden außerhalb von Twitch.
 */

/** Bruttopreise in Deutschland (Euro, inkl. 19 % USt.) */
export const SUB_PRICE_EUR = { t1: 4.99, t2: 9.99, t3: 24.99 } as const;
export const VAT = 0.19;
/** 1 Bit = 1 US-Cent an den Streamer, umgerechnet */
export const BIT_EUR = 0.009;
export const SHARES = [50, 60, 70] as const;
export type Share = (typeof SHARES)[number];
/** "auto": Anteil je Kanal aus den geschätzten Plus Points */
export type ShareMode = Share | "auto";
/** Plus Points je Monat für 60 % bzw. 70 % */
export const PLUS_POINTS = { 60: 100, 70: 300 } as const;
/** Prime-Abos zahlen immer den Standardsatz */
const PRIME_SHARE = 0.5;

const SEASON_FROM = "2026-10-01";
/** Unter so vielen alten Einträgen mit genauer Gegenprobe gelten Startwerte */
const MIN_CALIBRATION = 300;
/** Startwert: Plus Points je altem Eintrag (erste Stunden der Einzelerfassung) */
const DEFAULT_POINTS_PER_ENTRY = 0.06;
const MIN_STREAM_MIN = 10;
const BASE_CACHE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const net = (gross: number) => gross / (1 + VAT);
const NET = { t1: net(SUB_PRICE_EUR.t1), t2: net(SUB_PRICE_EUR.t2), t3: net(SUB_PRICE_EUR.t3) };

export interface Tiers {
  /** bezahlte Abos je Stufe, ohne Prime */
  t1: number;
  t2: number;
  t3: number;
  prime: number;
  /** davon verschenkt (in t1–t3 enthalten) */
  gift: number;
  /** Plus Points (nur selbst bezahlte Abos und Verlängerungen) */
  points: number;
}
const noTiers = (): Tiers => ({ t1: 0, t2: 0, t3: 0, prime: 0, gift: 0, points: 0 });
const tierUnits = (t: Tiers) => t.t1 + t.t2 + t.t3 + t.prime;
const paidNet = (t: Tiers) => t.t1 * NET.t1 + t.t2 * NET.t2 + t.t3 * NET.t3;
/** Euro für den Streamer: bezahlte Abos zum Kanal-Anteil, Prime zum Standardsatz */
const tierEur = (t: Tiers, share: number) => paidNet(t) * share + t.prime * NET.t1 * PRIME_SHARE;

/** Abwicklung je altem Eintrag (gemessen oder Startwert) */
interface PerEntry {
  paid: number;
  prime: number;
  units: number;
  points: number;
}
const DEFAULT_PER_ENTRY: PerEntry = { paid: NET.t1, prime: 0, units: 1, points: DEFAULT_POINTS_PER_ENTRY };
const entryEur = (e: PerEntry, share: number) => e.paid * share + e.prime * PRIME_SHARE;

interface BaseStream {
  player: string;
  start: number;
  end: number;
  vod: string | null;
  running: boolean;
  serverMin: number;
  /** alte Zählung (Abo-Ereignisse je Minute, nur auf dem Server) */
  legacy: number;
  bitsServer: number;
  bitsAll: number;
  /** genaue Erfassung, falls der Stream danach begann */
  precise: { server: Tiers; all: Tiers } | null;
}

export interface ChannelShare {
  /** geschätzte Plus Points je Monat (Untergrenze) */
  points: number;
  share: Share;
}

interface Base {
  streams: BaseStream[];
  /** Beginn der Einzelerfassung */
  preciseFrom: number | null;
  /** Beginn der alten Zählung */
  countedFrom: number | null;
  calibration: (PerEntry & { entries: number }) | null;
  perEntry: PerEntry;
  channels: Map<string, ChannelShare>;
  /** Einnahmen auf dem Server (automatischer Anteil) je Spieler: Zeitpunkte und aufsummierte Euro */
  timeline: Map<string, { t: number[]; cum: number[] }>;
  /**
   * Abos auf dem Server je Spieler, nach denselben Regeln wie die Einnahmen: genaue Einträge einzeln (verschenkte je
   * Empfänger, Sammelmeldungen nicht doppelt), alte Einträge mal gemessenem Faktor. Kachel, „Sub-Stars“ und Graph
   * zählen damit dasselbe, was die Einnahmen bewerten.
   */
  subsTimeline: Map<string, { t: number[]; cum: number[] }>;
  loadedAt: number;
}

// „Auf dem Server“ wie überall (lib/onServer.ts): kurz davor ein Verlaufspunkt online und live
const covered = onServerSql;

/** Plus Points einer Abo-Meldung (selbst bezahlt, nicht Prime) */
const POINTS_SQL = `CASE WHEN kind IN ('sub', 'resub') THEN CASE plan WHEN '1000' THEN 1 WHEN '2000' THEN 2 WHEN '3000' THEN 6 ELSE 0 END ELSE 0 END`;

/**
 * Einzelmeldungen, ein Community-Geschenk zählt einmal (größer aus Ankündigung und Einzelmeldungen), Weitergaben
 * zählen nicht (das Geschenk selbst kommt als eigene Meldung). `where` filtert twitch_subs (Alias t).
 */
const subRowsSql = (where: string) => `
  WITH grouped AS (
    SELECT channel_id, min(at) AS at, max(plan) AS plan, bool_or(on_server AND ${covered("t.channel_id", "t.at")}) AS on_server,
           greatest(coalesce(max(gift_count) FILTER (WHERE kind LIKE '%submysterygift'), 0),
                    count(*) FILTER (WHERE kind NOT LIKE '%submysterygift'))::int AS units
      FROM twitch_subs t WHERE gift_group IS NOT NULL AND ${where} GROUP BY channel_id, gift_group
  ), single AS (
    SELECT channel_id, at, plan, on_server AND ${covered("t.channel_id", "t.at")} AS on_server, kind, ${POINTS_SQL} AS points,
           CASE WHEN kind LIKE '%submysterygift' THEN coalesce(gift_count, 0)
                WHEN kind LIKE '%payforward' THEN 0 ELSE 1 END AS units
      FROM twitch_subs t WHERE gift_group IS NULL AND ${where}
  )
  SELECT channel_id, at, plan, units, true AS gift, on_server, 0 AS points FROM grouped WHERE units > 0
  UNION ALL
  SELECT channel_id, at, plan, units, kind LIKE '%gift' AND kind NOT LIKE '%upgrade' AS gift, on_server, points FROM single WHERE units > 0
  ORDER BY at`;

interface SubRow {
  channel_id: string;
  at: Date;
  plan: string | null;
  units: number;
  gift: boolean;
  on_server: boolean;
  points: number;
}

function addSub(t: Tiers, r: SubRow) {
  const key = r.plan === "Prime" ? "prime" : r.plan === "3000" ? "t3" : r.plan === "2000" ? "t2" : "t1";
  t[key] += r.units;
  if (r.gift) t.gift += r.units;
  t.points += r.points;
}

const shareFor = (points: number): Share => (points >= PLUS_POINTS[70] ? 70 : points >= PLUS_POINTS[60] ? 60 : 50);

async function loadBase(): Promise<Base> {
  const db = await getDb();
  const [first, counted] = await Promise.all([
    // Beginn der genauen Erfassung im Live-Chat. Nicht einfach der früheste Eintrag: Das VOD-Nachtragen schreibt auch
    // ältere Einträge (Kennung „vod-…“, z. B. 10./11. Okt.), davor und dazwischen gilt aber weiter die alte Zählung.
    // Mit dem frühesten Eintrag fiel die alte Zählung vom 12. bis 28. Okt. weg.
    db.query<{ at: Date | null }>(`SELECT min(at) AS at FROM twitch_subs WHERE id LIKE 'twitch-irc-%'`),
    // Abos werden erst seit diesem Zeitpunkt gezählt; frühere Streams hätten scheinbar keine Einnahmen
    db.query<{ at: Date | null }>(`SELECT min(at) AS at FROM events WHERE type = 'subscription' AND meta->>'serverOnline' = 'true'`),
  ]);
  const preciseFrom = first.rows[0]?.at?.getTime() ?? null;
  const countedFrom = counted.rows[0]?.at?.getTime() ?? null;
  const preciseDate = new Date(preciseFrom ?? 8.64e15);

  const [streamRows, subRows, legacyRows, bitRows] = await Promise.all([
    db.query<{
      player: string;
      st: Date;
      en: Date;
      vod: string | null;
      running: boolean;
      server_min: number;
      legacy: number;
      bits_server: number;
      bits_all: number;
    }>(
      `WITH ended AS (
         SELECT DISTINCT ON (player, st) player, st, st + make_interval(secs => secs) AS en, vod, false AS running FROM (
           SELECT player, (meta->>'streamSeconds')::float8 AS secs, meta->>'vodUrl' AS vod,
                  coalesce((meta->>'startedAt')::timestamptz, at - make_interval(secs => (meta->>'streamSeconds')::float8)) AS st
             FROM events WHERE type = 'stream_end' AND at >= $1 AND player IS NOT NULL AND meta->>'streamSeconds' IS NOT NULL
         ) x ORDER BY player, st, en DESC
       ), running AS (
         SELECT DISTINCT ON (player) player, coalesce((meta->>'startedAt')::timestamptz, at) AS st, now() AS en, NULL::text AS vod, true AS running
           FROM events s WHERE type = 'stream_start' AND at >= now() - interval '2 days' AND player IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM events e WHERE e.type = 'stream_end' AND e.player = s.player AND e.at >= s.at)
          ORDER BY player, at DESC
       ), streams AS (
         SELECT * FROM ended UNION ALL SELECT * FROM running r
          WHERE NOT EXISTS (SELECT 1 FROM ended d WHERE d.player = r.player AND d.en > r.st)
       )
       SELECT s.player, s.st, s.en, s.vod, s.running,
         (SELECT coalesce(sum(least(extract(epoch FROM nx - at), 300)) FILTER (WHERE nx - at <= interval '${COVER_GAP}'), 0) / 60
            FROM (SELECT h.at, h.viewers, h.online, lead(h.at) OVER (ORDER BY h.at) AS nx FROM player_history h
                   WHERE h.player = s.player AND h.at >= s.st AND h.at < s.en) x
           WHERE viewers IS NOT NULL AND online)::float8 AS server_min,
         (SELECT coalesce(sum(e.value), 0)::int FROM events e
           WHERE e.player = s.player AND e.at >= s.st AND e.at < s.en AND e.type IN ('subscription', 'subscription_gift')
             AND e.meta->>'serverOnline' = 'true' AND ${covered("e.player", "e.at")}) AS legacy,
         (SELECT coalesce(sum(c.bits) FILTER (WHERE c.on_server AND ${covered("c.channel_id", "c.at")}), 0)::int FROM twitch_cheers c
           WHERE c.channel_id = s.player AND c.at >= s.st AND c.at < s.en) AS bits_server,
         (SELECT coalesce(sum(c.bits), 0)::int FROM twitch_cheers c
           WHERE c.channel_id = s.player AND c.at >= s.st AND c.at < s.en) AS bits_all
       FROM streams s`,
      [SEASON_FROM],
    ),
    // Genaue Einträge erst ab Beginn der Live-Erfassung (davor zählt die alte Zählung; sonst doppelt)
    db.query<SubRow>(subRowsSql("t.at >= $1"), [preciseDate]),
    // Alte Zählung auf dem Server, je Minute (nur vor der Einzelerfassung, danach zählt diese)
    db.query<{ player: string; at: Date; n: number; ok: boolean }>(
      `SELECT e.player, date_trunc('minute', e.at) AS at, sum(e.value)::int AS n, bool_or(${covered("e.player", "e.at")}) AS ok
         FROM events e
        WHERE e.type IN ('subscription', 'subscription_gift') AND e.meta->>'serverOnline' = 'true' AND e.player IS NOT NULL
          AND e.at < $1
        GROUP BY 1, 2`,
      [preciseDate],
    ),
    db.query<{ channel_id: string; at: Date; bits: number }>(
      `SELECT c.channel_id, c.at, c.bits FROM twitch_cheers c WHERE c.on_server AND ${covered("c.channel_id", "c.at")}`,
    ),
  ]);

  const byPlayer = new Map<string, BaseStream[]>();
  const streams: BaseStream[] = streamRows.rows
    .filter((r) => countedFrom !== null && r.st.getTime() >= countedFrom)
    .map((r) => ({
      player: r.player,
      start: r.st.getTime(),
      end: r.en.getTime(),
      vod: r.vod,
      running: r.running,
      serverMin: r.server_min,
      legacy: r.legacy,
      bitsServer: r.bits_server,
      bitsAll: r.bits_all,
      precise: preciseFrom !== null && r.st.getTime() >= preciseFrom ? { server: noTiers(), all: noTiers() } : null,
    }))
    .sort((a, b) => a.start - b.start);
  for (const s of streams) {
    const list = byPlayer.get(s.player) ?? [];
    list.push(s);
    byPlayer.set(s.player, list);
  }
  for (const r of subRows.rows) {
    const t = r.at.getTime();
    const s = byPlayer.get(r.channel_id)?.find((x) => x.start <= t && t < x.end);
    if (!s?.precise) continue;
    addSub(s.precise.all, r);
    if (r.on_server) addSub(s.precise.server, r);
  }

  // Gegenprobe: abgeschlossene Streams mit beiden Zählungen
  const sum = { entries: 0, paid: 0, prime: 0, units: 0, points: 0 };
  for (const s of streams) {
    if (!s.precise || s.running) continue;
    sum.entries += s.legacy;
    sum.paid += paidNet(s.precise.server);
    sum.prime += s.precise.server.prime * NET.t1;
    sum.units += tierUnits(s.precise.server);
    sum.points += s.precise.server.points;
  }
  const calibration =
    sum.entries >= MIN_CALIBRATION
      ? {
          paid: sum.paid / sum.entries,
          prime: sum.prime / sum.entries,
          units: sum.units / sum.entries,
          points: sum.points / sum.entries,
          entries: sum.entries,
        }
      : null;
  const perEntry = calibration ?? DEFAULT_PER_ENTRY;

  // Plus Points je Kanal: genaue Meldungen (ganzer Stream) plus alte Einträge davor, auf 30 Tage hochgerechnet
  const loadedAt = Date.now();
  const days = countedFrom === null ? 1 : Math.max(1, (loadedAt - countedFrom) / DAY_MS);
  const rawPoints = new Map<string, number>();
  for (const r of subRows.rows) if (r.points > 0) rawPoints.set(r.channel_id, (rawPoints.get(r.channel_id) ?? 0) + r.points);
  for (const r of legacyRows.rows) rawPoints.set(r.player, (rawPoints.get(r.player) ?? 0) + r.n * perEntry.points);
  const channels = new Map<string, ChannelShare>();
  for (const [id, p] of rawPoints) {
    const points = (p * 30) / Math.min(30, days);
    channels.set(id, { points, share: shareFor(points) });
  }
  const autoShare = (id: string) => (channels.get(id)?.share ?? 50) / 100;

  // Zeitleiste auf dem Server (automatischer Anteil)
  const inc = new Map<string, [number, number][]>();
  const push = (id: string, t: number, eur: number) => {
    if (eur <= 0) return;
    const list = inc.get(id) ?? [];
    list.push([t, eur]);
    inc.set(id, list);
  };
  for (const r of legacyRows.rows) if (r.ok) push(r.player, r.at.getTime(), r.n * entryEur(perEntry, autoShare(r.player)));
  for (const r of subRows.rows) {
    if (!r.on_server) continue;
    const t = noTiers();
    addSub(t, r);
    push(r.channel_id, r.at.getTime(), tierEur(t, autoShare(r.channel_id)));
  }
  for (const r of bitRows.rows) push(r.channel_id, r.at.getTime(), r.bits * BIT_EUR);
  const cumulate = (m: Map<string, [number, number][]>) => {
    const out = new Map<string, { t: number[]; cum: number[] }>();
    for (const [id, list] of m) {
      list.sort((a, b) => a[0] - b[0]);
      let run = 0;
      out.set(id, { t: list.map((x) => x[0]), cum: list.map((x) => (run += x[1])) });
    }
    return out;
  };
  const timeline = cumulate(inc);
  // Abos (Einheiten) auf dem Server, gleiche Quellen wie oben
  const units = new Map<string, [number, number][]>();
  const pushUnits = (id: string, t: number, n: number) => {
    if (n <= 0) return;
    const list = units.get(id) ?? [];
    list.push([t, n]);
    units.set(id, list);
  };
  for (const r of legacyRows.rows) if (r.ok) pushUnits(r.player, r.at.getTime(), r.n * perEntry.units);
  for (const r of subRows.rows) {
    if (!r.on_server) continue;
    const t = noTiers();
    addSub(t, r);
    pushUnits(r.channel_id, r.at.getTime(), tierUnits(t));
  }
  const subsTimeline = cumulate(units);

  return { streams, preciseFrom, countedFrom, calibration, perEntry, channels, timeline, subsTimeline, loadedAt };
}

const swr = createSwrCache();
const getBase = () => swr("earnings-base", BASE_CACHE_MS, loadBase);

/* ------------------------------------------------------------------ Bewertung */

export interface EarningStream {
  player: string;
  start: number;
  end: number;
  vod: string | null;
  running: boolean;
  serverMin: number;
  streamMin: number;
  /** Abos auf dem Server (alte Streams: umgerechnet) */
  subs: number;
  bits: number;
  /** geschätzte Einnahmen auf dem Server, Euro */
  eur: number;
  /** genaue Erfassung: Stufen auf dem Server und Einnahmen im ganzen Stream */
  tiers: Tiers | null;
  eurAll: number | null;
}

export interface EarningPlayer {
  id: string;
  /** verwendeter Anteil (automatisch oder gewählt) */
  share: Share;
  /** geschätzte Plus Points je Monat (Untergrenze) */
  points: number;
  streams: number;
  hours: number;
  subs: number;
  gifted: number | null;
  bits: number;
  eur: number;
  perStream: number;
  perHour: number;
  /** €/h der letzten 7 Tage gegenüber den 7 Tagen davor (null: zu wenig Stunden) */
  trend: number | null;
  tiers: Tiers;
  /** Anteil der Stunden mit genauer Erfassung */
  preciseShare: number;
}

export interface Earnings {
  mode: ShareMode;
  preciseFrom: number | null;
  calibration: Base["calibration"];
  perEntry: PerEntry;
  players: EarningPlayer[];
  /** Kanäle je Anteil (automatisch) */
  shareCounts: Record<Share, number>;
  /** Tage (Berlin) nach Streamstart, aufsteigend */
  days: string[];
  /** Euro je Spieler und Tag, Index wie `days` */
  daily: Record<string, number[]>;
  /** Stunden auf dem Server je Spieler und Tag */
  dailyHours: Record<string, number[]>;
  totals: { eur: number; hours: number; subs: number; bits: number; streams: number };
  from: number | null;
  to: number | null;
}

const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

function channelShare(b: Base, id: string, mode: ShareMode): Share {
  return mode === "auto" ? (b.channels.get(id)?.share ?? 50) : mode;
}

function value(b: Base, s: BaseStream, share: Share): EarningStream {
  const f = share / 100;
  const p = s.precise;
  return {
    player: s.player,
    start: s.start,
    end: s.end,
    vod: s.vod,
    running: s.running,
    serverMin: s.serverMin,
    streamMin: Math.round((s.end - s.start) / 60_000),
    subs: p ? tierUnits(p.server) : s.legacy * b.perEntry.units,
    bits: s.bitsServer,
    eur: (p ? tierEur(p.server, f) : s.legacy * entryEur(b.perEntry, f)) + s.bitsServer * BIT_EUR,
    tiers: p ? p.server : null,
    eurAll: p ? tierEur(p.all, f) + s.bitsAll * BIT_EUR : null,
  };
}

export const parseShareMode = (v: unknown): ShareMode => (SHARES.includes(Number(v) as Share) ? (Number(v) as Share) : "auto");

export async function getEarnings(mode: ShareMode): Promise<Earnings> {
  const b = await getBase();
  const streams = b.streams.filter((s) => s.serverMin >= MIN_STREAM_MIN).map((s) => value(b, s, channelShare(b, s.player, mode)));
  const days = [...new Set(streams.map((s) => berlinDay.format(s.start)))].sort();
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const daily: Record<string, number[]> = {};
  const dailyHours: Record<string, number[]> = {};
  const now = b.loadedAt;
  const agg = new Map<string, { list: EarningStream[]; recent: [number, number]; before: [number, number] }>();
  for (const s of streams) {
    const di = dayIndex.get(berlinDay.format(s.start))!;
    (daily[s.player] ??= days.map(() => 0))[di] += s.eur;
    (dailyHours[s.player] ??= days.map(() => 0))[di] += s.serverMin / 60;
    const a = agg.get(s.player) ?? { list: [], recent: [0, 0], before: [0, 0] };
    a.list.push(s);
    const age = now - s.start;
    const slot = age < 7 * DAY_MS ? a.recent : age < 14 * DAY_MS ? a.before : null;
    if (slot) {
      slot[0] += s.eur;
      slot[1] += s.serverMin / 60;
    }
    agg.set(s.player, a);
  }
  const players: EarningPlayer[] = [...agg].map(([id, a]) => {
    const hours = a.list.reduce((x, s) => x + s.serverMin, 0) / 60;
    const eur = a.list.reduce((x, s) => x + s.eur, 0);
    const tiers = noTiers();
    let preciseHours = 0;
    for (const s of a.list) {
      if (!s.tiers) continue;
      preciseHours += s.serverMin / 60;
      for (const k of ["t1", "t2", "t3", "prime", "gift", "points"] as const) tiers[k] += s.tiers[k];
    }
    const enough = a.recent[1] >= 3 && a.before[1] >= 3;
    return {
      id,
      share: channelShare(b, id, mode),
      points: b.channels.get(id)?.points ?? 0,
      streams: a.list.length,
      hours,
      subs: a.list.reduce((x, s) => x + s.subs, 0),
      gifted: preciseHours > 0 ? tiers.gift : null,
      bits: a.list.reduce((x, s) => x + s.bits, 0),
      eur,
      perStream: eur / a.list.length,
      perHour: hours > 0 ? eur / hours : 0,
      trend: enough && a.before[0] > 0 ? a.recent[0] / a.recent[1] / (a.before[0] / a.before[1]) - 1 : null,
      tiers,
      preciseShare: hours > 0 ? preciseHours / hours : 0,
    };
  });
  players.sort((x, y) => y.eur - x.eur);
  const shareCounts: Record<Share, number> = { 50: 0, 60: 0, 70: 0 };
  for (const p of players) shareCounts[b.channels.get(p.id)?.share ?? 50]++;
  return {
    mode,
    preciseFrom: b.preciseFrom,
    calibration: b.calibration,
    perEntry: b.perEntry,
    players,
    shareCounts,
    days,
    daily,
    dailyHours,
    totals: {
      eur: players.reduce((x, p) => x + p.eur, 0),
      hours: players.reduce((x, p) => x + p.hours, 0),
      subs: players.reduce((x, p) => x + p.subs, 0),
      bits: players.reduce((x, p) => x + p.bits, 0),
      streams: streams.length,
    },
    from: streams.length ? streams[0].start : null,
    to: streams.length ? Math.max(...streams.map((s) => s.end)) : null,
  };
}

/** Streams eines Spielers, neueste zuerst */
export async function getEarningStreams(id: string, mode: ShareMode): Promise<EarningStream[]> {
  const b = await getBase();
  const share = channelShare(b, id, mode);
  return b.streams
    .filter((s) => s.player === id && s.serverMin >= MIN_STREAM_MIN)
    .map((s) => value(b, s, share))
    .reverse();
}

/* ------------------------------------------------------------------ Kennzahl für Graph und Spielerseite */

/** Aufsummierte Einnahmen auf dem Server bis `t` (automatischer Anteil) */
function cumAt(line: { t: number[]; cum: number[] } | undefined, t: number): number {
  if (!line) return 0;
  let lo = 0;
  let hi = line.t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (line.t[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : line.cum[lo - 1];
}

/**
 * Zeitreihe für den Graph-Baukasten: aufsummierte Einnahmen auf dem Server je Bündel (Stand am Bündelende), nur
 * Bündel mit Zuwachs plus ein Startpunkt. Ohne Spieler: alle zusammen.
 */
export async function getEarningsSeries(
  players: string[],
  from: number | null,
  to: number,
  bucketMinutes: number,
): Promise<{ id: string; points: { at: string; v: number }[] }[]> {
  const b = await getBase();
  const start = from ?? b.countedFrom ?? to;
  const size = bucketMinutes * 60_000;
  const lines = players.length ? players.map((id) => ({ id, ids: [id] })) : [{ id: "alle", ids: [...b.timeline.keys()] }];
  return lines.map(({ id, ids }) => {
    const buckets = new Set<number>();
    for (const pid of ids) {
      for (const t of b.timeline.get(pid)?.t ?? []) if (t >= start && t <= to) buckets.add(Math.floor(t / size) * size);
    }
    const first = Math.floor(start / size) * size;
    const at = [first, ...[...buckets].filter((x) => x > first).sort((x, y) => x - y)];
    const total = (t: number) => ids.reduce((s, pid) => s + cumAt(b.timeline.get(pid), t), 0);
    return { id, points: at.map((x) => ({ at: new Date(x).toISOString(), v: Math.round(total(x + size - 1) * 100) / 100 })) };
  });
}

/** Abos auf dem Server je Spieler (wie die Einnahmen gezählt) über die Zeit, für den Graphen */
export async function getSubsSeries(players: string[], from: number | null, to: number, bucketMinutes: number): Promise<{ id: string; points: { at: string; v: number }[] }[]> {
  const b = await getBase();
  const start = from ?? b.countedFrom ?? to;
  const size = bucketMinutes * 60_000;
  const lines = players.length ? players.map((id) => ({ id, ids: [id] })) : [{ id: "alle", ids: [...b.subsTimeline.keys()] }];
  return lines.map(({ id, ids }) => {
    const buckets = new Set<number>();
    for (const pid of ids) for (const t of b.subsTimeline.get(pid)?.t ?? []) if (t >= start && t <= to) buckets.add(Math.floor(t / size) * size);
    const first = Math.floor(start / size) * size;
    const at = [first, ...[...buckets].filter((x) => x > first).sort((x, y) => x - y)];
    const total = (t: number) => ids.reduce((s, pid) => s + cumAt(b.subsTimeline.get(pid), t), 0);
    return { id, points: at.map((x) => ({ at: new Date(x).toISOString(), v: Math.round(total(x + size - 1)) })) };
  });
}

/** Abos eines Spielers auf dem Server: Summe, seit `since` (laufender Stream) und Verlauf für die Sparkline */
export async function getPlayerSubs(id: string, since: number | null): Promise<{ total: number; currentStream: number; history: { at: string; value: number }[] }> {
  const b = await getBase();
  const line = b.subsTimeline.get(id);
  const total = line?.cum[line.cum.length - 1] ?? 0;
  const before = since !== null ? cumAt(line, since - 1) : total;
  const step = Math.max(1, Math.ceil((line?.t.length ?? 0) / 200));
  const history = (line?.t ?? [])
    .map((t, i) => ({ at: new Date(t).toISOString(), value: Math.round(line!.cum[i]) }))
    .filter((_, i, all) => i % step === 0 || i === all.length - 1);
  return { total: Math.round(total), currentStream: Math.round(total - before), history };
}

/** Rangliste: Abos auf dem Server je Spieler (wie die Einnahmen gezählt) */
export async function getSubsTotals(): Promise<Map<string, { value: number; at: number }>> {
  const b = await getBase();
  return new Map([...b.subsTimeline].map(([id, line]) => [id, { value: Math.round(line.cum[line.cum.length - 1] ?? 0), at: line.t[line.t.length - 1] ?? 0 }]));
}

/** Rangliste: Einnahmen auf dem Server je Spieler (automatischer Anteil) */
export async function getEarningsTotals(): Promise<Map<string, number>> {
  const b = await getBase();
  return new Map([...b.timeline].map(([id, line]) => [id, line.cum[line.cum.length - 1] ?? 0]));
}

export interface StreamTotals {
  /** Abos im ganzen Stream (genaue Erfassung) bzw. auf dem Server (alte Zählung) */
  subs: number;
  subsOnServer: number;
  eur: number;
  eurOnServer: number;
  /** false: Stream begann vor der Einzelerfassung, nur die alte Zählung auf dem Server */
  precise: boolean;
}

/** Laufende Streams: Abos und geschätzte Einnahmen seit Streamstart, frisch aus der Datenbank */
export async function getStreamTotals(streams: { player: string; startedAt: string | null }[]): Promise<Map<string, StreamTotals>> {
  const wanted = streams.filter((s): s is { player: string; startedAt: string } => Boolean(s.startedAt));
  const out = new Map<string, StreamTotals>();
  if (!wanted.length) return out;
  const b = await getBase();
  const db = await getDb();
  const ids = wanted.map((s) => s.player);
  const starts = wanted.map((s) => new Date(s.startedAt));
  const since = `t.at >= (SELECT w.st FROM unnest($1::text[], $2::timestamptz[]) AS w(id, st) WHERE w.id = t.channel_id)`;
  const [subs, legacy, bits] = await Promise.all([
    db.query<SubRow>(subRowsSql(`t.channel_id = ANY($1) AND ${since}`), [ids, starts]),
    db.query<{ player: string; n: number }>(
      `SELECT e.player, sum(e.value)::int AS n FROM events e
         JOIN unnest($1::text[], $2::timestamptz[]) AS w(id, st) ON w.id = e.player AND e.at >= w.st
        WHERE e.type IN ('subscription', 'subscription_gift') AND e.meta->>'serverOnline' = 'true'
        GROUP BY 1`,
      [ids, starts],
    ),
    db.query<{ channel_id: string; bits_all: number; bits_server: number }>(
      `SELECT c.channel_id, sum(c.bits)::int AS bits_all, (sum(c.bits) FILTER (WHERE c.on_server))::int AS bits_server FROM twitch_cheers c
         JOIN unnest($1::text[], $2::timestamptz[]) AS w(id, st) ON w.id = c.channel_id AND c.at >= w.st
        GROUP BY 1`,
      [ids, starts],
    ),
  ]);
  const all = new Map<string, Tiers>();
  const server = new Map<string, Tiers>();
  for (const r of subs.rows) {
    const a = all.get(r.channel_id) ?? noTiers();
    addSub(a, r);
    all.set(r.channel_id, a);
    if (r.on_server) {
      const s = server.get(r.channel_id) ?? noTiers();
      addSub(s, r);
      server.set(r.channel_id, s);
    }
  }
  const legacyOf = new Map(legacy.rows.map((r) => [r.player, r.n]));
  const bitsOf = new Map(bits.rows.map((r) => [r.channel_id, r]));
  for (const s of wanted) {
    const f = channelShare(b, s.player, "auto") / 100;
    const bit = bitsOf.get(s.player);
    const bitsAll = (bit?.bits_all ?? 0) * BIT_EUR;
    const bitsServer = (bit?.bits_server ?? 0) * BIT_EUR;
    const precise = b.preciseFrom !== null && Date.parse(s.startedAt) >= b.preciseFrom;
    if (precise) {
      const a = all.get(s.player) ?? noTiers();
      const v = server.get(s.player) ?? noTiers();
      out.set(s.player, {
        subs: tierUnits(a),
        subsOnServer: tierUnits(v),
        eur: tierEur(a, f) + bitsAll,
        eurOnServer: tierEur(v, f) + bitsServer,
        precise,
      });
    } else {
      const n = legacyOf.get(s.player) ?? 0;
      const eur = n * entryEur(b.perEntry, f) + bitsServer;
      out.set(s.player, { subs: Math.round(n * b.perEntry.units), subsOnServer: Math.round(n * b.perEntry.units), eur, eurOnServer: eur, precise });
    }
  }
  return out;
}

export interface PlayerEarnings {
  /** Einnahmen auf dem Server seit Beginn der Zählung */
  total: number;
  share: Share;
  points: number;
  perHour: number | null;
  history: { at: string; value: number }[];
}

export async function getPlayerEarnings(id: string): Promise<PlayerEarnings> {
  const b = await getBase();
  const line = b.timeline.get(id);
  const share = channelShare(b, id, "auto");
  const own = b.streams.filter((s) => s.player === id && s.serverMin >= MIN_STREAM_MIN).map((s) => value(b, s, share));
  const hours = own.reduce((x, s) => x + s.serverMin, 0) / 60;
  const eur = own.reduce((x, s) => x + s.eur, 0);
  // Verlauf für die Sparkline: höchstens ~200 Punkte
  const step = Math.max(1, Math.ceil((line?.t.length ?? 0) / 200));
  const history = (line?.t ?? [])
    .map((t, i) => ({ at: new Date(t).toISOString(), value: line!.cum[i] }))
    .filter((_, i, all) => i % step === 0 || i === all.length - 1);
  return {
    total: line?.cum[line.cum.length - 1] ?? 0,
    share,
    points: b.channels.get(id)?.points ?? 0,
    perHour: hours >= 1 ? eur / hours : null,
    history,
  };
}
