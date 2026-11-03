import { BOARD_STYLE } from "./boards";
import { EXTRA_STATS, EXTRA_STAT_KEYS, TOP_LABELS, type ExtraStatKey, type StatGroup } from "./playerStats";
import { BOARD_TONE, GROUP_TONE, METRIC_TONE, type Tone } from "./statTone";
import type { BoardKey, PlayerState } from "./types";

/**
 * Alle Bestenlisten an einem Ort: Titel, Untertitel, Ton, Icon und Rubrik. Genutzt von /bestenlisten und von
 * jedem Rang-Abzeichen, das auf seine Liste verlinkt (`boardHref`).
 *
 * Schlüssel: die neun Hauptlisten (`BoardKey`), Tracker-Listen (`tracked`, `followers`, …), Zusatzwerte aus
 * /api/player (`ExtraStatKey`), Rest außerhalb der eigenen Top 10 (`rest-<Kategorie>`) und einzelne Blöcke/Mobs
 * (`top` mit `item=<Kategorie>|<Item-Key>`, siehe `itemHref`).
 */

/** Kategorien mit Top-10-Listen je Spieler laut /api/player (`detail.tops`) */
export const TOP_CATEGORIES = ["blocksBroken", "blocksPlaced", "mobsKilled", "animalsKilled"] as const;
export type TopCategory = (typeof TOP_CATEGORIES)[number];
export const isTopCategory = (v: string): v is TopCategory => (TOP_CATEGORIES as readonly string[]).includes(v);

export type SpecialKey = "tracked" | "followers" | "twitchSubs" | "twitchBits" | "afk" | "afkmobs" | "afkblocks";
export type RestKey = `rest-${TopCategory}`;
export type ItemKey = "top";
export type LeaderboardKey = BoardKey | SpecialKey | ExtraStatKey | RestKey | ItemKey;

export interface LeaderboardMeta {
  title: string;
  sub: string;
  tone: Tone;
  /** Icon-Name aus `Icon` */
  icon: string;
  group: LeaderboardGroup;
}

export type LeaderboardGroup = "zeit" | StatGroup | "twitch";

/** Rubriken in der Reihenfolge der Auswahl */
export const LEADERBOARD_GROUPS: { key: LeaderboardGroup; label: string }[] = [
  { key: "zeit", label: "Spielzeit" },
  { key: "abbau", label: "Abbau & Bau" },
  { key: "kampf", label: "Kampf" },
  { key: "bewegung", label: "Bewegung" },
  { key: "items", label: "Items & Handel" },
  { key: "tiere", label: "Tiere & Natur" },
  { key: "twitch", label: "Twitch" },
  { key: "afk", label: "AFK" },
];

const BOARD_ICON: Record<BoardKey, string> = {
  playtimeSeconds: "clock",
  diamonds: "diamond",
  deaths: "skull",
  blocksBroken: "pickaxe",
  mobsKilled: "sword",
  distance: "boots",
  damageDealt: "heart",
  totemsUsed: "totem",
  foodEaten: "food",
};
const BOARD_GROUP: Record<BoardKey, LeaderboardGroup> = {
  playtimeSeconds: "zeit",
  diamonds: "abbau",
  deaths: "kampf",
  blocksBroken: "abbau",
  mobsKilled: "kampf",
  distance: "bewegung",
  damageDealt: "kampf",
  totemsUsed: "kampf",
  foodEaten: "items",
};
const BOARD_SUB: Record<BoardKey, string> = {
  playtimeSeconds: "Spielzeit laut API, sonst vom Tracker gemessene Online-Zeit",
  diamonds: "Diamanten",
  deaths: "Tode",
  blocksBroken: "Abgebaute Blöcke",
  mobsKilled: "Erledigte Mobs",
  distance: "Gelaufene Strecke",
  damageDealt: "Ausgeteilter Schaden in Herzen",
  totemsUsed: "Benutzte Totems",
  foodEaten: "Gegessene Nahrung",
};

/** Titel der Zusatzwerte im Stil der offiziellen Listen */
const EXTRA_TITLE: Record<ExtraStatKey, string> = {
  blocksPlaced: "Baumeister",
  damageTaken: "Prellbock",
  raidsWon: "Dorfretter",
  jumps: "Flummi",
  distanceFallen: "Fallobst",
  sneakSeconds: "Schleicher",
  itemsCrafted: "Werkbank-Profi",
  itemsPickedUp: "Sammler",
  itemsDropped: "Wegwerfer",
  itemsEnchanted: "Zauberlehrling",
  chestsOpened: "Truhenwühler",
  tradedWithVillagers: "Händler",
  animalsKilled: "Jäger",
  animalsBred: "Züchter",
  fishCaught: "Angelkönig",
  bellsRung: "Glöckner",
  afkSeconds: "Schlafmütze",
};

const TOP_GROUP: Record<TopCategory, LeaderboardGroup> = { blocksBroken: "abbau", blocksPlaced: "abbau", mobsKilled: "kampf", animalsKilled: "tiere" };
const TOP_TONE: Record<TopCategory, Tone> = {
  blocksBroken: BOARD_TONE.blocksBroken,
  blocksPlaced: GROUP_TONE.abbau,
  mobsKilled: BOARD_TONE.mobsKilled,
  animalsKilled: GROUP_TONE.tiere,
};
const TOP_ICON: Record<TopCategory, string> = { blocksBroken: "pickaxe", blocksPlaced: "pickaxe", mobsKilled: "sword", animalsKilled: "sword" };
/** Kurzname der Kategorie, z. B. für „Vielfalt: Abbau“ */
const TOP_SHORT: Record<TopCategory, string> = { blocksBroken: "Abbau", blocksPlaced: "Bau", mobsKilled: "Mobs", animalsKilled: "Tiere" };
/** Wert der Kategorie für „außerhalb der Top 10“ */
const TOP_UNIT: Record<TopCategory, string> = { blocksBroken: "abgebaute Blöcke", blocksPlaced: "platzierte Blöcke", mobsKilled: "erledigte Mobs", animalsKilled: "getötete Tiere" };

export const LEADERBOARDS: Record<Exclude<LeaderboardKey, ItemKey>, LeaderboardMeta> = {
  ...(Object.fromEntries(
    (Object.keys(BOARD_STYLE) as BoardKey[]).map((k) => [k, { title: BOARD_STYLE[k].title, sub: BOARD_SUB[k], tone: BOARD_TONE[k], icon: BOARD_ICON[k], group: BOARD_GROUP[k] }]),
  ) as Record<BoardKey, LeaderboardMeta>),
  tracked: { title: "Dauergäste", sub: "Online-Zeit laut Tracker, alle Spieler", tone: METRIC_TONE.tracked, icon: "users", group: "zeit" },
  followers: { title: "Fanmagnet", sub: "Neue Twitch-Follower, während der Streamer auf dem Server war", tone: METRIC_TONE.followers, icon: "users", group: "twitch" },
  twitchSubs: { title: "Sub-Stars", sub: "Twitch-Abos auf dem Server seit Beginn der IRC-Erfassung", tone: METRIC_TONE.twitchSubs, icon: "gift", group: "twitch" },
  twitchBits: { title: "Bit-Regen", sub: "Bits aus Cheers im eigenen Kanal, während der Streamer auf dem Server war", tone: METRIC_TONE.twitchBits, icon: "bits", group: "twitch" },
  afk: { title: "Standbilder", sub: "AFK-Zeit seit Tracker-Start laut Server: ab 5 Min ohne Bewegung", tone: METRIC_TONE.afkSeconds, icon: "clock", group: "afk" },
  afkmobs: { title: "Mob-Farmer", sub: "AFK-Zeit, in der trotzdem ≥ 10 Mobs pro Minute gestorben sind (AFK-Mobfarm)", tone: METRIC_TONE.afkMobsSeconds, icon: "sword", group: "afk" },
  afkblocks: { title: "Block-Farmer", sub: "AFK-Zeit, in der trotzdem ≥ 10 Blöcke pro Minute abgebaut wurden (AFK-Blockfarm)", tone: METRIC_TONE.afkBlocksSeconds, icon: "pickaxe", group: "afk" },
  ...(Object.fromEntries(
    EXTRA_STAT_KEYS.map((k) => [
      k,
      { title: EXTRA_TITLE[k], sub: EXTRA_STATS[k].label, tone: GROUP_TONE[EXTRA_STATS[k].group], icon: EXTRA_STATS[k].icon, group: EXTRA_STATS[k].group },
    ]),
  ) as Record<ExtraStatKey, LeaderboardMeta>),
  ...(Object.fromEntries(
    TOP_CATEGORIES.map((c) => [
      `rest-${c}`,
      {
        title: `Vielfalt: ${TOP_SHORT[c]}`,
        sub: `${TOP_UNIT[c][0].toUpperCase()}${TOP_UNIT[c].slice(1)} außerhalb der eigenen Top 10 – wer viel Verschiedenes macht`,
        tone: TOP_TONE[c],
        icon: TOP_ICON[c],
        group: TOP_GROUP[c],
      },
    ]),
  ) as Record<RestKey, LeaderboardMeta>),
};

/** Liste für ein einzelnes Item (z. B. Netherrack) */
export function itemBoardMeta(category: TopCategory, itemName: string): LeaderboardMeta {
  return {
    title: itemName,
    sub: `${TOP_LABELS[category]} – nur Spieler, bei denen es in den eigenen Top 10 steht`,
    tone: TOP_TONE[category],
    icon: TOP_ICON[category],
    group: TOP_GROUP[category],
  };
}

export const topCategoryLabel = (c: TopCategory) => TOP_LABELS[c];

/** Reihenfolge der wählbaren Listen (ohne Einzel-Items) */
export const LEADERBOARD_KEYS = Object.keys(LEADERBOARDS) as Exclude<LeaderboardKey, ItemKey>[];

export const isLeaderboardKey = (v: string): v is Exclude<LeaderboardKey, ItemKey> => v in LEADERBOARDS;

/** Link auf eine Bestenliste */
export function boardHref(key: Exclude<LeaderboardKey, ItemKey>, span?: string): string {
  const q = new URLSearchParams();
  if (key !== "playtimeSeconds") q.set("liste", key);
  if (span && span !== "24h") q.set("seit", span);
  const qs = q.toString();
  return qs ? `/bestenlisten?${qs}` : "/bestenlisten";
}

/** Link auf die Liste eines einzelnen Blocks, Mobs oder Tiers */
export function itemHref(category: TopCategory, itemKey: string): string {
  return `/bestenlisten?liste=top&item=${encodeURIComponent(`${category}|${itemKey}`)}`;
}

/** `item`-Parameter → Kategorie und Item-Key */
export function parseItemParam(v: string | undefined): { category: TopCategory; key: string } | null {
  const [category, key] = (v ?? "").split("|");
  return category && key && isTopCategory(category) ? { category, key } : null;
}

/* ---------- Ranglisten aus den Top-10-Listen (Bestenlisten-Seite und Profil rechnen gleich) ---------- */

/** Gesamtwert einer Top-10-Kategorie: Abgebaut und Mobs aus den Hauptwerten, die übrigen aus der Einzelstatistik */
export function categoryTotal(p: PlayerState, c: TopCategory): number | undefined {
  return c === "blocksBroken" || c === "mobsKilled" ? p.stats[c] : p.detail?.stats[c];
}

/** Vielfalt: Gesamtwert ohne die eigenen Top 10; `null`, wenn Gesamtwert oder Top-Liste fehlen */
export function restOf(p: PlayerState, c: TopCategory): { rest: number; total: number } | null {
  const total = categoryTotal(p, c);
  const tops = p.detail?.tops[c];
  if (typeof total !== "number" || total <= 0 || !tops?.length) return null;
  return { rest: Math.max(0, total - tops.reduce((s, e) => s + e.count, 0)), total };
}

/** Spieler einer Vielfalt-Liste, bester zuerst */
export function restRanking(players: PlayerState[], c: TopCategory): { player: PlayerState; rest: number; total: number }[] {
  return players
    .flatMap((player) => {
      const r = restOf(player, c);
      return r && r.rest > 0 ? [{ player, ...r }] : [];
    })
    .sort((a, b) => b.rest - a.rest || a.player.name.localeCompare(b.player.name, "de"));
}

/** Spieler mit dem Item in den eigenen Top 10, bester zuerst */
export function itemRanking(players: PlayerState[], c: TopCategory, itemKey: string): { player: PlayerState; count: number }[] {
  return players
    .flatMap((player) => {
      const e = player.detail?.tops[c]?.find((t) => t.key === itemKey);
      return e ? [{ player, count: e.count }] : [];
    })
    .sort((a, b) => b.count - a.count || a.player.name.localeCompare(b.player.name, "de"));
}

/** Einzelne Blöcke, Mobs und Tiere aus den Top-Listen der Spieler, je Kategorie (für Auswahl in Graph und Bestenlisten) */
export type ItemOptions = Partial<Record<TopCategory, { key: string; name: string; players: number }[]>>;

/** Alle Items aus den Top-10-Listen der Spieler, je Kategorie nach Anzahl Spieler sortiert */
export function itemOptions(players: PlayerState[]): ItemOptions {
  const out: ItemOptions = {};
  for (const c of TOP_CATEGORIES) {
    const items = new Map<string, { key: string; name: string; players: number }>();
    for (const p of players) {
      for (const e of p.detail?.tops[c] ?? []) {
        const it = items.get(e.key) ?? items.set(e.key, { key: e.key, name: e.name, players: 0 }).get(e.key)!;
        it.players += 1;
      }
    }
    out[c] = [...items.values()].sort((a, b) => b.players - a.players || a.name.localeCompare(b.name, "de"));
  }
  return out;
}
