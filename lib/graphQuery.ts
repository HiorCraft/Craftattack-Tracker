import { boardValue, num } from "./format";

/* ---------- Konfiguration ---------- */

export type Metric = "onlineCount" | "liveCount" | "viewers" | "playtimeSeconds" | "afkSeconds" | "afkMobsSeconds" | "afkBlocksSeconds" | "deaths" | "diamonds" | "blocksBroken" | "mobsKilled" | "distance" | "twitchSubs" | "online";

interface MetricMeta {
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
}

export const METRICS: Record<Metric, MetricMeta> = {
  onlineCount: { label: "Spieler online", perPlayer: false, counter: false, format: num, tone: "grass", icon: "users" },
  liveCount: { label: "Streams live", perPlayer: false, counter: false, format: num, tone: "twitch", icon: "twitch" },
  viewers: { label: "Zuschauer", perPlayer: true, counter: false, format: num, hint: "Ohne Spieler: Summe aller Streams", tone: "twitch", icon: "eye" },
  playtimeSeconds: { label: "Spielzeit", perPlayer: true, counter: true, format: (v) => boardValue("playtimeSeconds", v), hint: "Die API liefert Spielzeit nur für die Top 10", tone: "sky", icon: "clock" },
  afkSeconds: { label: "AFK-Zeit", perPlayer: true, counter: true, format: (v) => boardValue("playtimeSeconds", v), hint: "AFK = online, aber ≥ 5 Min keine Bewegung; aus dem Spielerverlauf berechnet", tone: "gold", icon: "clock" },
  afkMobsSeconds: { label: "AFK: Mobs farmen", perPlayer: true, counter: true, format: (v) => boardValue("playtimeSeconds", v), hint: "AFK-Zeit, in der trotzdem ≥ 10 Mobs pro Minute gestorben sind (Mob-Farm)", tone: "gold", icon: "sword" },
  afkBlocksSeconds: { label: "AFK: Blöcke farmen", perPlayer: true, counter: true, format: (v) => boardValue("playtimeSeconds", v), hint: "AFK-Zeit, in der trotzdem ≥ 10 Blöcke pro Minute abgebaut wurden (Block-Farm)", tone: "gold", icon: "pickaxe" },
  deaths: { label: "Tode", perPlayer: true, counter: true, format: num, tone: "redstone", icon: "skull" },
  diamonds: { label: "Diamanten", perPlayer: true, counter: true, format: num, tone: "diamond", icon: "diamond" },
  blocksBroken: { label: "Blöcke", perPlayer: true, counter: true, format: num, tone: "gold", icon: "pickaxe" },
  mobsKilled: { label: "Mobs", perPlayer: true, counter: true, format: num, tone: "grass", icon: "sword" },
  distance: { label: "Strecke", perPlayer: true, counter: true, format: (v) => boardValue("distance", v), tone: "pink", icon: "boots" },
  twitchSubs: { label: "Twitch Subs", perPlayer: true, counter: true, format: num, hint: "Abos, die eingegangen sind, während der Streamer auf dem Server online war", tone: "amethyst", icon: "gift" },
  online: { label: "Online (ja/nein)", perPlayer: true, counter: false, format: (v) => (v >= 1 ? "online" : "offline"), hint: "Ohne Spieler: Anzahl online", tone: "white", icon: "login" },
};
export const METRIC_KEYS = Object.keys(METRICS) as Metric[];

export const RANGES: { key: string; label: string; ms: number | null }[] = [
  { key: "1h", label: "1 Std", ms: 3600_000 },
  { key: "6h", label: "6 Std", ms: 6 * 3600_000 },
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
}

export const MAX_METRICS = 6;

export interface GraphQuery {
  /** Mindestens eine Kennzahl; mehrere werden gemeinsam gezeichnet */
  metrics: Metric[];
  spieler: string[];
  zeit: string;
  von: string;
  bis: string;
  raster: string;
  modus: "wert" | "zuwachs";
}

/** Query-Parameter → Konfiguration (auch serverseitig nutzbar) */
export function parseGraphQuery(sp: Record<string, string | string[] | undefined>): GraphQuery {
  const s = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const metrics = [...new Set(s("metric").split(",").map((x) => x.trim()))].filter((x): x is Metric => METRIC_KEYS.includes(x as Metric)).slice(0, MAX_METRICS);
  return {
    metrics: metrics.length ? metrics : ["onlineCount"],
    spieler: s("spieler").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 12),
    zeit: RANGES.some((r) => r.key === s("zeit")) ? s("zeit") : "24h",
    von: s("von"),
    bis: s("bis"),
    raster: RASTER.some((r) => r.key === s("raster")) ? s("raster") : "auto",
    modus: s("modus") === "zuwachs" ? "zuwachs" : "wert",
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
  return p;
}
