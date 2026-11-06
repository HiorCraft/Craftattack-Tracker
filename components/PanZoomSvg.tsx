"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_ZOOM = 1 / 10;
const MAX_ZOOM = 2;

/**
 * SVG mit Zoomen und Ziehen über seine viewBox. Ziehen verschiebt (erst ab ein paar Pixeln, damit Klicks auf
 * Köpfe weiter funktionieren), Strg/⌘ + Mausrad und zwei Finger zoomen, dazu Knöpfe. `base` ist die Startansicht;
 * ändert sie sich (andere Daten), springt die Ansicht dorthin zurück.
 */
export function PanZoomSvg({
  base,
  className,
  label,
  children,
}: {
  base: View;
  className?: string;
  label: string;
  /** Mit Funktion: bekommt den Maßstab `k` (1 = Startansicht, 0,5 = doppelt so nah), um Köpfe und Linien gleich groß zu halten */
  children: ReactNode | ((k: number) => ReactNode);
}) {
  const svg = useRef<SVGSVGElement>(null);
  const baseKey = `${base.x}|${base.y}|${base.w}|${base.h}`;
  const [state, setState] = useState({ key: baseKey, view: base });
  // Neue Startansicht: Zoom verwerfen (beim Rendern abgeglichen, kein Effekt nötig)
  const view = state.key === baseKey ? state.view : base;
  const viewRef = useRef(view);
  const baseRef = useRef(base);
  const keyRef = useRef(baseKey);
  useLayoutEffect(() => {
    viewRef.current = view;
    baseRef.current = base;
    keyRef.current = baseKey;
  });

  const set = useCallback(
    (v: View) => setState({ key: keyRef.current, view: v }),
    [],
  );

  /** Bildschirmpunkt → Koordinate in der viewBox */
  const toSvg = useCallback((cx: number, cy: number) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return null;
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }, []);

  /** Um Punkt (in viewBox-Koordinaten) mit Faktor zoomen; Faktor < 1 = näher heran */
  const zoomAt = useCallback(
    (f: number, at?: { x: number; y: number }, from?: View) => {
      const v = from ?? viewRef.current;
      const b = baseRef.current;
      const w = Math.min(b.w * MAX_ZOOM, Math.max(b.w * MIN_ZOOM, v.w * f));
      const k = w / v.w;
      const c = at ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
      const next = {
        x: c.x - (c.x - v.x) * k,
        y: c.y - (c.y - v.y) * k,
        w,
        h: v.h * k,
      };
      viewRef.current = next;
      set(next);
    },
    [set],
  );

  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; view: View; moved: boolean } | null =
      null;
    let pinch: { d: number; view: View } | null = null;
    let swallow = false;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const at = toSvg(e.clientX, e.clientY) ?? undefined;
      zoomAt(Math.exp(Math.max(-1, Math.min(1, e.deltaY / 100)) * 0.25), at);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), view: viewRef.current };
        drag = null;
      } else {
        drag = {
          x: e.clientX,
          y: e.clientY,
          view: viewRef.current,
          moved: false,
        };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const m = el.getScreenCTM();
      if (!m) return;
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 0) {
          zoomAt(
            pinch.d / d,
            toSvg((a.x + b.x) / 2, (a.y + b.y) / 2) ?? undefined,
            pinch.view,
          );
        }
        swallow = true;
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        el.setPointerCapture(e.pointerId);
        el.dataset.dragging = "";
      }
      // Pixel → viewBox-Einheiten (m.a = Maßstab der aktuellen Ansicht)
      const next = {
        ...drag.view,
        x: drag.view.x - dx / m.a,
        y: drag.view.y - dy / m.d,
      };
      viewRef.current = next;
      set(next);
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (drag?.moved) swallow = true;
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        drag = null;
        delete el.dataset.dragging;
      }
    };
    // Nach dem Ziehen keinen Klick auf einen Kopf auslösen
    const onClick = (e: MouseEvent) => {
      if (!swallow) return;
      swallow = false;
      e.stopPropagation();
      e.preventDefault();
    };
    const onDownReset = () => (swallow = false);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDownReset, true);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDownReset, true);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onClick, true);
    };
  }, [set, toSvg, zoomAt]);

  const zoomed =
    view !== base &&
    (view.w !== base.w || view.x !== base.x || view.y !== base.y);
  const controls = (
    <div className="radial__zoom" role="group" aria-label="Ansicht">
      <button
        type="button"
        onClick={() => zoomAt(1 / 1.4)}
        title="Näher heran (Strg + Mausrad)"
        aria-label="Näher heran"
      >
        +
      </button>
      <button
        type="button"
        onClick={() => zoomAt(1.4)}
        title="Weiter weg"
        aria-label="Weiter weg"
      >
        −
      </button>
      <button
        type="button"
        onClick={() => set(base)}
        disabled={!zoomed}
        title="Ansicht zurücksetzen"
        aria-label="Ansicht zurücksetzen"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 6V2h4M14 10v4h-4M2 2l4.5 4.5M14 14l-4.5-4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      {controls}
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className={className}
        role="img"
        aria-label={label}
        style={{ "--pz": view.w / base.w } as React.CSSProperties}
      >
        {typeof children === "function" ? children(view.w / base.w) : children}
      </svg>
    </>
  );
}

/** Startansicht: alle Punkte plus Rand, mindestens `min` breit */
export function fitView(
  points: { x: number; y: number }[],
  pad: number,
  min = 200,
): View {
  if (!points.length) return { x: -min / 2, y: -min / 2, w: min, h: min };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const w = Math.max(min, x1 - x0 + pad * 2);
  const h = Math.max(min, y1 - y0 + pad * 2);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}
