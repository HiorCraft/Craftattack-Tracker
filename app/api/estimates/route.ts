import { NextResponse, connection } from "next/server";
import { getDb } from "@/lib/db";
import { ESTIMATE } from "@/lib/estimateMode";

interface Row {
  kind: string;
  player: string | null;
  stat: string | null;
  from: Date;
  to: Date;
  confidence: number;
  share: number | null;
  note: string | null;
}

/**
 * Nur Schätzung: geschätzte Zeiträume mit Konfidenz. Ohne `player` die Tracker-Lücken (für alle Diagramme),
 * mit `player` zusätzlich die Nachträge dieses Spielers je Kennzahl.
 */
export async function GET(req: Request) {
  await connection();
  if (!ESTIMATE) return NextResponse.json({ error: "Nur in der Schätzung" }, { status: 404 });
  const player = new URL(req.url).searchParams.get("player");
  const db = await getDb();
  const [rows, meta] = await Promise.all([
    db.query<Row>(`SELECT kind, player, stat, "from", "to", confidence, share, note FROM estimates WHERE kind = 'gap' OR player = $1 ORDER BY "from"`, [player ?? ""]),
    db.query<{ generated_at: Date; started_at: Date }>(`SELECT generated_at, started_at FROM estimate_meta`).then((r) => r.rows[0]),
  ]);
  const zone = (r: Row) => ({ from: r.from.toISOString(), to: r.to.toISOString(), confidence: Math.round(r.confidence * 100) / 100, note: r.note ?? "" });
  return NextResponse.json(
    {
      generatedAt: meta?.generated_at?.toISOString() ?? null,
      startedAt: meta?.started_at?.toISOString() ?? null,
      gaps: rows.rows.filter((r) => r.kind === "gap").map(zone),
      ...(player ? { player: rows.rows.filter((r) => r.kind === "player").map((r) => ({ ...zone(r), stat: r.stat, share: r.share ?? 0 })) } : {}),
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
