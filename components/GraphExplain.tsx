"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Head } from "./Head";
import { BASE_PATH } from "@/lib/estimateMode";
import { EVENT_META, eventBadge } from "@/lib/events";
import type { TrackerEvent } from "@/lib/types";

interface Result {
  from: string;
  to: string;
  contributions: { id: string; name: string; uuid: string; delta: number }[];
  events: TrackerEvent[];
}

export interface ExplainTarget {
  from: number;
  to: number;
}

const tf = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const hm = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

/**
 * Was steckt hinter einer Veränderung im Graphen? Je Kennzahl die Beiträge der Spieler (größte zuerst, als Balken)
 * und die passenden Ereignisse im gewählten Zeitraum.
 */
export function GraphExplain({
  target,
  metrics,
  players,
  onClose,
}: {
  target: ExplainTarget;
  metrics: { metric: string; label: string; format: (v: number) => string; color: string }[];
  players: string[];
  onClose: () => void;
}) {
  const key = `${target.from}-${target.to}-${metrics.map((m) => m.metric).join(",")}-${players.join(",")}`;
  // Ergebnisse gehören zu einer Anfrage (key); ältere gelten nicht mehr, ohne den Zustand im Effekt zu leeren
  const [store, setStore] = useState<{ key: string; byMetric: Record<string, Result | "error"> }>({ key: "", byMetric: {} });
  const data = store.key === key ? store.byMetric : {};
  useEffect(() => {
    let off = false;
    const put = (metric: string, v: Result | "error") => setStore((s) => ({ key, byMetric: { ...(s.key === key ? s.byMetric : {}), [metric]: v } }));
    for (const m of metrics) {
      const p = new URLSearchParams({ metric: m.metric, von: String(Math.round(target.from)), bis: String(Math.round(target.to)) });
      if (players.length) p.set("spieler", players.join(","));
      fetch(`${BASE_PATH}/api/series/explain?${p}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: Result) => !off && put(m.metric, j))
        .catch(() => !off && put(m.metric, "error"));
    }
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key fasst Zeitraum, Kennzahlen und Spieler zusammen
  }, [key]);

  const sameDay = new Date(target.from).toDateString() === new Date(target.to).toDateString();
  return (
    <section className="box gx" data-tone="white" aria-label="Erklärung der Veränderung">
      <header className="gx__head">
        <h3 className="t-3">
          Was ist passiert? <span className="muted">{tf.format(target.from)} – {sameDay ? hm.format(target.to) : tf.format(target.to)}</span>
        </h3>
        <button type="button" className="tag" onClick={onClose} aria-label="Erklärung schließen">
          ✕
        </button>
      </header>
      <div className="gx__grid">
        {metrics.map((m) => {
          const r = data[m.metric];
          const total = r && r !== "error" ? r.contributions.reduce((s, c) => s + c.delta, 0) : 0;
          const max = r && r !== "error" ? Math.max(1, ...r.contributions.map((c) => Math.abs(c.delta))) : 1;
          return (
            <div key={m.metric} className="gx__metric">
              <p className="gx__title">
                <i style={{ background: m.color }} aria-hidden="true" /> <b>{m.label}</b>
                {r && r !== "error" && r.contributions.length > 0 && (
                  <span className="num muted">
                    {" "}
                    {total > 0 ? "+" : ""}
                    {m.format(total)} durch die Größten
                  </span>
                )}
              </p>
              {!r ? (
                <p className="muted">Lädt …</p>
              ) : r === "error" ? (
                <p className="muted">Konnte nicht geladen werden.</p>
              ) : (
                <>
                  {r.contributions.length === 0 ? (
                    <p className="muted">Keine Veränderung durch einzelne Spieler erkennbar.</p>
                  ) : (
                    <ol className="gx__list">
                      {r.contributions.map((c) => (
                        <li key={c.id}>
                          <Link href={`/spieler/${encodeURIComponent(c.id)}`} className="gx__who">
                            <Head id={c.id} uuid={c.uuid} name={c.name} size={20} src={32} decorative /> {c.name}
                          </Link>
                          <span className="gx__bar" aria-hidden="true">
                            <i data-neg={c.delta < 0 || undefined} style={{ width: `${(Math.abs(c.delta) / max) * 100}%`, background: m.color }} />
                          </span>
                          <span className="num gx__val">
                            {c.delta > 0 ? "+" : "−"}
                            {m.format(Math.abs(c.delta))}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {r.events.length > 0 && (
                    <ul className="gx__events">
                      {r.events.map((e) => {
                        const meta = EVENT_META[e.type];
                        const badge = eventBadge(e);
                        return (
                          <li key={e.id}>
                            <span className="num muted">{hm.format(Date.parse(e.at))}</span> <b>{e.playerName ?? e.player ?? ""}</b> {meta?.text(e) ?? e.type}
                            {badge && <span className="num muted"> · {badge}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
