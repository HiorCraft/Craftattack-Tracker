import { connection } from "next/server";
import { getAllSessions, getBoardTotalsOverTime, getFullBoard, getHistoryAll, getTwitchSubscriptionBoard } from "@/lib/store";
import { getPlayerRates, getRankHistory, getStatsExtras } from "@/lib/analytics";

/**
 * Füllt die teuren Zwischenspeicher der Spieler- und Statistikseiten (Rang-Verlauf, Raten, Sessions,
 * Bestenlisten, Statistik-Auswertungen).
 * Wird kurz nach dem Serverstart einmal aufgerufen, damit nicht der erste Besucher darauf wartet.
 * Alle Abfragen sind zwischengespeichert und laufen höchstens einmal gleichzeitig: wiederholte Aufrufe kosten nichts.
 */
export async function GET() {
  await connection();
  const started = Date.now();
  // Nacheinander statt gleichzeitig: schont Speicher und Datenbank auf kleinen Instanzen
  for (const load of [getRankHistory, getPlayerRates, getAllSessions, () => getFullBoard("followers"), getTwitchSubscriptionBoard, getStatsExtras, getHistoryAll, getBoardTotalsOverTime]) {
    await load();
  }
  return Response.json({ ok: true, ms: Date.now() - started }, { headers: { "cache-control": "no-store" } });
}
