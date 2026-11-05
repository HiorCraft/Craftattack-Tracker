import { boardValue, eur, num } from "./format";
import { GROUP_TONE, METRIC_TONE } from "./statTone";
import { EXTRA_STATS, EXTRA_STAT_KEYS, FORMATTERS, type ExtraMetric, type ExtraStatKey, type StatGroup } from "./playerStats";
import { BOARD_KEYS, type BoardKey } from "./types";
import { LEADERBOARDS, isTopCategory, topCategoryLabel, type TopCategory } from "./leaderboards";

/* ---------- Konfiguration ---------- */

type BaseMetric = "onlineCount" | "liveCount" | "viewers" | "playtimeSeconds" | "afkSeconds" | "afkMobsSeconds" | "afkBlocksSeconds" | "deaths" | "diamonds" | "blocksBroken" | "mobsKilled" | "distance" | "damageDealt" | "totemsUsed" | "foodEaten" | "followers" | "twitchSubs" | "twitchBits" | "twitchEarnings" | "online";
/** Liste, deren Rang-Verlauf es gibt (Hauptlisten und Zusatzwerte) */
export type RankKey = BoardKey | ExtraStatKey;
/** Platz eines Spielers in einer Bestenliste über die Zeit */
export type RankMetric = `rank:${RankKey}`;
/** Anzahl eines einzelnen Blocks/Mobs/Tiers aus den Top-Listen eines Spielers */
export type ItemMetric = `item:${TopCategory}|${string}`;
export type Metric = BaseMetric | ExtraMetric | RankMetric | ItemMetric;

/**
 * Einheit einer Kennzahl. Kennzahlen mit derselben Einheit teilen sich eine echte Y-Achse (Blöcke mit Blöcken,
 * Stunden mit Stunden …); bei verschiedenen Einheiten wird jede Linie auf ihr Maximum skaliert (%).
 */
export type Unit =
  | "spieler" | "streams" | "zuschauer" | "follower" | "subs" | "bits" | "euro" | "online" | "zeit" | "bloecke" | "kills" | "herzen" | "strecke"
  | "items" | "diamanten" | "tode" | "totems" | "raids" | "spruenge" | "truhen" | "handel" | "zucht" | "fische" | "glocken" | "platz";

export type MetricGroup = StatGroup | "server" | "rang" | "einzeln";

export interface MetricMeta {
  label: string;
  /** Gibt es die Kennzahl pro Spieler? Sonst nur für den Server. */
  perPlayer: boolean;
  /** Zähler, der nur steigt (Treppenlinie, Zuwachs sinnvoll) */
  counter: boolean;
  format: (v: number) => string;
  hint?: string;
  /** Farbton der Kachel in der Auswahl */
  tone: string;
  /** Icon-Name aus `Icon` */
  icon: string;
  /** Rubrik in der Auswahl; Server-Kennzahlen haben eine eigene */
  group: MetricGroup;
  unit: Unit;
  /** Kleiner ist besser (Rang): Achse umgedreht, Platz 1 oben */
  invert?: boolean;
  /** Ohne gewählte Spieler zeigt der Graph die besten fünf statt einer Summe */
  needsPlayers?: boolean;
}

const EXTRA_HINT = "Verlauf beginnt mit der Erfassung über die Einzelstatistik der API";
const hours = (v: number) => boardValue("playtimeSeconds", v);

const BASE_METRICS: Record<BaseMetric, MetricMeta> = {
  onlineCount: { label: "Spieler online", perPlayer: false, counter: false, format: num, tone: METRIC_TONE.onlineCount, icon: "users", group: "server", unit: "spieler" },
  liveCount: { label: "Streams live", perPlayer: false, counter: false, format: num, tone: METRIC_TONE.liveCount, icon: "twitch", group: "server", unit: "streams" },
  playtimeSeconds: { label: "Spielzeit", perPlayer: true, counter: true, format: hours, tone: METRIC_TONE.playtimeSeconds, icon: "clock", group: "allgemein", unit: "zeit" },
  online: { label: "Online (ja/nein)", perPlayer: true, counter: false, format: (v) => (v >= 1 ? "online" : "offline"), hint: "Ohne Spieler: Anzahl online", tone: METRIC_TONE.online, icon: "login", group: "allgemein", unit: "online" },
  viewers: { label: "Zuschauer", perPlayer: true, counter: false, format: num, hint: "Ohne Spieler: Summe aller Streams", tone: METRIC_TONE.viewers, icon: "eye", group: "allgemein", unit: "zuschauer" },
  followers: { label: "Follower", perPlayer: true, counter: true, format: num, hint: "Kumulierte neue Twitch-Follower während aufeinanderfolgender Messungen auf dem Server", tone: METRIC_TONE.followers, icon: "users", group: "allgemein", unit: "follower" },
  twitchSubs: { label: "Twitch Subs", perPlayer: true, counter: true, format: num, hint: "Abos, die eingegangen sind, während der Streamer auf dem Server online war", tone: METRIC_TONE.twitchSubs, icon: "gift", group: "allgemein", unit: "subs" },
  twitchBits: { label: "Twitch Bits", perPlayer: true, counter: true, format: num, hint: "Bits aus Cheers im Kanal, während der Streamer auf dem Server war", tone: METRIC_TONE.twitchBits, icon: "bits", group: "allgemein", unit: "bits" },
  twitchEarnings: { label: "Twitch-Einnahmen", perPlayer: true, counter: true, format: eur, hint: "Geschätzt aus Abos (Stufe, Prime, Anteil je Kanal) und Bits, während der Streamer auf dem Server war; ohne Werbung", tone: METRIC_TONE.twitchEarnings, icon: "coin", group: "allgemein", unit: "euro" },
  diamonds: { label: "Diamanten", perPlayer: true, counter: true, format: num, tone: METRIC_TONE.diamonds, icon: "diamond", group: "abbau", unit: "diamanten" },
  blocksBroken: { label: "Blöcke abgebaut", perPlayer: true, counter: true, format: num, tone: METRIC_TONE.blocksBroken, icon: "pickaxe", group: "abbau", unit: "bloecke" },
  deaths: { label: "Tode", perPlayer: true, counter: true, format: num, tone: METRIC_TONE.deaths, icon: "skull", group: "kampf", unit: "tode" },
  mobsKilled: { label: "Mobs", perPlayer: true, counter: true, format: num, tone: METRIC_TONE.mobsKilled, icon: "sword", group: "kampf", unit: "kills" },
  damageDealt: { label: "Schaden", perPlayer: true, counter: true, format: (v) => boardValue("damageDealt", v), hint: "Ausgeteilter Schaden in Herzen", tone: METRIC_TONE.damageDealt, icon: "heart", group: "kampf", unit: "herzen" },
  totemsUsed: { label: "Totems", perPlayer: true, counter: true, format: num, tone: METRIC_TONE.totemsUsed, icon: "totem", group: "kampf", unit: "totems" },
  distance: { label: "Strecke", perPlayer: true, counter: true, format: (v) => boardValue("distance", v), tone: METRIC_TONE.distance, icon: "boots", group: "bewegung", unit: "strecke" },
  foodEaten: { label: "Essen", perPlayer: true, counter: true, format: num, tone: METRIC_TONE.foodEaten, icon: "food", group: "items", unit: "items" },
  afkSeconds: { label: "AFK-Zeit", perPlayer: true, counter: true, format: hours, hint: "AFK laut Server (ab 5 Min ohne Bewegung), als Phasen seit Tracker-Start; ohne Server-Zähler geschätzt", tone: METRIC_TONE.afkSeconds, icon: "clock", group: "afk", unit: "zeit" },
  afkMobsSeconds: { label: "AFK: Mobs farmen", perPlayer: true, counter: true, format: hours, hint: "AFK-Zeit, in der trotzdem ≥ 10 Mobs pro Minute gestorben sind (Mob-Farm)", tone: METRIC_TONE.afkMobsSeconds, icon: "sword", group: "afk", unit: "zeit" },
  afkBlocksSeconds: { label: "AFK: Blöcke farmen", perPlayer: true, counter: true, format: hours, hint: "AFK-Zeit, in der trotzdem ≥ 10 Blöcke pro Minute abgebaut wurden (Block-Farm)", tone: METRIC_TONE.afkBlocksSeconds, icon: "pickaxe", group: "afk", unit: "zeit" },
};

/** Einheit der Zusatzwerte: gleiche Dinge zählen auf derselben Achse */
const EXTRA_UNIT: Record<ExtraStatKey, Unit> = {
  blocksPlaced: "bloecke",
  damageTaken: "herzen",
  raidsWon: "raids",
  jumps: "spruenge",
  distanceFallen: "strecke",
  sneakSeconds: "zeit",
  itemsCrafted: "items",
  itemsPickedUp: "items",
  itemsDropped: "items",
  itemsEnchanted: "items",
  chestsOpened: "truhen",
  tradedWithVillagers: "handel",
  animalsKilled: "kills",
  animalsBred: "zucht",
  fishCaught: "fische",
  bellsRung: "glocken",
  afkSeconds: "zeit",
};

const EXTRA_METRIC_META = Object.fromEntries(
  EXTRA_STAT_KEYS.map((k) => {
    const x = EXTRA_STATS[k];
    const meta: MetricMeta = { label: x.label, perPlayer: true, counter: true, format: FORMATTERS[x.format], hint: EXTRA_HINT, tone: GROUP_TONE[x.group], icon: x.icon, group: x.group, unit: EXTRA_UNIT[k] };
    return [x.metric, meta];
  }),
) as Record<ExtraMetric, MetricMeta>;

export const METRICS: Record<BaseMetric | ExtraMetric, MetricMeta> = { ...BASE_METRICS, ...EXTRA_METRIC_META };
export const METRIC_KEYS = Object.keys(METRICS) as (BaseMetric | ExtraMetric)[];

/** Listen mit Rang-Verlauf in der Reihenfolge der Auswahl */
export const RANK_KEYS: RankKey[] = [...BOARD_KEYS, ...EXTRA_STAT_KEYS];
const isRankKey = (k: string): k is RankKey => (RANK_KEYS as string[]).includes(k);

/** Einheit der Top-Listen-Kategorien */
const TOP_UNIT: Record<TopCategory, Unit> = { blocksBroken: "bloecke", blocksPlaced: "bloecke", mobsKilled: "kills", animalsKilled: "kills" };
const TOP_VERB: Record<TopCategory, string> = { blocksBroken: "abgebaut", blocksPlaced: "platziert", mobsKilled: "erledigt", animalsKilled: "erledigt" };

export const rankMetric = (k: RankKey): RankMetric => `rank:${k}`;
export const itemMetric = (c: TopCategory, key: string): ItemMetric => `item:${c}|${key}`;

/** Zerlegt eine Item-Kennzahl in Kategorie und Item-Key */
export function parseItemMetric(m: string): { category: TopCategory; key: string } | null {
  const match = /^item:([a-zA-Z]+)\|([a-z0-9_.:-]+)$/.exec(m);
  return match && isTopCategory(match[1]) ? { category: match[1], key: match[2] } : null;
}
export const rankKeyOf = (m: string): RankKey | null => (m.startsWith("rank:") && isRankKey(m.slice(5)) ? (m.slice(5) as RankKey) : null);

/** Name der Wert-Kennzahl einer Liste (Zusatzwerte heißen im Graphen teils anders, z. B. serverAfkSeconds) */
const valueMetricOf = (k: RankKey): Metric => ((BOARD_KEYS as string[]).includes(k) ? k : EXTRA_STATS[k as ExtraStatKey].metric) as Metric;

/** Platz-Kennzahl zu einer Wert-Kennzahl, falls es dafür einen Rang-Verlauf gibt */
export function rankOfMetric(m: Metric): RankMetric | null {
  const k = RANK_KEYS.find((x) => valueMetricOf(x) === m);
  return k ? rankMetric(k) : null;
}

/** Wert-Kennzahl zu einer Platz-Kennzahl */
export function valueOfRank(m: Metric): Metric | null {
  const k = rankKeyOf(m);
  return k ? valueMetricOf(k) : null;
}

export function isMetric(m: string): m is Metric {
  return m in METRICS || rankKeyOf(m) !== null || parseItemMetric(m) !== null;
}

/**
 * Beschreibung jeder Kennzahl, auch der zusammengesetzten (Rang, einzelnes Item).
 * `itemName` liefert den Anzeigenamen eines Items (z. B. „Netherrack“), sonst steht der Key da.
 */
export function metaOf(m: Metric, itemName?: (category: TopCategory, key: string) => string | undefined): MetricMeta {
  if (m in METRICS) return METRICS[m as keyof typeof METRICS];
  const rank = rankKeyOf(m);
  if (rank) {
    const board = LEADERBOARDS[rank];
    return {
      label: `Platz: ${board.title}`,
      perPlayer: true,
      counter: false,
      format: (v) => `#${num(Math.round(v))}`,
      hint: `Platz in der Bestenliste „${board.title}“ (${board.sub})`,
      tone: board.tone,
      icon: "trophy",
      group: "rang",
      unit: "platz",
      invert: true,
      needsPlayers: true,
    };
  }
  const item = parseItemMetric(m)!;
  return {
    label: `${itemName?.(item.category, item.key) ?? item.key} ${TOP_VERB[item.category]}`,
    perPlayer: true,
    counter: true,
    format: num,
    hint: `${topCategoryLabel(item.category)}: nur Spieler, bei denen es in den eigenen Top 10 steht`,
    tone: LEADERBOARDS[`rest-${item.category}`].tone,
    icon: item.category.startsWith("blocks") ? "pickaxe" : "sword",
    group: "einzeln",
    unit: TOP_UNIT[item.category],
    needsPlayers: true,
  };
}

export type { ItemOptions } from "./leaderboards";

export const RANGES: { key: string; label: string; ms: number | null }[] = [
  { key: "1h", label: "1 Std", ms: 3600_000 },
  { key: "6h", label: "6 Std", ms: 6 * 3600_000 },
  { key: "12h", label: "12 Std", ms: 12 * 3600_000 },
  { key: "24h", label: "24 Std", ms: 24 * 3600_000 },
  { key: "3d", label: "3 Tage", ms: 3 * 24 * 3600_000 },
  { key: "7d", label: "7 Tage", ms: 7 * 24 * 3600_000 },
  { key: "alle", label: "Alles", ms: null },
  { key: "eigen", label: "Eigener", ms: null },
];
export const RASTER: { key: string; label: string }[] = [
  { key: "auto", label: "Auto" },
  { key: "1", label: "1 Min" },
  { key: "5", label: "5 Min" },
  { key: "15", label: "15 Min" },
  { key: "60", label: "1 Std" },
  { key: "360", label: "6 Std" },
  { key: "1440", label: "1 Tag" },
];
export const COLORS = ["var(--ink)", "#9146ff", "#ff6452", "#1f9e8f", "#2f9a1f", "#d9a300", "#d35fb3", "#ff7a00", "#2b7bd1", "#8a5a3b", "#4f1a6d", "#6d6d6d"];

export interface PlayerOption {
  id: string;
  name: string;
  uuid?: string;
  online?: boolean;
}

export const MAX_METRICS = 6;

/** Tagesverlauf: wie die Tage zusammengefasst werden */
export const DAY_MODES = [
  { key: "linien", label: "Linie je Tag" },
  { key: "summe", label: "Summe" },
  { key: "schnitt", label: "Durchschnitt" },
] as const;
export type DayModeKey = (typeof DAY_MODES)[number]["key"];
export const DAY_SPREADS = [
  { key: "keine", label: "keine" },
  { key: "quartile", label: "mittlere Hälfte" },
  { key: "spanne", label: "Spannweite" },
] as const;
export type DaySpreadKey = (typeof DAY_SPREADS)[number]["key"];
export const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

export interface GraphQuery {
  /** Mindestens eine Kennzahl; mehrere werden gemeinsam gezeichnet */
  metrics: Metric[];
  spieler: string[];
  zeit: string;
  von: string;
  bis: string;
  raster: string;
  modus: "wert" | "zuwachs";
  /** Y-Achse: gemeinsame Einheit (wenn möglich) oder immer Prozent des eigenen Maximums */
  achse: "einheit" | "prozent";
  /** Zeitachse (fortlaufend) oder Tagesverlauf (alle Tage auf 0–24 Uhr gelegt) */
  ansicht: "zeit" | "tag";
  /** Tagesverlauf: Linie je Tag, Summe oder Durchschnitt */
  tage: DayModeKey;
  /** Tagesverlauf, Durchschnitt: Streuband */
  streuung: DaySpreadKey;
  /** Tagesverlauf: erlaubte Wochentage als Ziffern 1 (Mo) … 7 (So) */
  wochentage: string;
  /** Tagesverlauf: Abschnitte ohne Messpunkt – auto (Zähler 0, sonst auslassen), als 0 oder auslassen */
  luecken: "auto" | "null" | "auslassen";
}

/** Query-Parameter → Konfiguration (auch serverseitig nutzbar) */
export function parseGraphQuery(sp: Record<string, string | string[] | undefined>): GraphQuery {
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const metrics = [...new Set(s("metric").split(",").map((x) => x.trim()))].filter(isMetric).slice(0, MAX_METRICS);
  return {
    metrics: metrics.length ? metrics : ["onlineCount"],
    spieler: s("spieler").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 12),
    zeit: RANGES.some((r) => r.key === s("zeit")) ? s("zeit") : "24h",
    von: s("von"),
    bis: s("bis"),
    raster: RASTER.some((r) => r.key === s("raster")) ? s("raster") : "auto",
    modus: s("modus") === "zuwachs" ? "zuwachs" : "wert",
    achse: s("achse") === "prozent" ? "prozent" : "einheit",
    ansicht: s("ansicht") === "tag" ? "tag" : "zeit",
    tage: DAY_MODES.some((m) => m.key === s("tage")) ? (s("tage") as DayModeKey) : "schnitt",
    streuung: DAY_SPREADS.some((m) => m.key === s("streuung")) ? (s("streuung") as DaySpreadKey) : "quartile",
    wochentage: [...new Set(s("wochentage").replace(/[^1-7]/g, ""))].sort().join("") || "1234567",
    luecken: s("luecken") === "null" || s("luecken") === "auslassen" ? (s("luecken") as "null" | "auslassen") : "auto",
  };
}

export function toSearch(q: GraphQuery) {
  const p = new URLSearchParams();
  p.set("metric", q.metrics.join(","));
  if (q.spieler.length) p.set("spieler", q.spieler.join(","));
  if (q.zeit !== "24h") p.set("zeit", q.zeit);
  if (q.zeit === "eigen") {
    if (q.von) p.set("von", q.von);
    if (q.bis) p.set("bis", q.bis);
  }
  if (q.raster !== "auto") p.set("raster", q.raster);
  if (q.modus !== "wert") p.set("modus", q.modus);
  if (q.achse !== "einheit") p.set("achse", q.achse);
  if (q.ansicht === "tag") {
    p.set("ansicht", "tag");
    if (q.tage !== "schnitt") p.set("tage", q.tage);
    if (q.streuung !== "quartile") p.set("streuung", q.streuung);
    if (q.wochentage !== "1234567") p.set("wochentage", q.wochentage);
    if (q.luecken !== "auto") p.set("luecken", q.luecken);
  }
  return p;
}

/** Link auf den Graphen, z. B. `graphHref("diamonds", ["fabo"], "alle")` */
export function graphHref(metrics: Metric | Metric[], spieler: string[] = [], zeit = "alle", opts: { modus?: "zuwachs"; raster?: string } = {}): string {
  const p = new URLSearchParams();
  p.set("metric", (Array.isArray(metrics) ? metrics : [metrics]).join(","));
  if (spieler.length) p.set("spieler", spieler.join(","));
  if (zeit !== "24h") p.set("zeit", zeit);
  if (opts.raster) p.set("raster", opts.raster);
  if (opts.modus) p.set("modus", opts.modus);
  return `/graph?${p}`;
}
