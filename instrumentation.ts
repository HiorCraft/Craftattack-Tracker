export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Ausgehende Verbindungen über IPv4: Cloudflare vor craftattack.one sperrt die IPv6-Adresse des Servers
    // (HTTP 403, seit 2026-10-13), über IPv4 antwortet die API. Beides ist nötig, damit auch `fetch` (undici)
    // IPv4 nimmt und nicht per Happy Eyeballs doch bei IPv6 landet.
    if (process.env.CA_IPV4_ONLY !== "0") {
      const [dns, net] = await Promise.all([import("node:dns"), import("node:net")]);
      dns.setDefaultResultOrder("ipv4first");
      net.setDefaultAutoSelectFamily(false);
    }
    const { startPolling } = await import("./lib/tracker");
    startPolling();
    // Einmal pro Prozess: alte Verlaufsdaten korrigieren und fehlende AFK-Farm-Ereignisse nachtragen
    const { runBackfills } = await import("./lib/backfill");
    runBackfills().catch((err: unknown) => console.error("[tracker] Nachträge fehlgeschlagen:", err));
  }
}
