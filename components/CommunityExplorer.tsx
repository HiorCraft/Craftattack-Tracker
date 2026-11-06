"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NetzView, NaeheView } from "./CommunityViews";
import { recolor } from "./GroupViews";
import { FigValue } from "./FigValue";
import { Head } from "./Head";
import { PlayerSearch } from "./PlayerSearch";
import type { GraphEdge, GraphNode } from "./ConnectionGraph";
import type { CommunityCtx } from "./communityCtx";
import { sumDays, type DailyNetwork } from "@/lib/dailyNetwork";
import { DEFAULT_WEIGHTS, KIND_INFO, LINK_KINDS, weigh } from "@/lib/connectionWeights";
import { analyzeGroups, resolutionForCount } from "@/lib/groups";
import { isMutual, type Direction } from "@/lib/network";
import { loadOpen, loadSettings, parseSettings, sameWeights, saveOpen, saveSettings, SETTINGS_DEFAULTS, type CommunitySettings, type Show } from "@/lib/communitySettings";
import { num } from "@/lib/format";

export type CommunityView = "netz" | "distanz";
const VIEWS: { key: CommunityView; label: string; hint: string }[] = [
  { key: "netz", label: "Verbindungen", hint: "Alle Verbindungen als Netz; mit Spieler seine Verbindungen" },
  { key: "distanz", label: "Distanz", hint: "Wer allen am nächsten steht; mit Spieler alle nach ihrer Distanz zu ihm" },
];

const SHOW: { key: Show; label: string; hint: string }[] = [
  { key: "alle", label: "Alle", hint: "Alle Spieler" },
  { key: "online", label: "Online", hint: "Nur Spieler, die gerade auf dem Server sind" },
  { key: "live", label: "Live", hint: "Nur Spieler, die gerade streamen" },
];

const DIRECTIONS: { key: Direction; label: string; hint: string }[] = [
  { key: "von", label: "Von ihm", hint: "Wen er raidet, bei wem er schreibt, und weiter über deren Verbindungen" },
  { key: "zu", label: "Zu ihm", hint: "Wer ihn raidet oder bei ihm schreibt, und wer wiederum zu denen" },
  { key: "gegenseitig", label: "Gegenseitig", hint: "Nur Verbindungen, die in beide Richtungen gehen" },
];

/** Mindeststärke in Stufen: fein bei kleinen Werten, bis zu den stärksten Verbindungen */
const MIN_STEPS = [0, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500];

const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const DAY = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const dayLabel = (d: string) => DAY.format(Date.parse(`${d}T12:00:00Z`));

/** Abschnitte der Seitenleiste und ob sie anfangs offen sind (breit / schmal) */
type Section = "verteilung" | "filter" | "ansicht";
const OPEN_WIDE: Record<Section, boolean> = { verteilung: true, filter: true, ansicht: true };
const OPEN_NARROW: Record<Section, boolean> = { verteilung: false, filter: false, ansicht: false };

/**
 * Verbindungen: Netz und Distanz (Gruppen zuschaltbar) sind nur verschiedene Blicke auf dieselben Daten. Alle Einstellungen
 * (Zeitraum, Verteilung, Filter, Gruppen) gelten für jede Ansicht; ein gewählter Spieler bleibt beim Wechsel
 * gewählt und macht jede Ansicht spielerspezifisch. Ansicht, Filter und Spieler stehen in der Adresse, die übrigen
 * Einstellungen bleiben im Browser gespeichert.
 */
export function CommunityExplorer({
  nodes,
  daily,
  dailyServer,
  initialView,
  initialServer,
  initialFocus,
  initialGroups,
}: {
  nodes: GraphNode[];
  daily: DailyNetwork;
  dailyServer: DailyNetwork;
  initialView: CommunityView;
  initialServer: boolean;
  initialFocus: string;
  /** Aus der Adresse (?gruppen=1); sonst gilt die gespeicherte Einstellung */
  initialGroups: boolean | null;
}) {
  const [view, setView] = useState<CommunityView>(initialView);
  const [server, setServer] = useState(initialServer);
  const [focus, setFocus] = useState(initialFocus);
  const [s, setS] = useState<CommunitySettings>(SETTINGS_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Record<Section, boolean>>(OPEN_WIDE);
  const [sidebar, setSidebar] = useState(true);
  const set = useCallback((patch: Partial<CommunitySettings>) => setS((p) => ({ ...p, ...patch })), []);

  // Gespeichertes erst nach dem ersten Rendern lesen, sonst passt das Server-HTML nicht
  useEffect(() => {
    const saved = loadSettings();
    const narrow = window.matchMedia("(width < 1100px)").matches;
    const o = loadOpen();
    /* eslint-disable react-hooks/set-state-in-effect -- einmalig nach dem Hydrieren */
    if (saved || initialGroups !== null) setS({ ...(saved ?? SETTINGS_DEFAULTS), ...(initialGroups !== null ? { groups: initialGroups } : {}) });
    setOpen({ ...(narrow ? OPEN_NARROW : OPEN_WIDE), ...(o && !narrow ? (o as Record<Section, boolean>) : {}) });
    if (o?.leiste === false && !narrow) setSidebar(false);
    setLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loaded) saveSettings(s);
  }, [s, loaded]);
  useEffect(() => {
    if (loaded && !window.matchMedia("(width < 1100px)").matches) saveOpen({ ...open, leiste: sidebar });
  }, [open, sidebar, loaded]);

  // Ansicht, Filter und Spieler in der Adresse halten
  useEffect(() => {
    const u = new URL(window.location.href);
    const put = (k: string, v: string) => (v ? u.searchParams.set(k, v) : u.searchParams.delete(k));
    put("ansicht", view === "netz" ? "" : view);
    put("server", server ? "1" : "");
    put("spieler", focus);
    if (loaded) put("gruppen", s.groups ? "1" : "");
    // Mit null, damit Next.js die Adresse übernimmt (sonst setzt die Minuten-Aktualisierung sie zurück)
    window.history.replaceState(null, "", u);
  }, [view, server, focus, s.groups, loaded]);

  // Zeitraum: von–bis als Tage; „bis“ leer = immer der neueste Tag
  const data = server ? dailyServer : daily;
  const last = data.days.length - 1;
  const [range, setRange] = useState<{ from: number; to: number | null }>({ from: 0, to: null });
  const to = range.to === null ? last : Math.min(range.to, last);
  const from = Math.min(range.from, to);
  const pickRange = (f: number, t: number) => setRange({ from: f, to: t >= last ? null : t });

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const name = useCallback((id: string) => byId.get(id)?.name ?? id, [byId]);

  // Ein Filter für alle Ansichten: Spieler (online/live), Mindeststärke, gegenseitig
  const filter = useCallback(
    (edges: ReturnType<typeof sumDays>) => {
      const visible = (id: string) => {
        const n = byId.get(id);
        return !!n && (s.show === "alle" || (s.show === "online" ? n.online : n.live));
      };
      return edges.filter((e) => {
        if (!visible(e.a) || !visible(e.b)) return false;
        const w = weigh(e, s.weights).weight;
        return w > 0 && w >= s.min && (!s.mutual || isMutual(e, s.weights));
      });
    },
    [byId, s.show, s.weights, s.min, s.mutual],
  );
  const raw = useMemo(() => (last < 0 ? [] : sumDays(data, from, to)), [data, from, to, last]);
  const counts = useMemo(() => filter(raw), [filter, raw]);
  // Mindeststärke-Stufen bis zur stärksten Verbindung (darüber bliebe nichts übrig)
  const minSteps = useMemo(() => {
    const top = Math.max(0, ...raw.map((e) => weigh(e, s.weights).weight));
    const steps = MIN_STEPS.filter((v) => v <= top);
    return s.min > (steps.at(-1) ?? 0) ? [...steps, s.min] : steps;
  }, [raw, s.weights, s.min]);
  const weighted: GraphEdge[] = useMemo(() => counts.map((e) => ({ ...e, ...weigh(e, s.weights) })), [counts, s.weights]);
  // Gruppen nur rechnen, wenn sie gezeigt werden (die Suche nach der Anzahl ist teuer)
  const resolution = useMemo(() => (s.groups ? resolutionForCount(counts, s.weights, s.count) : 1), [counts, s.weights, s.count, s.groups]);
  // Gruppenfarben aus der ganzen Staffel (gleiche Einstellungen), damit Gruppen beim Verschieben des Zeitraums ihre Farbe behalten
  const season = useMemo(() => (last < 0 ? [] : filter(sumDays(data, 0, last))), [data, last, filter]);
  const anchorColor = useMemo(() => {
    if (!s.groups || (from === 0 && to === last)) return null;
    const a = analyzeGroups(season, s.weights, resolution);
    const color = new Map<string, string>();
    for (const g of a.groups) for (const m of g.members) color.set(m.id, g.color);
    return (id: string) => color.get(id) ?? null;
  }, [season, s.weights, resolution, from, to, last, s.groups]);
  const analysis = useMemo(() => {
    const a = analyzeGroups(counts, s.weights, resolution);
    return anchorColor ? recolor(a, anchorColor) : a;
  }, [counts, s.weights, resolution, anchorColor]);
  const groupColor = useCallback((id: string) => analysis.groups[analysis.groupOf.get(id) ?? -1]?.color ?? null, [analysis]);

  const select = useCallback((id: string) => setFocus((cur) => (cur === id && id ? cur : id)), []);
  const [hover, setHover] = useState<string | null>(null);
  const c: CommunityCtx = { nodes, byId, name, counts, weighted, weights: s.weights, analysis, groupColor, s, set, focus, select, hover, setHover };

  const raids = counts.reduce((a, e) => a + e.raidsAB + e.raidsBA, 0);
  const chats = counts.reduce((a, e) => a + e.chats, 0);
  const msgs = counts.reduce((a, e) => a + e.msgsAB + e.msgsBA, 0);
  const titleHours = Math.round(counts.reduce((a, e) => a + e.titleAB + e.titleBA, 0) / 3600);
  const linked = new Set(counts.flatMap((e) => [e.a, e.b])).size;
  const activeCount = raw.filter((e) => weigh(e, s.weights).weight > 0).length;
  const sizes = analysis.groups.map((g) => g.members.length);
  const changed = JSON.stringify(s) !== JSON.stringify(parseSettings(null)) || from !== 0 || to !== last;
  const fg = s.groups && focus ? analysis.groupOf.get(focus) : undefined;
  const linkedFocus = !!focus && counts.some((e) => e.a === focus || e.b === focus);

  // Verteilung: Name anklicken = nur das zählt, nochmal anklicken = wieder ausgewogen
  const activeKinds = LINK_KINDS.filter((k) => s.weights[k] > 0);
  const solo = activeKinds.length === 1 ? activeKinds[0] : null;
  const balanced = sameWeights(s.weights, DEFAULT_WEIGHTS);
  const soloPick = (k: (typeof LINK_KINDS)[number]) =>
    set({
      weights:
        solo === k
          ? DEFAULT_WEIGHTS
          : (Object.fromEntries(LINK_KINDS.map((x) => [x, x === k ? s.weights[k] || DEFAULT_WEIGHTS[k] : 0])) as CommunitySettings["weights"]),
    });

  const sec = (k: Section, title: string, summary: React.ReactNode, body: React.ReactNode) => (
    <details className="cs__sec" open={open[k]} onToggle={(e) => setOpen((o) => ({ ...o, [k]: (e.target as HTMLDetailsElement).open }))}>
      <summary>
        <span className="eyebrow">{title}</span>
        <span className="muted cs__sum">{summary}</span>
      </summary>
      <div className="cs__body">{body}</div>
    </details>
  );

  const viewSection =
    view === "distanz" &&
    sec(
      "ansicht",
      focus ? "Distanz" : "Zentralität",
      focus ? `${s.scale === "naehe" ? "nach Nähe" : "nach Schritten"} · ${DIRECTIONS.find((d) => d.key === s.dir)!.label}` : DIRECTIONS.find((d) => d.key === s.dir)!.label,
      <>
        <Seg label="Richtung" items={DIRECTIONS} value={s.dir} onPick={(dir) => set({ dir })} />
        {focus && (
          <>
            <Seg
              label="Ringe"
              items={[
                { key: "naehe", label: "Nach Nähe", hint: "Abstand zur Mitte = Nähe (stärkere Verbindungen weiter innen)" },
                { key: "schritte", label: "Nach Schritten", hint: "Ein Ring je Schritt über andere Spieler" },
              ]}
              value={s.scale}
              onPick={(scale) => set({ scale })}
            />
            <label className="cs__row" title="So viele der Nächsten zeigen">
              <span>Spieler</span>
              <input type="range" min={5} max={Math.max(10, linked - 1)} step={1} value={s.maxNodes === 0 ? Math.max(10, linked - 1) : s.maxNodes} onChange={(e) => set({ maxNodes: Number(e.target.value) >= linked - 1 ? 0 : Number(e.target.value) })} />
              <b className="num">{s.maxNodes === 0 ? "alle" : s.maxNodes}</b>
            </label>
            <Toggle on={s.showAll} onClick={() => set({ showAll: !s.showAll })} title="Spieler ohne Weg zu ihm am Rand zeigen">
              Nicht verbundene außen
            </Toggle>
          </>
        )}
      </>,
    );

  return (
    <div className="stack" style={{ "--stack": "16px" } as React.CSSProperties}>
      <dl className="grid st-figs st-figs--6">
        <div className="box st-fig" data-tone="twitch">
          <dt>Raids</dt>
          <FigValue>{num(raids)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="diamond">
          <dt title="Je Paar von Spielern, die gemeinsam im geteilten Chat waren">Geteilte Chats</dt>
          <FigValue>{num(chats)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="grass">
          <dt title="Stream-Zeit, in der Spieler einen anderen im Titel nannten („WG mit @…“), höchstens 8 Std je Tag und Paar">Im Titel genannt</dt>
          <FigValue unit="Std">{num(titleHours)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="gold">
          <dt title="Nachrichten von Spielern im Twitch-Chat eines anderen Spielers">Chat-Nachrichten</dt>
          <FigValue>{num(msgs)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="pink">
          <dt title={`${num(counts.length)} von ${num(activeCount)} Verbindungen nach den Filtern`}>Verbindungen</dt>
          <FigValue>{num(counts.length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="sky">
          <dt>{!s.groups ? "Spieler im Netz" : fg !== undefined ? "Gruppe" : "Gruppen"}</dt>
          <FigValue unit={fg !== undefined ? "Spieler" : undefined}>{!s.groups ? num(linked) : fg !== undefined ? num(analysis.groups[fg].members.length) : num(analysis.groups.length)}</FigValue>
        </div>
      </dl>

      <div className="conn__layout" data-nosidebar={!sidebar || undefined}>
        {sidebar && (
          <aside className="conn__side box cs" data-tone="white" id="comm-settings" aria-label="Einstellungen">
            <div className="cs__head">
              <div className="gb__seg comm__views" role="tablist" aria-label="Ansicht">
                {VIEWS.map((v) => (
                  <button key={v.key} type="button" role="tab" aria-selected={view === v.key} title={v.hint} onClick={() => setView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <button type="button" className="pick__x cs__hide" onClick={() => setSidebar(false)} aria-label="Einstellungen ausblenden" title="Einstellungen ausblenden">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.5" /></svg>
              </button>
            </div>
            <div className="comm__player">
              <PlayerSearch players={nodes} value={focus} onChange={select} label="Spieler auswählen" empty={{ label: "Alle Spieler" }} />
            </div>
            {focus && (
              <Link className="cs__profile" href={`/spieler/${encodeURIComponent(focus)}`} title={`Profil von ${name(focus)} öffnen`}>
                <Head id={focus} uuid={byId.get(focus)?.uuid} name={name(focus)} size={24} decorative />
                <span>
                  <b>Profil von {name(focus)}</b>
                  {(fg !== undefined || !linkedFocus) && <small className="muted">{fg !== undefined ? `Gruppe um ${name(analysis.groups[fg].leader)}` : "in diesem Zeitraum ohne Verbindung"}</small>}
                </span>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2.5" /></svg>
              </Link>
            )}
            <div className="cs__toggles">
              <Toggle on={s.groups} onClick={() => set({ groups: !s.groups })} title="Wer untereinander deutlich enger verbunden ist als mit dem Rest (Louvain). Sagt nichts über echte Freundschaften.">
                Gruppen
              </Toggle>
              <Toggle
                on={server}
                onClick={() => setServer(!server)}
                title="Nur, während mindestens einer der beiden auf dem Server war: Raids und Nachrichten zu dem Zeitpunkt, geteilter Chat und Titel nur für diese Zeit"
              >
                Verbindungen während online
              </Toggle>
            </div>
            {s.groups && (
              <div className="cs__groupbar">
                <label className="cs__row" title={`Gewünschte Zahl, so nah wie möglich. Gefunden: ${num(analysis.groups.length)} Gruppen, größte ${num(sizes[0] ?? 0)} Spieler, ${num(sizes.filter((n) => n === 1).length)} allein`}>
                  <span>Anzahl</span>
                  <input type="range" min={2} max={40} step={1} value={s.count} onChange={(e) => set({ count: Number(e.target.value) })} />
                  <b className="num">{num(s.count)}</b>
                </label>
                {view === "netz" && !focus && (
                  <Toggle on={s.groupMap} onClick={() => set({ groupMap: !s.groupMap })} title="Nur die Anführer, Linien = Verbindungen zwischen den Gruppen">
                    Ein Kopf je Gruppe
                  </Toggle>
                )}
              </div>
            )}
            {last >= 0 && (
              <div className="cs__time">
                <span className="eyebrow">Zeitraum</span>
                <span className="cs__dates">{from === to ? dayLabel(data.days[to]) : `${dayLabel(data.days[from])} – ${dayLabel(data.days[to])}`}</span>
                <DayRange last={last} from={from} to={to} label={(i) => dayLabel(data.days[i])} onChange={pickRange} />
              </div>
            )}
            {viewSection}
            {sec(
              "verteilung",
              "Verteilung",
              balanced ? "ausgewogen" : solo ? `nur ${KIND_INFO[solo].label}` : "eigene",
              <>
                {LINK_KINDS.map((k) => {
                  const w = s.weights[k];
                  return (
                    <div key={k} className="cs__row" data-off={w === 0 || undefined}>
                      <button
                        type="button"
                        className="cs__kind"
                        aria-pressed={solo === k}
                        onClick={() => soloPick(k)}
                        title={`${KIND_INFO[k].hint}. ${solo === k ? "Anklicken: wieder alles ausgewogen" : "Anklicken: nur das zählt"}`}
                      >
                        <i style={{ background: KIND_INFO[k].color }} aria-hidden="true" /> {KIND_INFO[k].label}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={5}
                        step={0.25}
                        value={w}
                        onChange={(e) => set({ weights: { ...s.weights, [k]: Number(e.target.value) } })}
                        aria-label={`Gewicht ${KIND_INFO[k].label}`}
                        aria-valuetext={w === 0 ? "aus" : `Faktor ${dec.format(w)}`}
                        title={w === 0 ? "zählt nicht" : KIND_INFO[k].unit(w)}
                      />
                      <b className="num">{w === 0 ? "aus" : `×${dec.format(w)}`}</b>
                    </div>
                  );
                })}
                {!balanced && (
                  <button type="button" className="linkbtn cs__balance" onClick={() => set({ weights: DEFAULT_WEIGHTS })}>
                    Ausgewogen
                  </button>
                )}
              </>,
            )}
            {sec(
              "filter",
              "Filter",
              [s.min ? `ab ${dec.format(s.min)} P.` : null, s.mutual ? "gegenseitig" : null, s.show !== "alle" ? SHOW.find((x) => x.key === s.show)!.label : null].filter(Boolean).join(" · ") || "keine",
              <>
                <label className="cs__row" title="Schwächere Verbindungen ausblenden (gilt auch für Distanz und Gruppen)">
                  <span>Mindeststärke</span>
                  <input
                    type="range"
                    min={0}
                    max={minSteps.length - 1}
                    step={1}
                    value={Math.max(0, minSteps.findIndex((v) => v >= s.min))}
                    onChange={(e) => set({ min: minSteps[Number(e.target.value)] })}
                    aria-valuetext={s.min === 0 ? "alle" : `ab ${dec.format(s.min)} Punkten`}
                  />
                  <b className="num">{s.min === 0 ? "alle" : `${dec.format(s.min)} P.`}</b>
                </label>
                <div className="cs__toggles">
                  <Seg label="Spieler" items={SHOW} value={s.show} onPick={(show) => set({ show })} />
                  <Toggle on={s.mutual} onClick={() => set({ mutual: !s.mutual })} title="Nur, wenn beide etwas für den anderen tun: raiden sich, schreiben beieinander, nennen sich im Titel oder teilen einen Chat">
                    Nur gegenseitige
                  </Toggle>
                </div>
              </>,
            )}
            {changed && (
              <button
                type="button"
                className="linkbtn cs__reset"
                onClick={() => {
                  setS({ ...SETTINGS_DEFAULTS });
                  setRange({ from: 0, to: null });
                }}
              >
                Alles zurücksetzen
              </button>
            )}
          </aside>
        )}

        <div className="conn__main">
          {!sidebar && (
            <button type="button" className="btn btn--small cs__open" data-tone="white" onClick={() => setSidebar(true)} aria-controls="comm-settings" aria-expanded="false">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M11 3L6 8l5 5" fill="none" stroke="currentColor" strokeWidth="2.5" /></svg> Einstellungen
            </button>
          )}
          {last < 0 ? (
            <p className="muted">Noch keine Verbindungen erfasst.</p>
          ) : view === "netz" ? (
            <NetzView c={c} />
          ) : (
            <NaeheView c={c} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Schalter: an = dunkel, aus = ausgegraut */
function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button type="button" className="cs__toggle" aria-pressed={on} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

/** Zeitraum als ein Regler mit zwei Griffen (von, bis); die Griffe schieben sich gegenseitig */
function DayRange({ last, from, to, label, onChange }: { last: number; from: number; to: number; label: (i: number) => string; onChange: (from: number, to: number) => void }) {
  const f = last > 0 ? from / last : 0;
  const t = last > 0 ? to / last : 1;
  return (
    <div className="cs__range" style={{ "--a": f, "--b": t } as React.CSSProperties}>
      <input
        type="range"
        min={0}
        max={Math.max(0, last)}
        step={1}
        value={from}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(v, Math.max(v, to));
        }}
        aria-label="Von"
        aria-valuetext={label(from)}
      />
      <input
        type="range"
        min={0}
        max={Math.max(0, last)}
        step={1}
        value={to}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(Math.min(v, from), v);
        }}
        aria-label="Bis"
        aria-valuetext={label(to)}
      />
    </div>
  );
}

function Seg<K extends string>({ label, items, value, onPick }: { label: string; items: { key: K; label: string; hint: string }[]; value: K; onPick: (k: K) => void }) {
  return (
    <div className="gb__seg" role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.key} type="button" aria-pressed={value === i.key} title={i.hint || undefined} onClick={() => onPick(i.key)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}
