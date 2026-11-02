"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Lange Inhalte (Verlauf, Listen) erst gekürzt zeigen: bis `height` Pixel, darunter „Mehr zeigen“ (je Klick
 * `height` mehr) und „Alle“. Ohne JavaScript bzw. vor dem Messen ist alles sichtbar.
 */
export function ShowMore({ height = 900, label = "Einträge", children }: { height?: number; label?: string; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(0);
  const [limit, setLimit] = useState(height);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFull(el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clipped = full > 0 && full > limit + 120;
  return (
    <div className="more">
      <div className="more__body" data-clipped={clipped || undefined} style={clipped ? { maxHeight: limit } : undefined}>
        <div ref={inner}>{children}</div>
      </div>
      {clipped && (
        <div className="more__bar">
          <button type="button" className="btn btn--small" data-tone="white" onClick={() => setLimit((l) => l + height)}>
            Mehr {label}
          </button>
          <button type="button" className="more__all" onClick={() => setLimit(Infinity)}>
            Alle zeigen
          </button>
        </div>
      )}
      {!clipped && limit > height && full > 0 && (
        <div className="more__bar">
          <button type="button" className="more__all" onClick={() => setLimit(height)}>
            Weniger zeigen
          </button>
        </div>
      )}
    </div>
  );
}
