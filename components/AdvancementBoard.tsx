"use client";

import { useState } from "react";
import { ADVANCEMENTS, ADV_CATEGORIES, type AdvCategory, type AdvFrame } from "@/lib/advancements";

interface Status {
  at?: number;
  guess?: string;
}

const date = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const pct = (x: number) => `${Math.round(x * 100)} %`;
const FRAME_LABEL: Record<AdvFrame, string> = { task: "Fortschritt", goal: "Ziel", challenge: "Aufgabe" };

/** Rahmen wie im Spiel: Fortschritt eckig, Ziel abgerundet, Aufgabe gezackt */
function Frame({ frame }: { frame: AdvFrame }) {
  return (
    <svg className="adv__frame" viewBox="0 0 32 32" aria-hidden="true">
      {frame === "task" && <rect x="3" y="3" width="26" height="26" rx="2" />}
      {frame === "goal" && <rect x="3" y="5" width="26" height="22" rx="11" />}
      {frame === "challenge" && <path d="M16 1 20 7 27 5 25 12 31 16 25 20 27 27 20 25 16 31 12 25 5 27 7 20 1 16 7 12 5 5 12 7Z" />}
      <path className="adv__check" d="M10 16.5 14 20.5 22 11.5" />
    </svg>
  );
}

type Filter = "alle" | "erzielt" | "fehlt";

/**
 * Fortschritte eines Spielers wie im Spiel nach Kategorien: gemeldet (mit Datum), vermutet (gestrichelt, mit Grund)
 * oder fehlend; dazu, wie viele andere Spieler ihn haben.
 */
export function AdvancementBoard({ mine, others, players }: { mine: Record<string, Status>; others: Record<string, [number, number]>; players: number }) {
  const [cat, setCat] = useState<AdvCategory>("story");
  const [filter, setFilter] = useState<Filter>("alle");
  const total = ADVANCEMENTS.length;
  const done = ADVANCEMENTS.filter((a) => mine[a.id]?.at).length;
  const guessed = ADVANCEMENTS.filter((a) => mine[a.id]?.guess).length;
  const shown = ADVANCEMENTS.filter((a) => a.cat === cat).filter((a) => (filter === "alle" ? true : filter === "erzielt" ? Boolean(mine[a.id]) : !mine[a.id]));

  return (
    <div className="adv">
      <div className="adv__summary">
        <p>
          <b className="adv__big num">{done + guessed}</b> <span className="muted">von {total}</span>
          <span className="adv__legend">
            <i className="adv__sw adv__sw--done" /> {done} gemeldet <i className="adv__sw adv__sw--guess" /> {guessed} vermutet
          </span>
        </p>
        <span className="adv__bar" aria-hidden="true">
          <i className="adv__bar-done" style={{ width: `${(100 * done) / total}%` }} />
          <i className="adv__bar-guess" style={{ width: `${(100 * guessed) / total}%` }} />
        </span>
      </div>

      <div className="adv__controls">
        <div className="gb__seg" role="group" aria-label="Kategorie">
          {ADV_CATEGORIES.map((c) => {
            const list = ADVANCEMENTS.filter((a) => a.cat === c.key);
            const n = list.filter((a) => mine[a.id]).length;
            return (
              <button key={c.key} type="button" aria-pressed={cat === c.key} onClick={() => setCat(c.key)}>
                {c.label} <span className="adv__count">{n}/{list.length}</span>
              </button>
            );
          })}
        </div>
        <div className="gb__seg" role="group" aria-label="Filter">
          {(["alle", "erzielt", "fehlt"] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "alle" ? "Alle" : f === "erzielt" ? "Erzielt" : "Fehlt"}
            </button>
          ))}
        </div>
      </div>

      <ul className="adv__grid">
        {shown.map((a) => {
          const s = mine[a.id];
          const state = s?.at ? "done" : s?.guess ? "guess" : "open";
          const [rep, gue] = others[a.id] ?? [0, 0];
          const share = players ? (rep + gue) / players : 0;
          return (
            <li key={a.id} className={`adv__card adv__card--${state} adv__card--${a.frame}`} title={a.desc}>
              <Frame frame={a.frame} />
              <div className="adv__text">
                <b>{a.title}</b>
                <span className="adv__desc">{a.desc}</span>
                <span className="adv__meta">
                  {state === "done" && date.format(s!.at!)}
                  {state === "guess" && <>vermutet: {s!.guess}</>}
                  {state === "open" && (a.frame === "task" ? "noch nicht gesehen" : `${FRAME_LABEL[a.frame]}, noch nicht gesehen`)}
                </span>
              </div>
              <span className="adv__others" title={`${rep} Spieler gemeldet, ${gue} vermutet, von ${players}`}>
                <span className="num">{pct(share)}</span>
                <span className="adv__obar" aria-hidden="true">
                  <i style={{ width: `${(100 * rep) / Math.max(1, players)}%` }} />
                  <i className="adv__obar-guess" style={{ width: `${(100 * gue) / Math.max(1, players)}%` }} />
                </span>
                <span className="adv__onum">{rep + gue} Spieler</span>
              </span>
            </li>
          );
        })}
        {shown.length === 0 && <li className="muted">Nichts in dieser Auswahl.</li>}
      </ul>
    </div>
  );
}
