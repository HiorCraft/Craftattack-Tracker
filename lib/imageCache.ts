import "server-only";
import { craftAttackPausedResponse, fetchCraftAttack, USER_AGENT } from "./craftattackFetch";
import { getDb } from "./db";

/**
 * Bilder (Köpfe, Skins) mit Zwischenspeicher in der Datenbank. Quellen werden der Reihe nach versucht:
 * frischer Eintrag → Abruf (bei Erfolg gespeichert) → alter Eintrag → nächste Quelle. So bleiben Köpfe sichtbar,
 * auch wenn eine Quelle sperrt oder pausiert, und überstehen jeden Deploy.
 */

const FRESH_MS = 24 * 60 * 60_000;
const CACHE_HEADER = "public, max-age=86400, stale-while-revalidate=604800";

export interface ImageSource {
  /** Schlüssel im Zwischenspeicher, z. B. `ca-head:zarbex` */
  key: string;
  /** Abruf; `null` = diesmal nicht versuchen (Quelle pausiert, bekanntermaßen nicht vorhanden) */
  load: () => Promise<Response | null>;
  /** Ergebnis nicht unter `key` speichern (z. B. Rückgriff auf einen schon gespeicherten Eintrag) */
  noStore?: boolean;
}

async function getCached(key: string): Promise<{ type: string; body: Buffer; at: number } | null> {
  const db = await getDb();
  const r = (await db.query<{ content_type: string; body: Buffer; fetched_at: Date }>(`SELECT content_type, body, fetched_at FROM image_cache WHERE key = $1`, [key])).rows[0];
  return r ? { type: r.content_type, body: r.body, at: new Date(r.fetched_at).getTime() } : null;
}

async function saveCached(key: string, type: string, body: Buffer) {
  const db = await getDb();
  await db.query(
    `INSERT INTO image_cache (key, content_type, body, fetched_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET content_type = EXCLUDED.content_type, body = EXCLUDED.body, fetched_at = now()`,
    [key, type, body],
  );
}

const image = (type: string, body: Buffer) =>
  new Response(new Uint8Array(body), { headers: { "content-type": type, "cache-control": CACHE_HEADER } });

export async function serveImage(sources: ImageSource[]): Promise<Response> {
  for (const s of sources) {
    const hit = await getCached(s.key).catch(() => null);
    if (hit && Date.now() - hit.at < FRESH_MS) return image(hit.type, hit.body);
    try {
      const r = await s.load();
      if (r?.ok) {
        const type = r.headers.get("content-type") ?? "image/png";
        const body = Buffer.from(await r.arrayBuffer());
        if (type.startsWith("image/") && body.length > 0) {
          if (!s.noStore) await saveCached(s.key, type, body).catch((err: unknown) => console.warn("[bild] Speichern fehlgeschlagen:", err instanceof Error ? err.message : err));
          return image(type, body);
        }
      }
    } catch {
      /* Quelle nicht erreichbar: alter Eintrag oder nächste Quelle */
    }
    if (hit) return image(hit.type, hit.body);
  }
  return new Response(null, { status: 404 });
}

/** Bilder, die craftattack.one nicht hat (404), einen Tag lang nicht erneut anfragen */
const missing = new Map<string, number>();

/** Quelle craftattack.one: übersprungen, solange Anfragen pausiert sind (nach einer Sperre) oder das Bild fehlt */
export function craftAttackImage(key: string, url: string): ImageSource {
  return {
    key,
    load: async () => {
      if (craftAttackPausedResponse(url)) return null;
      const miss = missing.get(url);
      if (miss && Date.now() - miss < FRESH_MS) return null;
      const r = await fetchCraftAttack(url, { headers: { "user-agent": USER_AGENT }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (r.status === 404) missing.set(url, Date.now());
      return r;
    },
  };
}

/** Quelle über `fetch` (z. B. mc-heads.net) */
export function webImage(key: string, url: string): ImageSource {
  return { key, load: () => fetch(url, { headers: { "user-agent": USER_AGENT }, cache: "no-store", signal: AbortSignal.timeout(10_000) }) };
}

/**
 * Letzter Ausweg: irgendein schon gespeichertes Bild, dessen Schlüssel mit einem der Präfixe beginnt (z. B. derselbe
 * Kopf in einer anderen Größe). Der Browser skaliert es.
 */
export function cachedAny(prefixes: string[]): ImageSource {
  return {
    key: `any:${prefixes.join(",")}`,
    noStore: true,
    load: async () => {
      const db = await getDb();
      for (const prefix of prefixes) {
        const r = (
          await db.query<{ content_type: string; body: Buffer }>(
            `SELECT content_type, body FROM image_cache WHERE key LIKE $1 ORDER BY fetched_at DESC LIMIT 1`,
            [`${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
          )
        ).rows[0];
        if (r) return new Response(new Uint8Array(r.body), { headers: { "content-type": r.content_type } });
      }
      return null;
    },
  };
}

/** Spieler, für die der offizielle Kopf bzw. Skin von craftattack.one noch nicht (oder lange nicht) gespeichert ist */
const WARM_MAX_PER_RUN = 40;
const WARM_STALE_MS = 7 * 24 * 60 * 60_000;

/**
 * Nur Tracker (der craftattack.one erreicht): offizielle Köpfe und Skins neuer Spieler in den Zwischenspeicher holen.
 * Die Website wird von craftattack.one gesperrt und liest sie dann aus der Datenbank. Höchstens ein Bild alle 2 s.
 */
export async function warmCraftAttackImages(): Promise<number> {
  const db = await getDb();
  const ids = (await db.query<{ id: string }>(`SELECT id FROM players`)).rows.map((r) => r.id.toLowerCase().replace(/[^a-z0-9_-]/g, "")).filter(Boolean);
  const have = new Map(
    (await db.query<{ key: string; fetched_at: Date }>(`SELECT key, fetched_at FROM image_cache WHERE key LIKE 'ca-head:%' OR key LIKE 'ca-skin:%'`)).rows.map((r) => [r.key, new Date(r.fetched_at).getTime()]),
  );
  const todo: { key: string; url: string }[] = [];
  for (const slug of ids)
    for (const [key, url] of [
      [`ca-head:${slug}`, `https://craftattack.one/skins/${slug}-head.webp`],
      [`ca-skin:${slug}`, `https://craftattack.one/skins/${slug}.webp`],
    ]) {
      const at = have.get(key);
      if (at === undefined || Date.now() - at > WARM_STALE_MS) todo.push({ key, url });
    }
  // Fehlende zuerst, dann veraltete
  todo.sort((a, b) => Number(have.has(a.key)) - Number(have.has(b.key)));
  let saved = 0;
  for (const t of todo.slice(0, WARM_MAX_PER_RUN)) {
    if (craftAttackPausedResponse(t.url)) break;
    const r = await craftAttackImage(t.key, t.url)
      .load()
      .catch(() => null);
    if (r?.ok) {
      const type = r.headers.get("content-type") ?? "image/webp";
      const body = Buffer.from(await r.arrayBuffer());
      if (type.startsWith("image/") && body.length > 0) {
        await saveCached(t.key, type, body);
        saved++;
      }
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  return saved;
}

export function startImageWarmup() {
  const gl = globalThis as typeof globalThis & { __acImageWarm?: boolean };
  if (gl.__acImageWarm) return;
  gl.__acImageWarm = true;
  const run = () =>
    void warmCraftAttackImages()
      .then((n) => n && console.log(`[tracker] ${n} Köpfe/Skins von craftattack.one gespeichert`))
      .catch((err: unknown) => console.warn("[tracker] Köpfe vorladen fehlgeschlagen:", err instanceof Error ? err.message : err));
  setTimeout(run, 90_000).unref();
  setInterval(run, 60 * 60_000).unref();
}
