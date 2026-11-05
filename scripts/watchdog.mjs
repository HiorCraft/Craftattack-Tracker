#!/usr/bin/env node
/**
 * Wächter: prüft alle paar Minuten, ob alles läuft, und schickt eine Push-Nachricht (ntfy), wenn jemand etwas tun
 * muss. Dazu eine Nachricht, wenn es wieder läuft. Ein Problem meldet sich erst, wenn es eine Weile anhält
 * (`after`), und erinnert höchstens alle REMIND_MS erneut.
 *
 *   NTFY_URL=https://ntfy.sh/<geheimes-thema> node scripts/watchdog.mjs
 *
 * Geprüft: Tunnel (SOCKS-Port), Tracker (letzte erfolgreiche Abfrage, Fehlertext), Website (intern und öffentlich),
 * Hintergrunddienste, freier Speicherplatz, VOD-Chat-Nachtrag (Sperre durch Twitch).
 * Zustand in WATCHDOG_STATE (Standard ~/.local/state/actracker-watchdog.json).
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statfsSync, appendFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { homedir } from "node:os";

const NTFY_URL = process.env.NTFY_URL;
if (!NTFY_URL) throw new Error("NTFY_URL fehlt");
const STATE = process.env.WATCHDOG_STATE ?? `${homedir()}/.local/state/actracker-watchdog.json`;
const TRACKER = process.env.WATCHDOG_TRACKER ?? "http://127.0.0.1:3020/api/tracker";
const WEB = process.env.WATCHDOG_WEB ?? "http://127.0.0.1:3010/bot";
// Startseite statt /bot: /bot liegt fast immer fertig im Cache und antwortete auch, als die Website hing
const PUBLIC = process.env.WATCHDOG_PUBLIC ?? "https://craftattack.hiorcraft.tv/";
/** Speicher des Website-Dienstes (Root-Unit, cgroup v2) */
const WEB_CGROUP = process.env.WATCHDOG_WEB_CGROUP ?? "/sys/fs/cgroup/system.slice/actracker-web.service";
const PROXY_PORT = Number(process.env.WATCHDOG_PROXY_PORT ?? 1080);
const MIN = 60_000;
const REMIND_MS = 3 * 60 * MIN;
/** „Läuft wieder“ erst, wenn es so lange am Stück wieder läuft; kommt das Problem vorher zurück, ist es derselbe Vorfall */
const STABLE_MS = 10 * MIN;

const sh = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 15_000 }, (err, out) => res(err ? (out || "").trim() || "failed" : out.trim())));
const portOpen = (port) =>
  new Promise((res) => {
    const s = connect({ host: "127.0.0.1", port, timeout: 3000 }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.on("timeout", () => {
      s.destroy();
      res(false);
    });
  });
const get = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "actracker-watchdog" } });
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : null };
  } catch (err) {
    return { status: 0, error: err?.cause?.code ?? err?.message ?? String(err) };
  }
};
const berlin = (t) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

/** Probleme: key → { title, message, priority, after (ms, so lange muss es anhalten) } */
async function check() {
  const problems = {};
  const tunnel = await portOpen(PROXY_PORT);
  if (!tunnel)
    problems.tunnel = {
      title: "Tunnel getrennt",
      message: "Kein Gerät hält den Tunnel zu craftattack.one. Bitte den Tunnel auf dem PC (oder Handy/Laptop) starten. Bis dahin fehlen Minecraft-Daten, Twitch läuft weiter.",
      priority: "high",
      tags: "electric_plug",
      after: 5 * MIN,
    };

  const t = await get(TRACKER);
  const tr = t.body?.tracker;
  if (!tr) {
    const svc = await sh("systemctl", ["--user", "is-active", "actracker-tracker"]);
    problems.tracker = {
      title: "Tracker antwortet nicht",
      message: `Der Tracker-Dienst ist ${svc === "active" ? "aktiv, antwortet aber nicht" : `nicht aktiv (${svc})`}. Er startet sich normalerweise selbst neu; hält das an, bitte melden.`,
      priority: "high",
      tags: "warning",
      after: 10 * MIN,
    };
  } else {
    const ageMin = tr.lastOk ? (Date.now() - Date.parse(tr.lastOk)) / MIN : Infinity;
    if (ageMin > 8) {
      const err = String(tr.lastError ?? "");
      const blocked = /403|cloudflare|attention|429|gesperrt|pausiert/i.test(err);
      const net = /fetch failed|ECONNREFUSED|socks|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(err);
      problems.polls = {
        title: blocked ? "craftattack.one sperrt den Tracker" : net && !tunnel ? "Keine Minecraft-Daten (Tunnel)" : "Keine Minecraft-Daten",
        message: `Letzte erfolgreiche Abfrage: ${tr.lastOk ? berlin(tr.lastOk) + " Uhr" : "nie"}. Fehler: ${err || "keiner gemeldet"}. ${
          blocked
            ? "Die Seite blockt die Abfragen (Cloudflare). Das löst sich meist von selbst; hält es Stunden an, die Verbindung über ein anderes Gerät versuchen."
            : net
              ? "Die Verbindung über den Tunnel klappt nicht: Tunnel-Gerät prüfen (läuft es, ist es online?)."
              : "Nichts zu tun, wenn es in einer halben Stunde nicht weg ist, bitte melden."
        }`,
        priority: blocked || net ? "high" : "default",
        tags: "minecraft,warning",
        after: net && !tunnel ? 5 * MIN : 10 * MIN,
      };
    }
  }

  const w = await get(WEB);
  const p = await get(PUBLIC);
  if (w.status !== 200 || p.status !== 200)
    problems.web = {
      title: "Website nicht erreichbar",
      message: `Intern: ${w.status || w.error}, öffentlich: ${p.status || p.error}. ${w.status === 200 ? "Der Server läuft, also liegt es an Caddy/DNS oder am Netz." : "Der Website-Dienst startet sich normalerweise selbst neu."}`,
      priority: "high",
      tags: "globe_with_meridians,warning",
      after: 6 * MIN,
    };

  // Website am Speicherlimit: der Kernel bremst sie dann aus (Seiten hängen, obwohl sie laufen)
  try {
    const cur = Number(readFileSync(`${WEB_CGROUP}/memory.current`, "utf8"));
    const high = Number(readFileSync(`${WEB_CGROUP}/memory.high`, "utf8"));
    if (Number.isFinite(high) && high > 0 && cur >= high * 0.95)
      problems.webmem = {
        title: "Website am Speicherlimit",
        message: `Die Website nutzt ${Math.round(cur / 1e6)} von ${Math.round(high / 1e6)} MB und wird ausgebremst (Seiten laden nicht). Kurzfristig hilft ein Neustart, dauerhaft ein höheres Limit (MemoryHigh/MemoryMax im Drop-in, braucht root).`,
        priority: "high",
        tags: "warning",
        after: 10 * MIN,
      };
  } catch {
    /* cgroup nicht lesbar: nicht prüfen */
  }

  // Ganzer Server: wenig freier Arbeitsspeicher und Swap fast voll → alles wird langsam
  const mem = Object.fromEntries(
    readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .map((l) => l.match(/^(\w+):\s+(\d+)/))
      .filter(Boolean)
      .map((m) => [m[1], Number(m[2]) * 1024]),
  );
  const availMb = mem.MemAvailable / 1e6;
  const swapUsed = mem.SwapTotal ? 1 - mem.SwapFree / mem.SwapTotal : 0;
  if (availMb < 350 && swapUsed > 0.85)
    problems.ram = {
      title: "Arbeitsspeicher des Servers knapp",
      message: `Nur noch ${Math.round(availMb)} MB frei, Swap zu ${Math.round(swapUsed * 100)} % voll. Website und Tracker werden langsam. Hilft: offene Claude-Code-Sitzungen schließen, sonst bitte melden (Dienste neu starten oder Server mit mehr RAM).`,
      priority: "high",
      tags: "warning",
      after: 15 * MIN,
    };
  // Speicherverlauf der Dienste (zur Fehlersuche, letzte ~3 Tage)
  try {
    const rss = async (unit, user) => {
      const pid = await sh("systemctl", [...(user ? ["--user"] : []), "show", "-p", "MainPID", "--value", unit]);
      const kids = await sh("pgrep", ["-P", pid]);
      const all = [pid, ...kids.split("\n")].filter((x) => /^\d+$/.test(x) && x !== "0");
      let sum = 0;
      for (const p of all) {
        const m = readFileSync(`/proc/${p}/status`, "utf8").match(/VmRSS:\s+(\d+)/);
        if (m) sum += Number(m[1]);
      }
      return Math.round(sum / 1024);
    };
    const line = `${new Date().toISOString()} avail=${Math.round(availMb)} swap=${Math.round(swapUsed * 100)}% web=${await rss("actracker-web", false)} tracker=${await rss("actracker-tracker", true)} schaetzung=${await rss("actracker-schaetzung", true)} vodchat=${await rss("actracker-vodchat", true)}\n`;
    const log = `${homedir()}/.local/state/actracker-mem.log`;
    appendFileSync(log, line);
    const lines = readFileSync(log, "utf8").split("\n");
    if (lines.length > 2200) writeFileSync(log, lines.slice(-2000).join("\n"));
  } catch {
    /* nur Protokoll */
  }

  for (const unit of ["actracker-schaetzung", "actracker-vodchat"]) {
    const s = await sh("systemctl", ["--user", "is-active", unit]);
    if (s !== "active")
      problems[unit] = { title: `Dienst ${unit} läuft nicht`, message: `Zustand: ${s}. Nicht dringend, bitte bei Gelegenheit melden.`, priority: "low", tags: "gear", after: 30 * MIN };
  }

  const fs = statfsSync("/");
  const freeGb = (fs.bavail * fs.bsize) / 1e9;
  if (freeGb < 3)
    problems.disk = {
      title: "Speicherplatz wird knapp",
      message: `Nur noch ${freeGb.toFixed(1)} GB frei. Bitte aufräumen lassen, bevor die Datenbank voll läuft.`,
      priority: freeGb < 1 ? "urgent" : "high",
      tags: "floppy_disk",
      after: 0,
    };

  // VOD-Chat-Nachtrag: lange Pause nach Sperre durch Twitch
  const vod = await sh("journalctl", ["--user", "-u", "actracker-vodchat", "--since", "-7 hours", "--no-pager", "-o", "cat"]);
  if (/Fehler \((?:HTTP 4\d\d|.*integrity.*)\), Pause 360 Min/i.test(vod))
    problems.vodchat = {
      title: "Twitch bremst den Chat-Nachtrag",
      message: "Der Nachtrag aus den VOD-Chats wurde von Twitch abgewiesen und pausiert 6 Stunden. Nichts zu tun, er versucht es danach langsam weiter.",
      priority: "low",
      tags: "hourglass",
      after: 0,
    };
  return problems;
}

async function notify({ title, message, priority = "default", tags = "" }) {
  const r = await fetch(NTFY_URL, {
    method: "POST",
    body: message,
    headers: { Title: title, Priority: priority, Tags: tags, Click: "https://craftattack.hiorcraft.tv/" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
}

function load() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

const state = load();
if (process.argv.includes("--test")) {
  await notify({ title: "CraftAttack-Tracker: Test", message: "Benachrichtigungen funktionieren. Du bekommst eine Nachricht, wenn du etwas tun musst, und eine, wenn es wieder läuft.", tags: "white_check_mark" });
  console.log("Testnachricht gesendet");
  process.exit(0);
}
const now = Date.now();
const problems = await check();
for (const [key, p] of Object.entries(problems)) {
  const s = (state[key] ??= { since: now, notified: 0 });
  // Zwischendurch kurz gut: weiter derselbe Vorfall (keine neue Meldung, kein „Läuft wieder“)
  delete s.okSince;
  const due = now - s.since >= p.after && (!s.notified || now - s.notified >= REMIND_MS);
  if (due) {
    await notify({ ...p, title: s.notified ? `Noch immer: ${p.title}` : p.title, message: `${p.message} (seit ${berlin(s.since)} Uhr)` });
    s.notified = now;
    console.log(`gemeldet: ${key}`);
  }
}
// Erledigt: erst nach STABLE_MS ohne Problem, und nur melden, wenn vorher gemeldet wurde
for (const key of Object.keys(state)) {
  if (problems[key]) continue;
  if (state[key].notified) {
    state[key].okSince ??= now;
    if (now - state[key].okSince < STABLE_MS) continue;
    await notify({ title: "Läuft wieder", message: `Erledigt: ${key === "tunnel" ? "Tunnel ist wieder verbunden" : key === "polls" ? "Minecraft-Daten kommen wieder" : key === "web" ? "Website ist wieder erreichbar" : key === "webmem" ? "Website hat wieder genug Speicher" : key === "ram" ? "Server hat wieder genug Arbeitsspeicher" : key} (Problem seit ${berlin(state[key].since)} Uhr).`, priority: "low", tags: "white_check_mark" });
    console.log(`erledigt: ${key}`);
  }
  delete state[key];
}
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify(state));
