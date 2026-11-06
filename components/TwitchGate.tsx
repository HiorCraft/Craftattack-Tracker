"use client";

import Link from "next/link";
import { useId, useState, useSyncExternalStore } from "react";

const KEY = "ac-twitch-consent";
const EVENT = "ac-twitch-consent";

/* Gemerkte Zustimmung in localStorage; das eigene Event hält mehrere Einbettungen im selben Tab synchron. */
function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

function setRemembered(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Zwei-Klick-Lösung: Bis zur Zustimmung lädt nichts von Twitch, auch kein Vorschaubild.
 * Auf dem Server und vor der Hydration ist immer der Platzhalter zu sehen.
 */
export function TwitchGate({ name, playerSrc, chatSrc }: { name: string; playerSrc: string; chatSrc: string }) {
  const stored = useSyncExternalStore(subscribe, remembered, () => false);
  const [now, setNow] = useState(false);
  const [remember, setRemember] = useState(false);
  const checkId = useId();

  if (!stored && !now) {
    return (
      <div className="twitch">
        <div className="box twitch__gate" data-tone="white">
          <p className="twitch__gate-title">Stream von {name} laden?</p>
          <p>
            Beim Laden verbindet sich dein Browser mit Twitch (USA). Twitch erhält dabei unter anderem deine IP-Adresse und kann Cookies setzen. Mehr in der{" "}
            <Link href="/datenschutz#plugins">Datenschutzerklärung</Link>.
          </p>
          <div className="twitch__gate-actions">
            <button
              type="button"
              className="btn btn--small"
              data-tone="twitch"
              onClick={() => {
                if (remember) setRemembered(true);
                setNow(true);
              }}
            >
              Stream und Chat laden
            </button>
            <label htmlFor={checkId}>
              <input id={checkId} type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Twitch künftig immer laden
            </label>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="twitch">
        <div className="box twitch__player" data-tone="white">
          <iframe src={playerSrc} title={`Stream von ${name}`} allowFullScreen allow="autoplay; fullscreen; picture-in-picture" />
        </div>
        <div className="box twitch__chat" data-tone="white">
          <iframe src={chatSrc} title={`Chat von ${name}`} />
        </div>
      </div>
      {stored && (
        <p className="muted" style={{ marginTop: 8, fontSize: ".9375rem" }}>
          Twitch wird bei dir automatisch geladen.{" "}
          <button type="button" className="twitch__revoke" onClick={() => setRemembered(false)}>
            Zustimmung widerrufen
          </button>
        </p>
      )}
    </>
  );
}
