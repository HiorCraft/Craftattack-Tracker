"use client";

import { useEffect, useState } from "react";
import { fuzzyScore } from "@/lib/fuzzy";

/**
 * Unscharfe Suche über eine vom Server gerenderte Liste: Einträge mit `data-search` (Begriffe mit `|` getrennt) in
 * der Liste `targetId` werden ausgeblendet, wenn sie nicht passen, und die besten Treffer rücken nach vorn.
 */
export function ListSearch({ targetId, label, placeholder }: { targetId: string; label: string; placeholder: string }) {
  const [q, setQ] = useState("");
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const list = document.getElementById(targetId);
    if (!list) return;
    const items = [...list.querySelectorAll<HTMLElement>("[data-search]")];
    if (!q.trim()) {
      for (const el of items) {
        el.hidden = false;
        el.style.order = "";
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Anzeige der Trefferzahl folgt der DOM-Filterung
      setCount(null);
      return;
    }
    const scored = items.map((el) => ({ el, s: fuzzyScore(q, (el.dataset.search ?? "").split("|")) })).sort((a, b) => b.s - a.s);
    scored.forEach(({ el, s }, i) => {
      el.hidden = s === 0;
      el.style.order = String(i);
    });
    setCount(scored.filter((x) => x.s > 0).length);
  }, [q, targetId]);
  return (
    <div className="psearch psearch--list">
      <span className="psearch__field">
        <input type="search" aria-label={label} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-controls={targetId} autoComplete="off" />
      </span>
      {count !== null && <span className="muted num" role="status">{count === 0 ? "Niemand gefunden" : `${count} Treffer`}</span>}
    </div>
  );
}
