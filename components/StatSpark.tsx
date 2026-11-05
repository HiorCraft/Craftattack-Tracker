"use client";

import type { SparkKey } from "@/lib/sparkSeries";
import { boardValue, eur, num } from "@/lib/format";
import Link from "next/link";
import { Sparkline, type SparkPoint } from "./Sparkline";
import { usePlayerZones } from "./Estimates";

/** Kennzahl in den Schätzungs-Nachträgen (scripts/estimate.mjs) */
const ESTIMATE_STAT: Partial<Record<SparkKey, string>> = { viewers: "viewers", twitchSubs: "subs", twitchBits: "bits" };


const FORMAT: Record<SparkKey, (v: number) => string> = {
  viewers: num,
  playtimeSeconds: (v) => boardValue("playtimeSeconds", v),
  deaths: num,
  diamonds: num,
  blocksBroken: num,
  mobsKilled: num,
  distance: (v) => boardValue("distance", v),
  damageDealt: (v) => boardValue("damageDealt", v),
  totemsUsed: num,
  foodEaten: num,
  followersOnServer: num,
  twitchSubs: num,
  twitchBits: num,
  twitchEarnings: eur,
};

const tf = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const df = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

/**
 * Verlaufskurve einer Kennzahl für die Statistik-Kacheln im Profil; die Reihe baut `sparkSeries` auf dem Server.
 * Bei zu wenigen Messpunkten bleibt die Fläche leer, damit die Kacheln gleich hoch bleiben.
 */
export function StatSpark({ data: series, k, label, height = 56, href }: { data: SparkPoint[]; k: SparkKey; label: string; height?: number; href?: string }) {
  const format = FORMAT[k];
  const zones = usePlayerZones(k === "twitchEarnings" ? null : (ESTIMATE_STAT[k] ?? k));
  // Reihe kommt fertig vom Server (lib/sparkSeries.ts)
  let data = series;
  if ((k === "twitchSubs" || k === "twitchBits" || k === "twitchEarnings") && data.length === 1) {
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
      <Sparkline points={data} width={320} height={height} format={format} step={k !== "viewers"} label={label} zones={zones} />
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
