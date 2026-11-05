import "server-only";
import { getDb } from "./db";
import { runsTracker, servesWeb } from "./mode";

/**
 * Vorberechnete Auswertungen: Der Tracker rechnet teure Dinge (Zuschauerwanderung, Netz, Gruppen über die Zeit) alle
 * paar Minuten im Hintergrund und legt das Ergebnis in `snapshots` ab. Die Website liest nur noch das fertige
 * Ergebnis, statt bei einem Seitenaufruf sekundenlang zu rechnen (das blockierte währenddessen alle anderen Anfragen).
 * Nach einem Neustart ist das letzte Ergebnis sofort da.
 *
 * Gibt es noch kein Ergebnis (erster Start), rechnet die Website einmal selbst.
 */

export interface Snapshot<T> {
  value: T;
  /** ms: wann berechnet */
  at: number;
}

/** So oft fragt die Website nach, ob es ein neueres Ergebnis gibt */
const CHECK_MS = 60_000;

const mem = new Map<string, { at: number; checked: number; value: unknown }>();
const pending = new Map<string, Promise<Snapshot<unknown>>>();

/** JSON mit Maps (als {"__map": [[k, v], …]}) */
const replacer = (_k: string, v: unknown) => (v instanceof Map ? { __map: [...v] } : v);
const reviver = (_k: string, v: unknown) => (v && typeof v === "object" && "__map" in v ? new Map((v as { __map: [unknown, unknown][] }).__map) : v);

async function read<T>(key: string, knownAt: number | null): Promise<Snapshot<T> | "same" | null> {
  const db = await getDb();
  const r = await db.query<{ at: Date }>(`SELECT at FROM snapshots WHERE key = $1`, [key]);
  const at = r.rows[0]?.at.getTime();
  if (at === undefined) return null;
  if (knownAt === at) return "same";
  const d = await db.query<{ data: string }>(`SELECT data FROM snapshots WHERE key = $1`, [key]);
  if (!d.rows[0]) return null;
  return { value: JSON.parse(d.rows[0].data, reviver) as T, at };
}

export async function writeSnapshot(key: string, value: unknown, at = Date.now()) {
  const db = await getDb();
  await db.query(
    `INSERT INTO snapshots (key, at, data) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET at = EXCLUDED.at, data = EXCLUDED.data`,
    [key, new Date(at), JSON.stringify(value, replacer)],
  );
  mem.set(key, { at, checked: Date.now(), value });
}

/**
 * Ergebnis für `key`: aus dem Speicher, sonst aus der Datenbank, sonst einmal selbst gerechnet.
 * Im reinen Tracker (und lokal ohne Trennung) rechnet `compute` selbst und legt das Ergebnis ab, wenn es älter als
 * `maxAgeMs` ist.
 */
export async function snapshot<T>(key: string, compute: () => Promise<T>, maxAgeMs: number): Promise<Snapshot<T>> {
  const now = Date.now();
  const m = mem.get(key);
  const producer = runsTracker();
  if (m && (producer ? now - m.at < maxAgeMs : now - m.checked < CHECK_MS)) return { value: m.value as T, at: m.at };
  let p = pending.get(key) as Promise<Snapshot<T>> | undefined;
  if (!p) {
    p = (async (): Promise<Snapshot<T>> => {
      if (!producer || servesWeb()) {
        const got = await read<T>(key, m?.at ?? null).catch(() => null);
        if (got === "same" && m) {
          m.checked = Date.now();
          if (!producer || Date.now() - m.at < maxAgeMs) return { value: m.value as T, at: m.at };
        } else if (got && got !== "same") {
          mem.set(key, { at: got.at, checked: Date.now(), value: got.value });
          if (!producer || Date.now() - got.at < maxAgeMs) return got;
        }
        // Website mit altem Ergebnis: das alte nehmen, der Tracker rechnet bald neu
        if (!producer && m) return { value: m.value as T, at: m.at };
      }
      const value = await compute();
      const at = Date.now();
      await writeSnapshot(key, value, at).catch((e: unknown) => {
        mem.set(key, { at, checked: Date.now(), value });
        console.error(`[snapshot] ${key} nicht gespeichert:`, e instanceof Error ? e.message : e);
      });
      return { value, at };
    })().finally(() => pending.delete(key));
    pending.set(key, p as Promise<Snapshot<unknown>>);
  }
  return p;
}

/** Zeitpunkt, zu dem `key` zuletzt berechnet wurde (ohne Daten zu laden) */
export function snapshotAt(key: string): number | null {
  return mem.get(key)?.at ?? null;
}
