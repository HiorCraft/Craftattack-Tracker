import { NextResponse, type NextRequest } from "next/server";
import { servesWeb } from "@/lib/mode";

/** Im Modus `tracker` bleiben nur Status- und Poll-Endpunkte erreichbar. */
const TRACKER_ONLY_PATHS = new Set(["/api/tracker", "/api/tracker/poll", "/api/cron/poll"]);

export function proxy(request: NextRequest) {
  if (servesWeb() || TRACKER_ONLY_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  return NextResponse.json(
    { ok: false, error: "Dieser Prozess läuft mit TRACKER_MODE=tracker und liefert keine Website aus." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
