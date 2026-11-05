import { distance, duration, hearts, num } from "./format";

/**
 * Zusatzwerte aus /api/player/<id>, die über die Board-Keys hinausgehen. Eine Quelle für Tracker (Verlauf),
 * Graph-Baukasten und Spielerprofil. Der Key ist der API-Name; `metric` ist der Name im Graphen, falls er
 * sich mit einer bestehenden Kennzahl überschneiden würde (die Tracker-AFK-Zeit heißt dort schon `afkSeconds`).
 */
export type StatGroup = "allgemein" | "abbau" | "kampf" | "bewegung" | "items" | "tiere" | "afk";

export const STAT_GROUPS: { key: StatGroup; label: string }[] = [
  { key: "allgemein", label: "Allgemein" },
  { key: "abbau", label: "Abbau & Bau" },
  { key: "kampf", label: "Kampf" },
  { key: "bewegung", label: "Bewegung" },
  { key: "items", label: "Items & Handel" },
  { key: "tiere", label: "Tiere & Natur" },
  { key: "afk", label: "AFK" },
];

type StatFormat = "num" | "distance" | "duration" | "hearts";
export const FORMATTERS: Record<StatFormat, (v: number) => string> = { num, distance, duration, hearts: (v) => `${hearts(v)} Herzen` };

interface ExtraStatMeta {
  label: string;
  group: StatGroup;
  format: StatFormat;
  /** Icon-Name aus `Icon` */
  icon: string;
  /** Kennzahl-Name im Graphen */
  metric: string;
}

export const EXTRA_STATS = {
  blocksPlaced: { label: "Blöcke platziert", group: "abbau", format: "num", icon: "pickaxe", metric: "blocksPlaced" },
  damageTaken: { label: "Schaden erlitten", group: "kampf", format: "hearts", icon: "heart", metric: "damageTaken" },
  raidsWon: { label: "Überfälle gewonnen", group: "kampf", format: "num", icon: "trophy", metric: "raidsWon" },
  jumps: { label: "Sprünge", group: "bewegung", format: "num", icon: "boots", metric: "jumps" },
  distanceFallen: { label: "Gefallen", group: "bewegung", format: "distance", icon: "boots", metric: "distanceFallen" },
  sneakSeconds: { label: "Geschlichen", group: "bewegung", format: "duration", icon: "clock", metric: "sneakSeconds" },
  itemsCrafted: { label: "Items hergestellt", group: "items", format: "num", icon: "bolt", metric: "itemsCrafted" },
  itemsPickedUp: { label: "Items aufgehoben", group: "items", format: "num", icon: "bolt", metric: "itemsPickedUp" },
  itemsDropped: { label: "Items fallen gelassen", group: "items", format: "num", icon: "bolt", metric: "itemsDropped" },
  itemsEnchanted: { label: "Items verzaubert", group: "items", format: "num", icon: "bolt", metric: "itemsEnchanted" },
  chestsOpened: { label: "Truhen geöffnet", group: "items", format: "num", icon: "gift", metric: "chestsOpened" },
  tradedWithVillagers: { label: "Handel mit Dorfbewohnern", group: "items", format: "num", icon: "users", metric: "tradedWithVillagers" },
  animalsKilled: { label: "Tiere getötet", group: "tiere", format: "num", icon: "sword", metric: "animalsKilled" },
  animalsBred: { label: "Tiere gezüchtet", group: "tiere", format: "num", icon: "heart", metric: "animalsBred" },
  fishCaught: { label: "Fische gefangen", group: "tiere", format: "num", icon: "food", metric: "fishCaught" },
  bellsRung: { label: "Glocken geläutet", group: "tiere", format: "num", icon: "flag", metric: "bellsRung" },
  afkSeconds: { label: "AFK laut Server", group: "afk", format: "duration", icon: "clock", metric: "serverAfkSeconds" },
} as const satisfies Record<string, ExtraStatMeta>;

export type ExtraStatKey = keyof typeof EXTRA_STATS;
export const EXTRA_STAT_KEYS = Object.keys(EXTRA_STATS) as ExtraStatKey[];
export type ExtraMetric = (typeof EXTRA_STATS)[ExtraStatKey]["metric"];
export const EXTRA_METRICS = EXTRA_STAT_KEYS.map((k) => EXTRA_STATS[k].metric) as ExtraMetric[];

/** Graph-Kennzahl → API-Key (für die Abfrage der jsonb-Spalte `player_history.extra`) */
export const EXTRA_KEY_OF_METRIC = Object.fromEntries(EXTRA_STAT_KEYS.map((k) => [EXTRA_STATS[k].metric, k])) as Record<ExtraMetric, ExtraStatKey>;

/** Top-Listen je Spieler laut API */
export const TOP_LABELS: Record<string, string> = {
  blocksBroken: "Meistabgebaute Blöcke",
  blocksPlaced: "Meistplatzierte Blöcke",
  mobsKilled: "Meistgetötete Mobs",
  animalsKilled: "Meistgetötete Tiere",
};

/**
 * Feste Reihenfolge der Zusatzwerte in `player_history.extra_stats` (integer[], 1-basiert in SQL).
 * NUR ANHÄNGEN, nie umsortieren oder löschen: alte Zeilen behalten sonst falsche Zuordnungen.
 */
export const EXTRA_HISTORY_KEYS: readonly ExtraStatKey[] = [
  "blocksPlaced",
  "damageTaken",
  "raidsWon",
  "jumps",
  "distanceFallen",
  "sneakSeconds",
  "itemsCrafted",
  "itemsPickedUp",
  "itemsDropped",
  "itemsEnchanted",
  "chestsOpened",
  "tradedWithVillagers",
  "animalsKilled",
  "animalsBred",
  "fishCaught",
  "bellsRung",
  "afkSeconds",
];

/** SQL-Ausdruck für einen Zusatzwert aus `player_history.extra_stats` */
export function extraStatSql(key: ExtraStatKey): string {
  const index = EXTRA_HISTORY_KEYS.indexOf(key);
  if (index === -1) throw new Error(`Zusatzwert ${key} fehlt in EXTRA_HISTORY_KEYS`);
  return `extra_stats[${index + 1}]`;
}
