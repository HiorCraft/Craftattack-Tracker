import "server-only";
import { createHash } from "node:crypto";
import { getActiveSharedChatSessions, saveSharedChatSession, type SharedChatSession } from "./store";
import { fetchSharedChatSession, TWITCH_ENABLED } from "./twitch";
import type { PlayerState, TrackerEvent } from "./types";

/**
 * Geteilter Chat (Twitch „Shared Chat", beim gemeinsamen Streamen „Stream Together").
 *
 * Erkennung:
 * - Mit Twitch-App-Zugang fragt der Tracker bei jedem Poll für live streamende Spieler die Shared-Chat-Session ab
 *   (ein Aufruf je Session, nicht je Kanal). Das ist genau und liefert Beginn und Ende.
 * - Ohne Twitch-App-Zugang wird der geteilte Chat aus Chat-Nachrichten erschlossen: Eine Kopie mit fremdem
 *   `source-room-id` zeigt, dass zwei Kanäle verbunden sind (jede Zuschauernachricht zählt). Ohne neue Hinweise
 *   endet so eine Session nach CHAT_SESSION_IDLE_MS, mit dem Zeitpunkt des letzten Hinweises als Ende. Der
 *   Live-Status taugt dafür nicht: ohne Twitch-API kennt der Tracker nur Streams, die craftattack.one meldet.
 */

const CHAT_SESSION_IDLE_MS = 30 * 60_000;

type Globals = typeof globalThis & { __acShared?: { active: Map<string, SharedChatSession>; loaded: Promise<void> | null } };

function g() {
  const gl = globalThis as Globals;
  if (!gl.__acShared) gl.__acShared = { active: new Map(), loaded: null };
  return gl.__acShared;
}

async function ensureActive() {
  const s = g();
  if (!s.loaded) {
    s.loaded = getActiveSharedChatSessions().then((list) => {
      for (const x of list) s.active.set(x.key, x);
    });
  }
  await s.loaded;
}

const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();
const eventId = (key: string, kind: string, at: string) => `shared-chat-${kind}-${createHash("sha256").update(`${key}:${at}`).digest("hex").slice(0, 24)}`;

/** Ereignis für Beginn oder Ende; alle beteiligten Spieler stehen in `meta`, damit es in jedem Profil auftaucht. */
function sessionEvent(kind: "start" | "end", s: SharedChatSession, players: Record<string, PlayerState>, at: string): TrackerEvent | null {
  const ids = s.participants.filter((id) => players[id]);
  if (ids.length === 0) return null;
  const first = players[ids[0]];
  const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(s.startedAt)) / 1000));
  return {
    id: eventId(s.key, kind, at),
    at,
    type: kind === "start" ? "shared_chat_start" : "shared_chat_end",
    player: first.id,
    playerName: first.name,
    uuid: first.uuid,
    where: "twitch",
    value: ids.length + s.otherCount,
    ...(kind === "end" ? { delta: seconds } : {}),
    meta: {
      sharedChatKey: s.key,
      sharedChatPlayers: ids.join(","),
      sharedChatNames: ids.map((id) => players[id].name).join(", "),
      sharedChatUuids: ids.map((id) => players[id].uuid).join(","),
      sharedChatOthers: s.otherCount,
      sharedChatSource: s.source,
    },
  };
}

async function start(s: SharedChatSession, players: Record<string, PlayerState>, out: TrackerEvent[]) {
  g().active.set(s.key, s);
  await saveSharedChatSession(s);
  const e = sessionEvent("start", s, players, s.startedAt);
  if (e) out.push(e);
}

async function end(s: SharedChatSession, players: Record<string, PlayerState>, at: string, out: TrackerEvent[]) {
  g().active.delete(s.key);
  const ended = { ...s, endedAt: at };
  await saveSharedChatSession(ended);
  const e = sessionEvent("end", ended, players, at);
  if (e) out.push(e);
}

/**
 * Abgleich mit der Twitch-API für alle live streamenden erfassten Spieler. Liefert neue Ereignisse.
 * `live` enthält je Spieler die Twitch-Nutzer-ID seines Kanals (aus der Streams-Abfrage).
 */
export async function syncSharedChatFromApi(live: { playerId: string; broadcasterId: string }[], players: Record<string, PlayerState>, now: string): Promise<TrackerEvent[]> {
  if (!TWITCH_ENABLED) return [];
  await ensureActive();
  const out: TrackerEvent[] = [];
  const playerOf = new Map(live.map((l) => [l.broadcasterId, l.playerId]));
  const covered = new Set<string>();
  const found = new Map<string, { participants: string[]; others: number; createdAt: string }>();
  for (const l of live) {
    if (covered.has(l.broadcasterId)) continue;
    const session = await fetchSharedChatSession(l.broadcasterId);
    covered.add(l.broadcasterId);
    if (!session) continue;
    for (const b of session.participants) covered.add(b);
    const ids = session.participants.map((b) => playerOf.get(b)).filter((id): id is string => Boolean(id));
    found.set(session.sessionId, { participants: sorted(ids), others: session.participants.length - ids.length, createdAt: session.createdAt });
  }
  for (const [sessionId, f] of found) {
    if (f.participants.length === 0) continue;
    const key = `api:${sessionId}`;
    const existing = g().active.get(key);
    if (existing) {
      const updated = { ...existing, participants: sorted([...existing.participants, ...f.participants]), otherCount: f.others, lastSeenAt: now };
      g().active.set(key, updated);
      await saveSharedChatSession(updated);
    } else {
      await start({ key, sessionId, source: "api", participants: f.participants, otherCount: f.others, startedAt: f.createdAt || now, lastSeenAt: now, endedAt: null }, players, out);
    }
  }
  // Von Twitch nicht mehr gemeldet: beendet
  for (const s of [...g().active.values()]) {
    if (s.source !== "api" || found.has(s.sessionId ?? "")) continue;
    await end(s, players, now, out);
  }
  return out;
}

/**
 * Ohne Twitch-App-Zugang: Hinweis aus einer geteilten Chat-Nachricht (Kanal `a` und `b` sind verbunden).
 * Liefert ein Start-Ereignis, wenn dadurch ein neuer geteilter Chat beginnt.
 */
export async function observeSharedChatPair(a: string, b: string, players: Record<string, PlayerState>, at: string): Promise<TrackerEvent[]> {
  if (TWITCH_ENABLED || a === b) return [];
  await ensureActive();
  const out: TrackerEvent[] = [];
  const match = [...g().active.values()].find((s) => s.source === "chat" && (s.participants.includes(a) || s.participants.includes(b)));
  if (match) {
    const updated = { ...match, participants: sorted([...match.participants, a, b]), lastSeenAt: at };
    g().active.set(match.key, updated);
    await saveSharedChatSession(updated);
    return out;
  }
  const participants = sorted([a, b]);
  await start({ key: `chat:${participants.join("+")}:${at}`, sessionId: null, source: "chat", participants, otherCount: 0, startedAt: at, lastSeenAt: at, endedAt: null }, players, out);
  return out;
}

/** Ohne Twitch-App-Zugang: aus Chat erschlossene Sessions beenden, sobald sie verstummt sind. */
export async function expireChatSessions(players: Record<string, PlayerState>, now: string): Promise<TrackerEvent[]> {
  if (TWITCH_ENABLED) return [];
  await ensureActive();
  const out: TrackerEvent[] = [];
  const t = Date.parse(now);
  for (const s of [...g().active.values()]) {
    if (s.source !== "chat") continue;
    if (t - Date.parse(s.lastSeenAt) >= CHAT_SESSION_IDLE_MS) await end(s, players, s.lastSeenAt, out);
  }
  return out;
}
