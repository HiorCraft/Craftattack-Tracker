import type { BoardKey } from "./types";
import type { StatGroup } from "./playerStats";

/**
 * Eine Farbe je Kennzahl – überall dieselbe: Kacheln, Bestenlisten, Graph-Auswahl, Ereignisse, Profil.
 *
 * Die neun Hauptlisten bekommen je einen eigenen Ton. Alles rund um Twitch ist `twitch`, "auf dem Server"
 * (online, Sessions, Online-Zeit) teilt sich den Ton der Spielzeit, AFK ist grau (`idle`) – so bedeutet
 * Farbe immer "welche Kennzahl". Kacheln einer Reihe sollten nie teils farbig, teils neutral sein.
 * Zusatzwerte erben den Ton ihrer Gruppe; AFK-Farmen den Ton dessen, was gefarmt wird.
 */
export type Tone = "sky" | "diamond" | "redstone" | "gold" | "grass" | "pink" | "amethyst" | "lava" | "ender" | "twitch" | "idle" | "white" | "paper";

export const BOARD_TONE: Record<BoardKey, Tone> = {
  playtimeSeconds: "sky",
  diamonds: "diamond",
  deaths: "redstone",
  blocksBroken: "gold",
  mobsKilled: "grass",
  distance: "pink",
  totemsUsed: "amethyst",
  damageDealt: "lava",
  foodEaten: "ender",
};

export const GROUP_TONE: Record<StatGroup, Tone> = {
  allgemein: "white",
  abbau: BOARD_TONE.blocksBroken,
  kampf: BOARD_TONE.damageDealt,
  bewegung: BOARD_TONE.distance,
  items: BOARD_TONE.foodEaten,
  tiere: BOARD_TONE.mobsKilled,
  afk: "idle",
};

/** Kennzahlen außerhalb der Hauptlisten */
export const METRIC_TONE = {
  ...BOARD_TONE,
  // Twitch
  liveCount: "twitch",
  viewers: "twitch",
  followers: "twitch",
  twitchSubs: "twitch",
  twitchBits: "twitch",
  twitchEarnings: "twitch",
  // Auf dem Server sein: derselbe Ton wie die Spielzeit (CSS: --presence), auch im Zeitstrahl
  onlineCount: BOARD_TONE.playtimeSeconds,
  online: BOARD_TONE.playtimeSeconds,
  /** Vom Tracker gemessene Online-Zeit */
  tracked: BOARD_TONE.playtimeSeconds,
  sessions: BOARD_TONE.playtimeSeconds,
  // AFK: eigener grauer Ton (CSS: --idle), Farmen in der Farbe dessen, was gefarmt wird
  afkSeconds: "idle",
  afkMobsSeconds: BOARD_TONE.mobsKilled,
  afkBlocksSeconds: BOARD_TONE.blocksBroken,
} satisfies Record<string, Tone>;

export type MetricToneKey = keyof typeof METRIC_TONE;
