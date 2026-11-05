import "server-only";
import { timingSafeEqual } from "node:crypto";
import { pollOnce } from "./tracker";
import { runsTracker } from "./mode";

export async function handleCronPoll(request: Request): Promise<Response> {
  // Nur Website (TRACKER_MODE=web): Der Tracker läuft woanders. Ein zweiter Poller würde doppelte Ereignisse schreiben.
  if (!runsTracker()) {
    return Response.json(
      { ok: false, error: "Dieser Prozess läuft mit TRACKER_MODE=web und fragt nicht ab. Cron-Aufrufe an den Tracker-Dienst richten." },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "Cron endpoint is not configured." }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  const authorization = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401, headers: { "cache-control": "no-store" } });
  }

  const result = await pollOnce();
  if (result.ok) {
    return Response.json({ ok: true, status: "polled", events: result.events }, { headers: { "cache-control": "no-store" } });
  }
  if (result.error === "busy" || result.error === "cooldown" || result.error?.startsWith("paused until ")) {
    return Response.json({ ok: true, status: "skipped", reason: result.error }, { headers: { "cache-control": "no-store" } });
  }
  return Response.json({ ok: false, error: result.error ?? "Poll failed." }, { status: 502, headers: { "cache-control": "no-store" } });
}
