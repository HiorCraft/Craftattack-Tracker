import "server-only";
import { createHash } from "node:crypto";
import { appendLiveEvent, chatEvent, getEvents, getState, incrementLiveSubscriptionEvent, saveTwitchCheer, saveTwitchChatMessage, saveTwitchSub } from "./store";
import { observeSharedChatPair } from "./sharedChat";
import { noteChatter } from "./chatMoves";
import { KNOWN_LOGINS } from "./tracker";
import type { PlayerState, TrackerEvent } from "./types";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const SYNC_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const JOIN_INTERVAL_MS = 500;
const JOIN_WINDOW_MS = 10_000;
const MAX_JOINS_PER_WINDOW = 20;
const MAX_SEEN_IDS = 10_000;
/** Ab so vielen Bits in einem Cheer (während der Streamer auf dem Server ist) gibt es ein Ereignis; 1.000 Bits ≈ 10 € */
const CHEER_EVENT_MIN_BITS = Number(process.env.CA_CHEER_EVENT_MIN ?? 1000);
const SUB_NOTICE_TYPES: Record<string, string> = {
  sub: "Neues Abo",
  resub: "Resub",
  subgift: "Geschenk-Abo",
  anonsubgift: "Anonymes Geschenk-Abo",
  "anon-subgift": "Anonymes Geschenk-Abo",
  submysterygift: "Community-Geschenke",
  anonsubmysterygift: "Anonyme Community-Geschenke",
  "anon-submysterygift": "Anonyme Community-Geschenke",
  giftpaidupgrade: "Geschenk-Abo fortgeführt",
  anongiftpaidupgrade: "Anonymes Geschenk-Abo fortgeführt",
  primepaidupgrade: "Prime-Abo fortgeführt",
  standardpayforward: "Weitergegebenes Geschenk-Abo",
  communitypayforward: "Weitergegebene Community-Geschenke",
};
const GIFT_NOTICE_IDS = new Set([
  "subgift",
  "anonsubgift",
  "anon-subgift",
  "submysterygift",
  "anonsubmysterygift",
  "anon-submysterygift",
  "standardpayforward",
  "communitypayforward",
]);

interface TwitchIrcMessage {
  tags: Record<string, string>;
  prefix: string | null;
  command: string;
  params: string[];
  trailing: string | null;
}

function unescapeTag(value: string): string {
  return value.replace(/\\([snr:\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "s": return " ";
      case "n": return "\n";
      case "r": return "\r";
      case ":": return ";";
      default: return "\\";
    }
  });
}

function parseTwitchIrcMessage(line: string): TwitchIrcMessage | null {
  const match = /^(?:@([^ ]+) )?(?::([^ ]+) )?([^ ]+)(?: (.*))?$/.exec(line);
  if (!match) return null;
  const tags: Record<string, string> = {};
  for (const part of (match[1] ?? "").split(";")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const key = separator < 0 ? part : part.slice(0, separator);
    tags[key] = separator < 0 ? "" : unescapeTag(part.slice(separator + 1));
  }

  const rest = match[4] ?? "";
  const trailingAt = rest.indexOf(" :");
  const paramsText = trailingAt < 0 ? rest : rest.slice(0, trailingAt);
  const trailing = trailingAt < 0 ? null : rest.slice(trailingAt + 2);
  return {
    tags,
    prefix: match[2] ?? null,
    command: match[3],
    params: paramsText ? paramsText.split(" ") : [],
    trailing,
  };
}

interface ChannelOwner {
  id: string;
  name: string;
  uuid: string;
  streamStartedAt: string | null;
}

interface IrcState {
  socket: WebSocket | null;
  registered: boolean;
  joined: Set<string>;
  desired: Map<string, ChannelOwner>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  syncTimer: ReturnType<typeof setInterval> | null;
  joinTimer: ReturnType<typeof setTimeout> | null;
  joinTimes: number[];
  processing: Promise<void>;
  seenIds: Set<string>;
  seenOrder: string[];
  /** Twitch-Raum-ID → Kanal-Login (aus ROOMSTATE/PRIVMSG), um geteilte Nachrichten ihrem Ursprung zuzuordnen */
  roomIds: Map<string, string>;
  /** Chat-Nachrichten und Notices, deren Speichern fehlschlug (z. B. Datenbank kurz weg), mit Zahl der Versuche */
  retry: { socket: WebSocket; line: string; tries: number }[];
  retryTimer: ReturnType<typeof setTimeout> | null;
}

type Globals = typeof globalThis & { __acTwitchIrc?: IrcState };

function state(): IrcState {
  const gl = globalThis as Globals;
  if (!gl.__acTwitchIrc) {
    gl.__acTwitchIrc = {
      socket: null,
      registered: false,
      joined: new Set(),
      desired: new Map(),
      reconnectTimer: null,
      syncTimer: null,
      joinTimer: null,
      joinTimes: [],
      processing: Promise.resolve(),
      seenIds: new Set(),
      seenOrder: [],
      roomIds: new Map(),
      retry: [],
      retryTimer: null,
    };
  }
  gl.__acTwitchIrc.roomIds ??= new Map();
  return gl.__acTwitchIrc;
}

function ircCredentials(): { nick: string | null; token: string | null } {
  const nick = process.env.TWITCH_IRC_NICK?.trim().toLowerCase() || null;
  const rawToken = process.env.TWITCH_IRC_TOKEN?.trim() || null;
  const token = rawToken?.replace(/^oauth:/i, "") ?? null;
  if (Boolean(nick) !== Boolean(token)) {
    throw new Error("TWITCH_IRC_NICK und TWITCH_IRC_TOKEN müssen gemeinsam gesetzt sein.");
  }
  if ((nick && !/^[a-z0-9_]{1,25}$/.test(nick)) || (token && /[\r\n ]/.test(token))) {
    throw new Error("Ungültige Twitch-IRC-Zugangsdaten in TWITCH_IRC_NICK/TWITCH_IRC_TOKEN.");
  }
  return { nick, token };
}

function rememberEventId(irc: IrcState, id: string) {
  irc.seenIds.add(id);
  irc.seenOrder.push(id);
  if (irc.seenOrder.length > MAX_SEEN_IDS) {
    const expired = irc.seenOrder.shift();
    if (expired) irc.seenIds.delete(expired);
  }
}

function safeChannel(value: string): string | null {
  const login = value.trim().replace(/^#/, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
}

function mappedChannels(players: Record<string, PlayerState>): Map<string, ChannelOwner> {
  const channels = new Map<string, ChannelOwner>();
  const ordered = Object.values(players).sort((a, b) => Number(Boolean(b.live)) - Number(Boolean(a.live)));
  for (const player of ordered) {
    const login = safeChannel(player.twitchLogin ?? player.id);
    if (login && !channels.has(login)) {
      channels.set(login, {
        id: player.id,
        name: player.name,
        uuid: player.uuid,
        streamStartedAt: player.live ? player.liveSince ?? player.live.startedAt ?? null : null,
      });
    }
  }
  for (const [id, twitchLogin] of Object.entries(KNOWN_LOGINS)) {
    const login = safeChannel(twitchLogin);
    if (login && !channels.has(login)) {
      const player = players[id];
      channels.set(login, player
        ? { id, name: player.name, uuid: player.uuid, streamStartedAt: player.live ? player.liveSince ?? player.live.startedAt ?? null : null }
        : { id, name: id, uuid: "", streamStartedAt: null });
    }
  }
  return channels;
}

function playerForTwitchLogin(players: Record<string, PlayerState>, login: string): PlayerState | undefined {
  const normalized = safeChannel(login);
  if (!normalized) return undefined;
  return Object.values(players).find((player) =>
    [player.twitchLogin, KNOWN_LOGINS[player.id], player.id]
      .some((candidate) => candidate && safeChannel(candidate) === normalized),
  );
}

function nextJoinDelay(joinTimes: number[], now: number): number {
  while (joinTimes.length > 0 && joinTimes[0] <= now - JOIN_WINDOW_MS) joinTimes.shift();
  const windowDelay = joinTimes.length >= MAX_JOINS_PER_WINDOW
    ? joinTimes[0] + JOIN_WINDOW_MS - now
    : 0;
  const spacingDelay = joinTimes.length > 0
    ? Math.max(0, joinTimes[joinTimes.length - 1] + JOIN_INTERVAL_MS - now)
    : 0;
  return Math.max(windowDelay, spacingDelay);
}

function pumpJoins(irc: IrcState) {
  const socket = irc.socket;
  if (!socket || !irc.registered || socket.readyState !== WebSocket.OPEN || irc.joinTimer) return;

  for (const channel of irc.joined) {
    if (!irc.desired.has(channel)) {
      socket.send(`PART #${channel}\r\n`);
      irc.joined.delete(channel);
    }
  }
  const channel = [...irc.desired.keys()].find((candidate) => !irc.joined.has(candidate));
  if (!channel) return;

  const delay = nextJoinDelay(irc.joinTimes, Date.now());
  if (delay > 0) {
    irc.joinTimer = setTimeout(() => {
      irc.joinTimer = null;
      pumpJoins(irc);
    }, delay);
    return;
  }

  socket.send(`JOIN #${channel}\r\n`);
  irc.joined.add(channel);
  irc.joinTimes.push(Date.now());
  irc.joinTimer = setTimeout(() => {
    irc.joinTimer = null;
    pumpJoins(irc);
  }, JOIN_INTERVAL_MS);
}

function reconcileChannels(irc: IrcState) {
  pumpJoins(irc);
}

function scheduleReconnect(irc: IrcState) {
  if (irc.reconnectTimer) return;
  irc.reconnectTimer = setTimeout(() => {
    irc.reconnectTimer = null;
    connect(irc);
  }, RECONNECT_DELAY_MS);
}

function connect(irc: IrcState) {
  if (irc.socket || typeof WebSocket === "undefined") {
    if (typeof WebSocket === "undefined") console.error("[twitch-irc] WebSocket ist in dieser Node.js-Runtime nicht verfügbar.");
    return;
  }
  try {
    const credentials = ircCredentials();
    const socket = new WebSocket(IRC_URL);
    irc.socket = socket;
    irc.registered = false;
    irc.joined.clear();
    socket.addEventListener("open", () => {
      socket.send(`PASS ${credentials.token ? `oauth:${credentials.token}` : "SCHMOOPIIE"}\r\n`);
      socket.send(`NICK ${credentials.nick ?? `justinfan${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`}\r\n`);
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      for (const line of event.data.split(/\r\n/)) {
        if (!line) continue;
        processLine(irc, socket, line, 0);
      }
    });
    socket.addEventListener("close", () => {
      if (irc.socket === socket) irc.socket = null;
      irc.registered = false;
      irc.joined.clear();
      if (irc.joinTimer) clearTimeout(irc.joinTimer);
      irc.joinTimer = null;
      scheduleReconnect(irc);
    });
    socket.addEventListener("error", () => {
      console.error("[twitch-irc] WebSocket-Verbindung fehlgeschlagen.");
      socket.close();
    });
  } catch (error) {
    console.error("[twitch-irc] Verbindung konnte nicht gestartet werden:", error instanceof Error ? error.message : error);
  }
}

const RETRY_MS = 30_000;
/** Etwa eine Stunde lang erneut versuchen, so lange darf die Datenbank weg sein */
const MAX_RETRIES = 120;
const MAX_RETRY_LINES = 20_000;

function processLine(irc: IrcState, socket: WebSocket, line: string, tries: number) {
  irc.processing = irc.processing
    .then(() => handleLine(irc, socket, line))
    .catch((error: unknown) => {
      // Nur Nachrichten und Notices nachholen; deren Zeitpunkt steht im Tag `tmi-sent-ts`, die IDs sind fest.
      const retryable = / (PRIVMSG|USERNOTICE) /.test(line) && tries < MAX_RETRIES && irc.retry.length < MAX_RETRY_LINES;
      if (tries === 0) console.error(`[twitch-irc] IRC-Nachricht konnte nicht verarbeitet werden${retryable ? ", neuer Versuch folgt" : ""}:`, error instanceof Error ? error.message : error);
      if (!retryable) return;
      irc.retry.push({ socket, line, tries: tries + 1 });
      irc.retryTimer ??= setTimeout(() => {
        irc.retryTimer = null;
        const lines = irc.retry.splice(0);
        if (lines.length) console.log(`[twitch-irc] ${lines.length} IRC-Nachrichten erneut verarbeiten`);
        for (const r of lines) processLine(irc, r.socket, r.line, r.tries);
      }, RETRY_MS);
    });
}

/**
 * Speichert einen Cheer im Kanal eines Spielers. Ein großer Cheer (ab CHEER_EVENT_MIN_BITS) während der Streamer auf
 * dem Server ist, wird außerdem ein Ereignis. Cheert ein anderer Spieler, steht er mit Kopf im Ereignis.
 */
async function recordCheer(
  irc: IrcState,
  message: TwitchIrcMessage,
  channel: string,
  owner: ChannelOwner,
  fromLogin: string,
  bits: number,
  at: string,
  players: Record<string, PlayerState>,
) {
  const player = players[owner.id];
  if (!player) return;
  const fromName = message.tags["display-name"] || fromLogin;
  const idSource = message.tags.id ?? `${channel}:${fromLogin}:${at}:${bits}`;
  const id = `twitch-cheer-${createHash("sha256").update(idSource).digest("hex").slice(0, 32)}`;
  const onServer = player.online;
  if (!(await saveTwitchCheer({ id, at, channelId: player.id, fromLogin, fromName, bits, onServer }))) return;
  if (!onServer || bits < CHEER_EVENT_MIN_BITS || irc.seenIds.has(id)) return;
  const cheerer = playerForTwitchLogin(players, fromLogin);
  await appendLiveEvent({
    id,
    at,
    type: "cheer",
    player: player.id,
    playerName: player.name,
    uuid: player.uuid,
    where: "twitch",
    value: bits,
    delta: bits,
    meta: {
      bits,
      fromName,
      fromLogin,
      channel,
      ...(cheerer && cheerer.id !== player.id ? { fromPlayerId: cheerer.id, fromPlayerName: cheerer.name, fromPlayerUuid: cheerer.uuid } : {}),
    },
  });
  rememberEventId(irc, id);
}

/** Hält eine Abo-Meldung einzeln mit Stufe fest, auch abseits des Servers (Einnahmen-Schätzung, intern). */
async function recordSub(message: TwitchIrcMessage, event: TrackerEvent, player: PlayerState) {
  const kind = message.tags["msg-id"];
  const number = (key: string) => {
    const n = Number(message.tags[key]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Community-Geschenk und seine Einzelmeldungen tragen dieselbe ID; ältere Meldungen nur origin-id am Sammelhinweis
  const group = message.tags["msg-param-community-gift-id"]
    || (kind.endsWith("submysterygift") ? message.tags["msg-param-origin-id"] : "")
    || null;
  await saveTwitchSub({
    id: event.id,
    at: event.at,
    channelId: player.id,
    kind,
    plan: message.tags["msg-param-sub-plan"] || null,
    months: number("msg-param-cumulative-months") ?? number("msg-param-months"),
    giftCount: number("msg-param-mass-gift-count"),
    giftGroup: group,
    fromLogin: message.tags.login?.toLowerCase() || null,
    onServer: player.online,
  });
}

function subscriptionEventFromNotice(message: TwitchIrcMessage, owner?: ChannelOwner): TrackerEvent | null {
  if (message.command !== "USERNOTICE") return null;
  const msgId = message.tags["msg-id"];
  const kind = msgId ? SUB_NOTICE_TYPES[msgId] : null;
  const channel = safeChannel(message.params[0] ?? "");
  if (!kind || !channel) return null;

  const sentAt = Number(message.tags["tmi-sent-ts"]);
  const timestamp = new Date(sentAt);
  const at = Number.isFinite(sentAt) && sentAt > 0 && Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString()
    : new Date().toISOString();
  const login = message.tags.login || message.tags["display-name"] || "";
  const subscriber = message.tags["display-name"] || login || "Unbekannt";
  const months = Number(message.tags["msg-param-cumulative-months"] ?? message.tags["msg-param-months"]);
  const idSource = message.tags.id ?? `${channel}:${at}:${msgId}:${login}:${message.trailing ?? ""}`;
  const id = `twitch-irc-${createHash("sha256").update(idSource).digest("hex").slice(0, 32)}`;
  const meta: NonNullable<TrackerEvent["meta"]> = {
    channel,
    kind,
    subscriber,
    msgId,
  };
  if (GIFT_NOTICE_IDS.has(msgId)) {
    meta.giftNotice = true;
    if (message.tags.login) meta.giftGiverLogin = message.tags.login.toLowerCase();
    if (subscriber) meta.giftGiverName = subscriber;
  }
  if (Number.isFinite(months) && months > 0) meta.months = months;
  const plan = message.tags["msg-param-sub-plan"];
  if (plan) meta.plan = plan;
  const planName = message.tags["msg-param-sub-plan-name"];
  if (planName) meta.planName = planName;
  const giftCount = Number(message.tags["msg-param-mass-gift-count"]);
  if (Number.isFinite(giftCount) && giftCount > 0) meta.giftCount = giftCount;
  const giftMonths = Number(message.tags["msg-param-gift-months"]);
  if (Number.isFinite(giftMonths) && giftMonths > 0) meta.giftMonths = giftMonths;
  const recipient = message.tags["msg-param-recipient-display-name"] || message.tags["msg-param-recipient-user-name"];
  if (recipient) meta.recipient = recipient;
  if (message.trailing) meta.message = message.trailing;

  const event: TrackerEvent = { id, at, type: "subscription", where: "twitch", meta };
  event.delta = Number.isFinite(Number(meta.giftCount)) && Number(meta.giftCount) > 0
    ? Number(meta.giftCount)
    : 1;
  if (owner) {
    event.player = owner.id;
    event.playerName = owner.name;
    if (owner.uuid) event.uuid = owner.uuid;
  }
  return event;
}

function raidEventFromNotice(
  message: TwitchIrcMessage,
  channel: string,
  raider: PlayerState,
  target: ChannelOwner,
): TrackerEvent | null {
  if (message.command !== "USERNOTICE" || message.tags["msg-id"] !== "raid") return null;
  const sentAt = Number(message.tags["tmi-sent-ts"]);
  const timestamp = new Date(sentAt);
  const at = Number.isFinite(sentAt) && sentAt > 0 && Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString()
    : new Date().toISOString();
  const viewerCount = Number(message.tags["msg-param-viewerCount"]);
  const idSource = message.tags.id ?? `${channel}:${at}:raid:${raider.id}:${target.id}:${message.trailing ?? ""}`;
  const id = `twitch-irc-${createHash("sha256").update(idSource).digest("hex").slice(0, 32)}`;
  return {
    id,
    at,
    type: "raid",
    player: raider.id,
    playerName: raider.name,
    uuid: raider.uuid,
    where: "twitch",
    ...(Number.isFinite(viewerCount) && viewerCount > 0 ? { value: viewerCount } : {}),
    meta: {
      raidLogin: message.tags["msg-param-login"] ?? raider.twitchLogin ?? raider.id,
      raidTargetPlayerId: target.id,
      raidTargetName: target.name,
      raidTargetUuid: target.uuid,
      raidTargetLogin: channel,
    },
  };
}

async function handleLine(irc: IrcState, socket: WebSocket, line: string) {
  if (line.startsWith("PING ")) {
    socket.send(line.replace(/^PING/, "PONG") + "\r\n");
    return;
  }
  const message = parseTwitchIrcMessage(line);
  if (!message) return;
  if (message.command === "RECONNECT") {
    socket.close();
    return;
  }
  if (message.command === "NOTICE" || message.command === "ERROR") {
    console.warn("[twitch-irc] Twitch-Servermeldung:", message.trailing ?? line);
    return;
  }
  if (message.command === "CAP" && line.includes(" NAK ")) {
    console.error("[twitch-irc] Twitch hat die angeforderten IRC-Funktionen abgelehnt.");
    socket.close();
    return;
  }
  if (message.command === "001") {
    irc.registered = true;
    reconcileChannels(irc);
    return;
  }
  if (message.command === "ROOMSTATE") {
    const channel = safeChannel(message.params[0] ?? "");
    if (channel && message.tags["room-id"]) irc.roomIds.set(message.tags["room-id"], channel);
    return;
  }
  if (message.command === "PRIVMSG") {
    const channel = safeChannel(message.params[0] ?? "");
    const senderLogin = safeChannel(message.prefix?.split("!", 1)[0] ?? message.tags.login ?? "");
    const owner = channel ? irc.desired.get(channel) : undefined;
    if (!channel || !senderLogin || !owner || !message.trailing?.trim()) return;
    const roomId = message.tags["room-id"];
    if (roomId) irc.roomIds.set(roomId, channel);

    // Geteilter Chat (Stream Together): Twitch liefert die Nachricht in jedem beteiligten Kanal aus. Kopien tragen
    // die Raum-ID des Ursprungskanals und die ID der Originalnachricht. Gespeichert wird sie nur einmal, beim
    // Kanal, in dem sie geschrieben wurde; die anderen Kanäle landen in `sharedWith`.
    const sourceRoomId = message.tags["source-room-id"];
    const isCopy = Boolean(sourceRoomId && roomId && sourceRoomId !== roomId);
    const sourceChannel = isCopy ? irc.roomIds.get(sourceRoomId!) : channel;
    const sourceOwner = sourceChannel ? irc.desired.get(sourceChannel) : undefined;

    const currentState = await getState();
    const sentAt = Number(message.tags["tmi-sent-ts"]);
    const timestamp = new Date(sentAt);
    const at = Number.isFinite(sentAt) && sentAt > 0 && Number.isFinite(timestamp.getTime())
      ? timestamp.toISOString()
      : new Date().toISOString();

    // Chat-Spur (nur Summen, siehe lib/chatMoves.ts); Kopien aus dem geteilten Chat nicht doppelt
    if (!isCopy) noteChatter(owner.id, message.tags["user-id"], Number.isFinite(sentAt) && sentAt > 0 ? sentAt : Date.now());

    // Cheer (Bits): nur im Ursprungskanal zählen, Kopien aus dem geteilten Chat nicht noch einmal
    const bits = Number(message.tags.bits);
    if (bits > 0 && !isCopy) await recordCheer(irc, message, channel, owner, senderLogin, bits, at, currentState.players);

    // Hinweis auf einen geteilten Chat zwischen zwei erfassten Kanälen (nur ohne Twitch-API-Zugang ausgewertet)
    if (isCopy && sourceOwner && currentState.players[sourceOwner.id] && currentState.players[owner.id]) {
      for (const event of await observeSharedChatPair(sourceOwner.id, owner.id, currentState.players, at)) {
        if (irc.seenIds.has(event.id)) continue;
        await appendLiveEvent(event);
        rememberEventId(irc, event.id);
      }
    }

    // Ursprung ist kein erfasster Spieler-Kanal: keine Nachricht zwischen Spielern
    if (!sourceOwner || !currentState.players[sourceOwner.id]) return;
    const sender = playerForTwitchLogin(currentState.players, senderLogin);
    // Eigener Chat (auch wenn er per geteiltem Chat bei anderen erscheint) zählt nicht
    if (!sender || sender.id === sourceOwner.id) return;

    const idSource = message.tags["source-id"] ?? message.tags.id ?? `${sourceChannel}:${sender.id}:${at}:${message.trailing}`;
    const id = `twitch-chat-${createHash("sha256").update(idSource).digest("hex").slice(0, 32)}`;
    const chat = {
      id,
      at,
      senderId: sender.id,
      senderName: sender.name,
      channelId: sourceOwner.id,
      channelName: sourceOwner.name,
      message: message.trailing,
      sharedWith: isCopy && owner.id !== sourceOwner.id && owner.id !== sender.id ? [owner.id] : [],
    };
    // Neue Nachricht zwischen Spielern auch als Ereignis (Kopien aus dem geteilten Chat nicht noch einmal)
    if (await saveTwitchChatMessage(chat)) await appendLiveEvent(chatEvent(chat, currentState.players));
    return;
  }
  if (message.command !== "USERNOTICE") return;
  const channel = safeChannel(message.params[0] ?? "");
  if (!channel) return;
  const owner = channel ? irc.desired.get(channel) : undefined;
  if (message.tags["msg-id"] === "raid") {
    const raiderLogin = message.tags["msg-param-login"];
    if (!owner || !raiderLogin) return;
    const currentState = await getState();
    const raider = playerForTwitchLogin(currentState.players, raiderLogin);
    if (!raider || raider.id === owner.id) return;
    const event = raidEventFromNotice(message, channel, raider, owner);
    if (!event || irc.seenIds.has(event.id)) return;
    await appendLiveEvent(event);
    rememberEventId(irc, event.id);
    return;
  }
  const event = subscriptionEventFromNotice(message, owner);
  if (!event || irc.seenIds.has(event.id)) return;
  const currentState = await getState();
  const player = event.player ? currentState.players[event.player] : undefined;
  if (player) {
    await recordSub(message, event, player).catch((error) => {
      console.error("[twitch-irc] Abo-Meldung nicht gespeichert:", error instanceof Error ? error.message : error);
    });
  }
  if (!player?.online) {
    rememberEventId(irc, event.id);
    return;
  }
  const streamStartedAt = player
    ? player.live ? player.liveSince ?? player.live.startedAt ?? null : null
    : owner?.streamStartedAt ?? null;
  const minute = Math.floor(Date.parse(event.at) / 60_000) * 60_000;
  const count = event.delta ?? 1;
  const giftGiver = event.meta?.giftNotice && typeof event.meta.giftGiverLogin === "string"
    ? playerForTwitchLogin(currentState.players, event.meta.giftGiverLogin)
    : undefined;
  if (giftGiver && giftGiver.id !== player.id) {
    await appendLiveEvent({
      ...event,
      type: "subscription_gift",
      player: player.id,
      playerName: player.name,
      uuid: player.uuid,
      delta: count,
      value: count,
      meta: {
        channel,
        bucket: "minute",
        streamStartedAt,
        serverOnline: true,
        giftGiverPlayerId: giftGiver.id,
        giftGiverName: giftGiver.name,
        giftGiverUuid: giftGiver.uuid,
        giftCount: count,
      },
    });
    rememberEventId(irc, event.id);
    return;
  }
  await incrementLiveSubscriptionEvent({
    ...event,
    id: `twitch-subs-online-${channel}-${streamStartedAt ?? "unknown"}-${minute}`,
    at: new Date(minute).toISOString(),
    delta: count,
    value: count,
    meta: { channel, bucket: "minute", streamStartedAt, serverOnline: true },
  });
  rememberEventId(irc, event.id);
}

async function syncChannels(irc: IrcState) {
  const current = await getState();
  const channels = mappedChannels(current.players);
  irc.desired = channels;
  reconcileChannels(irc);
  connect(irc);
}

/** Startet den IRC-Empfang einmal pro Node-Prozess. */
export function startTwitchIrc() {
  const irc = state();
  if (irc.syncTimer) return;
  try {
    ircCredentials();
  } catch (error) {
    console.error("[twitch-irc] IRC deaktiviert:", error instanceof Error ? error.message : error);
    return;
  }
  void getEvents().then((events) => {
    for (const event of events) {
      if (event.id.startsWith("twitch-irc-")) rememberEventId(irc, event.id);
    }
    void syncChannels(irc).catch((error: unknown) => {
      console.error("[twitch-irc] Kanäle konnten nicht synchronisiert werden:", error);
    });
  }).catch((error: unknown) => {
    console.error("[twitch-irc] Ereignisse konnten nicht geladen werden:", error);
  });
  irc.syncTimer = setInterval(() => {
    void syncChannels(irc).catch((error: unknown) => {
      console.error("[twitch-irc] Kanäle konnten nicht synchronisiert werden:", error);
    });
  }, SYNC_INTERVAL_MS);
}
