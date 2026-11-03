"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { BASE_PATH } from "@/lib/estimateMode";

const SCROLL_KEY = "ac.scroll.v1";
const VERSION = process.env.NEXT_PUBLIC_DEPLOY_ID ?? "";

/**
 * Lädt die Server-Daten einmal pro Minute neu, solange der Tab sichtbar ist.
 *
 * Läuft inzwischen eine neue Version der Website, passen die neuen Daten nicht zum Code im Browser; Next.js lädt dann
 * hart neu, die Seite sprang nach oben und Abschnitte erschienen erst nach und nach wieder. Deshalb wird vorher die
 * Version verglichen: gleiche Version → sanft aktualisieren; neue Version → einmal neu laden und danach an dieselbe
 * Stelle zurückscrollen.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    // Nach einem Neuladen wegen neuer Version: an die alte Stelle, sobald die Seite hoch genug ist
    let restore: ReturnType<typeof setInterval> | undefined;
    try {
      const saved = sessionStorage.getItem(SCROLL_KEY);
      if (saved) {
        sessionStorage.removeItem(SCROLL_KEY);
        const { path, y } = JSON.parse(saved) as { path: string; y: number };
        if (path === location.pathname + location.search) {
          const until = Date.now() + 15_000;
          restore = setInterval(() => {
            if (document.documentElement.scrollHeight >= y + innerHeight || Date.now() > until) {
              scrollTo({ top: y });
              clearInterval(restore);
            }
          }, 200);
        }
      }
    } catch {}

    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        const server = await fetch(`${BASE_PATH}/api/version`, { cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<{ id: string }>) : null))
          .catch(() => null);
        if (server?.id && VERSION && server.id !== VERSION) {
          try {
            sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: location.pathname + location.search, y: scrollY }));
          } catch {}
          location.reload();
          return;
        }
        router.refresh();
      }
      timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
    return () => {
      clearTimeout(timer);
      clearInterval(restore);
    };
  }, [router, intervalMs]);
  return null;
}
