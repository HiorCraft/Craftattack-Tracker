"use client";

import { Explain } from "./Explain";
import { ShowMore } from "./ShowMore";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ConnectionGraph, type GraphEdge, type GraphNode } from "./ConnectionGraph";
import { Head } from "./Head";
import { PlayerSearch } from "./PlayerSearch";
import { DEFAULT_WEIGHTS, KIND_INFO, LINK_KINDS, WEIGHT_PRESETS, weigh, type LinkCounts, type Weights } from "@/lib/connectionWeights";
import { adjacency, closeness, distancesFrom, type Direction } from "@/lib/network";
import { duration, num } from "@/lib/format";

/** Punkte und Faktoren mit höchstens zwei Nachkommastellen */
const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const KIND = KIND_INFO;
const PRESETS = WEIGHT_PRESETS;

export const DIRECTIONS: { key: Direction; label: string; hint: string }[] = [
  { key: "von", label: "Von ihm aus", hint: "Wen er raidet, bei wem er schreibt, und weiter über deren Verbindungen" },
  { key: "zu", label: "Zu ihm hin", hint: "Wer ihn raidet oder bei ihm schreibt, und wer wiederum zu denen" },
  { key: "gegenseitig", label: "Gegenseitig", hint: "Nur Verbindungen, die in beide Richtungen gehen" },
];

type Show = "alle" | "online" | "live";
const SHOW: { key: Show; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "online", label: "Auf dem Server" },
  { key: "live", label: "Live" },
];

interface Settings {
  weights: Weights;
  /** Verbindungen unter so vielen Punkten ausblenden */
  min: number;
  show: Show;
  /** Hervorgehobener Spieler (ID) oder leer */
  focus: string;
  /** Richtung für die Abstände vom hervorgehobenen Spieler */
  dir: Direction;
}
const DEFAULTS: Settings = { weights: DEFAULT_WEIGHTS, min: 0, show: "alle", focus: "", dir: "von" };
const STORAGE_KEY = "ac.verbindungen.v1";

/** Gespeicherte Einstellungen des Besuchers; alles Unbekannte fällt auf die Standardwerte zurück */
function loadSettings(): Settings | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Settings> | null;
    if (!raw || typeof raw !== "object") return null;
    const w = { ...DEFAULT_WEIGHTS };
    for (const k of LINK_KINDS) {
      const v = raw.weights?.[k];
      if (typeof v === "number" && v >= 0 && v <= 5) w[k] = v;
    }
    return {
      weights: w,
      min: typeof raw.min === "number" && raw.min >= 0 && raw.min <= 20 ? raw.min : 0,
      show: SHOW.some((s) => s.key === raw.show) ? (raw.show as Show) : "alle",
      focus: "",
      dir: DIRECTIONS.some((d) => d.key === raw.dir) ? (raw.dir as Direction) : "von",
    };
  } catch {
    return null;
  }
}

const sameWeights = (a: Weights, b: Weights) => LINK_KINDS.every((k) => a[k] === b[k]);

/**
 * Einstellungen, Graph und Tabelle der Verbindungen. Der Besucher legt fest, wie viel Raids, geteilte Chats und
 * Chat-Nachrichten zählen (Faktor 0 = aus), blendet schwache Verbindungen aus und kann einen Spieler hervorheben.
 * Alles wird im Browser gerechnet; die Einstellungen (ohne Hervorhebung) bleiben im Browser gespeichert.
 */
export function ConnectionExplorer({ nodes, edges }: { nodes: GraphNode[]; edges: LinkCounts[] }) {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }));

  // Gespeicherte Einstellungen erst nach dem ersten Rendern lesen, sonst passt das Server-HTML nicht
  useEffect(() => {
    const saved = loadSettings();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- einmalig nach dem Hydrieren
    if (saved) setS(saved);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ weights: s.weights, min: s.min, show: s.show, dir: s.dir }));
    } catch {
      /* Speicher gesperrt: Einstellungen gelten nur bis zum Neuladen */
    }
  }, [s.weights, s.min, s.show, s.dir, loaded]);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const shownEdges: GraphEdge[] = useMemo(() => {
    const visible = (id: string) => {
      const n = nodeById.get(id);
      if (!n) return false;
      return s.show === "alle" || (s.show === "online" ? n.online : n.live);
    };
    return edges
      .filter((e) => visible(e.a) && visible(e.b))
      .map((e) => ({ ...e, ...weigh(e, s.weights) }))
      .filter((e) => e.weight > 0 && e.weight >= s.min);
  }, [edges, nodeById, s.weights, s.min, s.show]);
  const shownNodes = useMemo(() => {
    const ids = new Set(shownEdges.flatMap((e) => [e.a, e.b]));
    return nodes.filter((n) => ids.has(n.id));
  }, [nodes, shownEdges]);
  const focus = s.focus && shownNodes.some((n) => n.id === s.focus) ? s.focus : null;
  const top = useMemo(
    () =>
      shownEdges
        .filter((e) => !focus || e.a === focus || e.b === focus)
        .sort((a, b) => b.weight - a.weight || b.chatSeconds - a.chatSeconds)
        .slice(0, 25),
    [shownEdges, focus],
  );
  // Abstände vom hervorgehobenen Spieler: gerichtet, über die gerade gezeigten Verbindungen
  const reach = useMemo(() => {
    if (!focus) return [];
    const out = adjacency(shownEdges, s.weights);
    return [...distancesFrom(focus, out, s.dir).values()].filter((r) => r.id !== focus).sort((a, b) => a.dist - b.dist);
  }, [focus, shownEdges, s.weights, s.dir]);
  const name = (id: string) => nodeById.get(id)?.name ?? id;
  const changed = !sameWeights(s.weights, DEFAULTS.weights) || s.min !== DEFAULTS.min || s.show !== DEFAULTS.show || s.focus !== "";

  const Person = ({ id }: { id: string }) => (
    <Link href={`/spieler/${encodeURIComponent(id)}`} className="conn__person">
      <Head id={id} uuid={nodeById.get(id)?.uuid} name={name(id)} size={22} decorative />
      <span>{name(id)}</span>
    </Link>
  );

  return (
    <>
      <div className="conn__layout">
      <div className="box conn__controls" data-tone="white">
        <fieldset className="conn__group">
          <legend className="eyebrow">Gewichtung</legend>
          <div className="gb__seg" role="group" aria-label="Voreinstellungen">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" aria-pressed={sameWeights(s.weights, p.w)} onClick={() => set({ weights: p.w })}>
                {p.label}
              </button>
            ))}
          </div>
          {LINK_KINDS.map((k) => {
            const w = s.weights[k];
            return (
              <label key={k} className="conn__weight" title={`${KIND[k].hint} · ${w === 0 ? "zählt nicht" : KIND[k].unit(w)}`}>
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
              </label>
            );
          })}
        </fieldset>

        <fieldset className="conn__group">
          <legend className="eyebrow">Anzeige</legend>
          <label className="conn__weight" title="Schwächere Verbindungen ausblenden">
            <span className="conn__weight-name">Mindeststärke</span>
            <input type="range" min={0} max={10} step={0.5} value={s.min} onChange={(e) => set({ min: Number(e.target.value) })} />
            <b className="num conn__weight-val">{s.min === 0 ? "alle" : `ab ${dec.format(s.min)} P.`}</b>
          </label>
          <div className="conn__row">
            <span className="conn__weight-name">Spieler</span>
            <div className="gb__seg" role="group" aria-label="Spieler">
              {SHOW.map((o) => (
                <button key={o.key} type="button" aria-pressed={s.show === o.key} onClick={() => set({ show: o.key })}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="conn__row">
            <span className="conn__weight-name">Fokus</span>
            <PlayerSearch players={shownNodes} value={focus ?? ""} onChange={(id) => set({ focus: id })} label="Spieler hervorheben" empty={{ label: "Niemand" }} />
          </div>
          <div className="conn__row">
            <span className="muted">
              {num(shownNodes.length)} Spieler · {num(shownEdges.length)} Verbindungen
            </span>
            {changed && (
              <button type="button" className="tag conn__reset" onClick={() => setS({ ...DEFAULTS })}>
                Zurücksetzen
              </button>
            )}
          </div>
        </fieldset>
      </div>

      <div className="box conn__box" data-tone="white">
        <ConnectionGraph nodes={shownNodes} edges={shownEdges} focus={focus} />
        <ul className="conn__legend muted">
          <li>
            <i style={{ background: "var(--twitch)" }} /> vor allem Raids
          </li>
          <li>
            <i style={{ background: "var(--diamond)" }} /> vor allem geteilter Chat
          </li>
          <li>
            <i style={{ background: "var(--grass)" }} /> vor allem Stream-Titel
          </li>
          <li>
            <i style={{ background: "var(--gold)" }} /> vor allem Chat-Nachrichten
          </li>
          <li>
            <i style={{ background: "var(--grass)" }} /> gerade im geteilten Chat
          </li>
          <li>
            <Explain label="Bedienung">
              Lila Rahmen: live · grünes Kästchen: auf dem Server · Name beim Überfahren (Touch: einmal antippen, zweimal fürs Profil) · Kopf ziehen zum
              Verschieben, anklicken fürs Profil
            </Explain>
          </li>
        </ul>
      </div>
      </div>

      {focus && (
        <>
          <div className="section-head" style={{ marginTop: 32 }}>
            <h2 className="t-2">
              Wie nah steht {name(focus)} den anderen?{" "}
              <Explain>
                Über den kürzesten Weg im Netz. Raids, Titel und Chat-Nachrichten zählen nur in ihre Richtung, geteilter Chat in beide. Nähe 50 % = direkt mit 1
                Punkt verbunden; über Umwege sinkt sie.
              </Explain>
            </h2>
            <div className="gb__seg" role="group" aria-label="Richtung">
              {DIRECTIONS.map((d) => (
                <button key={d.key} type="button" aria-pressed={s.dir === d.key} title={d.hint} onClick={() => set({ dir: d.key })}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          {reach.length === 0 ? (
            <p className="muted">In dieser Richtung ist niemand verbunden.</p>
          ) : (
            <div className="box" data-tone="white">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Spieler</th>
                      <th className="num">Nähe</th>
                      <th className="num">Schritte</th>
                      <th>Weg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reach.slice(0, 40).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Person id={r.id} />
                        </td>
                        <td className="num">
                          <span className="conn__near" style={{ "--near": closeness(r.dist) } as React.CSSProperties}>
                            {Math.round(closeness(r.dist) * 100)} %
                          </span>
                        </td>
                        <td className="num">{r.hops === 1 ? "direkt" : num(r.hops)}</td>
                        <td className="muted conn__path">{(s.dir === "zu" ? [...r.path].reverse() : r.path).map(name).join(s.dir === "gegenseitig" ? " ↔ " : " → ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {reach.length > 40 && <p className="muted">… und {num(reach.length - 40)} weitere, weiter entfernt.</p>}
            </div>
          )}
        </>
      )}

      <div className="section-head" style={{ marginTop: 32 }}>
        <h2 className="t-2">
          {focus ? `Verbindungen von ${name(focus)}` : "Stärkste Verbindungen"} <Explain>Punkte nach der eingestellten Gewichtung (Regler neben dem Netz).</Explain>
        </h2>
      </div>
      {top.length === 0 ? (
        <p className="muted">Mit diesen Einstellungen gibt es keine Verbindungen.</p>
      ) : (
        <div className="box" data-tone="white">
          <ShowMore height={720} label="Verbindungen">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Spieler</th>
                  <th />
                  <th className="num">Raids →</th>
                  <th className="num">← Raids</th>
                  <th className="num">Geteilte Chats</th>
                  <th className="num">Zeit im Chat</th>
                  <th className="num" title="Stream-Zeit, in der der erste Spieler den zweiten im Titel nannte (höchstens 8 Std je Tag)">
                    Titel →
                  </th>
                  <th className="num" title="Stream-Zeit, in der der zweite Spieler den ersten im Titel nannte">
                    ← Titel
                  </th>
                  <th className="num" title="Nachrichten des ersten Spielers im Chat des zweiten">
                    Nachr. →
                  </th>
                  <th className="num" title="Nachrichten des zweiten Spielers im Chat des ersten">
                    ← Nachr.
                  </th>
                  <th className="num">Punkte</th>
                </tr>
              </thead>
              <tbody>
                {top.map((e) => (
                  <tr key={`${e.a}|${e.b}`}>
                    <td>
                      <Person id={e.a} />
                    </td>
                    <td>
                      <Person id={e.b} />
                    </td>
                    <td className="num">{e.raidsAB ? num(e.raidsAB) : "–"}</td>
                    <td className="num">{e.raidsBA ? num(e.raidsBA) : "–"}</td>
                    <td className="num">
                      {e.now && (
                        <span className="tag" data-tone="grass" style={{ fontSize: ".75rem", padding: "1px 6px", marginRight: 6 }}>
                          jetzt
                        </span>
                      )}
                      {e.chats ? num(e.chats) : "–"}
                    </td>
                    <td className="num">{e.chatSeconds ? duration(e.chatSeconds) : "–"}</td>
                    <td className="num">{e.titleAB ? duration(e.titleAB) : "–"}</td>
                    <td className="num">{e.titleBA ? duration(e.titleBA) : "–"}</td>
                    <td className="num">{e.msgsAB ? num(e.msgsAB) : "–"}</td>
                    <td className="num">{e.msgsBA ? num(e.msgsBA) : "–"}</td>
                    <td className="num">
                      <b>{dec.format(e.weight)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </ShowMore>
        </div>
      )}
    </>
  );
}
