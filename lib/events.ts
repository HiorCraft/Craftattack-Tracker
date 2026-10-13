import type { EventType, TrackerEvent } from "./types";
import { duration, num, distance } from "./format";

export interface EventMeta {
  label: string;
  tone: string;
  /** Verb/Satz hinter dem Spielernamen */
  text: (e: TrackerEvent) => string;
  sub?: (e: TrackerEvent) => string | null;
}

const berlinTime = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
function farmStartSub(e: TrackerEvent, what: string): string | null {
  const n = Number(e.value ?? 0);
  // Neuere Ereignisse: since = Farm-Beginn, afkSince = Beginn der AFK-Phase; ältere hatten nur since (= AFK-Beginn)
  const afk = typeof e.meta?.afkSince === "string" ? e.meta.afkSince : typeof e.meta?.since === "string" ? e.meta.since : null;
  const win = Number(e.meta?.windowSeconds ?? 0);
  const amount = n > 0 ? (win > 0 ? `${num(n)} ${what} in ${duration(win)}` : `${num(n)} ${what} ohne Bewegung`) : null;
  return [amount, afk ? `AFK seit ${berlinTime(afk)} Uhr` : null].filter(Boolean).join(" · ") || null;
}
function farmEndSub(e: TrackerEvent, what: string): string | null {
  const s = Number(e.meta?.afkSeconds ?? 0);
  const n = Number(e.value ?? 0);
  return [s > 0 ? `Farm ${duration(s)}` : null, n > 0 ? `${num(n)} ${what}` : null].filter(Boolean).join(" · ") || null;
}

export const EVENT_META: Record<EventType, EventMeta> = {
  join: { label: "Join", tone: "grass", text: () => "ist auf den Server gekommen" },
  afk_start: {
    label: "AFK",
    tone: "gold",
    text: () => "ist AFK",
    sub: (e) => (typeof e.meta?.since === "string" ? `Keine Bewegung seit ${new Date(e.meta.since).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })} Uhr` : null),
  },
  afk_mobs_start: {
    label: "Mob-Farm",
    tone: "redstone",
    text: () => "farmt AFK Mobs",
    sub: (e) => farmStartSub(e, "Mobs"),
  },
  afk_mobs_end: {
    label: "Mob-Farm Ende",
    tone: "redstone",
    text: (e) => (e.meta?.byLeave ? "hat die Mob-Farm bis zum Leave laufen lassen" : e.meta?.stillAfk ? "farmt keine Mobs mehr, bleibt aber AFK" : "ist von der Mob-Farm zurück"),
    sub: (e) => farmEndSub(e, "Mobs"),
  },
  afk_blocks_start: {
    label: "Block-Farm",
    tone: "diamond",
    text: () => "baut AFK Blöcke ab",
    sub: (e) => farmStartSub(e, "Blöcke"),
  },
  afk_blocks_end: {
    label: "Block-Farm Ende",
    tone: "diamond",
    text: (e) => (e.meta?.byLeave ? "hat die Block-Farm bis zum Leave laufen lassen" : e.meta?.stillAfk ? "baut keine Blöcke mehr ab, bleibt aber AFK" : "ist von der Block-Farm zurück"),
    sub: (e) => farmEndSub(e, "Blöcke"),
  },
  afk_end: {
    label: "Zurück",
    tone: "grass",
    text: (e) => (e.meta?.byLeave ? "war bis zum Leave AFK" : "ist wieder da"),
    // Keine Farm-Menge über die ganze Phase: die steht minutengenau in den Farm-Ende-Ereignissen
    sub: (e) => {
      const s = Number(e.meta?.afkSeconds ?? 0);
      return s > 0 ? `AFK: ${duration(s)}` : null;
    },
  },
  leave: {
    label: "Leave",
    tone: "paper",
    text: () => "hat den Server verlassen",
    sub: (e) => {
      const s = Number(e.meta?.sessionSeconds ?? 0);
      return s > 0 ? `Session: ${duration(s)}` : null;
    },
  },
  death: {
    label: "Tod",
    tone: "redstone",
    text: (e) =>
      e.meta?.unknown
        ? `${e.delta === 1 ? "Jemand ist" : `${num(e.delta ?? 0)} Spieler sind`} gestorben`
        : e.delta && e.delta > 1
          ? `ist ${num(e.delta)}× gestorben`
          : "ist gestorben",
    sub: (e) =>
      e.meta?.unknown
        ? typeof e.meta.candidates === "number" && e.meta.candidates > 1
          ? `Außerhalb der Top 10 – ${num(e.meta.candidates)} Spieler ohne Einzelstatistik waren online, daher nicht eindeutig.`
          : "Außerhalb der Top 10 – wer genau, verrät die API nicht."
        : [
            e.meta?.inferred ? "Per Ausschluss zugeordnet: einziger Spieler online, den die Einzelstatistik nicht kennt" : null,
            e.value !== undefined ? `Insgesamt ${num(e.value)} Tode` : null,
            e.meta?.live ? "Live auf Twitch" : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
  },
  diamonds: {
    label: "Diamanten",
    tone: "diamond",
    text: (e) => `hat ${num(e.delta ?? 0)} Diamant${e.delta === 1 ? "en" : "en"} gefunden`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  blocksBroken: {
    label: "Blöcke",
    tone: "gold",
    text: (e) => `hat ${num(e.delta ?? 0)} Blöcke abgebaut`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  mobsKilled: {
    label: "Mobs",
    tone: "grass",
    text: (e) => `hat ${num(e.delta ?? 0)} Mobs erledigt`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  distance: {
    label: "Strecke",
    tone: "pink",
    text: (e) => `ist ${distance(e.delta ?? 0)} gelaufen`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${distance(e.value)} insgesamt` : null),
  },
  stream_start: {
    label: "Stream an",
    tone: "twitch",
    text: (e) => (e.meta?.onServer === false ? "ist live gegangen (nicht auf dem Server)" : "ist live gegangen"),
    sub: (e) => (e.meta?.title ? String(e.meta.title) : null),
  },
  stream_end: {
    label: "Stream aus",
    tone: "ender",
    text: () => "hat den Stream beendet",
    sub: (e) => {
      const s = Number(e.meta?.streamSeconds ?? 0);
      const peak = Number(e.meta?.peakViewers ?? 0);
      const parts = [];
      const peakOn = Number(e.meta?.peakViewersOnServer ?? 0);
      if (s > 0) parts.push(`Dauer: ${duration(s)}`);
      if (peak > 0) parts.push(`Peak: ${num(peak)} Zuschauer`);
      if (peakOn > 0 && peakOn !== peak) parts.push(`auf dem Server: ${num(peakOn)}`);
      return parts.length ? parts.join(" · ") : null;
    },
  },
  stream_title: {
    label: "Titel",
    tone: "amethyst",
    text: () => "hat den Streamtitel geändert",
    sub: (e) => (e.meta?.title ? String(e.meta.title) : null),
  },
  subscription: {
    label: "Abo",
    tone: "pink",
    text: (e) => e.player ? "hat in dieser Minute Subs erhalten" : `${e.meta?.channel ?? "Ein Streamer"} hat in dieser Minute Subs erhalten`,
    sub: () => "Minutensumme",
  },
  subscription_gift: {
    label: "Geschenk-Subs",
    tone: "amethyst",
    text: (e) => `hat ${num(e.delta ?? 0)} Subs von ${e.meta?.giftGiverName ?? "einem anderen Streamer"} geschenkt bekommen`,
    sub: (e) => e.meta?.channel ? `im Stream von ${e.meta.channel}` : null,
  },
  raid: {
    label: "Raid",
    tone: "twitch",
    text: (e) => `hat ${e.meta?.raidTargetName ?? "einen anderen Spieler"} geraidet`,
  },
  server_online: { label: "Server", tone: "grass", text: () => "Der Server ist wieder online" },
  server_offline: { label: "Server", tone: "redstone", text: () => "Der Server ist offline gegangen" },
  first_join: {
    label: "Neu",
    tone: "lava",
    text: () => "ist zum ersten Mal auf dem Server aufgetaucht",
    sub: () => "Zumindest seit der Tracker läuft.",
  },
  rank: {
    label: "Rang",
    tone: "gold",
    text: (e) =>
      e.value === 1
        ? `hat die Führung bei „${e.meta?.label}“ übernommen`
        : `ist bei „${e.meta?.label}“ auf Platz ${e.value} geklettert`,
    sub: (e) => (e.meta?.before ? `Vorher Platz ${e.meta.before}` : "Neu in den Top 3"),
  },
  milestone: {
    label: "Meilenstein",
    tone: "amethyst",
    text: (e) => {
      const v = e.value ?? 0;
      switch (String(e.meta?.board ?? "")) {
        case "playtimeSeconds":
          return `hat ${Math.round(v / 3600)} Stunden Spielzeit voll`;
        case "deaths":
          return `ist zum ${num(v)}. Mal gestorben`;
        case "diamonds":
          return `hat ${num(v)} Diamanten zusammen`;
        case "blocksBroken":
          return `hat ${num(v)} Blöcke abgebaut`;
        case "mobsKilled":
          return `hat ${num(v)} Mobs erledigt`;
        case "distance":
          return `ist ${distance(v)} gelaufen`;
        default:
          return `hat ${num(v)} erreicht`;
      }
    },
  },
  record: {
    label: "Rekord",
    tone: "redstone",
    text: (e) => `Neuer Rekord: ${num(e.value ?? 0)} ${e.meta?.label ?? ""}`,
    sub: (e) => (e.delta ? `+${num(e.delta)} gegenüber dem alten Rekord` : null),
  },
  tracker_start: {
    label: "Tracker",
    tone: "sky",
    text: () => "Der Tracker hat angefangen aufzuzeichnen",
    sub: (e) =>
      e.meta ? `${num(Number(e.meta.online ?? 0))} online · ${num(Number(e.meta.live ?? 0))} live` : null,
  },
};

export const EVENT_GROUPS: { key: string; label: string; tone: string; types: EventType[] }[] = [
  { key: "server", label: "Server", tone: "grass", types: ["join", "leave", "afk_start", "afk_mobs_start", "afk_mobs_end", "afk_blocks_start", "afk_blocks_end", "afk_end", "server_online", "server_offline", "tracker_start"] },
  { key: "death", label: "Tode", tone: "redstone", types: ["death"] },
  { key: "loot", label: "Loot & Arbeit", tone: "gold", types: ["diamonds", "blocksBroken", "mobsKilled", "distance"] },
  { key: "twitch", label: "Twitch", tone: "twitch", types: ["stream_start", "stream_end", "stream_title", "subscription", "subscription_gift", "raid"] },
  { key: "highlights", label: "Highlights", tone: "amethyst", types: ["first_join", "rank", "milestone", "record"] },
];

export function typesForGroup(key: string | undefined): EventType[] | null {
  if (!key) return null;
  return EVENT_GROUPS.find((g) => g.key === key)?.types ?? null;
}

/** Kurzer Wert fürs Badge rechts im Feed (z. B. „+3“, „+1,2 km“, „577 Zuschauer“). */
export function eventBadge(e: TrackerEvent): string | null {
  switch (e.type) {
    case "death":
      return `+${num(e.delta ?? 1)}`;
    case "diamonds":
    case "blocksBroken":
    case "mobsKilled":
      return `+${num(e.delta ?? 0)}`;
    case "distance":
      return `+${distance(e.delta ?? 0)}`;
    case "leave": {
      const s = Number(e.meta?.sessionSeconds ?? 0);
      return s > 0 ? duration(s) : null;
    }
    case "stream_start":
    case "stream_title":
      return e.value !== undefined ? `${num(e.value)} Zuschauer` : null;
    case "subscription":
      return `${num(e.value ?? 0)} Subs`;
    case "subscription_gift":
      return `${num(e.delta ?? 0)} Subs`;
    case "raid":
      return e.value !== undefined ? `${num(e.value)} Zuschauer` : null;
    case "stream_end": {
      const s = Number(e.meta?.streamSeconds ?? 0);
      return s > 0 ? duration(s) : null;
    }
    case "afk_end": {
      const s = Number(e.meta?.afkSeconds ?? 0);
      return s > 0 ? duration(s) : null;
    }
    case "afk_mobs_start":
    case "afk_mobs_end":
      return e.value ? `${num(e.value)} Mobs` : null;
    case "afk_blocks_start":
    case "afk_blocks_end":
      return e.value ? `${num(e.value)} Blöcke` : null;
    case "rank":
      return `#${e.value}`;
    case "milestone":
      return e.meta?.board === "playtimeSeconds" ? `${Math.round((e.value ?? 0) / 3600)} h` : e.meta?.board === "distance" ? distance(e.value ?? 0) : num(e.value ?? 0);
    case "record":
      return num(e.value ?? 0);
    case "server_online":
      return e.meta?.onlineCount !== undefined ? `${num(Number(e.meta.onlineCount))} online` : null;
    default:
      return null;
  }
}

/** Alle Ereignistypen mit Label, gruppiert – für den Typ-Filter. */
export const EVENT_TYPES: EventType[] = [
  "join",
  "leave",
  "afk_start",
  "afk_mobs_start",
  "afk_mobs_end",
  "afk_blocks_start",
  "afk_blocks_end",
  "afk_end",
  "first_join",
  "death",
  "diamonds",
  "blocksBroken",
  "mobsKilled",
  "distance",
  "stream_start",
  "stream_end",
  "stream_title",
  "subscription",
  "raid",
  "rank",
  "milestone",
  "record",
  "server_online",
  "server_offline",
  "tracker_start",
];

export const TIME_RANGES: { key: string; label: string; ms: number | null }[] = [
  { key: "1h", label: "Letzte Stunde", ms: 3600_000 },
  { key: "6h", label: "6 Stunden", ms: 6 * 3600_000 },
  { key: "24h", label: "24 Stunden", ms: 24 * 3600_000 },
  { key: "7d", label: "7 Tage", ms: 7 * 24 * 3600_000 },
  { key: "alle", label: "Alles", ms: null },
];
