"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";

const LONG = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const at = (d: string) => Date.parse(`${d}T12:00:00Z`);
const key = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Tag wählen, überall gleich: Vortag / Folgetag als Pfeile, dazwischen der Tag; ein Klick darauf klappt einen
 * Kalender auf, in dem nur Tage mit Daten anklickbar sind. Ziele kommen fertig vom Server (`hrefs`), damit andere
 * Parameter der Seite erhalten bleiben.
 */
export function DayPicker({
  hrefs,
  day,
  today,
  label = "Tag wählen",
}: {
  /** Wählbare Tage (YYYY-MM-DD) → Adresse */
  hrefs: Record<string, string>;
  day: string;
  /** Heute (YYYY-MM-DD), im Kalender umrandet */
  today?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const days = useMemo(() => Object.keys(hrefs).sort(), [hrefs]);
  const i = days.indexOf(day);
  const prev = i > 0 ? days[i - 1] : null;
  const next = i >= 0 && i < days.length - 1 ? days[i + 1] : null;

  // Monate vom ersten bis zum letzten wählbaren Tag, je als Wochen-Raster ab Montag
  const months = useMemo(() => {
    if (!days.length) return [];
    const out: { title: string; cells: (string | null)[] }[] = [];
    const [y0, m0] = days[0].split("-").map(Number);
    const [y1, m1] = days[days.length - 1].split("-").map(Number);
    for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
      const first = Date.UTC(y, m - 1, 1, 12);
      const len = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const lead = (new Date(first).getUTCDay() + 6) % 7;
      const cells: (string | null)[] = Array(lead).fill(null);
      for (let d = 0; d < len; d++) cells.push(key(first + d * 86_400_000));
      out.push({ title: MONTH.format(first), cells });
    }
    return out;
  }, [days]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const arrow = (d: string | null, dir: "prev" | "next") =>
    d ? (
      <Link className="daypick__arrow" href={hrefs[d]} scroll={false} aria-label={`${dir === "prev" ? "Vortag" : "Folgetag"}: ${LONG.format(at(d))}`} title={SHORT.format(at(d))}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d={dir === "prev" ? "M11 2L5 8l6 6" : "M5 2l6 6-6 6"} fill="none" stroke="currentColor" strokeWidth="3" />
        </svg>
      </Link>
    ) : (
      <span className="daypick__arrow" aria-hidden="true" data-off>
        <svg width="14" height="14" viewBox="0 0 16 16">
          <path d={dir === "prev" ? "M11 2L5 8l6 6" : "M5 2l6 6-6 6"} fill="none" stroke="currentColor" strokeWidth="3" />
        </svg>
      </span>
    );

  return (
    <div className="daypick" ref={box} role="group" aria-label={label}>
      {arrow(prev, "prev")}
      <button type="button" className="daypick__day" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 4h12v10H2zM2 7h12M5 2v3M11 2v3" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        {today && day === today ? `Heute, ${SHORT.format(at(day)).replace(/^\S+ /, "")}` : today && at(today) - at(day) === 86_400_000 ? `Gestern, ${SHORT.format(at(day)).replace(/^\S+ /, "")}` : LONG.format(at(day))}
      </button>
      {arrow(next, "next")}
      {open && (
        <div className="daypick__pop box" data-tone="white" id={id}>
          {months.map((mo) => (
            <div key={mo.title} className="daypick__month">
              <p className="eyebrow">{mo.title}</p>
              <div className="daypick__grid">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="daypick__wd" aria-hidden="true">
                    {w}
                  </span>
                ))}
                {mo.cells.map((d, n) =>
                  !d ? (
                    <span key={`x${n}`} />
                  ) : hrefs[d] ? (
                    <Link
                      key={d}
                      href={hrefs[d]}
                      scroll={false}
                      className="daypick__cell"
                      aria-current={d === day ? "date" : undefined}
                      data-today={d === today || undefined}
                      aria-label={LONG.format(at(d))}
                      onClick={() => setOpen(false)}
                    >
                      {Number(d.slice(8))}
                    </Link>
                  ) : (
                    <span key={d} className="daypick__cell" data-off data-today={d === today || undefined}>
                      {Number(d.slice(8))}
                    </span>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
