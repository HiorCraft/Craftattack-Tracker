"use client";

import { useEffect, useRef } from "react";

/**
 * Ein gemeinsamer Tooltip für alle Spielerköpfe (`[data-name]`, siehe `Head`): erscheint sofort beim Überfahren
 * oder Fokussieren (auch eines Links mit Kopf darin). Fest am Bildschirm positioniert, damit ihn keine Kachel
 * mit `overflow: hidden` abschneidet.
 */
export function HeadTip() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let current: Element | null = null;

    const hide = () => {
      current = null;
      tip.hidden = true;
    };
    const show = (el: Element) => {
      const name = el.getAttribute("data-name");
      if (!name) return hide();
      current = el;
      tip.textContent = name;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const half = tip.offsetWidth / 2;
      const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
      // Passt er nicht über den Kopf, darunter anzeigen
      const below = r.top < tip.offsetHeight + 12;
      tip.style.left = `${x}px`;
      tip.style.top = `${below ? r.bottom + 6 : r.top - 6}px`;
      tip.dataset.below = below ? "true" : "false";
    };
    const target = (node: EventTarget | null): Element | null => {
      if (!(node instanceof Element)) return null;
      return node.closest("[data-name]") ?? (node.matches("a, button") ? node.querySelector("[data-name]") : null);
    };
    const onOver = (e: Event) => {
      const el = target(e.target);
      if (el) show(el);
      else if (current) hide();
    };
    const onOut = (e: PointerEvent | FocusEvent) => {
      if (current && !(e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onOver);
    document.addEventListener("focusout", onOut);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onOver);
      document.removeEventListener("focusout", onOut);
      window.removeEventListener("scroll", hide, { capture: true });
    };
  }, []);

  return <div ref={ref} className="headtip" role="tooltip" hidden />;
}
