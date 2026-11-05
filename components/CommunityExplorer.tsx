"use client";

import { useEffect, useMemo, useState } from "react";
import { ConnectionExplorer } from "./ConnectionExplorer";
import { NetworkLab } from "./NetworkLab";
import { GroupsOverview } from "./GroupViews";
import { FigValue } from "./FigValue";
import type { GraphNode } from "./ConnectionGraph";
import { sumDays, type DailyNetwork } from "@/lib/dailyNetwork";
import { DEFAULT_WEIGHTS } from "@/lib/connectionWeights";
import { analyzeGroups } from "@/lib/groups";
import { num } from "@/lib/format";

export type CommunityView = "netz" | "naehe" | "gruppen";
const VIEWS: { key: CommunityView; label: string; hint: string }[] = [
  { key: "netz", label: "Netz", hint: "Alle Verbindungen als Netz, mit Gewichtung und Rangliste" },
  { key: "naehe", label: "Nähe", hint: "Ein Spieler in der Mitte, alle anderen nach ihrer Nähe zu ihm" },
  { key: "gruppen", label: "Gruppen", hint: "Wer untereinander deutlich enger verbunden ist als mit dem Rest" },
];

type Win = "gesamt" | "7" | "1";
const WINDOWS: { key: Win; label: string; hint: string }[] = [
  { key: "gesamt", label: "Bis dahin", hint: "Alles vom Staffelstart bis zum gewählten Tag" },
  { key: "7", label: "7 Tage", hint: "Die sieben Tage bis zum gewählten Tag" },
  { key: "1", label: "Nur der Tag", hint: "Nur der gewählte Tag" },
];

const DAY = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
const dayLabel = (d: string) => DAY.format(Date.parse(`${d}T12:00:00Z`));

/**
 * Netz, Nähe und Gruppen auf einer Seite: dieselben Daten (Tagesnetz), oben gemeinsam Ansicht, Zeitraum und
 * „Nur auf dem Server“, darunter Kennzahlen und die gewählte Ansicht mit ihren Daten. Ansicht, Filter und Mitte
 * stehen in der Adresse (teilbar), ohne die Seite neu zu laden.
 */
export function CommunityExplorer({
  nodes,
  daily,
  dailyServer,
  initialView,
  initialServer,
  initialFocus,
}: {
  nodes: GraphNode[];
  daily: DailyNetwork;
  dailyServer: DailyNetwork;
  initialView: CommunityView;
  initialServer: boolean;
  initialFocus: string;
}) {
  const [view, setView] = useState<CommunityView>(initialView);
  const [server, setServer] = useState(initialServer);
  const data = server ? dailyServer : daily;
  const last = data.days.length - 1;
  const [toRaw, setTo] = useState<number | null>(null);
  const to = toRaw === null ? last : Math.min(toRaw, last);
  const [win, setWin] = useState<Win>("gesamt");
  const [playing, setPlaying] = useState(false);
  const from = win === "gesamt" ? 0 : Math.max(0, to - (win === "7" ? 6 : 0));
  const edges = useMemo(() => (last < 0 ? [] : sumDays(data, from, to)), [data, from, to, last]);

  // Gruppenfarben aus der ganzen Staffel, damit Gruppen beim Durchspielen ihre Farbe behalten
  const anchorColor = useMemo(() => {
    const season = analyzeGroups(last < 0 ? [] : sumDays(data, 0, last), DEFAULT_WEIGHTS);
    const color = new Map<string, string>();
    for (const g of season.groups) for (const m of g.members) color.set(m.id, g.color);
    return (id: string) => color.get(id) ?? null;
  }, [data, last]);

  // Ansicht und Filter in der Adresse halten (Mitte setzt die Nähe-Ansicht selbst)
  useEffect(() => {
    const u = new URL(window.location.href);
    if (view === "netz") u.searchParams.delete("ansicht");
    else u.searchParams.set("ansicht", view);
    if (server) u.searchParams.set("server", "1");
    else u.searchParams.delete("server");
    window.history.replaceState(window.history.state, "", u);
  }, [view, server]);

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

  const raids = edges.reduce((s, e) => s + e.raidsAB + e.raidsBA, 0);
  const chats = edges.reduce((s, e) => s + e.chats, 0);
  const msgs = edges.reduce((s, e) => s + e.msgsAB + e.msgsBA, 0);
  const titleHours = Math.round(edges.reduce((s, e) => s + e.titleAB + e.titleBA, 0) / 3600);
  const linked = new Set(edges.flatMap((e) => [e.a, e.b])).size;

  return (
    <div className="stack" style={{ "--stack": "16px" } as React.CSSProperties}>
      <div className="box comm__bar" data-tone="white">
        <div className="gb__seg comm__views" role="tablist" aria-label="Ansicht">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} title={v.hint} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="gb__seg" role="group" aria-label="Welche Verbindungen">
          <button type="button" aria-pressed={!server} onClick={() => setServer(false)} title="Alles, was auf Twitch zwischen Spielern passiert ist">
            Alle Verbindungen
          </button>
          <button
            type="button"
            aria-pressed={server}
            onClick={() => setServer(true)}
            title="Nur, während mindestens einer der beiden auf dem Server war: Raids und Nachrichten zu dem Zeitpunkt, geteilter Chat und Titel nur für diese Zeit"
          >
            Nur auf dem Server
          </button>
        </div>
        {last >= 0 && (
          <div className="grp__time comm__time" role="group" aria-label="Zeitraum">
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
            <b className="num grp__time-day">{from === to ? dayLabel(data.days[to]) : `${dayLabel(data.days[from])} – ${dayLabel(data.days[to])}`}</b>
            <div className="gb__seg" role="group" aria-label="Zeitfenster">
              {WINDOWS.map((w) => (
                <button key={w.key} type="button" aria-pressed={win === w.key} title={w.hint} onClick={() => setWin(w.key)}>
                  {w.label}
                </button>
              ))}
            </div>
            {to !== last && (
              <button type="button" className="more__all" onClick={() => (setPlaying(false), setTo(null))}>
                Heute
              </button>
            )}
          </div>
        )}
      </div>

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
          <FigValue>{num(edges.length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="sky">
          <dt>Spieler im Netz</dt>
          <FigValue>{num(linked)}</FigValue>
        </div>
      </dl>

      {last < 0 ? (
        <p className="muted">Noch keine Verbindungen erfasst.</p>
      ) : view === "netz" ? (
        <ConnectionExplorer nodes={nodes} edges={edges} />
      ) : view === "naehe" ? (
        <NetworkLab nodes={nodes} edges={edges} initialFocus={initialFocus} />
      ) : (
        <GroupsOverview nodes={nodes} edges={edges} anchorColor={anchorColor} />
      )}
    </div>
  );
}
