import "server-only";
import { fetchCraftAttack, USER_AGENT } from "./craftattackFetch";
import { getDb } from "./db";

export interface OfficialEvent {
  title: string;
  text: string;
  href: string;
  date: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, bei eintägigen Events gleich `date`
  /** Beginn und Ende als HH:MM (Europe/Berlin); null, wenn die Seite keine Uhrzeit nennt */
  time: string | null;
  endTime: string | null;
  season: string;
  seasonHref: string | null;
  /** Anzahl Teilnehmer laut Karte, 0 ohne Angabe */
  participantCount: number;
  /** Spieler-IDs der Teilnehmer ("Mit dabei" auf der Event-Seite, sonst die Köpfe auf der Karte) */
  participants: string[];
}

export type EventState = "upcoming" | "today" | "live" | "past";

const BASE = "https://craftattack.one";
const HEADERS = { "user-agent": USER_AGENT };

function decode(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function strip(html: string) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Attribute eines Start-Tags, unabhängig von der Reihenfolge */
function attrs(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((m) => [m[1], decode(m[2] ?? "")]));
}

const absolute = (href: string) => (href.startsWith("http") ? href : BASE + href);

/**
 * Zustand eines Events nach denselben Regeln wie craftattack.one.
 * `now` ist die aktuelle Zeit als "YYYY-MM-DDTHH:MM" in Europe/Berlin.
 */
export function eventState(e: Pick<OfficialEvent, "date" | "end" | "time" | "endTime">, now: string): EventState {
  const today = now.slice(0, 10);
  if (e.end < today || (e.endTime && `${e.end}T${e.endTime}` <= now)) return "past";
  if (e.date > today) return "upcoming";
  if (!e.time || `${e.date}T${e.time}` > now) return "today";
  return "live";
}

/** Teilnehmer aus dem Abschnitt "Mit dabei" einer Event-Seite (`<article class="player" data-player="…">`) */
async function fetchParticipants(href: string): Promise<string[] | null> {
  try {
    const res = await fetchCraftAttack(href, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const start = html.search(/aria-labelledby="dabei"/);
    if (start < 0) return null;
    const section = html.slice(start, html.indexOf("</section>", start));
    return [...new Set([...section.matchAll(/data-player="([^"]+)"/g)].map((m) => m[1]))];
  } catch {
    return null;
  }
}

/** Liest die Event-Karten von craftattack.one/events/ samt Teilnehmern. Wirft bei Fehlern. */
async function scrapeOfficialEvents(): Promise<OfficialEvent[]> {
  const res = await fetchCraftAttack(`${BASE}/events/`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).replace(/ data-astro-cid-[a-z0-9]+(="[^"]*")?/g, "");
  const events: OfficialEvent[] = [];

  // Abschnitte pro Staffel: <section ...> <h2>Name</h2> <a class="btn" href="/staffeln/..."> und die Karten
  for (const sec of html.split(/<section\b/).slice(1)) {
    const season = strip(sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "");
    const seasonHref = sec.match(/href="(\/staffeln\/[^"]+)"/)?.[1] ?? null;
    for (const m of sec.matchAll(/<a\b([^>]*\bevent-card\b[^>]*)>([\s\S]*?)<\/a>/g)) {
      const a = attrs(m[1]);
      const inner = m[2];
      const title = strip(inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? "");
      const date = a["data-event-date"];
      if (!title || !a.href || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
      events.push({
        title,
        text: strip(inner.match(/<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ""),
        href: absolute(a.href),
        date,
        end: a["data-event-end"] || date,
        time: a["data-event-time"] || null,
        endTime: a["data-event-end-time"] || null,
        season,
        seasonHref: seasonHref ? absolute(seasonHref) : null,
        participantCount: Number(inner.match(/aria-label="(\d+) dabei"/)?.[1] ?? 0),
        participants: [...inner.matchAll(/\/skins\/([\w-]+)-head\./g)].map((h) => h[1]),
      });
    }
  }

  // Ändert die Seite ihr Format, lieber laut melden als still "Nichts angekündigt" zeigen
  const cards = html.match(/data-event-date="/g)?.length ?? 0;
  if (cards > events.length) throw new Error(`Unbekanntes Format: ${events.length} von ${cards} Event-Karten gelesen`);

  // Die Karte zeigt nur einige Köpfe; die vollständige Liste steht auf der Event-Seite.
  // Nacheinander abfragen, damit craftattackFetch die Pausen nach einer Sperre einhalten kann.
  for (const e of events) {
    if (e.participants.length >= e.participantCount) continue;
    const all = await fetchParticipants(e.href);
    if (all?.length) e.participants = all;
  }

  events.sort((a, b) => `${b.date}T${b.time ?? ""}`.localeCompare(`${a.date}T${a.time ?? ""}`));
  return events;
}

/**
 * Tracker: Termine holen und speichern. Bei einem Fehler bleibt der letzte gute Stand, nur der Fehler wird vermerkt.
 * Abgefragt wird vom Tracker aus, weil craftattack.one die Website-IP sperren kann (Cloudflare, HTTP 403).
 */
export async function syncOfficialEvents(): Promise<void> {
  const db = await getDb();
  try {
    const events = await scrapeOfficialEvents();
    await db.query(
      `INSERT INTO official_events (id, events, fetched_at, error, error_at) VALUES (1, $1, now(), NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET events = EXCLUDED.events, fetched_at = now(), error = NULL, error_at = NULL`,
      [JSON.stringify(events)],
    );
    console.log(`[tracker] ${events.length} offizielle Events abgeglichen`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `INSERT INTO official_events (id, error, error_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET error = EXCLUDED.error, error_at = now()`,
      [message],
    );
    console.warn(`[tracker] Offizielle Events nicht abrufbar: ${message}`);
  }
}

const EVENTS_SYNC_MS = 60 * 60_000;

/** Tracker: Termine kurz nach dem Start und danach stündlich abgleichen (einmal pro Prozess). */
export function startOfficialEventsSync() {
  const gl = globalThis as typeof globalThis & { __acEventsSync?: boolean };
  if (gl.__acEventsSync) return;
  gl.__acEventsSync = true;
  const run = () => void syncOfficialEvents().catch((err: unknown) => console.error("[tracker] Events-Abgleich fehlgeschlagen:", err));
  setTimeout(run, 30_000).unref();
  setInterval(run, EVENTS_SYNC_MS).unref();
}

/**
 * Website: zuletzt gespeicherte Termine. `error` nur, wenn es gar keinen Stand gibt oder der letzte gute Stand
 * älter als einige Stunden ist; ein einzelner fehlgeschlagener Abgleich ändert an der Anzeige nichts.
 */
export async function getOfficialEvents(): Promise<{ events: OfficialEvent[]; error: string | null; fetchedAt: string | null }> {
  const db = await getDb();
  const row = (
    await db.query<{ events: OfficialEvent[]; fetched_at: Date | null; error: string | null }>(
      `SELECT events, fetched_at, error FROM official_events WHERE id = 1`,
    )
  ).rows[0];
  if (!row?.fetched_at) return { events: [], error: row?.error ?? "Noch nicht abgeglichen", fetchedAt: null };
  const stale = Date.now() - row.fetched_at.getTime() > 3 * EVENTS_SYNC_MS;
  return { events: row.events, error: stale ? (row.error ?? "Abgleich überfällig") : null, fetchedAt: row.fetched_at.toISOString() };
}
