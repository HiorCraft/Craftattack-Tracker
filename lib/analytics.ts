import "server-only";
import { connection } from "next/server";
import { getDb } from "./db";
import { ensureLoaded, getAllSessions, getDailyEventSum, getEvents, getState, getTopSnapshotsAt, type StoredSession } from "./store";
import { EVENT_META } from "./events";
import { AFK_MS, AFK_FARM_WINDOW_MS, POLL_INTERVAL_MS, farmKindOf } from "./tracker";
import type { BoardKey, TrackerEvent, TrackerState, AfkKind } from "./types";
import { BOARD_KEYS } from "./types";
import { EXTRA_HISTORY_KEYS, extraStatSql, type ExtraStatKey } from "./playerStats";
import type { TopCategory } from "./leaderboards";
import { createSwrCache } from "./swrCache";
import { snapshot } from "./snapshots";

/* ============================================================ Tage (Europe/Berlin) */

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });
const partsFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", weekday: "short", hourCycle: "h23" });

/** Kalendertag (YYYY-MM-DD) in Berliner Zeit */
export const dayKey = (ms: number) => dayFmt.format(new Date(ms));

/** Mitternacht (Berlin) eines Tages als Millisekunden – robust gegen Sommer-/Winterzeit */
function dayStart(day: string): number {
  let t = Date.parse(`${day}T00:00:00Z`) - 2 * 3600_000; // Startschätzung (MESZ)
  for (let i = 0; i < 3; i++) {
    const hour = Number(partsFmt.formatToParts(new Date(t)).find((p) => p.type === "hour")?.value ?? 0);
    const key = dayKey(t);
    if (key === day && hour === 0) return t;
    // Korrigieren: Stunden-Differenz zurückrechnen
    const dayDiff = key < day ? 1 : key > day ? -1 : 0;
    t += dayDiff * 86400_000 - hour * 3600_000;
  }
  return t;
}

function shiftDay(day: string, days: number): string {
  return dayKey(dayStart(day) + 12 * 3600_000 + days * 86400_000);
}

const isValidDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/** Berliner Wochentag (0 = Montag) und Stunde eines Zeitpunkts */
function berlinSlot(ms: number): { dow: number; hour: number } {
  const parts = partsFmt.formatToParts(new Date(ms));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
  return { dow: dow < 0 ? 0 : dow, hour: hour % 24 };
}

/* ============================================================ Cache */

const swr = createSwrCache();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  await connection();
  return swr(key, ttlMs, load);
}

/* ============================================================ Streams als Sessions */

/** Live-Phasen aller Spieler aus Stream-an/aus-Ereignissen (laufende Streams: end = null). */
export async function getLiveSessions(): Promise<StoredSession[]> {
  await ensureLoaded();
  const db = await getDb();
  const rows = (
    await db.query<{ player: string; at: Date; type: string; meta: TrackerEvent["meta"] | null }>(
      `SELECT player, at, type, meta FROM events WHERE type IN ('stream_start', 'stream_end') AND player IS NOT NULL ORDER BY at ASC, id ASC`,
    )
  ).rows;
  const open = new Map<string, string>();
  const out: StoredSession[] = [];
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    if (r.type === "stream_end") {
      const secs = Number(r.meta?.streamSeconds ?? 0);
      const start = open.get(r.player) ?? new Date(Date.parse(at) - secs * 1000).toISOString();
      out.push({ player: r.player, start, end: at });
      open.delete(r.player);
    } else open.set(r.player, at);
  }
  const state = await getState();
  for (const [player, start] of open) {
    const p = state.players[player];
    out.push({ player, start, end: p?.live ? null : (p?.lastSeen ?? start) });
  }
  for (const p of Object.values(state.players)) {
    if (p.live && p.liveSince && !out.some((s) => s.player === p.id && s.end === null)) out.push({ player: p.id, start: p.liveSince, end: null });
  }
  return out;
}

/** Erster Zeitpunkt, ab dem es Daten gibt */
async function firstDataAt(): Promise<number | null> {
  return cached("firstAt", 300_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const r = (await db.query<{ at: Date | null }>(`SELECT min(at) AS at FROM history`)).rows[0];
    return r?.at ? new Date(r.at).getTime() : null;
  });
}

/** Einzelheiten eines AFK-Farm-Abschnitts innerhalb einer AFK-Phase (für den rückwirkenden Nachtrag der Farm-Ereignisse) */
export interface AfkFarmInfo {
  /** Beginn der Farm (ms) = Beginn des ersten Abschnitts mit ausreichender Rate */
  at: number;
  /** Gefarmte Menge der Art im ersten Abschnitt und dessen Länge (Sekunden) */
  atValue: number;
  windowSeconds: number;
  /** Gefarmte Menge der Art über die ganze Farm */
  value: number;
  mobs: number;
  blocks: number;
  /** Beginn der umgebenden AFK-Phase (ms) */
  afkSince: number;
  /** Farm endete mit dem Leave (oder dem letzten Gesehen-Zeitpunkt) statt mit Bewegung */
  byLeave: boolean;
  /** Farm endete, aber die AFK-Phase lief weiter (Rate unter AFK_FARM_MIN pro Minute) */
  stillAfk: boolean;
}

/** Zeitspanne [von, bis] in ms; AFK-Phasen tragen optional die Art (AFK-Farm) und deren Einzelheiten */
export type Span = [a: number, b: number, kind?: AfkKind, farm?: AfkFarmInfo];

function clip(sessions: StoredSession[], from: number, to: number, now: number): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const s of sessions) {
    const a = Math.max(from, Date.parse(s.start));
    const b = Math.min(to, s.end ? Date.parse(s.end) : now);
    if (b <= a) continue;
    const l = out.get(s.player) ?? [];
    l.push([a, b]);
    out.set(s.player, l);
  }
  for (const l of out.values()) l.sort((x, y) => x[0] - y[0]);
  return out;
}

export interface DayNav {
  day: string;
  prev: string | null;
  next: string | null;
  /** Erster Tag mit Daten und heute (für die Tagesauswahl) */
  firstDay: string;
  today: string;
  from: number;
  to: number;
  /** Ab wann an diesem Tag Daten vorliegen (null = ganzer Tag) */
  dataFrom: number | null;
}

async function dayNav(day: string | undefined, now: number): Promise<DayNav> {
  const today = dayKey(now);
  const d = day && isValidDay(day) && day <= today ? day : today;
  const first = await firstDataAt();
  const firstDay = first ? dayKey(first) : today;
  const from = dayStart(d);
  const to = dayStart(shiftDay(d, 1));
  return {
    day: d,
    prev: d > firstDay ? shiftDay(d, -1) : null,
    next: d < today ? shiftDay(d, 1) : null,
    firstDay,
    today,
    from,
    to,
    dataFrom: first !== null && first > from && first < to ? first : null,
  };
}

/* ============================================================ AFK-Phasen */

type AfkRow = {
  player: string;
  at: Date;
  online: boolean;
  distance: number | string | null;
  mobs: number | string | null;
  blocks: number | string | null;
  /** AFK-Zähler der Quelle (Sekunden), nur in Punkten mit Zusatzwerten */
  src: number | null;
};
const AFK_COLS = `player, at, online, distance, mobs_killed AS mobs, blocks_broken AS blocks, ${extraStatSql("afkSeconds")} AS src`;


/**
 * Liegen zwei Verlaufspunkte weiter auseinander, hat der Tracker nichts aufgezeichnet: Online-Spieler bekommen
 * spätestens alle 5 Min einen Punkt (plus Poll-Jitter). Knapp darüber, weil AFK schon nach 5 Min beginnt und eine
 * Lücke sonst als Stillstand zählen würde.
 */
const AFK_GAP_MS = 8 * 60_000;

/** Sekunden aller Phasen, optional nur einer Art („none“ = AFK ohne Farm) */
export function spanSeconds(spans: Span[], kind?: AfkKind | "none"): number {
  let sum = 0;
  for (const [a, b, k] of spans) {
    if (kind === undefined || (kind === "none" ? !k : k === kind)) sum += (b - a) / 1000;
  }
  return sum;
}

/**
 * Zählerstand zu einem beliebigen Zeitpunkt aus den Verlaufspunkten einer Stillstandsphase. Der Verlauf schreibt
 * einen Punkt bei jeder Abfrage mit Änderung (sonst spätestens alle 5 Min). Zwischen zwei Punkten stand der Zähler
 * also bis kurz vor dem späteren Punkt still; der Zuwachs fällt in die letzte Abfrage davor und wird dort linear verteilt.
 * Unbekannte Werte (null) gelten als unverändert.
 */
function counterAt(list: { t: number; mobs: number | null; blocks: number | null }[], key: "mobs" | "blocks"): (x: number) => number {
  const vals: number[] = [];
  let prev = list.find((p) => p[key] !== null)?.[key] ?? 0;
  for (const p of list) {
    const v = p[key];
    prev = v === null ? prev : Math.max(prev, v);
    vals.push(prev);
  }
  let i = 0;
  return (x: number) => {
    // Aufrufe kommen in aufsteigender Zeit: Zeiger nur vorwärts bewegen
    while (i < list.length - 1 && list[i + 1].t <= x) i++;
    if (i >= list.length - 1 || x <= list[i].t) return vals[i];
    const p = list[i];
    const q = list[i + 1];
    const ramp = Math.max(p.t, q.t - POLL_INTERVAL_MS);
    if (x <= ramp) return vals[i];
    return vals[i] + ((vals[i + 1] - vals[i]) * (x - ramp)) / (q.t - ramp);
  };
}

type CounterPoint = { t: number; mobs: number | null; blocks: number | null };

/**
 * Eine AFK-Phase [a, b] ab ihrem Beginn in einzelne Minuten zerlegen: Steigen Mobs bzw. Blöcke in einer Minute um
 * mindestens AFK_FARM_MIN, ist diese Minute AFK-Farm („mobs“ bzw. „blocks“), sonst normales AFK. Nichts wird über
 * die ganze Phase aufsummiert. Aufeinanderfolgende Minuten gleicher Art werden zu einer Spanne zusammengefasst.
 * `list` sind die Zählerstände während der Phase (der erste am oder vor `a`).
 */
function farmSpans(a: number, b: number, list: CounterPoint[], byLeave: boolean): Span[] {
  const mobsAt = counterAt(list, "mobs");
  const blocksAt = counterAt(list, "blocks");
  type Seg = { a: number; b: number; kind: AfkKind | undefined; m: number; bl: number; first: number; firstMs: number };
  const segs: Seg[] = [];
  let m0 = mobsAt(a);
  let b0 = blocksAt(a);
  for (let x = a; x < b; x += AFK_FARM_WINDOW_MS) {
    const y = Math.min(b, x + AFK_FARM_WINDOW_MS);
    const ms = y - x;
    const m1 = mobsAt(y);
    const b1 = blocksAt(y);
    const m = Math.max(0, m1 - m0);
    const bl = Math.max(0, b1 - b0);
    m0 = m1;
    b0 = b1;
    const last = segs[segs.length - 1];
    // Angebrochene Schlussminute (z. B. das Stück bis „jetzt“) sagt über die Rate kaum etwas: Art vom Vorgänger
    const kind = ms < AFK_FARM_WINDOW_MS && last ? last.kind : (farmKindOf(m, bl, ms) ?? undefined);
    if (last && last.kind === kind) {
      last.b = y;
      last.m += m;
      last.bl += bl;
    } else {
      segs.push({ a: x, b: y, kind, m, bl, first: kind === "mobs" ? m : bl, firstMs: ms });
    }
  }
  if (segs.length === 0) return [[a, b]];
  return segs.map((s, i): Span => {
    if (!s.kind) return [s.a, s.b];
    const lastSeg = i === segs.length - 1;
    return [
      s.a,
      s.b,
      s.kind,
      {
        at: s.a,
        atValue: s.first,
        windowSeconds: Math.round(s.firstMs / 1000),
        value: s.kind === "mobs" ? s.m : s.bl,
        mobs: s.m,
        blocks: s.bl,
        afkSince: a,
        byLeave: byLeave && lastSeg,
        stillAfk: !lastSeg,
      },
    ];
  });
}

/** Spannen [a, b] sortieren und überlappende bzw. aneinanderstoßende zusammenfassen */
function mergeRanges(list: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Teile einer Phase außerhalb der (sortierten, zusammengefassten) Bereiche `cut`; Art und Farm-Angaben bleiben */
function subtractRanges(span: Span, cut: [number, number][]): Span[] {
  const [a, b, ...rest] = span;
  const out: Span[] = [];
  let x = a;
  for (const [c, d] of cut) {
    if (d <= x) continue;
    if (c >= b) break;
    if (c > x) out.push([x, c, ...rest] as Span);
    x = Math.max(x, d);
  }
  if (x < b) out.push([x, b, ...rest] as Span);
  return out;
}

/** Steigt der AFK-Zähler der Quelle in einem Intervall um so viel weniger als dessen Länge, gilt es trotzdem als ganz AFK (Zähler in 30-s-Schritten) */
const SOURCE_AFK_SLACK_MS = 45_000;
/** Der Server rechnet beim AFK-Beginn die 5 Min Stillstand rückwirkend dazu: so weit darf ein Zuwachs vor das Intervall reichen */
const SOURCE_AFK_RETRO_MS = 10 * 60_000;

/**
 * AFK laut Quelle: Der Server zählt `afkSeconds` (/api/player) hoch, solange ein Spieler AFK ist, und hält dafür die
 * Spielzeit an. AFK beginnt nach 5 Min ohne Bewegung; diese 5 Min bucht er rückwirkend von der Spielzeit auf AFK um
 * (der Zähler springt um ~300 s). Zwischen zwei Verlaufspunkten mit Zählerstand ist der Zuwachs also die AFK-Zeit bis
 * zum späteren Punkt; ein voller Zuwachs reicht dabei so weit zurück, wie er groß ist. Ein Teil-Zuwachs liegt am Rand
 * zum benachbarten AFK-Intervall (Phase endet) bzw. am Intervallende (Phase beginnt). `covered` sind die Zeiträume, für die die Quelle eine Aussage macht – dort gilt nur sie.
 */
function sourceAfkFromRows(rows: AfkRow[], now: number, state: TrackerState): Map<string, { spans: Span[]; covered: [number, number][] }> {
  const out = new Map<string, { spans: Span[]; covered: [number, number][] }>();
  let i = 0;
  while (i < rows.length) {
    const id = rows[i].player;
    const covered: [number, number][] = [];
    const afk: { a: number; b: number; byLeave: boolean }[] = [];
    const pts: CounterPoint[] = [];
    // Letzter Punkt mit Zählerstand seit ununterbrochener Online-Zeit
    let prev = null as { t: number; v: number } | null;
    let lastAt = 0;
    const step = (t: number, v: number) => {
      if (prev && t > prev.t) {
        const dt = t - prev.t;
        const gain = Math.min(dt + SOURCE_AFK_RETRO_MS, Math.max(0, (v - prev.v) * 1000));
        covered.push([prev.t, t]);
        if (gain > 0) {
          const run = afk[afk.length - 1];
          const touches = run && run.b >= prev.t;
          // Ganzes Intervall, sonst am Rand zur laufenden Phase (sie endet hier) bzw. am Ende (Phase beginnt)
          const [a, b] = gain >= dt - SOURCE_AFK_SLACK_MS ? [Math.min(prev.t, t - gain), t] : touches ? [prev.t, prev.t + gain] : [t - gain, t];
          if (run && a <= run.b) run.b = Math.max(run.b, b);
          else afk.push({ a, b, byLeave: false });
        }
      }
      prev = { t, v };
    };
    for (; i < rows.length && rows[i].player === id; i++) {
      const r = rows[i];
      const t = new Date(r.at).getTime();
      if (t - lastAt > AFK_GAP_MS) prev = null;
      lastAt = t;
      if (!r.online) {
        const run = afk[afk.length - 1];
        if (prev && run && run.b >= prev.t) run.byLeave = true;
        prev = null;
        continue;
      }
      pts.push({ t, mobs: r.mobs === null ? null : Number(r.mobs), blocks: r.blocks === null ? null : Number(r.blocks) });
      if (r.src !== null) step(t, Number(r.src));
    }
    // Laufende Sitzung: jüngster Zählerstand aus dem Zustand (jede Minute frisch), läuft die Phase noch, bis jetzt
    const p = state.players[id];
    const live = p?.online ? p.detail?.stats.afkSeconds : undefined;
    const fetched = p?.detail ? Date.parse(p.detail.fetchedAt) : NaN;
    if (typeof live === "number" && fetched - lastAt <= AFK_GAP_MS) {
      step(fetched, live);
      const run = afk[afk.length - 1];
      if (run && run.b >= fetched - SOURCE_AFK_SLACK_MS && now - fetched <= 3 * POLL_INTERVAL_MS) {
        run.b = now;
        covered.push([fetched, now]);
      }
    }
    if (covered.length === 0) continue;
    const spans: Span[] = [];
    for (const run of afk) {
      const before = pts.filter((q) => q.t <= run.a).at(-1);
      const list = [...(before ? [before] : []), ...pts.filter((q) => q.t > run.a && q.t < run.b)];
      const end = pts.find((q) => q.t >= run.b);
      list.push({ t: run.b, mobs: end?.mobs ?? null, blocks: end?.blocks ?? null });
      spans.push(...farmSpans(run.a, run.b, list, run.byLeave));
    }
    out.set(id, { spans, covered: mergeRanges(covered) });
  }
  return out;
}

/**
 * AFK-Phasen aus nach Spieler und Zeit sortierten Verlaufspunkten (siehe `getAfkSpans`). Vorrang hat die Quelle
 * (`sourceAfkFromRows`); nur wo sie keine Aussage macht (vor ihrer Aufzeichnung, Datenlücken, Abfrage fehlgeschlagen),
 * gilt die eigene Erkennung (`ownAfkFromRows`). Ausnahme: stillstehend farmen (eigene Erkennung mit Farm-Art) zählt
 * immer, denn die Quelle wertet Blöcke abbauen als Aktivität (bei ≥ 10 Blöcken pro Minute 0 % AFK laut Server).
 */
function afkFromRows(rows: AfkRow[], from: number, to: number, now: number, state: TrackerState): Map<string, Span[]> {
  const own = ownAfkFromRows(rows, from, to, now, state);
  const source = sourceAfkFromRows(rows, now, state);
  const out = new Map<string, Span[]>();
  for (const id of new Set([...own.keys(), ...source.keys()])) {
    const src = source.get(id);
    const ownList = own.get(id) ?? [];
    const farms = mergeRanges(ownList.filter((s) => s[2]).map((s): [number, number] => [s[0], s[1]]));
    const list: Span[] = [];
    for (const s of src?.spans ?? []) {
      const a = Math.max(from, s[0]);
      const b = Math.min(to, s[1]);
      if (b > a) list.push(...subtractRanges([a, b, ...s.slice(2)] as Span, farms));
    }
    for (const s of ownList) list.push(...(s[2] || !src ? [s] : subtractRanges(s, src.covered)));
    if (list.length) out.set(id, list.sort((x, y) => x[0] - y[0]));
  }
  return out;
}

/**
 * Eigene AFK-Erkennung (Ersatz, wenn die Quelle keinen AFK-Zähler liefert): online, aber seit AFK_MS keine Bewegung,
 * rückwirkend ab der letzten Bewegung – so zählt auch der Server (gegen dessen Zähler abgeglichen: 5 Min, nur Strecke).
 */
function ownAfkFromRows(rows: AfkRow[], from: number, to: number, now: number, state: TrackerState): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  const add = (id: string, a: number, b: number, kind: AfkKind | undefined, farm?: AfkFarmInfo) => {
    const x = Math.max(from, a);
    const y = Math.min(to, b);
    if (y - x <= 0) return;
    const l = out.get(id) ?? [];
    l.push(kind && farm ? [x, y, kind, farm] : kind ? [x, y, kind] : [x, y]);
    out.set(id, l);
  };
  let cur: string | null = null;
  let lastMove = 0;
  let lastDist: number | null = null;
  let wasOnline = false;
  // Zähler zuletzt gesehen
  let lastMobs: number | null = null;
  let lastBlocks: number | null = null;
  // Zählerstände der laufenden Stillstandsphase (ab der letzten Bewegung), Grundlage der Farm-Abschnitte
  let pts: CounterPoint[] = [];
  const close = (id: string, t: number, byLeave = false, mobs = lastMobs, blocks = lastBlocks) => {
    if (!(wasOnline && lastDist !== null && t - lastMove >= AFK_MS)) return;
    const list = pts.filter((p) => p.t < t);
    list.push({ t, mobs, blocks });
    for (const s of farmSpans(lastMove, t, list, byLeave)) add(id, ...s);
  };
  const finish = (id: string) => {
    const p = state.players[id];
    const mobs = p?.stats.mobsKilled ?? lastMobs;
    const blocks = p?.stats.blocksBroken ?? lastBlocks;
    if (p?.online) close(id, Math.min(now, to), false, mobs, blocks);
    else if (wasOnline) close(id, Date.parse(p?.lastSeen ?? new Date(now).toISOString()), true, mobs, blocks);
  };
  const restart = (t: number, d: number | null) => {
    lastMove = t;
    lastDist = d;
    pts = [{ t, mobs: lastMobs, blocks: lastBlocks }];
  };
  let lastAt = 0;
  for (const r of rows) {
    const t = new Date(r.at).getTime();
    const d = r.distance === null ? null : Number(r.distance);
    if (r.player !== cur) {
      if (cur) finish(cur);
      cur = r.player;
      lastMobs = r.mobs === null ? null : Number(r.mobs);
      lastBlocks = r.blocks === null ? null : Number(r.blocks);
      restart(t, d);
      wasOnline = r.online;
      lastAt = t;
      continue;
    }
    // Zähler des vorigen Punkts (Stand, als der Spieler zuletzt nachweislich stillstand)
    const prevMobs = lastMobs;
    const prevBlocks = lastBlocks;
    if (r.mobs !== null) lastMobs = Number(r.mobs);
    if (r.blocks !== null) lastBlocks = Number(r.blocks);
    const prevAt = lastAt;
    lastAt = t;
    // Datenlücke (Tracker stand still) oder keine Strecke bekannt: nichts über Bewegung aussagbar, also kein AFK.
    // Eine bis dahin laufende Phase endet mit dem letzten belegten Punkt; die Bewegungsuhr startet erst mit dem
    // nächsten frischen Streckenwert neu.
    if (t - prevAt > AFK_GAP_MS || (r.online && d === null)) {
      close(cur, prevAt, false, prevMobs, prevBlocks);
      wasOnline = r.online;
      restart(t, d);
      continue;
    }
    if (!r.online) {
      if (wasOnline) close(cur, t, true);
      wasOnline = false;
      restart(t, d);
      continue;
    }
    if (!wasOnline) {
      // Join: Bewegungsuhr neu starten
      wasOnline = true;
      restart(t, d);
      continue;
    }
    if (d !== null && (lastDist === null || d > lastDist)) {
      // Bewegung irgendwann zwischen dem vorigen Punkt und jetzt: Stillstand ist nur bis zum vorigen Punkt belegt.
      // (Sonst würde jede Tracker-Pause ≥ AFK_MS, z. B. ein Deploy, bei laufenden Spielern eine AFK-Phase erzeugen.)
      close(cur, prevAt, false, prevMobs, prevBlocks);
      restart(t, d);
    } else if (r.mobs !== null && r.blocks !== null) {
      // Steht weiter still: Zählerstand für die Farm-Abschnitte merken (Punkte ohne Zähler verlängern nur den Abschnitt)
      pts.push({ t, mobs: lastMobs, blocks: lastBlocks });
    }
    if (d !== null) lastDist = d;
  }
  if (cur) finish(cur);
  for (const l of out.values()) l.sort((x, y) => x[0] - y[0]);
  return out;
}

/**
 * AFK-Phasen aller Spieler aus dem Spielerverlauf: online, aber die Strecke steigt mindestens AFK_MS lang nicht.
 * Funktioniert damit auch rückwirkend für Tage vor Einführung der AFK-Erkennung. Die Phase beginnt mit der
 * letzten Bewegung und endet mit dem letzten Punkt vor der nächsten Bewegung bzw. mit dem Leave; läuft sie noch,
 * endet sie bei `now`.
 */
async function getAfkSpans(from: number, to: number, now: number): Promise<Map<string, Span[]>> {
  return cached(`afk:${from}:${to}`, 60_000, () => loadAfkSpans(from, to, now));
}

/** Wie `getAfkSpans`, aber ohne Cache und ohne Request-Kontext (auch beim Prozessstart nutzbar). */
export async function loadAfkSpans(from: number, to: number, now: number): Promise<Map<string, Span[]>> {
  await ensureLoaded();
  const db = await getDb();
  const state = await getState();
  // Vorlauf, damit die letzte Bewegung vor `from` bekannt ist
  const range = [new Date(from - 12 * 3600_000), new Date(to)];
  // Spielerweise laden: der gesamte Verlauf (über eine Million Zeilen) passt nicht auf einmal in den Speicher,
  // und die Erkennung arbeitet ohnehin je Spieler.
  const players = (await db.query<{ player: string }>(`SELECT DISTINCT player FROM player_history WHERE at >= $1 AND at < $2`, range)).rows;
  const out = new Map<string, Span[]>();
  for (const { player } of players) {
    const rows = (await db.query<AfkRow>(`SELECT ${AFK_COLS} FROM player_history WHERE player = $1 AND at >= $2 AND at < $3 ORDER BY at`, [player, ...range])).rows;
    for (const [id, spans] of afkFromRows(rows, from, to, now, state)) out.set(id, spans);
  }
  return out;
}

/**
 * AFK-Phasen aller Spieler über die gesamte Laufzeit (für Bestenliste und Graph). Liest den ganzen Spieler-Verlauf
 * (über eine Million Zeilen), deshalb rechnet das der Tracker alle 10 Min vor (lib/snapshotJobs.ts); die Website liest
 * nur das Ergebnis. Ob jemand gerade AFK ist, kommt aus dem Live-Zustand, nicht aus der Vorberechnung.
 */
export const AFK_SNAPSHOT = "afk-spans";
export const AFK_SNAPSHOT_MS = 10 * 60_000;

/** Ohne Request-Kontext (auch im Tracker nutzbar) */
export function computeAllAfkSpans(): Promise<Map<string, Span[]>> {
  const now = Date.now();
  return loadAfkSpans(0, now, now);
}

export async function getAllAfkSpans(): Promise<Map<string, Span[]>> {
  return cached("afk:all", 60_000, async () => (await snapshot(AFK_SNAPSHOT, computeAllAfkSpans, AFK_SNAPSHOT_MS)).value);
}

/** AFK-Bestenliste: Summe der AFK-Phasen je Spieler (optional nur einer Art), optional nur bis zu einem Zeitpunkt (für ▲/▼). */
export async function getAfkBoard(kind?: AfkKind, untilMsAgo = 0): Promise<{ id: string; name: string; uuid: string; value: number; online: boolean; afkNow: boolean }[]> {
  const [spans, state] = await Promise.all([getAllAfkSpans(), getState()]);
  const until = Date.now() - untilMsAgo;
  const rows: { id: string; name: string; uuid: string; value: number; online: boolean; afkNow: boolean }[] = [];
  for (const [id, all] of spans) {
    const list = kind ? all.filter((s) => s[2] === kind) : all;
    let sum = 0;
    let afkNow = false;
    for (const [a, b] of list) {
      sum += Math.max(0, Math.min(b, until) - a) / 1000;
      if (untilMsAgo === 0 && b >= until - AFK_SNAPSHOT_MS - 90_000 && state.players[id]?.online && state.players[id]?.afkSince) afkNow = true;
    }
    if (sum <= 0) continue;
    const p = state.players[id];
    rows.push({ id, name: p?.name ?? id, uuid: p?.uuid ?? "", value: Math.round(sum), online: p?.online ?? false, afkNow });
  }
  return rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "de"));
}

/** Ränge der AFK-Bestenliste vor `hoursAgo` Stunden */
export async function getAfkRanksBefore(hoursAgo = 24, kind?: AfkKind): Promise<Record<string, number>> {
  return cached(`afkRanksBefore:${hoursAgo}:${kind ?? "alle"}`, 300_000, async () => {
    const rows = await getAfkBoard(kind, hoursAgo * 3600_000);
    return Object.fromEntries(rows.map((r, i) => [r.id, i + 1]));
  });
}

/**
 * AFK-Zeit als Zeitreihe für den Graph-Baukasten: kumulierte AFK-Sekunden je Spieler (oder aller zusammen)
 * zum Ende jedes Bündels.
 */
export async function getAfkSeries(q: { players: string[]; from: number | null; to: number | null; bucketMinutes: number | null; mode: "wert" | "zuwachs"; kind?: AfkKind }): Promise<{
  series: { id: string; name: string; points: { at: string; v: number }[] }[];
  bucketMinutes: number;
}> {
  const [spans, state, first] = await Promise.all([getAllAfkSpans(), getState(), firstDataAt()]);
  const now = Date.now();
  const from = q.from ?? first ?? now;
  const to = Math.min(q.to ?? now, now);
  const spanMin = Math.max(1, (to - from) / 60_000);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  const minutes = q.bucketMinutes ?? (steps.find((s) => s >= 5 && spanMin / s <= 600) ?? 1440);
  const stepMs = minutes * 60_000;
  const t0 = Math.floor(from / stepMs) * stepMs;
  const ids = q.players.length ? q.players : [...spans.keys()];
  const pick = (id: string) => (spans.get(id) ?? []).filter((s) => !q.kind || s[2] === q.kind);
  const cumulative = (list: Span[]) => {
    const points: { at: string; v: number }[] = [];
    let acc = 0;
    let k = 0;
    for (let t = t0; t <= to; t += stepMs) {
      const end = t + stepMs;
      // Alle Phasen, die vor `end` liegen, aufaddieren (Phasen sind sortiert)
      while (k < list.length && list[k][1] <= end) {
        acc += (list[k][1] - list[k][0]) / 1000;
        k++;
      }
      let partial = 0;
      for (let j = k; j < list.length && list[j][0] < end; j++) partial += Math.max(0, end - list[j][0]) / 1000;
      points.push({ at: new Date(Math.min(end, now)).toISOString(), v: Math.round(acc + partial) });
    }
    return points;
  };
  let series: { id: string; name: string; points: { at: string; v: number }[] }[];
  if (q.players.length) {
    series = ids.map((id) => ({ id, name: state.players[id]?.name ?? id, points: cumulative(pick(id)) }));
  } else {
    const all = ids.map((id) => cumulative(pick(id)));
    const n = all[0]?.length ?? 0;
    const points = Array.from({ length: n }, (_, i) => ({ at: all[0][i].at, v: all.reduce((s, l) => s + (l[i]?.v ?? 0), 0) }));
    series = [{ id: "alle", name: "Alle Spieler", points }];
  }
  if (q.mode === "zuwachs") {
    series = series.map((s) => ({ ...s, points: s.points.slice(1).map((p, i) => ({ at: p.at, v: Math.max(0, p.v - s.points[i].v) })) }));
  }
  return { series, bucketMinutes: minutes };
}

/** AFK-Phasen eines Spielers über die gesamte Laufzeit. */
export async function getPlayerAfkSpans(id: string): Promise<Span[]> {
  return cached(`afk:player:${id}`, 60_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const now = Date.now();
    const rows = (await db.query<AfkRow>(`SELECT ${AFK_COLS} FROM player_history WHERE player = $1 ORDER BY at`, [id])).rows;
    return afkFromRows(rows, 0, now, now, await getState()).get(id) ?? [];
  });
}

/* ============================================================ Zeitstrahl */

interface TimelineRow {
  id: string;
  name: string;
  uuid: string;
  online: Span[];
  live: Span[];
  seconds: number;
  /** AFK-Phasen (Teil der Online-Zeit) */
  afk: Span[];
  afkSeconds: number;
  /** Davon AFK-Farm: Mobs bzw. Blöcke (Sekunden) */
  afkMobsSeconds: number;
  afkBlocksSeconds: number;
  /** Live-Zeit auf Twitch an diesem Tag (Sekunden) */
  liveSeconds: number;
}

export async function getDayTimeline(day?: string): Promise<{ nav: DayNav; rows: TimelineRow[]; now: number }> {
  const now = Date.now();
  const nav = await dayNav(day, now);
  const [sessions, lives, state, afk] = await Promise.all([getAllSessions(), getLiveSessions(), getState(), getAfkSpans(nav.from, nav.to, now)]);
  const on = clip(sessions, nav.from, nav.to, now);
  const li = clip(lives, nav.from, nav.to, now);
  const ids = new Set([...on.keys(), ...li.keys()]);
  const rows: TimelineRow[] = [...ids].map((id) => {
    const p = state.players[id];
    const o = on.get(id) ?? [];
    const a = afk.get(id) ?? [];
    const l = li.get(id) ?? [];
    return {
      id,
      name: p?.name ?? id,
      uuid: p?.uuid ?? "",
      online: o,
      live: l,
      afk: a,
      seconds: o.reduce((s, [x, y]) => s + (y - x) / 1000, 0),
      afkSeconds: spanSeconds(a),
      afkMobsSeconds: spanSeconds(a, "mobs"),
      afkBlocksSeconds: spanSeconds(a, "blocks"),
      liveSeconds: l.reduce((s, [x, y]) => s + (y - x) / 1000, 0),
    };
  });
  rows.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, "de"));
  return { nav, rows, now };
}

/* ============================================================ Zeitraffer */

export interface TimelapseFrame {
  at: number;
  /** Indizes in `players` */
  online: number[];
  live: number[];
  /** Indizes der Spieler, die online, aber AFK sind */
  afk: number[];
  /** Davon: AFK-Farm (Mobs bzw. Blöcke) */
  afkMobs: number[];
  afkBlocks: number[];
  deaths: number | null;
  viewers: number | null;
  messages: TimelapseMessage[];
}

/** Meldung im Zeitraffer: Spieler als Kopf, danach der Text ohne Namen; bei Toden durch Spieler der Mörder */
export interface TimelapseMessage {
  player: { id: string; name: string; uuid: string } | null;
  text: string;
  killer: { id: string; name: string; uuid: string } | null;
}

export interface Timelapse {
  nav: DayNav;
  stepMinutes: number;
  players: { id: string; name: string; uuid: string }[];
  frames: TimelapseFrame[];
}

const TIMELAPSE_TYPES = new Set<TrackerEvent["type"]>(["death", "first_join", "milestone", "record", "rank", "server_online", "server_offline", "stream_start"]);

export async function getTimelapse(day?: string): Promise<Timelapse> {
  const now = Date.now();
  const nav = await dayNav(day, now);
  const step = 5;
  const stepMs = step * 60_000;
  const [sessions, lives, state, events, afkSpans] = await Promise.all([getAllSessions(), getLiveSessions(), getState(), getEvents(), getAfkSpans(nav.from, nav.to, now)]);
  await ensureLoaded();
  const db = await getDb();
  const hist = (
    await db.query<{ at: Date; deaths: number | string; viewers: number | string }>(
      `SELECT to_timestamp(floor(extract(epoch FROM at) / $1) * $1) AS at, max(deaths) AS deaths, max(viewers) AS viewers
         FROM history WHERE at >= $2 AND at < $3 GROUP BY 1 ORDER BY 1`,
      [step * 60, new Date(nav.from), new Date(nav.to)],
    )
  ).rows;
  const histAt = new Map(hist.map((h) => [new Date(h.at).getTime(), h]));

  const on = clip(sessions, nav.from, nav.to, now);
  const li = clip(lives, nav.from, nav.to, now);
  const ids = [...new Set([...on.keys(), ...li.keys()])];
  const players = ids
    .map((id) => ({ id, name: state.players[id]?.name ?? id, uuid: state.players[id]?.uuid ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  const index = new Map(players.map((p, i) => [p.id, i]));
  const covers = (spans: Span[] | undefined, t: number) => Boolean(spans?.some(([a, b]) => a <= t && t < b));

  // Ereignisse des Tages als kurze Texte
  const dayEvents = events.filter((e) => {
    const t = Date.parse(e.at);
    return t >= nav.from && t < nav.to && TIMELAPSE_TYPES.has(e.type) && !(e.type === "death" && e.meta?.unknown);
  });
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const message = (e: TrackerEvent): TimelapseMessage => ({
    player: e.player ? { id: e.player, name: e.playerName ?? e.player, uuid: e.uuid ?? "" } : null,
    text: EVENT_META[e.type].text(e),
    killer:
      e.type === "death" && str(e.meta?.killerId)
        ? { id: str(e.meta?.killerId), name: str(e.meta?.killerName) || str(e.meta?.killerId), uuid: str(e.meta?.killerUuid) }
        : null,
  });

  const end = Math.min(nav.to, now);
  const frames: TimelapseFrame[] = [];
  let ei = 0;
  const sorted = [...dayEvents].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let lastDeaths: number | null = null;
  for (let t = nav.from; t <= end; t += stepMs) {
    const online: number[] = [];
    const live: number[] = [];
    const afk: number[] = [];
    const afkMobs: number[] = [];
    const afkBlocks: number[] = [];
    for (const id of ids) {
      const i = index.get(id)!;
      const isOn = covers(on.get(id), t);
      if (isOn) online.push(i);
      if (covers(li.get(id), t)) live.push(i);
      const span = isOn ? afkSpans.get(id)?.find(([a, b]) => a <= t && t < b) : undefined;
      if (span) {
        afk.push(i);
        if (span[2] === "mobs") afkMobs.push(i);
        if (span[2] === "blocks") afkBlocks.push(i);
      }
    }
    const h = histAt.get(t);
    if (h) lastDeaths = Number(h.deaths);
    const messages: TimelapseMessage[] = [];
    while (ei < sorted.length && Date.parse(sorted[ei].at) <= t) {
      if (Date.parse(sorted[ei].at) > t - stepMs) messages.push(message(sorted[ei]));
      ei++;
    }
    frames.push({ at: t, online, live, afk, afkMobs, afkBlocks, deaths: h ? Number(h.deaths) : lastDeaths, viewers: h ? Number(h.viewers) : null, messages: messages.slice(0, 6) });
  }
  return { nav, stepMinutes: step, players, frames };
}

/* ============================================================ Statistik-Erweiterungen */

export interface DayRow {
  day: string;
  players: number;
  maxOnline: number;
  playerHours: number;
  deaths: number;
  maxViewers: number;
  /** AFK-Stunden an diesem Tag (Teil der Spielerstunden) */
  afkHours: number;
}
export interface StatsExtras {
  /** Spielerstunden je Tagesstunde (Berliner Zeit) */
  playHours: { hour: number; hours: number; afkHours: number }[];
  afk: {
    perPlayer: { id: string; name: string; uuid: string; seconds: number; onlineSeconds: number; share: number }[];
    longest: { id: string; name: string; uuid: string; seconds: number; from: string; to: string } | null;
    totalHours: number;
    /** AFK-Farmen: je Art die Top-Spieler (Sekunden) und die Gesamtstunden */
    farm: Record<AfkKind, { perPlayer: { id: string; name: string; uuid: string; seconds: number }[]; hours: number }>;
  };
  /** Längste Sessions */
  marathons: { id: string; name: string; uuid: string; seconds: number; start: string; end: string | null }[];
  heatmap: (number | null)[][]; // [7][24] Ø online
  /** AFK-Anteil an den Spielerstunden je Wochentag × Stunde (0…1, null ohne Daten) */
  heatmapAfk: (number | null)[][];
  days: DayRow[];
  deathsByHour: { hour: number; deaths: number; playerHours: number; rate: number | null }[];
  deathStreaks: { id: string; name: string; uuid: string; count: number; from: string; to: string }[];
  deathRate: { id: string; name: string; uuid: string; deaths: number; hours: number; perHour: number }[];
  loyalty: {
    perDay: { day: string; players: number }[];
    groups: { h24: number; d3: number; d7: number; gone: number };
    gone: { id: string; name: string; uuid: string; days: number; lastSeen: string }[];
    total: number;
  };
  availability: {
    ratio: number | null;
    outages: { from: string; to: string | null; minutes: number | null }[];
    gaps: { from: string; to: string; minutes: number }[];
  };
  fullest: { at: string; value: number }[];
  mostViewers: { at: string; value: number }[];
  totals: { playerHours: number; players: number };
}

export async function getStatsExtras(): Promise<StatsExtras> {
  return cached("statsExtras", 120_000, async () => {
    const now = Date.now();
    await ensureLoaded();
    const db = await getDb();
    const [hourly, deathsPerDay, sessions, state, events, gapRows, topOnline, topViewers] = await Promise.all([
      db.query<{ h: Date; avg_online: number | string; max_online: number; max_viewers: number; n: number | string }>(
        `SELECT date_trunc('hour', at) AS h, avg(online_count) AS avg_online, max(online_count) AS max_online, max(viewers) AS max_viewers, count(*) AS n
           FROM history GROUP BY 1 ORDER BY 1`,
      ),
      getDailyEventSum("death"),
      getAllSessions(),
      getState(),
      getEvents(),
      db.query<{ at: Date; prev: Date }>(
        `SELECT at, prev FROM (SELECT at, lag(at) OVER (ORDER BY at) AS prev FROM history) x WHERE prev IS NOT NULL AND at - prev > interval '5 minutes' ORDER BY at DESC LIMIT 20`,
      ),
      db.query<{ at: Date; v: number }>(`SELECT at, online_count AS v FROM history ORDER BY online_count DESC, at ASC LIMIT 400`),
      db.query<{ at: Date; v: number }>(`SELECT at, viewers AS v FROM history ORDER BY viewers DESC, at ASC LIMIT 400`),
    ]);

    // Heatmap Wochentag × Stunde (Ø online)
    const sum = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const cnt = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const hourOfDay = Array(24).fill(0) as number[]; // Spielerstunden je Tagesstunde
    const dayAgg = new Map<string, { maxOnline: number; maxViewers: number; playerHours: number }>();
    for (const r of hourly.rows) {
      const t = new Date(r.h).getTime();
      const { dow, hour } = berlinSlot(t + 1800_000);
      const avg = Number(r.avg_online);
      // Anteil der Stunde, der tatsächlich beobachtet wurde (30-s-Takt → max. 120 Punkte)
      const share = Math.min(1, Number(r.n) / 110);
      sum[dow][hour] += avg;
      cnt[dow][hour] += 1;
      hourOfDay[hour] += avg * share;
      const d = dayKey(t + 1800_000);
      const a = dayAgg.get(d) ?? { maxOnline: 0, maxViewers: 0, playerHours: 0 };
      a.maxOnline = Math.max(a.maxOnline, r.max_online);
      a.maxViewers = Math.max(a.maxViewers, r.max_viewers);
      a.playerHours += avg * share;
      dayAgg.set(d, a);
    }
    const heatmap = sum.map((row, d) => row.map((v, h) => (cnt[d][h] ? Math.round((v / cnt[d][h]) * 10) / 10 : null)));

    // Spieler pro Tag und Spielstunden pro Tag aus Sessions
    const playersPerDay = new Map<string, Set<string>>();
    const hoursPerDay = new Map<string, number>();
    const trackedSec = new Map<string, number>();
    for (const s of sessions) {
      const a = Date.parse(s.start);
      const b = s.end ? Date.parse(s.end) : now;
      if (b <= a) continue;
      trackedSec.set(s.player, (trackedSec.get(s.player) ?? 0) + (b - a) / 1000);
      let t = a;
      while (t < b) {
        const d = dayKey(t);
        const next = Math.min(b, dayStart(shiftDay(d, 1)));
        (playersPerDay.get(d) ?? playersPerDay.set(d, new Set()).get(d)!).add(s.player);
        hoursPerDay.set(d, (hoursPerDay.get(d) ?? 0) + (next - t) / 3600_000);
        t = next;
      }
    }
    // AFK-Phasen über die ganze Laufzeit: je Spieler, je Tag, längste Phase
    // Ganze Staffel: vorberechnet im Tracker (dieselben Phasen wie für die Bestenliste)
    const afkSpans = await getAllAfkSpans();
    const afkPerDay = new Map<string, number>();
    const afkPerPlayer = new Map<string, number>();
    const farmPerPlayer: Record<AfkKind, Map<string, number>> = { mobs: new Map(), blocks: new Map() };
    let longestAfk: StatsExtras["afk"]["longest"] = null;
    for (const [id, spans] of afkSpans) {
      for (const [a, b, kind] of spans) {
        afkPerPlayer.set(id, (afkPerPlayer.get(id) ?? 0) + (b - a) / 1000);
        if (kind) farmPerPlayer[kind].set(id, (farmPerPlayer[kind].get(id) ?? 0) + (b - a) / 1000);
        if (!longestAfk || b - a > longestAfk.seconds * 1000) {
          longestAfk = { id, name: state.players[id]?.name ?? id, uuid: state.players[id]?.uuid ?? "", seconds: Math.round((b - a) / 1000), from: new Date(a).toISOString(), to: new Date(b).toISOString() };
        }
        let t = a;
        while (t < b) {
          const d = dayKey(t);
          const next = Math.min(b, dayStart(shiftDay(d, 1)));
          afkPerDay.set(d, (afkPerDay.get(d) ?? 0) + (next - t) / 3600_000);
          t = next;
        }
      }
    }
    const afkPlayers: StatsExtras["afk"]["perPlayer"] = [...afkPerPlayer]
      .map(([id, seconds]) => {
        const onlineSeconds = trackedSec.get(id) ?? 0;
        return { id, name: state.players[id]?.name ?? id, uuid: state.players[id]?.uuid ?? "", seconds: Math.round(seconds), onlineSeconds: Math.round(onlineSeconds), share: onlineSeconds > 0 ? Math.min(1, seconds / onlineSeconds) : 0 };
      })
      .sort((a, b) => b.seconds - a.seconds);
    const farmList = (m: Map<string, number>) => ({
      perPlayer: [...m]
        .map(([id, seconds]) => ({ id, name: state.players[id]?.name ?? id, uuid: state.players[id]?.uuid ?? "", seconds: Math.round(seconds) }))
        .sort((x, y) => y.seconds - x.seconds)
        .slice(0, 8),
      hours: [...m.values()].reduce((s, v) => s + v, 0) / 3600,
    });
    const afk: StatsExtras["afk"] = {
      perPlayer: afkPlayers.slice(0, 10),
      longest: longestAfk,
      totalHours: [...afkPerDay.values()].reduce((s, v) => s + v, 0),
      farm: { mobs: farmList(farmPerPlayer.mobs), blocks: farmList(farmPerPlayer.blocks) },
    };

    // Längste Sessions
    const marathons: StatsExtras["marathons"] = sessions
      .map((s) => ({ id: s.player, name: state.players[s.player]?.name ?? s.player, uuid: state.players[s.player]?.uuid ?? "", seconds: Math.round(((s.end ? Date.parse(s.end) : now) - Date.parse(s.start)) / 1000), start: s.start, end: s.end }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 8);

    // AFK-Spielerstunden je Wochentag × Stunde und je Tagesstunde (aus den AFK-Phasen, in 10-Minuten-Schritten)
    const afkSlot = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
    const afkHour = Array(24).fill(0) as number[];
    for (const spansOf of afkSpans.values()) {
      for (const [a, b] of spansOf) {
        for (let t = a; t < b; t += 600_000) {
          const part = Math.min(600_000, b - t) / 3600_000;
          const { dow, hour } = berlinSlot(t);
          afkSlot[dow][hour] += part;
          afkHour[hour] += part;
        }
      }
    }
    // sum[d][h] = Σ Ø online über alle beobachteten Stunden dieses Slots ≈ Spielerstunden im Slot
    const heatmapAfk = sum.map((row, d) => row.map((v, h) => (cnt[d][h] && v > 0 ? Math.min(1, afkSlot[d][h] / v) : null)));
    const playHours = hourOfDay.map((h, hour) => ({ hour, hours: Math.round(h * 10) / 10, afkHours: Math.round(Math.min(h, afkHour[hour]) * 10) / 10 }));

    const deathsDay = new Map(deathsPerDay.map((d) => [d.day, d.value]));
    const allDays = [...new Set([...dayAgg.keys(), ...playersPerDay.keys()])].sort();
    const days: DayRow[] = allDays.map((day) => ({
      day,
      players: playersPerDay.get(day)?.size ?? 0,
      maxOnline: dayAgg.get(day)?.maxOnline ?? 0,
      playerHours: hoursPerDay.get(day) ?? dayAgg.get(day)?.playerHours ?? 0,
      deaths: deathsDay.get(day) ?? 0,
      maxViewers: dayAgg.get(day)?.maxViewers ?? 0,
      afkHours: afkPerDay.get(day) ?? 0,
    }));

    // Tode nach Tagesstunde
    const deathEvents = events.filter((e) => e.type === "death");
    const deathsHour = Array(24).fill(0) as number[];
    // Tode vor der Erfassung (aus /api/player) nicht in Raten, die durch vom Tracker gemessene Zeit teilen
    for (const e of deathEvents) if (!e.meta?.beforeTracking) deathsHour[berlinSlot(Date.parse(e.at)).hour] += e.delta ?? 1;
    const deathsByHour = deathsHour.map((d, hour) => {
      const ph = hourOfDay[hour];
      return { hour, deaths: d, playerHours: Math.round(ph), rate: ph >= 3 ? Math.round((d / ph) * 100 * 10) / 10 : null };
    });

    // Tod-Serien (≥ 3 Tode eines Spielers in 60 Minuten)
    const byPlayer = new Map<string, TrackerEvent[]>();
    for (const e of deathEvents) if (e.player && !e.meta?.unknown) (byPlayer.get(e.player) ?? byPlayer.set(e.player, []).get(e.player)!).push(e);
    const deathStreaks: StatsExtras["deathStreaks"] = [];
    for (const [id, list] of byPlayer) {
      list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      let i = 0;
      while (i < list.length) {
        let j = i;
        let count = 0;
        while (j < list.length && Date.parse(list[j].at) - Date.parse(list[i].at) <= 3600_000) count += list[j++].delta ?? 1;
        if (count >= 3) {
          deathStreaks.push({ id, name: list[i].playerName ?? id, uuid: list[i].uuid ?? "", count, from: list[i].at, to: list[j - 1].at });
          i = j;
        } else i++;
      }
    }
    deathStreaks.sort((a, b) => b.count - a.count || Date.parse(b.from) - Date.parse(a.from));

    // Todesrate je Spieler (Tode laut Ereignissen / getrackte Online-Stunden)
    const deathRate: StatsExtras["deathRate"] = [];
    for (const [id, list] of byPlayer) {
      const hours = (trackedSec.get(id) ?? 0) / 3600;
      const deaths = list.reduce((s, e) => s + (e.meta?.beforeTracking ? 0 : (e.delta ?? 1)), 0);
      if (hours < 1 || deaths < 2) continue;
      deathRate.push({ id, name: state.players[id]?.name ?? id, uuid: state.players[id]?.uuid ?? "", deaths, hours: Math.round(hours * 10) / 10, perHour: Math.round((deaths / hours) * 100) / 100 });
    }
    deathRate.sort((a, b) => b.perHour - a.perHour);

    // Treue
    const players = Object.values(state.players).filter((p) => p.sessions > 0 || p.online);
    const groups = { h24: 0, d3: 0, d7: 0, gone: 0 };
    const gone: StatsExtras["loyalty"]["gone"] = [];
    for (const p of players) {
      const ageDays = p.online ? 0 : (now - Date.parse(p.lastSeen)) / 86400_000;
      if (ageDays <= 1) groups.h24++;
      else if (ageDays <= 3) groups.d3++;
      else if (ageDays <= 7) groups.d7++;
      else groups.gone++;
      if (ageDays > 3) gone.push({ id: p.id, name: p.name, uuid: p.uuid, days: Math.floor(ageDays), lastSeen: p.lastSeen });
    }
    gone.sort((a, b) => b.days - a.days);
    const loyalty = { perDay: allDays.map((day) => ({ day, players: playersPerDay.get(day)?.size ?? 0 })), groups, gone, total: players.length };

    // Verfügbarkeit
    const first = hourly.rows.length ? new Date(hourly.rows[0].h).getTime() : now;
    const serverEvents = events.filter((e) => e.type === "server_online" || e.type === "server_offline").sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const outages: StatsExtras["availability"]["outages"] = [];
    let offlineSince: string | null = state.latest && state.latest.serverOnline === false && serverEvents.length === 0 ? state.startedAt : null;
    for (const e of serverEvents) {
      if (e.type === "server_offline") offlineSince = e.at;
      else if (offlineSince) {
        outages.push({ from: offlineSince, to: e.at, minutes: Math.round((Date.parse(e.at) - Date.parse(offlineSince)) / 60_000) });
        offlineSince = null;
      }
    }
    if (offlineSince) outages.push({ from: offlineSince, to: null, minutes: null });
    const offlineMs = outages.reduce((s, o) => s + ((o.to ? Date.parse(o.to) : now) - Date.parse(o.from)), 0);
    const span = now - first;
    const gaps = gapRows.rows.map((r) => ({ from: new Date(r.prev).toISOString(), to: new Date(r.at).toISOString(), minutes: Math.round((new Date(r.at).getTime() - new Date(r.prev).getTime()) / 60_000) }));
    const availability = { ratio: span > 3600_000 ? Math.max(0, 1 - offlineMs / span) : null, outages: outages.reverse().slice(0, 10), gaps };

    // Vollste Momente (mind. 2 h Abstand)
    const spread = (rows: { at: Date; v: number }[]) => {
      const out: { at: string; value: number }[] = [];
      for (const r of rows) {
        const t = new Date(r.at).getTime();
        if (out.some((o) => Math.abs(Date.parse(o.at) - t) < 2 * 3600_000)) continue;
        out.push({ at: new Date(t).toISOString(), value: Number(r.v) });
        if (out.length >= 8) break;
      }
      return out;
    };

    const totals = { playerHours: [...hoursPerDay.values()].reduce((s, v) => s + v, 0), players: players.length };
    return { playHours, afk, marathons, heatmap, heatmapAfk, days, deathsByHour, deathStreaks: deathStreaks.slice(0, 10), deathRate: deathRate.slice(0, 10), loyalty, availability, fullest: spread(topOnline.rows), mostViewers: spread(topViewers.rows), totals };
  });
}

/* ============================================================ Startseite: Verlauf + Bewegung */

export interface TrendPoint {
  at: number;
  online: number;
  live: number;
  viewers: number;
}

/** Letzte `hours` Stunden Server-Verlauf, auf 2-Minuten-Bündel (Maximum) verdichtet. */
export async function getHistoryRange(hours: number): Promise<TrendPoint[]> {
  return cached(`range:${hours}`, 60_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const minutes = hours <= 6 ? 1 : hours <= 24 ? 2 : 5;
    const rows = (
      await db.query<{ at: Date; online: number; live: number; viewers: number }>(
        `SELECT to_timestamp(floor(extract(epoch FROM at) / ($1 * 60)) * ($1 * 60)) AS at, max(online_count) AS online, max(live_count) AS live, max(viewers) AS viewers
           FROM history WHERE at >= $2 GROUP BY 1 ORDER BY 1`,
        [minutes, new Date(Date.now() - hours * 3600_000)],
      )
    ).rows;
    return rows.map((r) => ({ at: new Date(r.at).getTime(), online: Number(r.online), live: Number(r.live), viewers: Number(r.viewers) }));
  });
}

/** Rang je Spieler vor 24 h in jedem Board (aus player_history), für ▲/▼ in den Bestenlisten. */
export async function getBoardRanksBefore(hoursAgo = 24): Promise<Partial<Record<BoardKey, Record<string, number>>>> {
  return cached(`ranksBefore:${hoursAgo}`, 300_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const cutoff = new Date(Date.now() - hoursAgo * 3600_000);
    type RankRow = {
      player: string;
      playtime_seconds: number | string | null;
      deaths: number | string | null;
      diamonds: number | string | null;
      blocks_broken: number | string | null;
      mobs_killed: number | string | null;
      distance: number | string | null;
      damage_dealt: number | string | null;
      totems_used: number | string | null;
      food_eaten: number | string | null;
    };
    const rows = (
      await db.query<RankRow>(
        `WITH known_players AS (
           SELECT DISTINCT player FROM player_history WHERE at <= $1
         )
         SELECT players.player, playtime.playtime_seconds, deaths.deaths, diamonds.diamonds,
                blocks.blocks_broken, mobs.mobs_killed, distance.distance,
                damage.damage_dealt, totems.totems_used, food.food_eaten
           FROM known_players players
           LEFT JOIN LATERAL (
             SELECT playtime_seconds FROM player_history
              WHERE player = players.player AND at <= $1 AND playtime_seconds IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) playtime ON true
           LEFT JOIN LATERAL (
             SELECT deaths FROM player_history
              WHERE player = players.player AND at <= $1 AND deaths IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) deaths ON true
           LEFT JOIN LATERAL (
             SELECT diamonds FROM player_history
              WHERE player = players.player AND at <= $1 AND diamonds IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) diamonds ON true
           LEFT JOIN LATERAL (
             SELECT blocks_broken FROM player_history
              WHERE player = players.player AND at <= $1 AND blocks_broken IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) blocks ON true
           LEFT JOIN LATERAL (
             SELECT mobs_killed FROM player_history
              WHERE player = players.player AND at <= $1 AND mobs_killed IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) mobs ON true
           LEFT JOIN LATERAL (
             SELECT distance FROM player_history
              WHERE player = players.player AND at <= $1 AND distance IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) distance ON true
           LEFT JOIN LATERAL (
             SELECT damage_dealt FROM player_history
              WHERE player = players.player AND at <= $1 AND damage_dealt IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) damage ON true
           LEFT JOIN LATERAL (
             SELECT totems_used FROM player_history
              WHERE player = players.player AND at <= $1 AND totems_used IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) totems ON true
           LEFT JOIN LATERAL (
             SELECT food_eaten FROM player_history
              WHERE player = players.player AND at <= $1 AND food_eaten IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) food ON true`,
        [cutoff],
      )
    ).rows;
    const col: Record<BoardKey, keyof Omit<RankRow, "player">> = {
      playtimeSeconds: "playtime_seconds",
      deaths: "deaths",
      diamonds: "diamonds",
      blocksBroken: "blocks_broken",
      mobsKilled: "mobs_killed",
      distance: "distance",
      damageDealt: "damage_dealt",
      totemsUsed: "totems_used",
      foodEaten: "food_eaten",
    };
    const out: Partial<Record<BoardKey, Record<string, number>>> = {};
    for (const key of BOARD_KEYS) {
      const ranked = rows
        .filter((row) => row[col[key]] !== null)
        .sort((a, b) => Number(b[col[key]]) - Number(a[col[key]]));
      out[key] = Object.fromEntries(ranked.map((row, index) => [row.player, index + 1]));
    }

    return out;
  });
}

/** Letzter Wert je Spieler bis `cutoff` für einen Spaltenausdruck aus `player_history` (feste Ausdrücke, nie aus der Anfrage) */
async function playerValuesAt(column: string, cutoff: Date): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = (
    await db.query<{ player: string; v: number | string }>(
      `WITH known_players AS (SELECT DISTINCT player FROM player_history WHERE at <= $1)
       SELECT players.player, x.v
         FROM known_players players
         JOIN LATERAL (
           SELECT ${column} AS v FROM player_history
            WHERE player = players.player AND at <= $1 AND ${column} IS NOT NULL
            ORDER BY at DESC LIMIT 1
         ) x ON true`,
      [cutoff],
    )
  ).rows;
  return new Map(rows.map((r) => [r.player, Number(r.v)]));
}

/** Rangfolge (1 = bester) aus Werten; nur Werte über 0, wie in den Bestenlisten */
function ranksOf(values: Map<string, number>): Record<string, number> {
  const ranked = [...values].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(ranked.map(([player], i) => [player, i + 1]));
}

/** Rang je Spieler in einer Zusatzwert-Liste vor `hoursAgo` Stunden (Verlauf in `player_history.extra_stats`, alle 5 Min) */
export async function getExtraRanksBefore(key: ExtraStatKey, hoursAgo = 24): Promise<Record<string, number>> {
  return cached(`extraRanksBefore:${key}:${hoursAgo}`, 300_000, async () => {
    await ensureLoaded();
    return ranksOf(await playerValuesAt(extraStatSql(key), new Date(Date.now() - hoursAgo * 3600_000)));
  });
}

/**
 * Rang je Spieler vor `hoursAgo` Stunden in der Liste eines einzelnen Items (`itemKey`) oder, ohne `itemKey`,
 * in der Vielfalt-Liste der Kategorie (Gesamtwert damals minus Summe der damaligen Top 10).
 */
export async function getTopRanksBefore(category: TopCategory, hoursAgo = 24, itemKey?: string): Promise<Record<string, number>> {
  return cached(`topRanksBefore:${category}:${itemKey ?? "*"}:${hoursAgo}`, 300_000, async () => {
    await ensureLoaded();
    const cutoff = new Date(Date.now() - hoursAgo * 3600_000);
    const snapshots = await getTopSnapshotsAt(cutoff);
    const values = new Map<string, number>();
    if (itemKey) {
      for (const [player, tops] of snapshots) {
        const v = tops[category]?.[itemKey];
        if (typeof v === "number") values.set(player, v);
      }
      return ranksOf(values);
    }
    const totalColumn = category === "blocksBroken" ? "blocks_broken" : category === "mobsKilled" ? "mobs_killed" : extraStatSql(category);
    const totals = await playerValuesAt(totalColumn, cutoff);
    for (const [player, tops] of snapshots) {
      const total = totals.get(player);
      const top = Object.values(tops[category] ?? {});
      if (total === undefined || top.length === 0) continue;
      values.set(player, Math.max(0, total - top.reduce((s, v) => s + v, 0)));
    }
    return ranksOf(values);
  });
}

/** Rang je Spieler in der Follower-Bestenliste vor `hoursAgo` Stunden. */
export async function getFollowerRanksBefore(hoursAgo = 24): Promise<Record<string, number>> {
  return cached(`followerRanksBefore:${hoursAgo}`, 300_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const cutoff = new Date(Date.now() - hoursAgo * 3600_000);
    const rows = (
      await db.query<{ player: string; value: number | string }>(
        `SELECT DISTINCT ON (player) player, followers_on_server AS value
           FROM player_history
          WHERE at <= $1 AND followers_on_server IS NOT NULL
          ORDER BY player, at DESC`,
        [cutoff],
      )
    ).rows;
    rows.sort((a, b) => Number(b.value) - Number(a.value));
    return Object.fromEntries(rows.map((row, index) => [row.player, index + 1]));
  });
}

/**
 * Rang je Spieler vor `hoursAgo` Stunden in der Dauergäste-Liste (Online-Zeit laut Tracker).
 * Rückgerechnet aus den Sessions: aktuelle Tracker-Sekunden minus Online-Zeit innerhalb des Zeitfensters.
 */
export async function getTrackedRanksBefore(hoursAgo = 24): Promise<Record<string, number>> {
  return cached(`trackedRanksBefore:${hoursAgo}`, 300_000, async () => {
    const [state, sessions] = await Promise.all([getState(), getAllSessions()]);
    const now = Date.now();
    const cutoff = now - hoursAgo * 3600_000;
    const recent = new Map<string, number>();
    for (const s of sessions) {
      const start = Date.parse(s.start);
      const end = s.end ? Date.parse(s.end) : now;
      const overlap = Math.min(end, now) - Math.max(start, cutoff);
      if (overlap > 0) recent.set(s.player, (recent.get(s.player) ?? 0) + overlap / 1000);
    }
    const rows: { id: string; value: number }[] = [];
    for (const p of Object.values(state.players)) {
      const nowSecs = p.trackedSeconds + (p.online && p.sessionStart ? (now - Date.parse(p.sessionStart)) / 1000 : 0);
      const before = nowSecs - (recent.get(p.id) ?? 0);
      // Nur wer damals schon Online-Zeit hatte (und vor dem Zeitpunkt überhaupt bekannt war), hatte einen Platz
      if (before > 0 && Date.parse(p.firstSeen) <= cutoff) rows.push({ id: p.id, value: before });
    }
    rows.sort((a, b) => b.value - a.value);
    return Object.fromEntries(rows.map((r, i) => [r.id, i + 1]));
  });
}

/* ---------- Spielerprofil: Raten pro Online-Stunde ---------- */

export type RateKey = "deaths" | "diamonds" | "blocksBroken" | "mobsKilled" | "distance";
export const RATE_KEYS: RateKey[] = ["deaths", "diamonds", "blocksBroken", "mobsKilled", "distance"];

export interface PlayerRates {
  /** Zuwachs seit Tracker-Start je Zähler */
  delta: Record<RateKey, number>;
  /** Vom Tracker gemessene Online-Stunden */
  hours: number;
  /** Zuwachs pro Online-Stunde; null, wenn zu wenig Online-Zeit */
  perHour: Record<RateKey, number | null>;
}

const RATE_COL: Record<RateKey, string> = { deaths: "deaths", diamonds: "diamonds", blocksBroken: "blocks_broken", mobsKilled: "mobs_killed", distance: "distance" };
const MIN_HOURS = 0.5;

interface EdgeRow {
  player: string;
  deaths: number | null;
  diamonds: number | null;
  blocks_broken: number | null;
  mobs_killed: number | null;
  distance: number | string | null;
}

/**
 * Raten aller Spieler (Zuwachs seit Tracker-Start geteilt durch gemessene Online-Zeit) plus Serverdurchschnitt.
 * Erster und letzter bekannter Wert je Spieler aus der Historie.
 */
export async function getPlayerRates(): Promise<{ players: Record<string, PlayerRates>; server: Record<RateKey, number | null> }> {
  return cached("playerRates", 300_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const cols = Object.values(RATE_COL).join(", ");
    const [firstRows, lastRows, state] = await Promise.all([
      // Erster und letzter Messpunkt je Spieler über den Primärschlüssel (player, at): ein Index-Zugriff je Spieler
      // statt zweimal die ganze Tabelle zu sortieren
      db.query<EdgeRow>(
        `SELECT p.id AS player, h.* FROM players p
           CROSS JOIN LATERAL (SELECT ${cols} FROM player_history WHERE player = p.id AND deaths IS NOT NULL ORDER BY at ASC LIMIT 1) h`,
      ).then((r) => r.rows),
      db.query<EdgeRow>(
        `SELECT p.id AS player, h.* FROM players p
           CROSS JOIN LATERAL (SELECT ${cols} FROM player_history WHERE player = p.id AND deaths IS NOT NULL ORDER BY at DESC LIMIT 1) h`,
      ).then((r) => r.rows),
      getState(),
    ]);
    const first = new Map(firstRows.map((r) => [r.player, r]));
    const now = Date.now();
    const players: Record<string, PlayerRates> = {};
    const sum = { deaths: 0, diamonds: 0, blocksBroken: 0, mobsKilled: 0, distance: 0 };
    let sumHours = 0;
    for (const last of lastRows) {
      const f = first.get(last.player);
      const p = state.players[last.player];
      if (!f || !p) continue;
      const secs = p.trackedSeconds + (p.online && p.sessionStart ? (now - Date.parse(p.sessionStart)) / 1000 : 0);
      const hours = secs / 3600;
      const d = (k: RateKey) => Math.max(0, Number(last[RATE_COL[k] as keyof EdgeRow] ?? 0) - Number(f[RATE_COL[k] as keyof EdgeRow] ?? 0));
      const delta = { deaths: d("deaths"), diamonds: d("diamonds"), blocksBroken: d("blocksBroken"), mobsKilled: d("mobsKilled"), distance: d("distance") };
      const perHour = Object.fromEntries(RATE_KEYS.map((k) => [k, hours >= MIN_HOURS ? delta[k] / hours : null])) as Record<RateKey, number | null>;
      players[last.player] = { delta, hours, perHour };
      if (hours >= MIN_HOURS) {
        sumHours += hours;
        for (const k of RATE_KEYS) sum[k] += delta[k];
      }
    }
    const server = Object.fromEntries(RATE_KEYS.map((k) => [k, sumHours > 0 ? sum[k] / sumHours : null])) as Record<RateKey, number | null>;
    return { players, server };
  });
}


/* ---------- Spielerprofil: Rang-Verlauf ---------- */


export interface RankHistory {
  /** Bündel-Zeitpunkte (ms) */
  buckets: number[];
  bucketMinutes: number;
  /** Spieler → Liste → Rang je Bündel (null = damals noch kein Wert) */
  players: Record<string, Partial<Record<BoardKey, (number | null)[]>>>;
  /** Liste → Anzahl gerankter Spieler je Bündel */
  of: Partial<Record<BoardKey, number[]>>;
  /** Wie `players`, für die Zusatzwerte aus /api/player (nur Spieler mit Wert werden gerankt) */
  extra: Record<string, Partial<Record<ExtraStatKey, (number | null)[]>>>;
}

const RANK_COL: Record<BoardKey, string> = {
  playtimeSeconds: "playtime_seconds",
  diamonds: "diamonds",
  deaths: "deaths",
  blocksBroken: "blocks_broken",
  mobsKilled: "mobs_killed",
  distance: "distance",
  damageDealt: "damage_dealt",
  totemsUsed: "totems_used",
  foodEaten: "food_eaten",
};

/**
 * Rang aller Spieler in den neun Hauptlisten über die Zeit: je Bündel der letzte bekannte Wert pro Spieler,
 * fortgeschrieben, daraus die Platzierung. Gerankt wird nur, wer in der Liste einen Wert hat.
 * Ein Durchlauf für alle Spieler, 10 Minuten gecacht.
 */
export async function getRankHistory(): Promise<RankHistory> {
  return cached("rankHistory", 600_000, async () => {
    await ensureLoaded();
    const db = await getDb();
    const cols = BOARD_KEYS.map((k) => RANK_COL[k]);
    const anyValue = cols.map((c) => `${c} IS NOT NULL`).join(" OR ");
    // Ältester Messpunkt: je Spieler ein Index-Zugriff statt eines Durchlaufs über die ganze Tabelle
    const first = (
      await db.query<{ at: Date | null }>(
        `SELECT min(h.at) AS at FROM players p CROSS JOIN LATERAL (SELECT at FROM player_history WHERE player = p.id ORDER BY at LIMIT 1) h`,
      )
    ).rows[0]?.at ?? null;
    if (!first) return { buckets: [], bucketMinutes: 60, players: {}, of: {}, extra: {} };
    const spanMin = (Date.now() - new Date(first).getTime()) / 60_000;
    const steps = [30, 60, 120, 180, 360, 720, 1440];
    const minutes = steps.find((s) => spanMin / s <= 120) ?? 1440;
    // Je Spieler und Bündel der letzte Messpunkt mit Werten: ein Index-Zugriff über (player, at) je Paar statt die
    // ganze Tabelle zu gruppieren. Leere Spalten übernimmt die Fortschreibung unten aus dem vorigen Bündel.
    const bucketsSql = `SELECT generate_series(to_timestamp(floor(extract(epoch FROM $2::timestamptz) / ($1 * 60)) * ($1 * 60)), now(), make_interval(mins => $1::int)) AS bucket`;
    const rows = (
      await db.query<Record<string, unknown> & { player: string; bucket: Date }>(
        `WITH b AS (${bucketsSql})
         SELECT p.id AS player, b.bucket, h.*
           FROM players p CROSS JOIN b
           CROSS JOIN LATERAL (
             SELECT ${cols.join(", ")} FROM player_history
              WHERE player = p.id AND at >= b.bucket AND at < b.bucket + make_interval(mins => $1::int) AND (${anyValue})
              ORDER BY at DESC LIMIT 1
           ) h
          ORDER BY b.bucket`,
        [minutes, first],
      )
    ).rows;
    const buckets: number[] = [];
    const last = new Map<string, Partial<Record<BoardKey, number>>>();
    const players: RankHistory["players"] = {};
    const of: RankHistory["of"] = {};
    let i = 0;
    while (i < rows.length) {
      const t = new Date(rows[i].bucket).getTime();
      for (; i < rows.length && new Date(rows[i].bucket).getTime() === t; i++) {
        const r = rows[i];
        const cur = { ...(last.get(r.player) ?? {}) };
        for (const k of BOARD_KEYS) {
          const v = r[RANK_COL[k]];
          if (v !== null && v !== undefined) cur[k] = Number(v);
        }
        last.set(r.player, cur);
      }
      const bi = buckets.length;
      buckets.push(t);
      for (const k of BOARD_KEYS) {
        const order = [...last.entries()].filter(([, v]) => v[k] !== undefined).sort((a, b) => b[1][k]! - a[1][k]!);
        (of[k] ??= []).push(order.length);
        // Gleichstand teilt sich den Platz (wie die API): Platz = 1 + Anzahl echt besserer Spieler
        let place = 0;
        order.forEach(([pid, v], idx) => {
          if (idx === 0 || v[k] !== order[idx - 1][1][k]) place = idx + 1;
          const series = ((players[pid] ??= {})[k] ??= []);
          while (series.length < bi) series.push(null);
          series.push(place);
        });
      }
    }

    // Zusatzwerte: gleiche Bündel, Werte aus dem kompakten integer[] (nur jede ~5. Zeile hat es)
    const extraRows = (
      await db.query<{ player: string; bucket: Date; extra_stats: (number | null)[] }>(
        `WITH b AS (${bucketsSql})
         SELECT p.id AS player, b.bucket, h.extra_stats
           FROM players p CROSS JOIN b
           CROSS JOIN LATERAL (
             SELECT extra_stats FROM player_history
              WHERE player = p.id AND at >= b.bucket AND at < b.bucket + make_interval(mins => $1::int) AND extra_stats IS NOT NULL
              ORDER BY at DESC LIMIT 1
           ) h`,
        [minutes, first],
      )
    ).rows;
    const extraByBucket = new Map<number, typeof extraRows>();
    for (const r of extraRows) {
      const t = new Date(r.bucket).getTime();
      (extraByBucket.get(t) ?? extraByBucket.set(t, []).get(t)!).push(r);
    }
    const extra: RankHistory["extra"] = {};
    const lastExtra = new Map<string, (number | null)[]>();
    buckets.forEach((t, bi) => {
      for (const r of extraByBucket.get(t) ?? []) lastExtra.set(r.player, r.extra_stats);
      if (lastExtra.size === 0) return;
      EXTRA_HISTORY_KEYS.forEach((key, ki) => {
        const order = [...lastExtra.entries()]
          .filter(([, values]) => values[ki] !== null && values[ki] !== undefined)
          .sort((a, b) => Number(b[1][ki]) - Number(a[1][ki]));
        let place = 0;
        order.forEach(([pid, values], idx) => {
          if (idx === 0 || Number(values[ki]) !== Number(order[idx - 1][1][ki])) place = idx + 1;
          const series = ((extra[pid] ??= {})[key] ??= []);
          while (series.length < bi) series.push(null);
          series.push(place);
        });
      });
    });
    return { buckets, bucketMinutes: minutes, players, of, extra };
  });
}

/**
 * Platz je Spieler über die Zeit für den Graphen (aus dem Rang-Verlauf, Bündel wie im Profil).
 * Ohne gewählte Spieler: die fünf, die zuletzt am besten platziert waren.
 */
export async function getRankSeries(q: { key: BoardKey | ExtraStatKey; players: string[]; from: number | null; to: number | null }): Promise<{
  series: { id: string; name: string; points: { at: string; v: number }[] }[];
  bucketMinutes: number;
}> {
  const [h, state] = await Promise.all([getRankHistory(), getState()]);
  const isBoard = (BOARD_KEYS as readonly string[]).includes(q.key);
  const seriesOf = (pid: string): (number | null)[] | undefined =>
    isBoard ? h.players[pid]?.[q.key as BoardKey] : h.extra[pid]?.[q.key as ExtraStatKey];
  const lastOf = (pid: string) => [...(seriesOf(pid) ?? [])].reverse().find((v): v is number => v !== null) ?? Infinity;
  const all = [...new Set([...Object.keys(h.players), ...Object.keys(h.extra)])];
  const ids = q.players.length ? q.players : all.filter((pid) => lastOf(pid) < Infinity).sort((a, b) => lastOf(a) - lastOf(b)).slice(0, 5);
  const from = q.from ?? 0;
  const to = q.to ?? Date.now();
  const series = ids.map((id) => {
    const values = seriesOf(id) ?? [];
    const points = h.buckets.flatMap((t, i) => {
      const v = values[i];
      return v !== null && v !== undefined && t >= from && t <= to ? [{ at: new Date(t).toISOString(), v }] : [];
    });
    return { id, name: state.players[id]?.name ?? id, points };
  });
  return { series, bucketMinutes: h.bucketMinutes };
}
