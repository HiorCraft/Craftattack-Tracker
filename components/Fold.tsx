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

const noop = () => () => {};

/**
 * Vor dem ersten Paint: eingeklappte Abschnitte sofort verbergen. Sonst zeigt die Seite sie beim Laden (der Server
 * kennt die Wahl nicht) und blendet sie erst nach dem Hydrieren aus, was wie ein Fehler aussieht. Die Regel gilt nur,
 * solange der Abschnitt noch nicht hydriert ist (`data-live` fehlt); danach entscheidet React.
 */
export function FoldScript() {
  const js = `try{var c=(localStorage.getItem(${JSON.stringify(KEY)})||"").split("|").filter(Boolean);if(c.length){var s=document.createElement("style");s.textContent=c.map(function(i){i=JSON.stringify(i);return".fold__body[data-fold="+i+"]:not([data-live]){display:none}"}).join("");document.head.appendChild(s)}}catch(e){}`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
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
  const live = useSyncExternalStore(noop, () => true, () => false);
  const body = useId();
  const H = level === 2 ? "h2" : "h3";
  return (
    <>
      <div className="section-head fold__head" data-closed={closed || undefined}>
        <H className={className} id={titleId}>
          {title}
        </H>
        <div className="fold__side">
          {aside}
          <button type="button" className="fold__btn" aria-expanded={!closed} aria-controls={body} onClick={() => setFold(!closed)} title={closed ? "Abschnitt wieder einblenden" : "Abschnitt ausblenden"}>
            {closed ? "Einblenden" : <span className="sr-only">Ausblenden</span>}
            <span aria-hidden="true">{closed ? "+" : "−"}</span>
          </button>
        </div>
      </div>
      <div id={body} className="fold__body" data-fold={id} data-live={live || undefined} hidden={closed}>
        {children}
      </div>
    </>
  );
}
