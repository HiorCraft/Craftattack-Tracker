import { NextResponse, connection } from "next/server";
import { getAfkSeries } from "@/lib/analytics";
import { METRICS } from "@/lib/graphQuery";
import { getSeries, getState, SERIES_METRICS, type SeriesMetric } from "@/lib/store";

const BUCKETS = new Set([1, 5, 15, 30, 60, 180, 360, 720, 1440]);

/** Scores aller Spieler zur Sortierung der Vorschläge im Graph-Baukasten. */
export async function GET(req: Request) {
  await connection();
  const sp = new URL(req.url).searchParams;
  const metric = sp.get("metric") as SeriesMetric;
  if (!SERIES_METRICS.includes(metric) || !(metric in METRICS) || !METRICS[metric as keyof typeof METRICS].perPlayer) {
    return NextResponse.json({ error: "unbekannte Spieler-Kennzahl" }, { status: 400 });
  }

  const n = (key: string) => {
    const value = Number(sp.get(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const raster = n("raster");
  const bucketMinutes = raster !== null && BUCKETS.has(raster) ? raster : null;
  const from = n("von");
  const to = n("bis");
  const mode = sp.get("modus") === "zuwachs" && METRICS[metric as keyof typeof METRICS].counter ? "zuwachs" : "wert";
  const players = Object.keys((await getState()).players);
  if (!players.length) return NextResponse.json({ scores: {} });

  const series =
    metric === "afkSeconds" || metric === "afkMobsSeconds" || metric === "afkBlocksSeconds"
      ? await getAfkSeries({
          players,
          from,
          to,
          bucketMinutes,
          mode,
          kind: metric === "afkMobsSeconds" ? "mobs" : metric === "afkBlocksSeconds" ? "blocks" : undefined,
        })
      : await getSeries({ metric, players, from, to, bucketMinutes, mode });

  const scores = Object.fromEntries(
    series.series.map(({ id, points }) => [
      id,
      mode === "zuwachs" ? points.reduce((sum, point) => sum + point.v, 0) : (points.at(-1)?.v ?? 0),
    ]),
  );
  return NextResponse.json({ scores }, { headers: { "cache-control": "private, max-age=30" } });
}
