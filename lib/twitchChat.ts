import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import { appendEvents, getState, saveState } from "./store";
import type { PlayerState, TrackerEvent } from "./types";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const RETRY_MS = 10_000;
const MAX_SEEN_IDS = 500;

interface IrcMessage {
  tags: Map<string, string>;
  command: string;
  params: string[];
  prefix: string;
}

interface ChatRuntime {
  desired: Map<string, PlayerState>;
  playersByLogin: Map<string, PlayerState>;
  socket: WebSocket | null;
  ready: boolean;
  joined: Set<string>;
  retry: ReturnType<typeof setTimeout> | null;
  seenIds: Set<string>;
}

type Globals = typeof globalThis & { __acTwitchChat?: ChatRuntime };

function runtime(): ChatRuntime {
  const gl = globalThis as Globals;
  if (!gl.__acTwitchChat) {
    gl.__acTwitchChat = {
      desired: new Map(),
      playersByLogin: new Map(),
      socket: null,
      ready: false,
      joined: new Set(),
      retry: null,
      seenIds: new Set(),
    };
  }
  return gl.__acTwitchChat;
}

function normalize(login: string) {
  return login.replace(/^#/, "").toLowerCase();
}

function unescapeTag(value: string) {
  return value.replace(/\\([snr:\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "s": return " ";
      case "n": return "\n";
      case "r": return "\r";
      case ":": return ";";
      case "\\": return "\\";
      default: return escaped;
    }
  });
}

function parseIrcMessage(line: string): IrcMessage | null {
  let rest = line;
  const tags = new Map<string, string>();
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    for (const pair of rest.slice(1, end).split(";")) {
      const [key, ...parts] = pair.split("=");
      if (key) tags.set(key, unescapeTag(parts.join("=")));
    }
    rest = rest.slice(end + 1);
  }

  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }

  const trailingAt = rest.indexOf(" :");
  const head = trailingAt < 0 ? rest : rest.slice(0, trailingAt);
  const params = head.split(" ").filter(Boolean);
  const command = params.shift();
  if (!command) return null;
  if (trailingAt >= 0) params.push(rest.slice(trailingAt + 2));
  return { tags, command, params, prefix };
}

function refreshChannels(client: ChatRuntime, socket: WebSocket) {
  if (!client.ready || socket.readyState !== WebSocket.OPEN) return;
  try {
    const wanted = new Set(client.desired.keys());
    for (const channel of client.joined) {
      if (!wanted.has(channel)) {
        socket.send(`PART #${channel}`);
        client.joined.delete(channel);
      }
    }
    for (const channel of wanted) {
      if (!client.joined.has(channel)) {
        socket.send(`JOIN #${channel}`);
        client.joined.add(channel);
      }
    }
  } catch (error) {
    console.error("[twitch-chat] Kanal-Abos konnten nicht aktualisiert werden:", error);
    socket.close();
  }
}

function scheduleReconnect(client: ChatRuntime) {
  if (client.desired.size === 0 || client.retry) return;
  client.retry = setTimeout(() => {
    client.retry = null;
    connect(client);
  }, RETRY_MS);
}

function connect(client: ChatRuntime) {
  if (client.socket || client.desired.size === 0) return;

  let socket: WebSocket;
  try {
    socket = new WebSocket(IRC_URL);
  } catch (error) {
    console.error("[twitch-chat] Verbindung konnte nicht gestartet werden:", error);
    scheduleReconnect(client);
    return;
  }

  client.socket = socket;
  client.ready = false;
  client.joined.clear();

  socket.addEventListener("open", () => {
    try {
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      socket.send("PASS SCHMOOPIIE");
      socket.send(`NICK justinfan${randomInt(10_000_000, 100_000_000)}`);
    } catch (error) {
      console.error("[twitch-chat] IRC-Anmeldung fehlgeschlagen:", error);
      socket.close();
    }
  });

  socket.addEventListener("message", (event) => {
    void handleFrame(client, socket, event.data).catch((error: unknown) => {
      console.error("[twitch-chat] IRC-Nachricht konnte nicht verarbeitet werden:", error);
    });
  });

  socket.addEventListener("error", () => {
    console.warn("[twitch-chat] Verbindung zum Twitch-Chat fehlgeschlagen");
    socket.close();
  });

  socket.addEventListener("close", () => {
    if (client.socket !== socket) return;
    client.socket = null;
    client.ready = false;
    client.joined.clear();
    scheduleReconnect(client);
  });
}

async function frameText(data: unknown): Promise<string | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return null;
}

async function handleFrame(client: ChatRuntime, socket: WebSocket, data: unknown) {
  const text = await frameText(data);
  if (text === null) return;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const message = parseIrcMessage(line);
    if (!message) continue;

    if (message.command === "PING") {
      socket.send(`PONG :${message.params.at(-1) ?? "tmi.twitch.tv"}`);
    } else if (message.command === "001") {
      client.ready = true;
      refreshChannels(client, socket);
    } else if (message.command === "RECONNECT") {
      socket.close();
    } else if (message.command === "USERNOTICE" && message.tags.get("msg-id") === "raid") {
      await recordRaid(client, message);
    }
  }
}

async function recordRaid(client: ChatRuntime, message: IrcMessage) {
  const targetLogin = message.params[0];
  if (!targetLogin) return;
  const target = client.desired.get(normalize(targetLogin));
  if (!target) return;

  const prefixLogin = message.prefix.split("!")[0];
  const sourceLogin = normalize(message.tags.get("login") || prefixLogin);
  const source = client.playersByLogin.get(sourceLogin);
  if (!source || source.id === target.id) return;

  const raidId = message.tags.get("id") || randomUUID();
  if (client.seenIds.has(raidId)) return;
  client.seenIds.add(raidId);
  if (client.seenIds.size > MAX_SEEN_IDS) {
    const oldest = client.seenIds.values().next().value;
    if (oldest) client.seenIds.delete(oldest);
  }

  const viewerCount = Number(message.tags.get("msg-param-viewerCount"));
  const event: TrackerEvent = {
    id: `raid-${raidId}`,
    at: new Date().toISOString(),
    type: "raid",
    player: source.id,
    playerName: source.name,
    uuid: source.uuid,
    where: "twitch",
    value: Number.isFinite(viewerCount) && viewerCount >= 0 ? viewerCount : undefined,
    meta: {
      login: sourceLogin,
      targetPlayerId: target.id,
      targetPlayerName: target.name,
      targetUuid: target.uuid,
      targetLogin: normalize(targetLogin),
    },
  };

  await appendEvents([event]);
  const state = await getState();
  state.eventCount += 1;
  await saveState(state);
  console.log(`[twitch-chat] Raid erkannt: ${source.name} → ${target.name}`);
}

/** Liest anonym die Chats aktiver Streams mit und erkennt Raid-Meldungen zwischen erfassten Spielern. */
export function syncTwitchChat(players: Record<string, PlayerState>) {
  const client = runtime();
  const desired = new Map<string, PlayerState>();
  const playersByLogin = new Map<string, PlayerState>();

  for (const player of Object.values(players)) {
    const logins = new Set([player.id, player.twitchLogin, player.live?.login].filter((login): login is string => Boolean(login)));
    for (const login of logins) playersByLogin.set(normalize(login), player);
    if (player.live?.login) desired.set(normalize(player.live.login), player);
  }

  client.desired = desired;
  client.playersByLogin = playersByLogin;
  if (desired.size === 0) {
    if (client.retry) clearTimeout(client.retry);
    client.retry = null;
    const socket = client.socket;
    client.socket = null;
    client.ready = false;
    client.joined.clear();
    socket?.close();
    return;
  }

  if (client.socket?.readyState === WebSocket.OPEN) refreshChannels(client, client.socket);
  else connect(client);
}
