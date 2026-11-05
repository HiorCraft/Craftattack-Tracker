import { connection } from "next/server";
import { signatureDirectory } from "@/lib/webBotAuth";

/** Schlüsselverzeichnis für Web Bot Auth (Cloudflare Verified Bots), siehe lib/webBotAuth.ts */
export async function GET(req: Request) {
  await connection();
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const directory = signatureDirectory(host);
  if (!directory) return new Response("Kein Schlüssel eingerichtet.", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(directory.body, { headers: directory.headers });
}
