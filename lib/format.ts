const nf = new Intl.NumberFormat("de-DE");
const dtf = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});
const tf = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

export const num = (n: number) => nf.format(Math.round(n));
const ef = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
/** Euro ohne Cent, z. B. „1.234 €“ */
export const eur = (n: number) => ef.format(n);
export const hearts = (damage: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(damage / 20);

export function duration(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} T ${h} Std`;
  if (h > 0) return `${h} Std ${m} Min`;
  return `${m} Min`;
}

export function distance(m: number) {
  const r = Math.round(m);
  return r >= 1000 ? `${nf.format(Math.round(r / 100) / 10)} km` : `${r} m`;
}

export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "–";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s)) return "–";
  if (s < 90) return "gerade eben";
  const m = Math.round(s / 60);
  if (m < 60) return `vor ${m} Min`;
  const h = Math.round(s / 3600);
  if (h < 24) return `vor ${h} Std`;
  return `vor ${Math.round(s / 86400)} T`;
}

export const dateTime = (iso: string) => dtf.format(new Date(iso));
export const time = (iso: string) => tf.format(new Date(iso));

/** Wert und Einheit getrennt, damit die Einheit in engen Listen kleiner gesetzt werden kann */
export function boardParts(key: string, v: number): { value: string; unit: string | null } {
  if (key === "damageDealt") return { value: hearts(v), unit: "Herzen" };
  return { value: boardValue(key, v), unit: null };
}

export function boardValue(key: string, v: number) {
  switch (key) {
    case "playtimeSeconds":
      return duration(v);
    case "distance":
      return distance(v);
    case "damageDealt":
      return `${hearts(v)} Herzen`;
    default:
      return num(v);
  }
}

/** Kopf-Bild über unseren Proxy: kuratierter Kopf von craftattack.one, sonst Mojang-Skin per UUID. */
export const headUrl = (uuid: string | undefined, size = 32, id?: string) =>
  `/api/head/${encodeURIComponent(id ?? "_")}?u=${encodeURIComponent(uuid ?? "")}&s=${size}`;

/** Ganzkörper-Render (3D) über unseren Proxy: kuratiert von craftattack.one, sonst Mojang-Skin per UUID. */
export const skinUrl = (uuid: string | undefined, size = 256, id?: string) =>
  `/api/skin/${encodeURIComponent(id ?? "_")}?u=${encodeURIComponent(uuid ?? "")}&s=${size}`;
