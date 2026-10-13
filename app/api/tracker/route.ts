import { NextResponse, connection } from "next/server";
import { getEvents, getState } from "@/lib/store";

export async function GET(req: Request) {
  await connection();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 5000);
  const player = url.searchParams.get("player");
  const type = url.searchParams.get("type");
  const [state, events] = await Promise.all([getState(), getEvents()]);
  let list = events;
  if (player) list = list.filter((e) => e.player === player || e.meta?.raidTargetPlayerId === player);
  if (type) list = list.filter((e) => e.type === type);
  return NextResponse.json({
    tracker: {
      startedAt: state.startedAt,
      lastPoll: state.lastPoll,
      lastOk: state.lastOk,
      lastError: state.lastError,
      polls: state.polls,
      eventCount: state.eventCount,
    },
    latest: state.latest,
    players: state.players,
    history: state.history,
    events: list.slice(-limit).reverse(),
  });
}
