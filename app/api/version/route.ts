import { connection } from "next/server";

/** Kennung der laufenden Version (scripts/deploy.sh setzt DEPLOY_ID beim Bauen). Offene Seiten vergleichen damit. */
export async function GET() {
  await connection();
  return Response.json({ id: process.env.NEXT_PUBLIC_DEPLOY_ID ?? "" }, { headers: { "cache-control": "no-store" } });
}
