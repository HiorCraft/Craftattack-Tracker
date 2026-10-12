export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPolling } = await import("./lib/tracker");
    startPolling();
    const { startTwitchIrc } = await import("./lib/twitchIrc");
    startTwitchIrc();
    // Einmal pro Prozess: alte Verlaufsdaten korrigieren und fehlende AFK-Farm-Ereignisse nachtragen
    const { runBackfills } = await import("./lib/backfill");
    runBackfills().catch((err: unknown) => console.error("[tracker] Nachträge fehlgeschlagen:", err));
  }
}
