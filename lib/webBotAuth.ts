import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Web Bot Auth (RFC 9421 HTTP Message Signatures, Cloudflare Verified Bots): Der Tracker signiert seine Anfragen an
 * craftattack.one mit einem Ed25519-Schlüssel, damit Cloudflare ihn als angemeldeten Bot erkennt statt als
 * unbekannten Client. Der öffentliche Schlüssel liegt im Verzeichnis `/.well-known/http-message-signatures-directory`
 * der Website (SIGNATURE_AGENT), bei Cloudflare wird diese URL im Bot-Antrag angegeben.
 * https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/
 *
 * Schlüssel: `WEB_BOT_AUTH_KEY_FILE` (Pfad zur PEM-Datei) oder `WEB_BOT_AUTH_KEY` (PEM-Inhalt, `\n` erlaubt).
 * Ohne Schlüssel bleibt alles unsigniert wie bisher.
 */

/** Wo das Schlüsselverzeichnis liegt; wird bei jeder Anfrage als `Signature-Agent` mitgeschickt */
export const SIGNATURE_AGENT = process.env.WEB_BOT_AUTH_AGENT ?? "https://craftattack.hiorcraft.tv";
/** Gültigkeit einer Anfrage-Signatur (Cloudflare empfiehlt kurz, etwa eine Minute) */
const REQUEST_TTL_S = 60;
/** Gültigkeit der Signatur des Schlüsselverzeichnisses */
const DIRECTORY_TTL_S = 3600;

interface BotKey {
  privateKey: KeyObject;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  keyid: string;
}

let loaded: BotKey | null | undefined;

export function botKey(): BotKey | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  try {
    const file = process.env.WEB_BOT_AUTH_KEY_FILE;
    const pem = file ? readFileSync(file, "utf8") : process.env.WEB_BOT_AUTH_KEY?.replace(/\\n/g, "\n");
    if (!pem) return loaded;
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Schlüssel ist kein Ed25519-Schlüssel");
    const { x } = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
    const jwk = { kty: "OKP" as const, crv: "Ed25519" as const, x };
    // JWK-Thumbprint (RFC 7638 / RFC 8037): SHA-256 über die Pflichtfelder in fester Reihenfolge
    const keyid = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url");
    loaded = { privateKey, jwk, keyid };
  } catch (err) {
    console.error("[web-bot-auth] Schlüssel nicht lesbar, Anfragen bleiben unsigniert:", err instanceof Error ? err.message : err);
  }
  return loaded;
}

function signatureHeaders(key: BotKey, components: [string, string][], params: string) {
  const list = components.map(([name]) => name).join(" ");
  const signatureParams = `(${list});${params}`;
  // Signaturbasis nach RFC 9421, Abschnitt 2.5
  const base = [...components.map(([name, value]) => `${name}: ${value}`), `"@signature-params": ${signatureParams}`].join("\n");
  const signature = sign(null, Buffer.from(base), key.privateKey).toString("base64");
  return { "signature-input": `sig1=${signatureParams}`, signature: `sig1=:${signature}:` };
}

/** Signatur-Parameter: Zeitraum, Schlüssel, Zufallswert und Zweck (`tag`) */
function params(key: BotKey, ttl: number, tag: string) {
  const created = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(32).toString("base64");
  return `created=${created};expires=${created + ttl};keyid="${key.keyid}";alg="ed25519";nonce="${nonce}";tag="${tag}"`;
}

/** Header für eine signierte Anfrage; leer ohne Schlüssel */
export function webBotAuthHeaders(url: string | URL): Record<string, string> {
  const key = botKey();
  if (!key) return {};
  const agent = JSON.stringify(SIGNATURE_AGENT);
  return {
    "signature-agent": agent,
    ...signatureHeaders(
      key,
      [
        ['"@authority"', new URL(url).host],
        ['"signature-agent"', agent],
      ],
      params(key, REQUEST_TTL_S, "web-bot-auth"),
    ),
  };
}

/** Antwort für `/.well-known/http-message-signatures-directory`: JWKS mit dem öffentlichen Schlüssel, selbst signiert */
export function signatureDirectory(host: string): { body: string; headers: Record<string, string> } | null {
  const key = botKey();
  if (!key) return null;
  return {
    body: JSON.stringify({ keys: [key.jwk] }),
    headers: {
      "content-type": "application/http-message-signatures-directory+json",
      "cache-control": "max-age=300",
      ...signatureHeaders(
        key,
        [['"@authority";req', host]],
        params(key, DIRECTORY_TTL_S, "http-message-signatures-directory"),
      ),
    },
  };
}
