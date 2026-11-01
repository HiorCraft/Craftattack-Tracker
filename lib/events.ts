import type { EventType, TrackerEvent } from "./types";
import { duration, hearts, num, distance } from "./format";
import { BOARD_TONE, METRIC_TONE } from "./statTone";
import { EXTRA_STATS, FORMATTERS, type ExtraStatKey } from "./playerStats";

/** Zusatzwert eines Ereignisses (Typ „stat“ oder Meilenstein eines Zusatzwerts) */
const extraOf = (e: TrackerEvent) => {
  const key = String(e.meta?.key ?? e.meta?.board ?? "") as ExtraStatKey;
  const m = EXTRA_STATS[key];
  return m ? { key, ...m, fmt: FORMATTERS[m.format] } : null;
};
/** Satz zu einem Zuwachs eines Zusatzwerts */
function statText(e: TrackerEvent): string {
  const x = extraOf(e);
  const d = e.delta ?? 0;
  if (!x) return `hat ${num(d)} erreicht`;
  switch (x.key) {
    case "blocksPlaced":
      return `hat ${num(d)} Blöcke platziert`;
    case "damageTaken":
      return `hat ${hearts(d)} Herzen Schaden eingesteckt`;
    case "raidsWon":
      return d === 1 ? "hat einen Überfall abgewehrt" : `hat ${num(d)} Überfälle abgewehrt`;
    case "itemsCrafted":
      return `hat ${num(d)} Items hergestellt`;
    case "itemsEnchanted":
      return d === 1 ? "hat ein Item verzaubert" : `hat ${num(d)} Items verzaubert`;
    case "tradedWithVillagers":
      return `hat ${num(d)}× mit Dorfbewohnern gehandelt`;
    case "animalsKilled":
      return `hat ${num(d)} Tiere erlegt`;
    case "animalsBred":
      return `hat ${num(d)} Tiere gezüchtet`;
    case "fishCaught":
      return d === 1 ? "hat einen Fisch geangelt" : `hat ${num(d)} Fische geangelt`;
    case "bellsRung":
      return d === 1 ? "hat die Glocke geläutet" : `hat ${num(d)}× die Glocke geläutet`;
    default:
      return `${x.label}: +${x.fmt(d)}`;
  }
}

interface EventMeta {
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
  join: { label: "Join", tone: "white", text: () => "ist auf den Server gekommen" },
  afk_start: {
    label: "AFK",
    tone: METRIC_TONE.afkSeconds,
    text: () => "ist AFK",
    sub: (e) => (typeof e.meta?.since === "string" ? `Keine Bewegung seit ${new Date(e.meta.since).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })} Uhr` : null),
  },
  afk_mobs_start: {
    label: "Mob-Farm",
    tone: METRIC_TONE.afkMobsSeconds,
    text: () => "farmt AFK Mobs",
    sub: (e) => farmStartSub(e, "Mobs"),
  },
  afk_mobs_end: {
    label: "Mob-Farm Ende",
    tone: METRIC_TONE.afkMobsSeconds,
    text: (e) => (e.meta?.byLeave ? "hat die Mob-Farm bis zum Leave laufen lassen" : e.meta?.stillAfk ? "farmt keine Mobs mehr, bleibt aber AFK" : "ist von der Mob-Farm zurück"),
    sub: (e) => farmEndSub(e, "Mobs"),
  },
  afk_blocks_start: {
    label: "Block-Farm",
    tone: METRIC_TONE.afkBlocksSeconds,
    text: () => "baut AFK Blöcke ab",
    sub: (e) => farmStartSub(e, "Blöcke"),
  },
  afk_blocks_end: {
    label: "Block-Farm Ende",
    tone: METRIC_TONE.afkBlocksSeconds,
    text: (e) => (e.meta?.byLeave ? "hat die Block-Farm bis zum Leave laufen lassen" : e.meta?.stillAfk ? "baut keine Blöcke mehr ab, bleibt aber AFK" : "ist von der Block-Farm zurück"),
    sub: (e) => farmEndSub(e, "Blöcke"),
  },
  afk_end: {
    label: "Zurück",
    tone: METRIC_TONE.afkSeconds,
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
    tone: BOARD_TONE.deaths,
    text: (e) =>
      e.meta?.unknown
        ? `${e.delta === 1 ? "Jemand ist" : `${num(e.delta ?? 0)} Spieler sind`} gestorben`
        : e.delta && e.delta > 1
          ? `ist ${num(e.delta)}× gestorben`
          : "ist gestorben",
    sub: (e) => {
      if (e.meta?.unknown) {
        return typeof e.meta.candidates === "number" && e.meta.candidates > 1
          ? `Außerhalb der Top 10 – ${num(e.meta.candidates)} Spieler ohne Einzelstatistik waren online, daher nicht eindeutig.`
          : "Außerhalb der Top 10 – wer genau, verrät die API nicht.";
      }
      return [
        typeof e.meta?.killerName === "string" ? `Von ${e.meta.killerName} getötet` : null,
        typeof e.meta?.deathMessage === "string" ? e.meta.deathMessage : null,
        e.meta?.inferred ? "Per Ausschluss zugeordnet: einziger Spieler online, den die Einzelstatistik nicht kennt" : null,
        e.value !== undefined ? `Insgesamt ${num(e.value)} Tode` : null,
        e.meta?.live ? "Live auf Twitch" : null,
      ]
        .filter(Boolean)
        .join(" · ") || null;
    },
  },
  achievement: {
    label: "Achievement",
    tone: "white",
    text: (e) => `hat das Achievement „${e.meta?.title ?? e.meta?.advancement ?? "unbekannt"}“ erhalten`,
    sub: (e) =>
      [
        typeof e.meta?.advancement === "string" ? e.meta.advancement : null,
        typeof e.meta?.frame === "string" ? e.meta.frame : null,
        typeof e.meta?.message === "string" ? e.meta.message : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  },
  diamonds: {
    label: "Diamanten",
    tone: BOARD_TONE.diamonds,
    text: (e) => `hat ${num(e.delta ?? 0)} Diamant${e.delta === 1 ? "en" : "en"} gefunden`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  blocksBroken: {
    label: "Blöcke",
    tone: BOARD_TONE.blocksBroken,
    text: (e) => `hat ${num(e.delta ?? 0)} Blöcke abgebaut`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  mobsKilled: {
    label: "Mobs",
    tone: BOARD_TONE.mobsKilled,
    text: (e) => `hat ${num(e.delta ?? 0)} Mobs erledigt`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  distance: {
    label: "Strecke",
    tone: BOARD_TONE.distance,
    text: (e) => `ist ${distance(e.delta ?? 0)} gelaufen`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${distance(e.value)} insgesamt` : null),
  },
  damageDealt: {
    label: "Schaden",
    tone: BOARD_TONE.damageDealt,
    text: (e) => `hat ${hearts(e.delta ?? 0)} Herzen Schaden verursacht`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${hearts(e.value)} Herzen insgesamt` : null),
  },
  totemsUsed: {
    label: "Totems",
    tone: BOARD_TONE.totemsUsed,
    text: (e) => `hat ${num(e.delta ?? 0)} Totems benutzt`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  foodEaten: {
    label: "Essen",
    tone: BOARD_TONE.foodEaten,
    text: (e) => `hat ${num(e.delta ?? 0)} Essen gegessen`,
    sub: (e) => (e.value !== undefined ? `Jetzt ${num(e.value)} insgesamt` : null),
  },
  stream_start: {
    label: "Stream an",
    tone: "twitch",
    text: (e) => (e.meta?.onServer === false ? "ist live gegangen (nicht auf dem Server)" : "ist live gegangen"),
    sub: (e) => (e.meta?.title ? String(e.meta.title) : null),
  },
  stream_end: {
    label: "Stream aus",
    tone: "twitch",
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
    tone: "twitch",
    text: () => "hat den Streamtitel geändert",
    sub: (e) => (e.meta?.title ? String(e.meta.title) : null),
  },
  subscription: {
    label: "Abo",
    tone: "twitch",
    text: (e) => e.player ? "hat in dieser Minute Subs erhalten" : `${e.meta?.channel ?? "Ein Streamer"} hat in dieser Minute Subs erhalten`,
    sub: () => "Minutensumme",
  },
  subscription_gift: {
    label: "Geschenk-Subs",
    tone: "twitch",
    text: (e) => `hat ${num(e.delta ?? 0)} Subs von ${e.meta?.giftGiverName ?? "einem anderen Streamer"} geschenkt bekommen`,
    sub: (e) => e.meta?.channel ? `im Stream von ${e.meta.channel}` : null,
  },
  cheer: {
    label: "Cheer",
    tone: "twitch",
    text: (e) => `hat ${num(e.value ?? 0)} Bits von ${e.meta?.fromName ?? "einem Zuschauer"} bekommen`,
    sub: (e) => (e.meta?.fromPlayerName ? `Gecheert hat Spieler ${e.meta.fromPlayerName}` : "Einzelner Cheer"),
  },
  clip: {
    label: "Clip",
    tone: "twitch",
    text: (e) => `wurde geclippt: „${e.meta?.title ?? "Clip"}“`,
    sub: (e) =>
      [
        e.value !== undefined ? `${num(e.value)} Aufrufe` : null,
        typeof e.meta?.creatorName === "string" ? `Clip von ${e.meta.creatorName}` : null,
        typeof e.meta?.clipSeconds === "number" ? `${e.meta.clipSeconds} s` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
  },
  follower_burst: {
    label: "Follower-Schub",
    tone: "twitch",
    text: (e) => `hat ${num(e.delta ?? 0)} Follower in ${duration(Number(e.meta?.windowSeconds ?? 60))} auf dem Server gewonnen (mehr als 20 pro Minute)`,
    sub: (e) => `Auf dem Server insgesamt ${num(e.value ?? 0)} neue Follower erfasst`,
  },
  raid: {
    label: "Raid",
    tone: "twitch",
    text: (e) => `hat ${e.meta?.raidTargetName ?? "einen anderen Spieler"} geraidet`,
  },
  chat: {
    label: "Chat",
    tone: "twitch",
    text: (e) => `schreibt im Chat von ${e.meta?.channelName ?? "einem anderen Spieler"}`,
    sub: (e) => (typeof e.meta?.message === "string" ? `„${e.meta.message}“` : null),
  },
  shared_chat_start: {
    label: "Geteilter Chat",
    tone: "twitch",
    text: (e) => `streamt mit geteiltem Chat mit ${sharedChatWho(e)}`,
    sub: (e) => (e.meta?.sharedChatSource === "chat" ? "Aus geteilten Chat-Nachrichten erkannt" : "Stream Together laut Twitch"),
  },
  shared_chat_end: {
    label: "Geteilter Chat Ende",
    tone: "twitch",
    text: (e) => `hat den geteilten Chat mit ${sharedChatWho(e)} beendet`,
    sub: (e) => (e.delta ? `Dauer ${duration(e.delta)}` : null),
  },
  server_online: { label: "Server", tone: "grass", text: () => "Der Server ist wieder online" },
  server_offline: { label: "Server", tone: "redstone", text: () => "Der Server ist offline gegangen" },
  first_join: {
    label: "Neu",
    tone: "white",
    text: () => "ist zum ersten Mal auf dem Server aufgetaucht",
    sub: () => "Zumindest seit der Tracker läuft.",
  },
  rank: {
    label: "Rang",
    tone: "white",
    text: (e) =>
      e.value === 1
        ? `hat die Führung bei „${e.meta?.label}“ übernommen`
        : `ist bei „${e.meta?.label}“ auf Platz ${e.value} geklettert`,
    sub: (e) => (e.meta?.before ? `Vorher Platz ${e.meta.before}` : "Neu in den Top 3"),
  },
  milestone: {
    label: "Meilenstein",
    tone: "white",
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
        default: {
          const x = extraOf(e);
          return x ? `hat die Marke ${x.fmt(v)} bei „${x.label}“ geknackt` : `hat ${num(v)} erreicht`;
        }
      }
    },
  },
  stat: {
    label: "Statistik",
    tone: "white",
    text: statText,
    sub: (e) => {
      const x = extraOf(e);
      return x && e.value !== undefined ? `Jetzt ${x.fmt(e.value)} insgesamt · ${x.label}` : null;
    },
  },
  record: {
    label: "Rekord",
    tone: "white",
    text: (e) => `Neuer Rekord: ${num(e.value ?? 0)} ${e.meta?.label ?? ""}`,
    sub: (e) => (e.delta ? `+${num(e.delta)} gegenüber dem alten Rekord` : null),
  },
  tracker_start: {
    label: "Tracker",
    tone: "white",
    text: () => "Der Tracker hat angefangen aufzuzeichnen",
    sub: (e) =>
      e.meta ? `${num(Number(e.meta.online ?? 0))} online · ${num(Number(e.meta.live ?? 0))} live` : null,
  },
};

export const EVENT_GROUPS: { key: string; label: string; tone: string; types: EventType[] }[] = [
  { key: "server", label: "Server", tone: "white", types: ["join", "leave", "afk_start", "afk_mobs_start", "afk_mobs_end", "afk_blocks_start", "afk_blocks_end", "afk_end", "server_online", "server_offline", "tracker_start"] },
  { key: "death", label: "Tode", tone: BOARD_TONE.deaths, types: ["death"] },
  { key: "loot", label: "Loot & Arbeit", tone: "white", types: ["diamonds", "blocksBroken", "mobsKilled", "distance", "damageDealt", "totemsUsed", "foodEaten", "stat"] },
  { key: "twitch", label: "Twitch", tone: "twitch", types: ["stream_start", "stream_end", "stream_title", "subscription", "subscription_gift", "cheer", "clip", "follower_burst", "raid", "chat", "shared_chat_start", "shared_chat_end"] },
  { key: "highlights", label: "Highlights", tone: "white", types: ["achievement", "first_join", "rank", "milestone", "record"] },
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
    case "damageDealt":
      return `+${hearts(e.delta ?? 0)} Herzen`;
    case "totemsUsed":
    case "foodEaten":
      return `+${num(e.delta ?? 0)}`;
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
    case "cheer":
      return `${num(e.value ?? 0)} Bits`;
    case "clip":
      return `${num(e.value ?? 0)} Aufrufe`;
    case "follower_burst":
      return `+${num(e.delta ?? 0)} Follower`;
    case "raid":
      return e.value !== undefined ? `${num(e.value)} Zuschauer` : null;
    case "shared_chat_start":
      return e.value !== undefined ? `${num(e.value)} Kanäle` : null;
    case "shared_chat_end":
      return e.delta ? duration(e.delta) : null;
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
      return e.meta?.board === "playtimeSeconds" ? `${Math.round((e.value ?? 0) / 3600)} h` : e.meta?.board === "distance" ? distance(e.value ?? 0) : e.meta?.board === "damageDealt" ? `${hearts(e.value ?? 0)} Herzen` : (extraOf(e)?.fmt(e.value ?? 0) ?? num(e.value ?? 0));
    case "record":
      return num(e.value ?? 0);
    case "stat": {
      const x = extraOf(e);
      return x ? `+${x.fmt(e.delta ?? 0)}` : null;
    }
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
  "achievement",
  "diamonds",
  "blocksBroken",
  "mobsKilled",
  "distance",
  "damageDealt",
  "totemsUsed",
  "foodEaten",
  "stream_start",
  "stream_end",
  "stream_title",
  "subscription",
  "subscription_gift",
  "cheer",
  "clip",
  "follower_burst",
  "raid",
  "chat",
  "shared_chat_start",
  "shared_chat_end",
  "rank",
  "milestone",
  "stat",
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

/**
 * Mindest-Zuwachs, ab dem ein Zähler-Ereignis entsteht bzw. angezeigt wird (Rohwerte der API).
 * Essen: mehr als 2 Mahlzeiten. Schaden: mehr als 20 Herzen (Rohwert ÷ 20, also mehr als 400).
 */
export const EVENT_MIN_DELTA = { foodEaten: 3, damageDealt: 401 } as const;

/**
 * Schwellen fürs Anzeigen in Feeds (gespeichert wird mehr, das bleibt für Graphen und Auswertungen). Gewählt nach der
 * Verteilung der Zuwächse je Abfrage: Übrig bleiben die auffälligen ~1–5 %, statt dass Strecke, Blöcke und Abos den
 * Feed füllen (vorher z. B. 1.600 Strecken-Ereignisse am Tag). Abos: Zahl je Minute im Kanal.
 */
export const FEED_MIN_DELTA: Partial<Record<TrackerEvent["type"], number>> = {
  distance: 6000,
  blocksBroken: 2000,
  mobsKilled: 500,
  damageDealt: 3000, // 150 Herzen (Rohwert ÷ 20)
  foodEaten: 10,
  subscription: 20,
};

/** Kleine Zähler-Ereignisse ausblenden (auch ältere, die vor der Schwelle gespeichert wurden) */
export function isShownEvent(e: Pick<TrackerEvent, "type" | "delta"> & { value?: number }): boolean {
  const min = FEED_MIN_DELTA[e.type];
  if (min === undefined) return true;
  return (e.type === "subscription" ? (e.value ?? e.delta ?? 0) : (e.delta ?? 0)) >= min;
}

/** Beteiligte eines geteilten Chats als Text, z. B. „Papaplatte, Trymacs und 1 weiterer Kanal" */
function sharedChatWho(e: Pick<TrackerEvent, "meta" | "player">): string {
  // Der Spieler des Ereignisses steht schon vorne im Satz
  const ids = sharedChatPlayers(e);
  const names = String(e.meta?.sharedChatNames ?? "").split(", ").filter((name, i) => name && ids[i] !== e.player);
  const others = Number(e.meta?.sharedChatOthers ?? 0);
  const parts = [...names, ...(others > 0 ? [`${others} ${others === 1 ? "weiterer Kanal" : "weitere Kanäle"}`] : [])];
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} und ${parts[parts.length - 1]}`;
}

/** Spieler-IDs, die an einem Geteilter-Chat-Ereignis beteiligt sind */
export function sharedChatPlayers(e: Pick<TrackerEvent, "meta">): string[] {
  return String(e.meta?.sharedChatPlayers ?? "").split(",").filter(Boolean);
}

/**
 * Alle an einem Ereignis beteiligten Spieler, der Handelnde zuerst: Opfer und Täter eines Tods, Raid-Ziel,
 * Sub-Schenker, Kanal einer Chatnachricht und die Spieler eines geteilten Chats.
 */
export function eventPlayers(e: Pick<TrackerEvent, "player" | "type" | "meta">): string[] {
  const ids = [
    e.player,
    e.type === "death" ? e.meta?.killerId : null,
    e.meta?.raidTargetPlayerId,
    e.meta?.giftGiverPlayerId,
    e.type === "chat" ? e.meta?.channelId : null,
    ...sharedChatPlayers(e),
  ];
  return [...new Set(ids.filter((x): x is string => typeof x === "string" && x !== ""))];
}

/**
 * Ziel eines Klicks auf ein Ereignis: die Ereignisse-Seite mit diesem Spieler und dieser Art, auf der Seite des
 * Ereignisses und dorthin gescrollt.
 */
export function eventHref(e: Pick<TrackerEvent, "id" | "player" | "type">): string {
  const p = new URLSearchParams();
  if (e.player) p.set("spieler", e.player);
  p.set("t", e.type);
  p.set("ev", e.id);
  return `/ereignisse?${p}#ev-${e.id}`;
}

/** VOD-Links der Chat-Ereignisse je Chat-Nachricht (ID ohne `chat-`), für klickbare Nachrichten im Chat-Verlauf */
export function chatVodLinks(events: TrackerEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type === "chat" && typeof e.meta?.vodUrl === "string") out.set(e.id.slice("chat-".length), e.meta.vodUrl);
  }
  return out;
}
