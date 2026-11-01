export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runsTracker, servesWeb, trackerMode } = await import("./lib/mode");
    console.log(`[tracker] Modus: ${trackerMode()}`);
    if (servesWeb()) {
      // Teure Zwischenspeicher der Spielerseiten vorwärmen, sobald der Server Anfragen annimmt
      const port = process.env.PORT ?? "3000";
      setTimeout(() => {
        fetch(`http://127.0.0.1:${port}/api/warm`, { signal: AbortSignal.timeout(120_000) })
          .then(async (r) => console.log(`[tracker] Zwischenspeicher vorgewärmt (${r.status}, ${(await r.json().catch(() => ({})) as { ms?: number }).ms ?? "?"} ms)`))
          .catch((err: unknown) => console.warn("[tracker] Vorwärmen fehlgeschlagen:", err instanceof Error ? err.message : err));
      }, 15_000);
    }
    if (!runsTracker()) return;
    const { startPolling } = await import("./lib/tracker");
    startPolling();
    const { startTwitchIrc } = await import("./lib/twitchIrc");
    startTwitchIrc();
    // Offizielle Termine: nur der Tracker fragt craftattack.one ab, die Website liest aus der Datenbank
    const { startOfficialEventsSync } = await import("./lib/officialEvents");
    startOfficialEventsSync();
    // Köpfe und Skins neuer Spieler von craftattack.one speichern (die Website selbst wird dort gesperrt)
    const { startImageWarmup } = await import("./lib/imageCache");
    startImageWarmup();
    // Twitch-Verlauf (VODs, Clips) auch rückwirkend, z. B. Streams in Tracker-Lücken
    const { startTwitchHistorySync } = await import("./lib/twitchHistory");
    startTwitchHistorySync();
    // Ereignisse und Meilensteine für die Zusatzwerte (platzierte Blöcke, Handel, Angeln, …), auch rückwirkend
    const { startExtraEvents } = await import("./lib/extraEvents");
    startExtraEvents();
    // Sammel-Sprünge (nach Lücken, veraltete Werte, Zeit offline) markieren, Feeds blenden sie aus
    const { startEventQuality } = await import("./lib/eventQuality");
    startEventQuality();
    // Einmal pro Prozess: alte Verlaufsdaten korrigieren und fehlende AFK-Farm-Ereignisse nachtragen
    const { runBackfills } = await import("./lib/backfill");
    runBackfills().catch((err: unknown) => console.error("[tracker] Nachträge fehlgeschlagen:", err));
  }
}
