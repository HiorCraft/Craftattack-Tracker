"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BASE_PATH, ESTIMATE } from "@/lib/estimateMode";
import { duration } from "@/lib/format";

/**
 * Schätzungs-Ausgabe (/schaetzung): Zeiträume mit geschätzten Werten und ihre Konfidenz. Die Diagramme schattieren
 * diese Bereiche und nennen die Konfidenz im Tooltip. In der normalen Website ist alles leer und unsichtbar.
 */
export interface EstimateZone {
  from: number;
  to: number;
  /** 0–1 */
  confidence: number;
  note: string;
}

export interface PlayerEstimate {
  stat: string;
  from: number;
  to: number;
  confidence: number;
  /** Anteil der Messpunkte, die geschätzt sind (0–1) */
  share: number;
}

interface Payload {
  gaps: EstimateZone[];
  generatedAt: string | null;
  startedAt: string | null;
}

const GapCtx = createContext<Payload>({ gaps: [], generatedAt: null, startedAt: null });
const PlayerCtx = createContext<PlayerEstimate[]>([]);

/** Lücken einmal je Seitenaufruf laden (klein: ein paar Dutzend Zeilen) */
export function EstimateProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Payload>({ gaps: [], generatedAt: null, startedAt: null });
  useEffect(() => {
    if (!ESTIMATE) return;
    let off = false;
    fetch(`${BASE_PATH}/api/estimates`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (off || !j) return;
        setData({
          gaps: (j.gaps ?? []).map((g: { from: string; to: string; confidence: number; note: string }) => ({ ...g, from: Date.parse(g.from), to: Date.parse(g.to) })),
          generatedAt: j.generatedAt ?? null,
          startedAt: j.startedAt ?? null,
        });
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []);
  return <GapCtx.Provider value={data}>{children}</GapCtx.Provider>;
}

/** Geschätzte Werte eines Spielers (für die Kacheln im Profil) */
export function EstimatePlayer({ id, children }: { id: string; children: ReactNode }) {
  const [rows, setRows] = useState<PlayerEstimate[]>([]);
  useEffect(() => {
    if (!ESTIMATE) return;
    let off = false;
    fetch(`${BASE_PATH}/api/estimates?player=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (off || !j) return;
        setRows((j.player ?? []).map((e: { stat: string; from: string; to: string; confidence: number; share: number }) => ({ ...e, from: Date.parse(e.from), to: Date.parse(e.to) })));
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [id]);
  return <PlayerCtx.Provider value={rows}>{children}</PlayerCtx.Provider>;
}

export const useEstimateGaps = () => useContext(GapCtx).gaps;
export const useEstimateInfo = () => useContext(GapCtx);

/** Zonen für eine Kennzahl eines Spielers: eigene Nachträge plus die globalen Tracker-Lücken */
export function usePlayerZones(stat: string | null): EstimateZone[] {
  const gaps = useEstimateGaps();
  const rows = useContext(PlayerCtx);
  if (!ESTIMATE) return [];
  const own = stat ? rows.filter((r) => r.stat === stat && r.share > 0).map((r) => ({ from: r.from, to: r.to, confidence: r.confidence, note: "nachgetragen" })) : [];
  return [...gaps, ...own];
}

export function zoneAt(zones: EstimateZone[], t: number): EstimateZone | null {
  let best: EstimateZone | null = null;
  for (const z of zones) if (t >= z.from && t <= z.to && (!best || z.confidence < best.confidence)) best = z;
  return best;
}

export const pct = (c: number) => `${Math.round(c * 100)} %`;

/** Schattierte Bereiche im SVG; x = Zeit → Koordinate, sichtbarer Bereich [t0, t1] */
export function EstimateRects({ zones, x, t0, t1, height }: { zones: EstimateZone[]; x: (t: number) => number; t0: number; t1: number; height: number }) {
  if (!zones.length) return null;
  return (
    <g className="est-zones" aria-hidden="true">
      {zones
        .filter((z) => z.to > t0 && z.from < t1)
        .map((z, i) => {
          const a = x(Math.max(t0, z.from));
          const b = x(Math.min(t1, z.to));
          // Je unsicherer, desto kräftiger die Schattierung
          return <rect key={i} x={a} y={0} width={Math.max(1, b - a)} height={height} className="est-zone" style={{ opacity: 0.12 + (1 - z.confidence) * 0.35 }} />;
        })}
    </g>
  );
}

/** Zeile im Tooltip, wenn der Punkt in einem geschätzten Bereich liegt */
export function EstimateTip({ zones, t }: { zones: EstimateZone[]; t: number }) {
  const z = zoneAt(zones, t);
  if (!z) return null;
  return <span className="est-tip">geschätzt · Konfidenz {pct(z.confidence)}</span>;
}

/** Hinweisleiste oben auf jeder Seite der Schätzung */
export function EstimateBanner() {
  const { generatedAt } = useEstimateInfo();
  return (
    <div className="est-banner" role="note">
      <div className="wrap est-banner__in">
        <strong>Schätzung</strong>
        <span>
          Datenlücken und erst später erfasste Werte sind mit Hochrechnungen aus dem Verhalten der Spieler gefüllt. Geschätzte Bereiche sind in den Diagrammen
          schattiert, mit Konfidenz.
          {generatedAt && <span className="muted"> Stand {new Date(generatedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" })}.</span>}
        </span>
        <span className="est-banner__links">
          <a href={`${BASE_PATH}/so-funktionierts#schaetzung`}>Wie geschätzt wird</a>
          {/* Absichtlich ohne Link: "/" liegt außerhalb des basePath dieser Ausgabe */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/">Echte Daten</a>
        </span>
      </div>
    </div>
  );
}

const STAT_LABEL: Record<string, string> = {
  playtimeSeconds: "Spielzeit",
  deaths: "Tode",
  diamonds: "Diamanten",
  blocksBroken: "Abgebaute Blöcke",
  mobsKilled: "Mobs",
  distance: "Strecke",
  damageDealt: "Schaden",
  totemsUsed: "Totems",
  foodEaten: "Essen",
  followers: "Follower",
  followersOnServer: "Follower auf dem Server",
  subs: "Twitch-Subs",
  viewers: "Zuschauer in Lücken",
  tops: "Top-Listen",
};

/** Übersicht im Profil: welche Werte geschätzt sind und wie sicher */
export function PlayerEstimateSummary() {
  const rows = useContext(PlayerCtx);
  if (!ESTIMATE || !rows.length) return null;
  const main = rows.filter((r) => STAT_LABEL[r.stat]);
  const extras = rows.filter((r) => r.stat.startsWith("x:"));
  const df = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: "Europe/Berlin" });
  return (
    <details className="est-summary box" data-tone="white">
      <summary>
        <strong>Geschätzte Werte</strong> <span className="muted">· {main.length + (extras.length ? 1 : 0)} Kennzahlen mit Schätzanteil</span>
      </summary>
      <ul>
        {main.map((r) => (
          <li key={r.stat}>
            <span>{STAT_LABEL[r.stat]}</span>
            <span className="muted">
              {df.format(r.from)}–{df.format(r.to)}
              {r.share > 0 ? ` · ${Math.max(1, Math.round(r.share * 100))} % der Punkte` : ""}
            </span>
            <b className="num">Konfidenz {pct(r.confidence)}</b>
          </li>
        ))}
        {extras.length > 0 && (
          <li>
            <span>Zusatzwerte ({extras.length})</span>
            <span className="muted">vor der Einzelabfrage</span>
            <b className="num">Konfidenz {pct(extras.reduce((s, r) => s + r.confidence, 0) / extras.length)}</b>
          </li>
        )}
      </ul>
    </details>
  );
}

/** Abschnitt für „So funktioniert’s“: Methode und Liste der Lücken */
export function EstimateExplainer() {
  const { gaps, startedAt } = useEstimateInfo();
  if (!ESTIMATE) return null;
  const dtf = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
  return (
    <section className="box how__section" data-tone="white" aria-labelledby="schaetzung-h" id="schaetzung">
      <h2 className="t-3" id="schaetzung-h">
        So wird geschätzt
      </h2>
      <p>
        Diese Ansicht füllt alles, was der Tracker nicht gesehen hat: Zeiten, in denen er aus war, und Werte, die erst später erfasst wurden (zum Beispiel
        Spielzeit außerhalb der Top 10, Schaden, Essen und Totems vor dem 18.10., Follower vor dem 14.10., Top-Listen vor dem 21.10.).
        {startedAt && ` Startpunkt ist der Beginn von CraftAttack 14 (${dtf.format(Date.parse(startedAt))} Uhr), dort steht jeder Zähler bei 0.`}
      </p>
      <ul>
        <li>
          <b>Sessions:</b> Für jeden Spieler wird aus den echten Daten ermittelt, zu welcher Uhrzeit er meist online ist, wie lange seine Sessions dauern
          und wie oft er AFK ist. Daraus entstehen Sessions für die Lücke, so lange, dass die bekannte Spielzeit vorher und nachher aufgeht.
        </li>
        <li>
          <b>Zähler:</b> Der Zuwachs zwischen zwei bekannten Werten wird auf die Online-Minuten verteilt, schubweise statt gleichmäßig (Abbauen,
          Kämpfen und Laufen kommen in Phasen). Tode mit echtem Zeitpunkt aus dem Todes-Feed bleiben, wo sie waren.
        </li>
        <li>
          <b>Twitch:</b> Streams folgen dem Streaming-Verhalten des Spielers, bekannte Stream-Starts bleiben. Zuschauer laufen mit Anlauf und leichtem
          Rauschen von den Werten vorher zu denen nachher. Abos kommen aus der Abo-Rate des Kanals je Zuschauerminute, Follower aus den
          Zuschauerminuten.
        </li>
        <li>
          <b>Offtag:</b> Montag, 26.10., war der Server zu. Dort wird keine Spielzeit verteilt.
        </li>
        <li>
          <b>Nicht erfunden:</b> Chatnachrichten, Raids, Cheers und Geschenk-Abos (echte Personen und Texte).
        </li>
      </ul>
      <p>Konfidenz: wie sicher der Wert ungefähr stimmt. Kurze Lücken mit bekannten Werten an beiden Rändern liegen hoch, lange Lücken und Rückrechnungen niedriger.</p>
      {gaps.length > 0 && (
        <table className="est-table">
          <thead>
            <tr>
              <th>Von</th>
              <th>Bis</th>
              <th>Dauer</th>
              <th>Grund</th>
              <th>Konfidenz</th>
            </tr>
          </thead>
          <tbody>
            {gaps.map((g) => (
              <tr key={g.from}>
                <td>{dtf.format(g.from)}</td>
                <td>{dtf.format(g.to)}</td>
                <td className="num">{duration(Math.round((g.to - g.from) / 1000))}</td>
                <td>{g.note}</td>
                <td className="num">{pct(g.confidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
