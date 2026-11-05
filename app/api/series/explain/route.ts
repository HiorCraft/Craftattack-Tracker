import { NextResponse, connection } from "next/server";
import { explainChange } from "@/lib/store";

/**
 * Erklärung einer Veränderung im Graphen: ?metric=&von=<ms>&bis=<ms>&spieler=a,b
 * Beiträge je Spieler und passende Ereignisse im Zeitraum (höchstens 31 Tage).
 */
export async function GET(req: Request) {
  await connection();
  const sp = new URL(req.url).searchParams;
  const metric = sp.get("metric") ?? "";
  const from = Number(sp.get("von"));
  const to = Number(sp.get("bis"));
  if (!/^[a-zA-Z:]+$/.test(metric) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * 86400_000) {
    return NextResponse.json({ error: "ungültige Anfrage" }, { status: 400 });
  }
  const players = [...new Set((sp.get("spieler") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  return NextResponse.json(await explainChange({ metric, from, to, players }), { headers: { "cache-control": "private, max-age=30" } });
}
