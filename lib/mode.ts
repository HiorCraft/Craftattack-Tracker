/**
 * Betriebsmodus des Prozesses, gesteuert über `TRACKER_MODE`:
 * - `all` (Standard): Website und Tracker laufen im selben Prozess.
 * - `web`: nur die Website. Poller, Twitch-IRC und Nachträge starten nicht;
 *   `/api/tracker/poll` und `/api/cron/poll` bleiben für externe Cron-Aufrufe nutzbar.
 * - `tracker`: nur der Tracker. Seiten antworten mit 503; erreichbar bleiben
 *   `/api/tracker` (Status) sowie `/api/tracker/poll` und `/api/cron/poll`.
 *
 * Kein `server-only`, damit `proxy.ts` den Modus lesen kann.
 */
type TrackerMode = "all" | "web" | "tracker";

function parseMode(raw: string | undefined): TrackerMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "all") return "all";
  if (value === "web" || value === "tracker") return value;
  console.warn(`[tracker] Unbekannter TRACKER_MODE "${raw}", verwende "all".`);
  return "all";
}

let cached: TrackerMode | undefined;

export function trackerMode(): TrackerMode {
  if (!cached) cached = parseMode(process.env.TRACKER_MODE);
  return cached;
}

/** Soll dieser Prozess den Poller, Twitch-IRC und die Nachträge betreiben? Die Schätzungs-Ausgabe nie. */
export function runsTracker(): boolean {
  return trackerMode() !== "web" && process.env.NEXT_PUBLIC_CA_ESTIMATE !== "1";
}

/** Soll dieser Prozess die Website ausliefern? */
export function servesWeb(): boolean {
  return trackerMode() !== "tracker";
}
