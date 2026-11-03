"use client";

import { useEffect, useState } from "react";

const clock = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

function rel(ms: number) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  return `um ${clock.format(Date.now() - ms)}`;
}

/**
 * Wie alt die angezeigten Daten sind („Stand: vor 3 Min.“), läuft im Browser mit. Seiten kommen aus einem kurzen
 * Zwischenspeicher, teure Auswertungen werden nur alle paar Minuten neu berechnet; das soll man sehen können.
 */
export function DataAge({ at, prefix = "Stand", hint }: { at: number; prefix?: string; hint?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  // Vor dem Hydrieren die Uhrzeit (gleich auf Server und Browser), danach relativ
  const text = now === null ? clock.format(at) : rel(Math.max(0, now - at));
  return (
    <span className="data-age" title={`${prefix}: ${clock.format(at)} Uhr${hint ? ` · ${hint}` : ""}`}>
      {prefix}: <time dateTime={new Date(at).toISOString()}>{text}</time>
    </span>
  );
}
