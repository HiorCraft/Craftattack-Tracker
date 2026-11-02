"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Erklärung erst auf Klick: kleines „?“, der Text öffnet sich als Kasten darunter. Nur Inline-Elemente
 * (<span>, <button>), damit es auch in Absätzen und Überschriften gültiges HTML bleibt.
 */
export function Explain({ children, label = "Erklärung" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="explain" ref={ref}>
      <button type="button" className="explain__btn" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      {open && (
        <span className="explain__box" role="note">
          {children}
        </span>
      )}
    </span>
  );
}
