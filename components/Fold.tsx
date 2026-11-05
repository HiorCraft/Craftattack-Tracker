"use client";

import { useId, useSyncExternalStore, type ReactNode } from "react";

/**
 * Abschnitt mit Überschrift, den der Besucher ausblenden kann. Der Zustand bleibt im Browser gespeichert
 * (je `id`), damit Ausgeblendetes auch beim nächsten Besuch weg ist. Auf dem Server immer offen.
 */
const KEY = "ac.fold.v1";
const listeners = new Set<() => void>();

function readClosed(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function setClosed(id: string, closed: boolean) {
  const set = new Set(readClosed().split("|").filter(Boolean));
  if (closed) set.add(id);
  else set.delete(id);
  try {
    localStorage.setItem(KEY, [...set].join("|"));
  } catch {
    // ohne Speicher gilt die Wahl nur bis zum Neuladen nicht – dann bleibt es offen
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => e.key === KEY && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFolded(id: string): [boolean, (closed: boolean) => void] {
  const raw = useSyncExternalStore(subscribe, readClosed, () => "");
  const closed = raw.split("|").includes(id);
  return [closed, (c) => setClosed(id, c)];
}

export function Fold({
  id,
  title,
  titleId,
  aside,
  level = 2,
  className = "t-2",
  children,
}: {
  /** Eindeutiger Schlüssel, z. B. „profil.clips“ */
  id: string;
  title: ReactNode;
  titleId?: string;
  /** Rechts in der Kopfzeile (Links, Umschalter); bleibt auch eingeklappt sichtbar */
  aside?: ReactNode;
  level?: 2 | 3;
  className?: string;
  children: ReactNode;
}) {
  const [closed, setFold] = useFolded(id);
  const body = useId();
  const H = level === 2 ? "h2" : "h3";
  return (
    <>
      <div className="section-head fold__head" data-closed={closed || undefined}>
        <div className="fold__title">
          <H className={className} id={titleId}>
            {title}
          </H>
          <button type="button" className="fold__btn" aria-expanded={!closed} aria-controls={body} onClick={() => setFold(!closed)} title={closed ? "Einblenden" : "Ausblenden"}>
            <span aria-hidden="true">{closed ? "+" : "−"}</span>
            <span className="sr-only">{closed ? "einblenden" : "ausblenden"}</span>
          </button>
        </div>
        {aside}
      </div>
      <div id={body} hidden={closed}>
        {children}
      </div>
    </>
  );
}
