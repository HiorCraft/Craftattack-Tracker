"use client";

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_WEIGHTS, KIND_INFO, LINK_KINDS, WEIGHT_PRESETS, weigh, type LinkCounts, type Weights } from "@/lib/connectionWeights";
import { analyzeGroups, resolutionForCount, type GroupAnalysis } from "@/lib/groups";
import { num } from "@/lib/format";
import { isMutual } from "@/lib/network";

const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const KIND = KIND_INFO;
const PRESETS = WEIGHT_PRESETS;
const same = (a: Weights, b: Weights) => LINK_KINDS.every((k) => a[k] === b[k]);

/** Feinheit als Schieberegler auf einer Log-Skala: Stufe 0–40 ↔ 0,25–16 */
const RES_STEPS = 40;
const resOfStep = (s: number) => Math.round(0.25 * Math.pow(64, s / RES_STEPS) * 100) / 100;
const stepOfRes = (r: number) => Math.round((Math.log(r / 0.25) / Math.log(64)) * RES_STEPS);

export interface GroupSettingsValue {
  weights: Weights;
  /** "feinheit": Regler; "anzahl": gewünschte Zahl der Gruppen (Feinheit wird passend gesucht) */
  mode: "feinheit" | "anzahl";
  resolution: number;
  count: number;
  /** Nur Verbindungen, die in beide Richtungen gehen: in den Graphen und in der Gruppenbildung */
  mutual: boolean;
}
const DEFAULTS: GroupSettingsValue = { weights: DEFAULT_WEIGHTS, mode: "feinheit", resolution: 1, count: 10, mutual: false };
const STORAGE_KEY = "ac.gruppen.v1";

function load(): GroupSettingsValue | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<GroupSettingsValue> | null;
    if (!raw || typeof raw !== "object") return null;
    const w = { ...DEFAULT_WEIGHTS };
    for (const k of LINK_KINDS) {
      const v = raw.weights?.[k];
      if (typeof v === "number" && v >= 0 && v <= 5) w[k] = v;
    }
    return {
      weights: w,
      mode: raw.mode === "anzahl" ? "anzahl" : "feinheit",
      resolution: typeof raw.resolution === "number" && raw.resolution >= 0.25 && raw.resolution <= 16 ? raw.resolution : 1,
      count: typeof raw.count === "number" && raw.count >= 2 && raw.count <= 60 ? Math.round(raw.count) : 10,
      mutual: raw.mutual === true,
    };
  } catch {
    return null;
  }
}

/**
 * Einstellungen für Gruppen und Netz-Versuch: wie viel Raids, geteilte Chats und Nachrichten zählen (wie auf
 * /verbindungen) und wie fein die Gruppen sind, als Regler oder als gewünschte Anzahl. Bleibt im Browser gespeichert
 * und gilt auf allen Gruppen-Seiten gleich, damit Links zwischen Gruppen zur selben Einteilung führen.
 */
export function useGroupSettings(edges: LinkCounts[]) {
  const [s, setS] = useState<GroupSettingsValue>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const saved = load();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- einmalig nach dem Hydrieren
    if (saved) setS(saved);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* Speicher gesperrt: gilt nur bis zum Neuladen */
    }
  }, [s, loaded]);
  const set = (patch: Partial<GroupSettingsValue>) => setS((prev) => ({ ...prev, ...patch }));
  // Einseitige Verbindungen (nur Raids oder Nachrichten in eine Richtung) fallen ganz weg: aus den Graphen und aus der
  // Gruppenbildung samt Anführer, Kern, Rand und Begründung
  const mutualEdges = useMemo(() => edges.filter((e) => isMutual(e, s.weights)), [edges, s.weights]);
  const groupEdges = s.mutual ? mutualEdges : edges;
  const shown = useMemo(() => (s.mutual ? (e: LinkCounts) => isMutual(e, s.weights) : () => true), [s.mutual, s.weights]);
  const resolution = useMemo(() => (s.mode === "anzahl" ? resolutionForCount(groupEdges, s.weights, s.count) : s.resolution), [groupEdges, s.weights, s.mode, s.count, s.resolution]);
  const analysis: GroupAnalysis = useMemo(() => analyzeGroups(groupEdges, s.weights, resolution), [groupEdges, s.weights, resolution]);
  const activeCount = useMemo(() => edges.filter((e) => weigh(e, s.weights).weight > 0).length, [edges, s.weights]);
  const sizes = analysis.groups.map((g) => g.members.length);
  const controls = (
    <div className="box conn__controls" data-tone="white">
      <fieldset className="conn__group">
        <legend className="eyebrow">Was zählt wie viel</legend>
        <div className="gb__seg" role="group" aria-label="Voreinstellungen">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" aria-pressed={same(s.weights, p.w)} onClick={() => set({ weights: p.w })}>
              {p.label}
            </button>
          ))}
        </div>
        {LINK_KINDS.map((k) => {
          const w = s.weights[k];
          return (
            <label key={k} className="conn__weight" title={KIND[k].hint}>
              <span className="conn__weight-name">
                <i style={{ background: KIND[k].color }} aria-hidden="true" /> {KIND[k].label}
              </span>
              <input
                type="range"
                min={0}
                max={5}
                step={0.25}
                value={w}
                onChange={(e) => set({ weights: { ...s.weights, [k]: Number(e.target.value) } })}
                aria-valuetext={w === 0 ? "aus" : `Faktor ${dec.format(w)}`}
              />
              <b className="num conn__weight-val">{w === 0 ? "aus" : `×${dec.format(w)}`}</b>
              <span className="muted conn__weight-unit">{w === 0 ? "zählt nicht" : KIND[k].unit(w)}</span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="conn__group">
        <legend className="eyebrow">Verbindungen</legend>
        <div className="gb__seg" role="group" aria-label="Richtung der Verbindungen">
          <button type="button" aria-pressed={!s.mutual} onClick={() => set({ mutual: false })}>
            Alle
          </button>
          <button type="button" aria-pressed={s.mutual} onClick={() => set({ mutual: true })} title="Nur, wenn beide etwas für den anderen tun: z. B. raiden sich gegenseitig, schreiben beieinander oder teilen einen Chat">
            Nur gegenseitige
          </button>
        </div>
        <p className="muted">
          {num(mutualEdges.length)} von {num(activeCount)} Verbindungen gehen in beide Richtungen. Einseitig: nur einer raidet oder schreibt beim anderen.
          {s.mutual && " Gruppen, Anführer, Kern und Rand werden nur aus den gegenseitigen gebildet."}
        </p>
      </fieldset>
      <fieldset className="conn__group">
        <legend className="eyebrow">Gruppen</legend>
        <div className="gb__seg" role="group" aria-label="Einteilung">
          <button type="button" aria-pressed={s.mode === "feinheit"} onClick={() => set({ mode: "feinheit", resolution })}>
            Feinheit
          </button>
          <button type="button" aria-pressed={s.mode === "anzahl"} onClick={() => set({ mode: "anzahl", count: analysis.groups.length })}>
            Anzahl
          </button>
        </div>
        {s.mode === "feinheit" ? (
          <label className="conn__weight">
            <span className="conn__weight-name">Feinheit</span>
            <input type="range" min={0} max={RES_STEPS} step={1} value={stepOfRes(s.resolution)} onChange={(e) => set({ resolution: resOfStep(Number(e.target.value)) })} aria-valuetext={dec.format(s.resolution)} />
            <b className="num conn__weight-val">{dec.format(s.resolution)}</b>
            <span className="muted conn__weight-unit">höher = mehr, kleinere Gruppen</span>
          </label>
        ) : (
          <label className="conn__weight">
            <span className="conn__weight-name">Gruppen</span>
            <input type="range" min={2} max={40} step={1} value={s.count} onChange={(e) => set({ count: Number(e.target.value) })} />
            <b className="num conn__weight-val">{num(s.count)}</b>
            <span className="muted conn__weight-unit">gewünscht, so nah wie möglich (Feinheit {dec.format(resolution)})</span>
          </label>
        )}
        <p className="muted">
          {num(analysis.groups.length)} Gruppen · größte {num(sizes[0] ?? 0)} Spieler · {num(sizes.filter((n) => n === 1).length)} ohne Gruppe (allein)
        </p>
        <button type="button" className="tag conn__reset" onClick={() => setS({ ...DEFAULTS })} hidden={same(s.weights, DEFAULTS.weights) && s.mode === "feinheit" && s.resolution === 1 && !s.mutual}>
          Zurücksetzen
        </button>
      </fieldset>
    </div>
  );
  return { analysis, weights: s.weights, resolution, controls, shown, mutual: s.mutual, groupEdges };
}
