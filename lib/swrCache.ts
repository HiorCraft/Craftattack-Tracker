/**
 * Zwischenspeicher für teure Abfragen, ausgelegt für einen kleinen Server (Render, 512 MB):
 * - Single-Flight: Gleichzeitige Anfragen teilen sich eine Berechnung, statt sie mehrfach zu starten.
 *   Mehrfaches Klicken auf eine Spielerseite startet so nicht mehrere teure Abfragen parallel.
 * - Stale-while-revalidate: Ist ein Eintrag abgelaufen, bekommt die Anfrage sofort den alten Wert,
 *   und genau eine Neuberechnung läuft im Hintergrund. Nur der allererste Aufruf wartet.
 */
interface Entry {
  at: number;
  has: boolean;
  value: unknown;
  pending: Promise<unknown> | null;
}

export function createSwrCache() {
  const entries = new Map<string, Entry>();

  function refresh<T>(key: string, load: () => Promise<T>): Promise<T> {
    const entry = entries.get(key) ?? { at: 0, has: false, value: undefined, pending: null };
    if (entry.pending) return entry.pending as Promise<T>;
    const pending = load().then(
      (value) => {
        entries.set(key, { at: Date.now(), has: true, value, pending: null });
        return value;
      },
      (err: unknown) => {
        // Fehlgeschlagen: alten Wert behalten, beim nächsten Aufruf erneut versuchen
        entry.pending = null;
        throw err;
      },
    );
    entry.pending = pending;
    entries.set(key, entry);
    return pending;
  }

  return async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = entries.get(key);
    if (entry?.has) {
      if (Date.now() - entry.at >= ttlMs && !entry.pending) {
        refresh(key, load).catch((err: unknown) => console.warn(`[cache] ${key} konnte nicht aktualisiert werden:`, err instanceof Error ? err.message : err));
      }
      return entry.value as T;
    }
    return refresh(key, load);
  };
}
