#!/usr/bin/env node
/**
 * Kurzzeit-Cache vor der Website, für viele gleichzeitige Besucher, und Wechsel auf neue Versionen ohne Ausfall.
 *
 *   node scripts/cached-server.mjs        (PORT wie gewohnt, Next.js läuft intern auf PORT + 1 bzw. PORT + 2)
 *
 * Die Seiten hängen nur von der URL ab (kein Login, keine Cookies) und die Daten ändern sich höchstens einmal pro
 * Minute. Deshalb wird jede Seite (HTML, RSC-Daten für Navigation und Auto-Refresh, API-Antworten) höchstens alle
 * FRESH_MS neu gerendert; alle anderen Besucher bekommen die fertige, gzip-komprimierte Kopie.
 * - Gleichzeitige Anfragen für dieselbe Seite warten auf ein einziges Rendern.
 * - Ältere Kopien werden immer sofort ausgeliefert, egal wie alt, und im Hintergrund erneuert. Wie alt die Daten
 *   sind, steht auf jeder Seite („Stand: vor …“). Warten muss nur, wer eine Seite aufruft, die noch nie gerendert wurde.
 * - Höchstens MAX_RENDERS Seiten werden gleichzeitig gerendert (2 CPUs), der Rest wartet in einer Schlange.
 *   Besucher, die warten, kommen vor Erneuerungen im Hintergrund dran.
 *
 * Neue Version ohne Ausfall (scripts/deploy.sh): Der Build landet abwechselnd in `.next-a` / `.next-b`, der Name
 * steht in `.next-active`. SIGUSR2 an diesen Prozess startet Next.js aus dem neuen Ordner auf dem anderen Port,
 * wartet, bis es antwortet, rendert die zuletzt besuchten Seiten (und WARM) mit der neuen Version in einen neuen
 * Seiten-Cache und schaltet dann um; der alte Prozess endet kurz danach. Bis dahin bedient der alte alle Anfragen. Dateien unter `/_next/static/` liefert dieser Prozess selbst
 * von der Platte, aus allen Build-Ordnern: Seiten, die noch die alte Version geladen haben, funktionieren weiter.
 * Seiten der alten Version kommen nicht in den neuen Cache (sie passen nicht zur neuen Version); Dateien früherer
 * Versionen liegen zusätzlich 7 Tage in `.next-static-archive`.
 *
 * Endet der aktive Next.js-Prozess unerwartet, endet auch dieser Prozess (systemd startet neu).
 * `/schaetzung` ist abgeschaltet und leitet auf die Startseite.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const PORTS = [PORT + 1, PORT + 2];
const FRESH_MS = 60_000;
/** Beim Versionswechsel höchstens so viele Seiten vorrendern, und höchstens so lange */
const REWARM_MAX = 120;
const REWARM_MS = 4 * 60_000;
const REWARM_PARALLEL = 2;
const MAX_BYTES = 120 * 1024 * 1024;
const MAX_RENDERS = 3;
const MAX_QUEUE = 400;
const UPSTREAM_TIMEOUT_MS = 90_000;
/** Nach dem Umschalten darf der alte Prozess so lange laufende Anfragen beenden */
const RETIRE_MS = 15_000;
/** Vor dem Umschalten immer rendern, auch wenn sie gerade niemand besucht hat */
const WARM = ["/", "/spieler", "/bestenlisten", "/live", "/ereignisse", "/verlauf", "/graph", "/verbindungen", "/gruppen", "/naehe", "/zuschauer", "/statistik"];
const DIST_DIRS = [".next-a", ".next-b", ".next"];
/** Statische Dateien früherer Versionen (scripts/deploy.sh hebt sie 7 Tage auf), für Seiten, die noch offen sind */
const STATIC_ARCHIVE = ".next-static-archive";
/** Nie zwischenspeichern: Cron/Poll, Vorwärmen, Status */
const BYPASS = [/^\/api\/cron\//, /^\/api\/tracker(\/|$|\?)/, /^\/api\/warm/, /^\/api\/version/];
/** Diese Anfrage-Header ändern die Antwort von Next.js (siehe dessen `Vary`) und gehören in den Schlüssel */
const VARY = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url"];
/** Nicht an den Besucher weiterreichen; Länge und Kodierung setzt dieser Prozess selbst */
const DROP = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "content-encoding"]);
const TYPES = { ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8" };

const log = (...a) => console.log("[cache]", ...a);

/* ---------- Next.js als Kindprozess(e) ---------- */
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const activeDist = () => {
  try {
    const d = readFileSync(".next-active", "utf8").trim();
    if (DIST_DIRS.includes(d) && existsSync(join(d, "BUILD_ID"))) return d;
  } catch {}
  return ".next";
};

function startNext(dist, port) {
  const child = spawn(process.execPath, ["--max-old-space-size=280", "--max-semi-space-size=16", nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    env: { ...process.env, PORT: String(port), ...(dist === ".next" ? {} : { NEXT_DIST_DIR: dist }) },
    stdio: "inherit",
  });
  const inst = { child, port, dist, retired: false };
  child.on("exit", (code, signal) => {
    if (inst.retired) return;
    if (current === inst) {
      console.error(`[cache] Next.js beendet (${signal ?? code}), beende auch den Cache`);
      process.exit(code || 1);
    }
  });
  return inst;
}

let current = startNext(activeDist(), PORTS[0]);
let switching = false;
log(`Next.js aus ${current.dist} auf ${current.port}`);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    current.child.kill(sig);
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(port, path, timeout = UPSTREAM_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout, headers: { "accept-encoding": "gzip" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(0));
  });
}

/** Neue Version starten, vorwärmen, umschalten (SIGUSR2) */
async function switchVersion() {
  if (switching) return log("Wechsel läuft schon");
  const dist = activeDist();
  if (dist === current.dist) return log(`${dist} läuft bereits`);
  switching = true;
  const port = PORTS.find((p) => p !== current.port);
  log(`Starte neue Version aus ${dist} auf ${port}`);
  const next = startNext(dist, port);
  next.retired = true; // bis zum Umschalten: Ende nicht als Ausfall werten
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 180_000 && next.child.exitCode === null) {
    if ((await get(port, "/api/tracker", 5_000)) === 200) {
      ok = true;
      break;
    }
    await sleep(1_000);
  }
  if (!ok) {
    log("Neue Version antwortet nicht, bleibe bei der alten");
    next.child.kill("SIGTERM");
    switching = false;
    return;
  }
  const warmed = await rewarm(port);
  const old = current;
  next.retired = false;
  current = next;
  old.retired = true;
  // Seiten der alten Version nicht weiter ausliefern: Sie verweisen auf deren Dateien und passen nicht zu den
  // Daten, die die neue Version beim Aktualisieren liefert (das ließ Abschnitte nach dem Laden verschwinden).
  // Stattdessen gilt der eben mit der neuen Version gefüllte Cache.
  cache.clear();
  cachedBytes = 0;
  for (const [key, entry] of warmed) store(key, entry);
  log(`${warmed.size} Seiten mit der neuen Version vorgerendert`);
  log(`Umgeschaltet auf ${dist} nach ${Math.round((Date.now() - t0) / 1000)} s`);
  setTimeout(() => old.child.kill("SIGTERM"), RETIRE_MS).unref();
  switching = false;
}
process.on("SIGUSR2", () => void switchVersion().catch((e) => ((switching = false), console.error("[cache] Wechsel fehlgeschlagen:", e))));

/**
 * Zuletzt besuchte Seiten (ohne RSC-Varianten) plus WARM mit der neuen Version rendern. Die alte bedient so lange
 * weiter alle Besucher. Ergebnis: Schlüssel → Eintrag, wird beim Umschalten der neue Cache.
 */
async function rewarm(port) {
  const t0 = Date.now();
  const keys = [];
  const seen = new Set();
  const add = (key) => !seen.has(key) && (seen.add(key), keys.push(key));
  const hosts = new Set();
  // Map: zuletzt benutzt steht hinten
  for (const key of [...cache.keys()].reverse()) {
    const [host, , ...vary] = key.split("\n");
    hosts.add(host);
    if (vary.every((v) => !v) && keys.length < REWARM_MAX) add(key);
  }
  for (const host of hosts.size ? hosts : [`127.0.0.1:${PORT}`]) for (const path of WARM) add([host, path, ...VARY.map(() => "")].join("\n"));
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < keys.length && Date.now() - t0 < REWARM_MS) {
      const key = keys[i++];
      const [host, url] = key.split("\n");
      try {
        const entry = await fetchUpstream({ url, headers: { host, accept: "text/html,*/*", "user-agent": "actracker-cache/rewarm" } }, port);
        entry.key = key;
        if (entry.status === 200 && !entry.headers["set-cookie"]) out.set(key, entry);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: REWARM_PARALLEL }, worker));
  log(`vorgerendert: ${out.size} von ${keys.length} in ${Math.round((Date.now() - t0) / 1000)} s`);
  return out;
}

/* ---------- Statische Dateien aus allen Build-Ordnern ---------- */
function serveStatic(req, res) {
  const rel = normalize(decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/_next\/static\//, ""));
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return false;
  const roots = [current.dist, ...DIST_DIRS.filter((d) => d !== current.dist)].map((d) => join(d, "static"));
  for (const root of [...roots, STATIC_ARCHIVE]) {
    const file = join(root, rel);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

/* ---------- Cache ---------- */
/** @type {Map<string, { key?: string; at: number; status: number; headers: Record<string, string | string[]>; body: Buffer; gzip: boolean; plain?: Buffer }>} */
const cache = new Map();
let cachedBytes = 0;
/** @type {Map<string, Promise<any>>} */
const rendering = new Map();
let active = 0;
/** Wartende: Besucher (vorn) und Erneuerungen im Hintergrund (danach) */
/** @type {(() => void)[]} */
const queue = [];
/** @type {(() => void)[]} */
const background = [];

function store(key, entry) {
  const old = cache.get(key);
  if (old) {
    cachedBytes -= old.body.length + (old.plain?.length ?? 0);
    cache.delete(key);
  }
  cache.set(key, entry);
  cachedBytes += entry.body.length;
  // Älteste zuerst verdrängen (Map behält die Einfügereihenfolge, Treffer werden hinten neu eingereiht)
  for (const [k, e] of cache) {
    if (cachedBytes <= MAX_BYTES) break;
    cachedBytes -= e.body.length + (e.plain?.length ?? 0);
    cache.delete(k);
  }
}

function slot(bg = false) {
  if (active < MAX_RENDERS) {
    active++;
    return Promise.resolve();
  }
  const q = bg ? background : queue;
  if (q.length >= MAX_QUEUE) return Promise.reject(Object.assign(new Error("Warteschlange voll"), { busy: true }));
  return new Promise((resolve) => q.push(resolve)).then(() => void active++);
}
function release() {
  active--;
  (queue.shift() ?? background.shift())?.();
}

/** Holt die Antwort von Next.js vollständig (gzip angefragt) */
function fetchUpstream(req, port = current.port) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, "accept-encoding": "gzip" };
    const up = http.request({ host: "127.0.0.1", port, method: "GET", path: req.url, headers, timeout: UPSTREAM_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ at: Date.now(), status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks), gzip: res.headers["content-encoding"] === "gzip" }));
      res.on("error", reject);
    });
    up.on("timeout", () => up.destroy(new Error("Zeitüberschreitung beim Rendern")));
    up.on("error", reject);
    up.end();
  });
}

/** Ein Rendern je Schlüssel, egal wie viele Besucher gleichzeitig fragen */
function render(key, req, bg = false) {
  let p = rendering.get(key);
  if (!p) {
    p = slot(bg)
      .then(() => fetchUpstream(req).finally(release))
      .then((entry) => {
        entry.key = key;
        if (entry.status === 200 && !entry.headers["set-cookie"]) store(key, entry);
        return entry;
      })
      .finally(() => rendering.delete(key));
    rendering.set(key, p);
  }
  return p;
}

function send(req, res, entry, state) {
  const headers = {};
  for (const [k, v] of Object.entries(entry.headers)) if (!DROP.has(k) && v !== undefined) headers[k] = v;
  let body = entry.body;
  if (entry.gzip) {
    if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) headers["content-encoding"] = "gzip";
    else {
      if (!entry.plain) {
        entry.plain = gunzipSync(entry.body);
        if (cache.get(entry.key) === entry) cachedBytes += entry.plain.length;
      }
      body = entry.plain;
    }
  }
  headers["content-length"] = String(body.length);
  headers["x-cache"] = state;
  headers["x-cache-age"] = String(Math.round((Date.now() - entry.at) / 1000));
  res.writeHead(entry.status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

/** Alles, was nicht zwischengespeichert wird, unverändert durchreichen (inkl. Streaming) */
function pass(req, res) {
  const up = http.request({ host: "127.0.0.1", port: current.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Website startet gerade, bitte gleich neu laden.");
  });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  res.on("error", () => {});
  const url = req.url ?? "/";
  if (/^\/schaetzung(\/|\?|$)/.test(url)) {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.startsWith("/_next/static/") && serveStatic(req, res)) return;
  if ((req.method !== "GET" && req.method !== "HEAD") || BYPASS.some((r) => r.test(url))) return pass(req, res);
  const key = [req.headers.host ?? "", url, ...VARY.map((h) => req.headers[h] ?? "")].join("\n");
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit) {
    // Treffer hinten neu einreihen (zuletzt benutzt)
    cache.delete(key);
    cache.set(key, hit);
    if (age >= FRESH_MS) render(key, req, true).catch(() => {});
    return send(req, res, hit, age < FRESH_MS ? "HIT" : "STALE");
  }
  try {
    send(req, res, await render(key, req), "MISS");
  } catch (err) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "5" });
    res.end(err?.busy ? "Gerade sehr viele Besucher, bitte in ein paar Sekunden neu laden." : "Website startet gerade, bitte gleich neu laden.");
  }
});
server.keepAliveTimeout = 65_000;
server.listen(PORT, () => log(`Port ${PORT} → Next.js (frisch ${FRESH_MS / 1000} s, ältere Kopien sofort, Erneuerung im Hintergrund)`));
