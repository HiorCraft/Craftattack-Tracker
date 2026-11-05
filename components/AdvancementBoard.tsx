"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { preload } from "react-dom";
import { ADVANCEMENTS, ADV_CATEGORIES, type AdvCategory, type Advancement } from "@/lib/advancements";
import { BASE_PATH } from "@/lib/estimateMode";

interface Status {
  at?: number;
  guess?: string;
}

const date = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const FRAME_LABEL = { task: "Fortschritt", goal: "Ziel", challenge: "Aufgabe" } as const;
const BG: Record<AdvCategory, string> = { story: "stone", nether: "nether", end: "end", adventure: "adventure", husbandry: "husbandry" };

/** Wie im Spiel bei GUI-Größe 2: Rahmen 26 px → 52 px, Symbol 16 px → 32 px, Abstände 28 × 27 → 56 × 54 */
const SCALE = 2;
const COL = 28 * SCALE;
const ROW = 27 * SCALE;
const NODE = 26 * SCALE;
const PAD = 12 * SCALE;
/** Sprite public/adv/icons.png: 16 Spalten, 64-px-Felder (Blöcke als Würfel wie im Inventar), angezeigt in 32 px */
const SPRITE_COLS = 16;

interface Placed {
  a: Advancement;
  x: number;
  y: number;
}

/** Baum je Kategorie: Tiefe nach rechts, Blätter untereinander, Eltern mittig zu ihren Kindern */
function layout(cat: AdvCategory): { nodes: Placed[]; width: number; height: number } {
  const list = ADVANCEMENTS.filter((a) => a.cat === cat);
  const kids = new Map<string, Advancement[]>();
  for (const a of list) if (a.parent) (kids.get(a.parent) ?? kids.set(a.parent, []).get(a.parent)!).push(a);
  const row = new Map<string, number>();
  let next = 0;
  const place = (a: Advancement): number => {
    const ch = kids.get(a.id) ?? [];
    if (!ch.length) {
      row.set(a.id, next++);
      return row.get(a.id)!;
    }
    const rs = ch.map(place);
    const r = (rs[0] + rs[rs.length - 1]) / 2;
    row.set(a.id, r);
    return r;
  };
  for (const root of list.filter((a) => !a.parent)) place(root);
  const nodes = list.map((a) => ({ a, x: PAD + a.depth * COL, y: PAD + (row.get(a.id) ?? 0) * ROW }));
  const width = Math.max(...nodes.map((n) => n.x)) + NODE + PAD;
  const height = Math.max(...nodes.map((n) => n.y)) + NODE + PAD;
  return { nodes, width, height };
}

function Icon({ index, size = 32 }: { index: number; size?: number }) {
  const f = size / 16;
  return (
    <span
      className="advt__icon"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${BASE_PATH}/adv/icons.png)`,
        backgroundSize: `${SPRITE_COLS * 16 * f}px auto`,
        backgroundPosition: `-${(index % SPRITE_COLS) * size}px -${Math.floor(index / SPRITE_COLS) * size}px`,
      }}
    />
  );
}

/**
 * Fortschritte wie im Spiel: Reiter je Kategorie, Baum mit Original-Rahmen und -Symbolen auf dem Reiter-Hintergrund.
 * Gold = gemeldet, gold mit „?“ = vermutet, grau = noch nicht gesehen. Text nur im Tooltip (Zeigen oder Tippen).
 * Die Fläche lässt sich wie im Spiel mit der Maus ziehen.
 */
export function AdvancementBoard({ mine, others, players }: { mine: Record<string, Status>; others: Record<string, [number, number]>; players: number }) {
  const [cat, setCatState] = useState<AdvCategory>("story");
  // Gewählten Reiter über Neuladen hinweg behalten (z. B. wenn eine neue Version der Website kommt)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("ac.adv.tab") as AdvCategory | null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- gespeicherte Auswahl erst nach dem Hydrieren lesen
      if (saved && ADV_CATEGORIES.some((c) => c.key === saved)) setCatState(saved);
    } catch {}
  }, []);
  const setCat = (c: AdvCategory) => {
    setCatState(c);
    try {
      sessionStorage.setItem("ac.adv.tab", c);
    } catch {}
  };
  const [tip, setTip] = useState<{ id: string; pinned: boolean } | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const { nodes, width, height } = useMemo(() => layout(cat), [cat]);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.a.id, n])), [nodes]);
  const total = ADVANCEMENTS.length;
  const done = ADVANCEMENTS.filter((a) => mine[a.id]?.at).length;
  const guessed = ADVANCEMENTS.filter((a) => mine[a.id]?.guess).length;
  const tipNode = tip ? pos.get(tip.id) : undefined;
  // Alle Rahmen und Hintergründe vorab laden, sonst fehlen sie beim ersten Umschalten kurz
  for (const f of ["task", "goal", "challenge"]) for (const st of ["obtained", "unobtained"]) preload(`${BASE_PATH}/adv/${f}-${st}.png`, { as: "image" });
  for (const b of Object.values(BG)) preload(`${BASE_PATH}/adv/bg-${b}.png`, { as: "image" });
  preload(`${BASE_PATH}/adv/icons.png`, { as: "image" });
  // Wie im Spiel: die Wurzel der Kategorie im Blick (senkrecht mittig)
  useEffect(() => {
    const v = view.current;
    const root = nodes.find((n) => !n.a.parent);
    if (v && root) v.scrollTo({ left: 0, top: Math.max(0, root.y + NODE / 2 - v.clientHeight / 2) });
  }, [nodes]);

  // Verbindungen wie im Spiel: waagerecht aus dem Elternteil, senkrecht, waagerecht ins Kind
  const lines = nodes
    .filter((n) => n.a.parent && pos.has(n.a.parent))
    .map((n) => {
      const p = pos.get(n.a.parent!)!;
      const x1 = p.x + NODE / 2;
      const y1 = p.y + NODE / 2;
      const x2 = n.x + NODE / 2;
      const y2 = n.y + NODE / 2;
      const mx = x2 - COL / 2;
      return { id: n.a.id, d: `M${x1} ${y1}H${mx}V${y2}H${x2}`, on: Boolean(mine[n.a.id]) };
    });

  return (
    <div className="advt">
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

      <div className="advt__tabs" role="group" aria-label="Kategorie">
        {ADV_CATEGORIES.map((c) => {
          const list = ADVANCEMENTS.filter((a) => a.cat === c.key);
          const root = list.find((a) => !a.parent)!;
          const n = list.filter((a) => mine[a.id]).length;
          return (
            <button
              key={c.key}
              type="button"
              className="advt__tab"
              aria-pressed={cat === c.key}
              title={`${c.label}: ${n} von ${list.length}`}
              onClick={() => {
                setCat(c.key);
                setTip(null);
              }}
            >
              <Icon index={root.icon} />
              <span className="advt__tabcount">
                {n}/{list.length}
              </span>
            </button>
          );
        })}
      </div>

      <div
        ref={view}
        className="advt__view"
        style={{ backgroundImage: `url(${BASE_PATH}/adv/bg-${BG[cat]}.png)`, maxHeight: Math.min(height + 4, 560) }}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse" || !view.current) return;
          drag.current = { x: e.clientX, y: e.clientY, sl: view.current.scrollLeft, st: view.current.scrollTop, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || !view.current) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          view.current.scrollLeft = d.sl - dx;
          view.current.scrollTop = d.st - dy;
        }}
        onPointerUp={() => setTimeout(() => (drag.current = null), 0)}
        onPointerLeave={() => (drag.current = null)}
      >
        <div className="advt__canvas" style={{ width, height }}>
          <svg className="advt__lines" width={width} height={height} aria-hidden="true">
            {lines.map((l) => (
              <path key={`o${l.id}`} d={l.d} className="advt__line-outer" />
            ))}
            {lines.map((l) => (
              <path key={`i${l.id}`} d={l.d} className={l.on ? "advt__line-inner advt__line-inner--on" : "advt__line-inner"} />
            ))}
          </svg>
          {nodes.map(({ a, x, y }) => {
            const s = mine[a.id];
            const state = s?.at ? "done" : s?.guess ? "guess" : "open";
            return (
              <button
                key={a.id}
                type="button"
                className={`advt__node advt__node--${state}`}
                style={{ left: x, top: y, width: NODE, height: NODE, backgroundImage: `url(${BASE_PATH}/adv/${a.frame}-${state === "open" ? "unobtained" : "obtained"}.png)` }}
                aria-label={`${a.title}: ${state === "done" ? "erzielt" : state === "guess" ? "vermutlich erzielt" : "nicht gesehen"}`}
                aria-describedby={tip?.id === a.id ? "advt-tip" : undefined}
                onPointerEnter={(e) => e.pointerType === "mouse" && !tip?.pinned && setTip({ id: a.id, pinned: false })}
                onPointerLeave={(e) => e.pointerType === "mouse" && !tip?.pinned && setTip(null)}
                onFocus={() => setTip({ id: a.id, pinned: false })}
                onBlur={() => setTip((t) => (t?.pinned ? t : null))}
                onClick={() => {
                  if (drag.current?.moved) return;
                  setTip((t) => (t?.id === a.id && t.pinned ? null : { id: a.id, pinned: true }));
                }}
              >
                <Icon index={a.icon} />
                {state === "guess" && <span className="advt__q">?</span>}
              </button>
            );
          })}
          {tipNode && (
            <Tip
              a={tipNode.a}
              s={mine[tipNode.a.id]}
              share={others[tipNode.a.id] ?? [0, 0]}
              players={players}
              x={tipNode.x}
              y={tipNode.y}
              flip={tipNode.x + NODE + 300 > width && tipNode.x > 300}
            />
          )}
        </div>
      </div>
      <p className="muted advt__note">Ziehen zum Verschieben, Zeigen oder Tippen für Details. Grafiken aus Minecraft © Mojang, keine offizielle Seite.</p>
    </div>
  );
}

function Tip({ a, s, share, players, x, y, flip }: { a: Advancement; s?: Status; share: [number, number]; players: number; x: number; y: number; flip: boolean }) {
  const state = s?.at ? "done" : s?.guess ? "guess" : "open";
  const [rep, gue] = share;
  return (
    <div id="advt-tip" role="tooltip" className={`advt__tip advt__tip--${state}`} style={flip ? { right: `calc(100% - ${x}px + 6px)`, top: y } : { left: x + NODE + 6, top: y }}>
      <b className="advt__tiphead">{a.title}</b>
      <span>{a.desc}</span>
      <span className="advt__tipmeta">
        {state === "done" && <>Erzielt am {date.format(s!.at!)}</>}
        {state === "guess" && <>Vermutlich erzielt: {s!.guess}</>}
        {state === "open" && <>Noch nicht gesehen</>} · {FRAME_LABEL[a.frame]}
      </span>
      <span className="advt__tipmeta">
        {players ? Math.round((100 * (rep + gue)) / players) : 0} % der Spieler ({rep + gue} von {players}
        {gue ? `, davon ${gue} vermutet` : ""})
      </span>
    </div>
  );
}
