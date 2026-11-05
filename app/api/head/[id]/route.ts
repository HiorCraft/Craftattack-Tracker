import { connection } from "next/server";
import { cachedAny, craftAttackImage, serveImage, webImage } from "@/lib/imageCache";

/**
 * Kopf-Bild eines Spielers.
 * 1. kuratierter Kopf von craftattack.one (/skins/<id>-head.webp) – passt auch bei Zweitaccounts
 * 2. sonst Mojang-Skin über mc-heads.net anhand der UUID, ersatzweise minotar.net
 * 3. zuletzt irgendein gespeicherter Kopf dieses Spielers (andere Größe)
 * Beides liegt im Bild-Zwischenspeicher der Datenbank (lib/imageCache.ts): Sperrt oder pausiert eine Quelle, kommt
 * der zuletzt gespeicherte Kopf.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/head/[id]">) {
  await connection();
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const uuid = url.searchParams.get("u") ?? "";
  const size = Math.min(256, Math.max(8, Number(url.searchParams.get("s") ?? 32) || 32));
  const slug = id.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const target = /^[0-9a-f-]{32,36}$/i.test(uuid) ? uuid.replace(/-/g, "").toLowerCase() : "MHF_Steve";
  return serveImage([
    ...(slug ? [craftAttackImage(`ca-head:${slug}`, `https://craftattack.one/skins/${slug}-head.webp`)] : []),
    webImage(`mc-head:${target}:${size}`, `https://mc-heads.net/avatar/${target}/${size}`),
    // mc-heads.net sperrt diesen Server teils (Cloudflare); minotar liefert denselben Kopf mit Hut-Ebene
    webImage(`minotar-head:${target}:${size}`, `https://minotar.net/helm/${target}/${size}.png`),
    cachedAny([...(slug ? [`ca-head:${slug}`] : []), `mc-head:${target}:`, `minotar-head:${target}:`]),
  ]);
}
