import { NextResponse, connection } from "next/server";
import { getItemSeries, getSeries, SERIES_METRICS, type SeriesMetric } from "@/lib/store";
import { getAfkSeries, getRankSeries } from "@/lib/analytics";
import { parseItemMetric, rankKeyOf } from "@/lib/graphQuery";

const BUCKETS = new Set([1, 5, 15, 30, 60, 180, 360, 720, 1440]);

/**
 * Zeitreihen für den Graphen: ?metric=&spieler=a,b&von=<ms>&bis=<ms>&raster=<min>&modus=wert|zuwachs
 * `metric` ist eine Kennzahl, `rank:<Liste>` (Platz über die Zeit) oder `item:<Kategorie>|<Item>` (einzelner Block/Mob).
 */
export async function GET(req: Request) {
  await connection();
  const sp = new URL(req.url).searchParams;
  const raw = sp.get("metric") ?? "";
  const players = [...new Set((sp.get("spieler") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const n = (k: string) => {
    const v = Number(sp.get(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const raster = n("raster");
  const base = { players, from: n("von"), to: n("bis"), bucketMinutes: raster !== null && BUCKETS.has(raster) ? raster : null, mode: sp.get("modus") === "zuwachs" ? ("zuwachs" as const) : ("wert" as const) };
  const headers = { "cache-control": "private, max-age=30" };
  // Platz in einer Bestenliste (Rang-Verlauf) und einzelne Blöcke/Mobs aus den Top-Listen
  const rank = rankKeyOf(raw);
  if (rank) return NextResponse.json(await getRankSeries({ key: rank, players, from: base.from, to: base.to }), { headers });
  const item = parseItemMetric(raw);
  if (item) return NextResponse.json(await getItemSeries({ ...base, category: item.category, key: item.key }), { headers });
  const metric = raw as SeriesMetric;
  if (!SERIES_METRICS.includes(metric)) return NextResponse.json({ error: "unbekannte Kennzahl" }, { status: 400 });
  // AFK-Zeit kommt nicht aus einer Spalte, sondern aus den rückwirkend berechneten AFK-Phasen
  if (metric === "afkSeconds" || metric === "afkMobsSeconds" || metric === "afkBlocksSeconds") {
    const kind = metric === "afkMobsSeconds" ? ("mobs" as const) : metric === "afkBlocksSeconds" ? ("blocks" as const) : undefined;
    return NextResponse.json(await getAfkSeries({ ...base, kind }), { headers: { "cache-control": "private, max-age=30" } });
  }
  const data = await getSeries({
    metric,
    players,
    from: n("von"),
    to: n("bis"),
    bucketMinutes: raster !== null && BUCKETS.has(raster) ? raster : null,
    mode: sp.get("modus") === "zuwachs" ? "zuwachs" : "wert",
  });
  return NextResponse.json(data, { headers: { "cache-control": "private, max-age=30" } });
}
