"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Erklärung erst auf Klick: kleines „?“, der Text öffnet sich als Kasten darunter. Nur Inline-Elemente
 * (<span>, <button>), damit es auch in Absätzen und Überschriften gültiges HTML bleibt.
 */
export function Explain({ children, label = "Erklärung" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  // Nie aus dem Fenster ragen: ragt der Kasten rechts hinaus, rückt er nach links (8 px Abstand zum Rand)
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const over = r.right - (document.documentElement.clientWidth - 8);
    setShift(over > 0 ? Math.min(over, Math.max(0, r.left - 8)) : 0);
  }, [open]);
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
        <span className="explain__box" role="note" ref={box} style={shift ? { transform: `translateX(-${shift}px)` } : undefined}>
          {children}
        </span>
      )}
    </span>
  );
}
