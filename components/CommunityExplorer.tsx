"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NetzView, NaeheView, AROUND_NET } from "./CommunityViews";
import { recolor } from "./GroupViews";
import { FigValue } from "./FigValue";
import { Explain } from "./Explain";
import { PlayerSearch } from "./PlayerSearch";
import type { GraphEdge, GraphNode } from "./ConnectionGraph";
import type { CommunityCtx } from "./communityCtx";
import { sumDays, type DailyNetwork } from "@/lib/dailyNetwork";
import { KIND_INFO, LINK_KINDS, WEIGHT_PRESETS, weigh } from "@/lib/connectionWeights";
import { analyzeGroups, resolutionForCount } from "@/lib/groups";
import { isMutual, type Direction } from "@/lib/network";
import { loadOpen, loadSettings, parseSettings, sameWeights, saveOpen, saveSettings, SETTINGS_DEFAULTS, type CommunitySettings, type Show, type Win } from "@/lib/communitySettings";
import { num } from "@/lib/format";

export type CommunityView = "netz" | "distanz";
const VIEWS: { key: CommunityView; label: string; hint: string }[] = [
  { key: "netz", label: "Verbindungen", hint: "Alle Verbindungen als Netz; mit Spieler sein Umfeld und seine Verbindungen" },
  { key: "distanz", label: "Distanz", hint: "Wer allen am nächsten steht; mit Spieler alle nach ihrer Distanz zu ihm" },
];

const WINDOWS: { key: Win; label: string; hint: string }[] = [
  { key: "gesamt", label: "Bis dahin", hint: "Alles vom Staffelstart bis zum gewählten Tag" },
  { key: "7", label: "7 Tage", hint: "Die sieben Tage bis zum gewählten Tag" },
  { key: "1", label: "Nur der Tag", hint: "Nur der gewählte Tag" },
];

const SHOW: { key: Show; label: string; hint: string }[] = [
  { key: "alle", label: "Alle", hint: "Alle Spieler" },
  { key: "online", label: "Gerade online", hint: "Nur Spieler, die gerade auf dem Server sind" },
  { key: "live", label: "Live", hint: "Nur Spieler, die gerade streamen" },
];

const DIRECTIONS: { key: Direction; label: string; hint: string }[] = [
  { key: "von", label: "Von ihm aus", hint: "Wen er raidet, bei wem er schreibt, und weiter über deren Verbindungen" },
  { key: "zu", label: "Zu ihm hin", hint: "Wer ihn raidet oder bei ihm schreibt, und wer wiederum zu denen" },
  { key: "gegenseitig", label: "Gegenseitig", hint: "Nur Verbindungen, die in beide Richtungen gehen" },
];

const AROUND_GROUP: [number, string][] = [
  [0, "Nur die Gruppe"],
  [1, "+ Nachbarn"],
  [2, "+ 2 Schritte"],
  [99, "Ganzes Netz"],
];

/** Feinheit als Schieberegler auf einer Log-Skala: Stufe 0–40 ↔ 0,25–16 */
const RES_STEPS = 40;
const resOfStep = (s: number) => Math.round(0.25 * Math.pow(64, s / RES_STEPS) * 100) / 100;
const stepOfRes = (r: number) => Math.round((Math.log(r / 0.25) / Math.log(64)) * RES_STEPS);

/** Mindeststärke in Stufen: fein bei kleinen Werten, bis zu den stärksten Verbindungen */
const MIN_STEPS = [0, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500];

const dec = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
const DAY = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const dayLabel = (d: string) => DAY.format(Date.parse(`${d}T12:00:00Z`));

/** Abschnitte der Seitenleiste und ob sie anfangs offen sind (breit / schmal) */
type Section = "zeit" | "gewicht" | "filter" | "ansicht" | "gruppen";
const OPEN_WIDE: Record<Section, boolean> = { zeit: true, gewicht: true, filter: true, ansicht: true, gruppen: true };
const OPEN_NARROW: Record<Section, boolean> = { zeit: true, gewicht: false, filter: false, ansicht: false, gruppen: false };

/**
 * Verbindungen: Netz und Distanz (Gruppen zuschaltbar) sind nur verschiedene Blicke auf dieselben Daten. Alle Einstellungen
 * (Zeitraum, Gewichtung, Filter, Gruppen) gelten für jede Ansicht; ein gewählter Spieler bleibt beim Wechsel
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
    window.history.replaceState(window.history.state, "", u);
  }, [view, server, focus, s.groups, loaded]);

  const data = server ? dailyServer : daily;
  const last = data.days.length - 1;
  const [toRaw, setTo] = useState<number | null>(null);
  const to = toRaw === null ? last : Math.min(toRaw, last);
  const [playing, setPlaying] = useState(false);
  const from = s.win === "gesamt" ? 0 : Math.max(0, to - (s.win === "7" ? 6 : 0));
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setTo((d) => {
        const cur = d === null ? last : d;
        if (cur >= last) {
          setPlaying(false);
          return null;
        }
        return cur + 1;
      });
    }, 1400);
    return () => clearInterval(t);
  }, [playing, last]);

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
  const resolution = useMemo(() => (s.groupMode === "anzahl" ? resolutionForCount(counts, s.weights, s.count) : s.resolution), [counts, s.weights, s.groupMode, s.count, s.resolution]);
  // Gruppenfarben aus der ganzen Staffel (gleiche Einstellungen), damit Gruppen beim Durchspielen ihre Farbe behalten
  const season = useMemo(() => (last < 0 ? [] : filter(sumDays(data, 0, last))), [data, last, filter]);
  const anchorColor = useMemo(() => {
    if (from === 0 && to === last) return null;
    const a = analyzeGroups(season, s.weights, resolution);
    const color = new Map<string, string>();
    for (const g of a.groups) for (const m of g.members) color.set(m.id, g.color);
    return (id: string) => color.get(id) ?? null;
  }, [season, s.weights, resolution, from, to, last]);
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
  const preset = WEIGHT_PRESETS.find((p) => sameWeights(p.w, s.weights))?.label ?? "eigene";
  const changed = JSON.stringify(s) !== JSON.stringify(parseSettings(null));
  const fg = focus ? analysis.groupOf.get(focus) : undefined;

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
    view === "distanz"
      ? focus
        ? sec(
            "ansicht",
            "Distanz",
            `${s.scale === "naehe" ? "nach Nähe" : "nach Schritten"} · ${DIRECTIONS.find((d) => d.key === s.dir)!.label}`,
            <>
              <Seg label="Richtung" items={DIRECTIONS} value={s.dir} onPick={(dir) => set({ dir })} />
              <Seg
                label="Ringe"
                items={[
                  { key: "naehe", label: "Nach Nähe", hint: "Abstand zur Mitte = Nähe (stärkere Verbindungen weiter innen)" },
                  { key: "schritte", label: "Nach Schritten", hint: "Ein Ring je Schritt über andere Spieler" },
                ]}
                value={s.scale}
                onPick={(scale) => set({ scale })}
              />
              <label className="conn__weight" title="So viele der Nähesten zeigen">
                <span className="conn__weight-name">Spieler</span>
                <input type="range" min={5} max={Math.max(10, linked - 1)} step={1} value={s.maxNodes === 0 ? Math.max(10, linked - 1) : s.maxNodes} onChange={(e) => set({ maxNodes: Number(e.target.value) >= linked - 1 ? 0 : Number(e.target.value) })} />
                <b className="num conn__weight-val">{s.maxNodes === 0 ? "alle" : s.maxNodes}</b>
              </label>
              <label className="conn__row">
                <input type="checkbox" checked={s.showAll} onChange={(e) => set({ showAll: e.target.checked })} /> Nicht verbundene außen zeigen
              </label>
            </>,
          )
        : sec(
            "ansicht",
            "Zentralität",
            DIRECTIONS.find((d) => d.key === s.dir)!.label,
            <>
              <Seg label="Richtung" items={DIRECTIONS} value={s.dir} onPick={(dir) => set({ dir })} />
              <p className="muted">Spieler auswählen oder im Bild anklicken für die Distanz aller zu ihm.</p>
            </>,
          )
      : focus
        ? sec(
            "ansicht",
            `Umfeld von ${name(focus)}`,
            (s.groups ? AROUND_GROUP : AROUND_NET).find(([k]) => k === (s.groups ? s.around : Math.max(1, s.around)))?.[1],
            <Seg
              label="Umfeld"
              items={(s.groups ? AROUND_GROUP : AROUND_NET).map(([k, l]) => ({ key: String(k), label: l, hint: "" }))}
              value={String(s.groups ? s.around : Math.max(1, s.around))}
              onPick={(k) => set({ around: Number(k) })}
            />,
          )
        : null;

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
          <dt>Verbindungen</dt>
          <FigValue>{num(counts.length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="sky">
          <dt>{!s.groups ? "Spieler im Netz" : fg !== undefined ? "Gruppe" : "Gruppen"}</dt>
          <FigValue unit={s.groups && fg !== undefined ? "Spieler" : undefined}>{!s.groups ? num(linked) : fg !== undefined ? num(analysis.groups[fg].members.length) : num(analysis.groups.length)}</FigValue>
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
              {focus && (
                <Link className="more__all" href={`/spieler/${encodeURIComponent(focus)}`}>
                  Profil
                </Link>
              )}
            </div>
            {focus && (
              <p className="muted cs__focusline">{fg !== undefined ? `${name(focus)}: Gruppe um ${name(analysis.groups[fg].leader)}` : `${name(focus)}: in diesem Zeitraum ohne Verbindung`}</p>
            )}
            <Seg
              label="Welche Verbindungen"
              items={[
                { key: "alle", label: "Alle Verbindungen", hint: "Alles, was auf Twitch zwischen Spielern passiert ist" },
                {
                  key: "server",
                  label: "Nur auf dem Server",
                  hint: "Nur, während mindestens einer der beiden auf dem Server war: Raids und Nachrichten zu dem Zeitpunkt, geteilter Chat und Titel nur für diese Zeit",
                },
              ]}
              value={server ? "server" : "alle"}
              onPick={(k) => setServer(k === "server")}
            />
            <label className="conn__row cs__groups" title="Wer untereinander deutlich enger verbunden ist als mit dem Rest">
              <input
                type="checkbox"
                checked={s.groups}
                onChange={(e) => {
                  set({ groups: e.target.checked });
                  if (e.target.checked) setOpen((o) => ({ ...o, gruppen: true }));
                }}
              /> <b>Gruppen anzeigen</b>
            </label>
            {last >= 0 &&
              sec(
                "zeit",
                "Zeitraum",
                from === to ? dayLabel(data.days[to]) : `${dayLabel(data.days[from])} – ${dayLabel(data.days[to])}`,
                <>
                  <div className="cs__time">
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
                        const v = Number(e.target.value);
                        setTo(v >= last ? null : v);
                      }}
                      aria-label="Tag"
                      aria-valuetext={dayLabel(data.days[to])}
                    />
                    {to !== last && (
                      <button type="button" className="more__all" onClick={() => (setPlaying(false), setTo(null))}>
                        Heute
                      </button>
                    )}
                  </div>
                  <Seg label="Zeitfenster" items={WINDOWS} value={s.win} onPick={(win) => set({ win })} />
                </>,
              )}
            {viewSection}
            {sec(
              "gewicht",
              "Was zählt wie viel",
              preset,
              <>
                <div className="gb__seg" role="group" aria-label="Voreinstellungen">
                  {WEIGHT_PRESETS.map((p) => (
                    <button key={p.label} type="button" aria-pressed={sameWeights(s.weights, p.w)} onClick={() => set({ weights: p.w })}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {LINK_KINDS.map((k) => {
                  const w = s.weights[k];
                  return (
                    <label key={k} className="conn__weight" title={`${KIND_INFO[k].hint} · ${w === 0 ? "zählt nicht" : KIND_INFO[k].unit(w)}`}>
                      <span className="conn__weight-name">
                        <i style={{ background: KIND_INFO[k].color }} aria-hidden="true" /> {KIND_INFO[k].label}
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
              </>,
            )}
            {sec(
              "filter",
              "Filter",
              [s.min ? `ab ${dec.format(s.min)} P.` : null, s.mutual ? "gegenseitig" : null, s.show !== "alle" ? SHOW.find((x) => x.key === s.show)!.label : null].filter(Boolean).join(" · ") || "keine",
              <>
                <label className="conn__weight" title="Schwächere Verbindungen ausblenden (auch für Distanz und Gruppen)">
                  <span className="conn__weight-name">Mindeststärke</span>
                  <input
                    type="range"
                    min={0}
                    max={minSteps.length - 1}
                    step={1}
                    value={Math.max(0, minSteps.findIndex((v) => v >= s.min))}
                    onChange={(e) => set({ min: minSteps[Number(e.target.value)] })}
                    aria-valuetext={s.min === 0 ? "alle" : `ab ${dec.format(s.min)} Punkten`}
                  />
                  <b className="num conn__weight-val">{s.min === 0 ? "alle" : `ab ${dec.format(s.min)} P.`}</b>
                </label>
                <Seg
                  label="Richtung der Verbindungen"
                  items={[
                    { key: "alle", label: "Alle", hint: "Auch einseitige Verbindungen" },
                    { key: "gegenseitig", label: "Nur gegenseitige", hint: "Nur, wenn beide etwas für den anderen tun: raiden sich, schreiben beieinander, nennen sich im Titel oder teilen einen Chat" },
                  ]}
                  value={s.mutual ? "gegenseitig" : "alle"}
                  onPick={(k) => set({ mutual: k === "gegenseitig" })}
                />
                <Seg label="Spieler" items={SHOW} value={s.show} onPick={(show) => set({ show })} />
                <p className="muted">
                  {num(counts.length)} von {num(activeCount)} Verbindungen · {num(linked)} Spieler
                </p>
              </>,
            )}
            {s.groups &&
              sec(
              "gruppen",
              "Gruppen",
              `${num(analysis.groups.length)} Gruppen`,
              <>
                <div className="gb__seg" role="group" aria-label="Einteilung">
                  <button type="button" aria-pressed={s.groupMode === "feinheit"} onClick={() => set({ groupMode: "feinheit", resolution })}>
                    Feinheit
                  </button>
                  <button type="button" aria-pressed={s.groupMode === "anzahl"} onClick={() => set({ groupMode: "anzahl", count: analysis.groups.length })}>
                    Anzahl
                  </button>
                </div>
                {s.groupMode === "feinheit" ? (
                  <label className="conn__weight" title="Höher = mehr, kleinere Gruppen">
                    <span className="conn__weight-name">Feinheit</span>
                    <input type="range" min={0} max={RES_STEPS} step={1} value={stepOfRes(s.resolution)} onChange={(e) => set({ resolution: resOfStep(Number(e.target.value)) })} aria-valuetext={dec.format(s.resolution)} />
                    <b className="num conn__weight-val">{dec.format(s.resolution)}</b>
                  </label>
                ) : (
                  <label className="conn__weight" title={`Gewünschte Zahl, so nah wie möglich (Feinheit ${dec.format(resolution)})`}>
                    <span className="conn__weight-name">Gruppen</span>
                    <input type="range" min={2} max={40} step={1} value={s.count} onChange={(e) => set({ count: Number(e.target.value) })} />
                    <b className="num conn__weight-val">{num(s.count)}</b>
                  </label>
                )}
                <p className="muted">
                  {num(analysis.groups.length)} Gruppen · größte {num(sizes[0] ?? 0)} Spieler · {num(sizes.filter((n) => n === 1).length)} allein{" "}
                  <Explain>Louvain: die Aufteilung, bei der möglichst viel Verbindungsstärke innerhalb der Gruppen liegt, benannt nach dem Mitglied mit der meisten Aufmerksamkeit. Sagt nichts über echte Freundschaften.</Explain>
                </p>
                {view === "netz" && !focus && (
                  <Seg
                    label="Darstellung"
                    items={[
                      { key: "alle", label: "Alle Spieler", hint: "Jeder Spieler auf der Fläche seiner Gruppe" },
                      { key: "karte", label: "Ein Kopf je Gruppe", hint: "Nur die Anführer, Linien = Verbindungen zwischen den Gruppen" },
                    ]}
                    value={s.groupMap ? "karte" : "alle"}
                    onPick={(k) => set({ groupMap: k === "karte" })}
                  />
                )}
              </>,
            )}
            {changed && (
              <button type="button" className="tag conn__reset" onClick={() => setS({ ...SETTINGS_DEFAULTS })}>
                Alle Einstellungen zurücksetzen
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
