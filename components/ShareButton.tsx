"use client";

import { useState } from "react";

/** Teilen über das System-Menü (Handy), sonst Adresse in die Zwischenablage */
export function ShareButton({ title }: { title: string }) {
  const [done, setDone] = useState(false);
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      /* abgebrochen oder nicht erlaubt */
    }
  };
  return (
    <button type="button" className="btn btn--small" data-tone="white" onClick={share}>
      {done ? "Link kopiert" : "Teilen"}
    </button>
  );
}
