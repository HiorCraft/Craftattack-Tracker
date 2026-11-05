import { connection } from "next/server";
import { cachedAny, craftAttackImage, serveImage, webImage } from "@/lib/imageCache";

/**
 * Ganzkörper-Bild eines Spielers.
 * 1. kuratierter Skin von craftattack.one (/skins/<id>.webp) – passt auch bei Zweitaccounts
 * 2. sonst Mojang-Skin über mc-heads.net anhand der UUID, ersatzweise visage.surgeplay.com
 * 3. zuletzt irgendein gespeichertes Ganzkörper-Bild dieses Spielers (andere Größe)
 * Beides liegt im Bild-Zwischenspeicher der Datenbank (lib/imageCache.ts): Sperrt oder pausiert eine Quelle, kommt
 * das zuletzt gespeicherte Bild.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/skin/[id]">) {
  await connection();
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const uuid = url.searchParams.get("u") ?? "";
  const size = Math.min(512, Math.max(32, Number(url.searchParams.get("s") ?? 256) || 256));
  const slug = id.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const target = /^[0-9a-f-]{32,36}$/i.test(uuid) ? uuid.replace(/-/g, "").toLowerCase() : "MHF_Steve";
  return serveImage([
    ...(slug ? [craftAttackImage(`ca-skin:${slug}`, `https://craftattack.one/skins/${slug}.webp`)] : []),
    webImage(`mc-body:${target}:${size}`, `https://mc-heads.net/body/${target}/${size}`),
    webImage(`visage-body:${target}:${size}`, `https://visage.surgeplay.com/full/${size}/${target}`),
    cachedAny([...(slug ? [`ca-skin:${slug}`] : []), `mc-body:${target}:`, `visage-body:${target}:`]),
  ]);
}
