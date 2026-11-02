"use client";

import { useEffect, useMemo, useState } from "react";
import { GroupsOverview } from "./GroupViews";
import type { GraphNode } from "./ConnectionGraph";
import { sumDays, type DailyNetwork } from "@/lib/dailyNetwork";
import { DEFAULT_WEIGHTS } from "@/lib/connectionWeights";
import { analyzeGroups } from "@/lib/groups";

type Win = "gesamt" | "7" | "1";
const WINDOWS: { key: Win; label: string; hint: string }[] = [
  { key: "gesamt", label: "Bis dahin", hint: "Alles vom Staffelstart bis zu diesem Tag" },
  { key: "7", label: "7 Tage", hint: "Die sieben Tage bis zu diesem Tag" },
  { key: "1", label: "Nur der Tag", hint: "Nur dieser eine Tag" },
];

const DAY = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const dayLabel = (d: string) => DAY.format(Date.parse(`${d}T12:00:00Z`));

/**
 * Gruppen über die Zeit: Schieberegler über die Tage der Staffel, Zeitfenster und Abspielen. Der Server liefert
 * das Netz je Tag einmal, Fenster und Gruppen rechnet der Browser. Farben hängen an der Einteilung der ganzen
 * Staffel, damit dieselbe Gruppe beim Durchspielen ihre Farbe behält.
 */
export function GroupsTimeline({ nodes, daily, base }: { nodes: GraphNode[]; daily: DailyNetwork; base: { path: string; key: string } }) {
  const last = daily.days.length - 1;
  const [to, setTo] = useState(last);
  const [win, setWin] = useState<Win>("gesamt");
  const [playing, setPlaying] = useState(false);
  const from = win === "gesamt" ? 0 : Math.max(0, to - (win === "7" ? 6 : 0));
  const edges = useMemo(() => sumDays(daily, from, to), [daily, from, to]);

  // Feste Farben aus der ganzen Staffel (Standard-Gewichtung)
  const anchorColor = useMemo(() => {
    const season = analyzeGroups(sumDays(daily, 0, last), DEFAULT_WEIGHTS);
    const color = new Map<string, string>();
    for (const g of season.groups) for (const m of g.members) color.set(m.id, g.color);
    return (id: string) => color.get(id) ?? null;
  }, [daily, last]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setTo((d) => {
        if (d >= last) {
          setPlaying(false);
          return d;
        }
        return d + 1;
      });
    }, 1400);
    return () => clearInterval(t);
  }, [playing, last]);

  if (last < 0) return <p className="muted">Noch keine Verbindungen erfasst.</p>;

  const toolbar = (
    <div className="grp__time" role="group" aria-label="Zeitpunkt">
      <button
        type="button"
        className="btn btn--small"
        data-tone="white"
        onClick={() => {
          if (!playing && to >= last) setTo(0);
          setPlaying(!playing);
        }}
        aria-label={playing ? "Anhalten" : "Abspielen"}
        title={playing ? "Anhalten" : "Tag für Tag abspielen"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={to}
        onChange={(e) => {
          setPlaying(false);
          setTo(Number(e.target.value));
        }}
        aria-label="Tag"
        aria-valuetext={dayLabel(daily.days[to])}
      />
      <b className="num grp__time-day">
        {from === to ? dayLabel(daily.days[to]) : `${dayLabel(daily.days[from])} – ${dayLabel(daily.days[to])}`}
      </b>
      <div className="gb__seg" role="group" aria-label="Zeitfenster">
        {WINDOWS.map((w) => (
          <button key={w.key} type="button" aria-pressed={win === w.key} title={w.hint} onClick={() => setWin(w.key)}>
            {w.label}
          </button>
        ))}
      </div>
      {to !== last && (
        <button type="button" className="more__all" onClick={() => (setPlaying(false), setTo(last))}>
          Heute
        </button>
      )}
    </div>
  );

  return <GroupsOverview nodes={nodes} edges={edges} base={base} toolbar={toolbar} anchorColor={anchorColor} />;
}
