import { NextResponse, connection } from "next/server";
import { loadTracker } from "@/lib/data";
import { vodsBetween } from "@/lib/twitch";

/**
 * Twitch-VODs der Spieler in einem Zeitraum, für den Graphen: ?spieler=a,b&von=<ms>&bis=<ms>
 * Antwort: { vods: { [spieler]: { from, to, vodId, vodStart }[] } }. Ohne Twitch-Zugang oder Login: leer.
 */
export async function GET(req: Request) {
  await connection();
  const sp = new URL(req.url).searchParams;
  const players = [...new Set((sp.get("spieler") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const from = Number(sp.get("von"));
  const to = Number(sp.get("bis"));
  if (!players.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return NextResponse.json({ vods: {} });
  const { state } = await loadTracker();
  const out: Record<string, { from: number; to: number; vodId: string; vodStart: number }[]> = {};
  await Promise.all(
    players.map(async (id) => {
      const p = state.players[id];
      const login = p?.twitchLogin ?? p?.live?.login;
      if (!login) return;
      // Twitch langsam oder gesperrt: lieber ohne VODs als ein hängender Graph
      const list = await Promise.race([vodsBetween(login, from, to).catch((e: Error) => (console.warn(`[vods] ${login}: ${e.message}`), [])), new Promise<[]>((r) => setTimeout(() => r([]), 4000))]);
      if (list.length) out[id] = list.map((v) => ({ from: v.start, to: v.end, vodId: v.id, vodStart: v.start }));
    }),
  );
  return NextResponse.json({ vods: out }, { headers: { "cache-control": "private, max-age=300" } });
}
