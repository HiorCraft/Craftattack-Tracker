"use client";

import type { PlayerPoint } from "@/lib/types";
import { boardValue, num } from "@/lib/format";
import Link from "next/link";
import { Sparkline } from "./Sparkline";

export type SparkKey = Exclude<keyof PlayerPoint, "at" | "online">;

const FORMAT: Record<SparkKey, (v: number) => string> = {
  viewers: num,
  playtimeSeconds: (v) => boardValue("playtimeSeconds", v),
  deaths: num,
  diamonds: num,
  blocksBroken: num,
  mobsKilled: num,
  distance: (v) => boardValue("distance", v),
  twitchSubs: num,
};

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const df = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

/** Vom Tracker gemessene Online-Zeit als Verlauf: Zeit zwischen zwei Messpunkten zählt, wenn der Spieler beim ersten online war. */
function trackedSeries(points: PlayerPoint[]) {
  const out: { at: string; v: number }[] = [];
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i - 1].online) acc += (Date.parse(points[i].at) - Date.parse(points[i - 1].at)) / 1000;
    out.push({ at: points[i].at, v: Math.round(acc) });
  }
  return out;
}

/**
 * Verlaufskurve einer Kennzahl für die Statistik-Kacheln im Profil.
 * Bei zu wenigen Messpunkten bleibt die Fläche leer, damit die Kacheln gleich hoch bleiben.
 */
export function StatSpark({ points, k, label, height = 56, href }: { points: PlayerPoint[]; k: SparkKey; label: string; height?: number; href?: string }) {
  const format = FORMAT[k];
  let data = points.filter((p) => p[k] !== null).map((p) => ({ at: p.at, v: p[k] as number }));
  // Spielzeit gibt es von der API nur für die Top 10 – sonst die Tracker-Online-Zeit zeigen
  if (k === "playtimeSeconds" && data.length < 2 && points.length >= 2) data = trackedSeries(points);
  if (k === "twitchSubs" && data.length === 1) {
    data = [{ at: new Date(Date.parse(data[0].at) - 24 * 60 * 60_000).toISOString(), v: 0 }, data[0]];
  }
  if (data.length < 2) {
    return (
      <div className="st-fig__spark st-fig__spark--empty" style={{ height: height + 18 }}>
        <span>{data.length === 0 ? "Noch keine Daten" : "Graph folgt"}</span>
      </div>
    );
  }
  const t0 = Date.parse(data[0].at);
  const t1 = Date.parse(data[data.length - 1].at);
  const body = (
    <>
      <Sparkline points={data} width={320} height={height} format={format} step={k !== "viewers"} label={label} />
      <div className="chart__axis">
        <span>{t1 - t0 > 36e5 * 20 ? df.format(t0) : tf.format(t0)}</span>
        <span>{tf.format(t1)}</span>
      </div>
    </>
  );
  // Mit href ist der ganze Graph ein Link (z. B. auf den großen Graphen der Statistik-Seite)
  return href ? (
    <Link className="st-fig__spark st-fig__spark--link" href={href} title={`${label} im Graphen der Statistik öffnen`}>
      {body}
    </Link>
  ) : (
    <div className="st-fig__spark">{body}</div>
  );
}
