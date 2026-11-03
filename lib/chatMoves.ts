import "server-only";
import { getDb } from "./db";

/**
 * Chat-Spuren für die Zuschauerwanderung: Schreibt jemand im Chat von A und kurz darauf (bis 45 Min) im Chat von B,
 * zählt das als Wechsel A → B. Gespeichert werden NUR Summen je 5-Minuten-Abschnitt und Kanalpaar
 * (`viewer_chat_moves`): wie viele wechselten, wie viele später noch bei B schrieben (geblieben) und wie viele
 * zurück zu A gingen. Twitch-Nutzerkennungen liegen nur im Arbeitsspeicher, höchstens 90 Minuten, und werden nie
 * geschrieben oder geloggt.
 *
 * Schreiber sind nur ein Teil der Zuschauer (die aktiven), aber jeder Wechsel ist ein direkter Beleg, wer wohin
 * geht, auch wenn gleichzeitig mehrere Streams enden und die Zuschauerzahlen allein das nicht trennen.
 */

const MOVE_WINDOW_MS = 45 * 60_000;
/** Geblieben: schreibt 20–90 Min nach dem Wechsel noch einmal bei B */
const STAY_AFTER_MS = 20 * 60_000;
const FOLLOW_MS = 90 * 60_000;
const FLUSH_MS = 60_000;

interface Seen {
  chan: string;
  at: number;
}
interface Moved {
  from: string;
  to: string;
  key: string;
  at: number;
  stay: boolean;
  back: boolean;
}
type Counts = { n: number; stay: number; back: number };

type Globals = typeof globalThis & {
  __acChatMoves?: { seen: Map<string, Seen>; moved: Map<string, Moved>; pending: Map<string, Counts>; timer: ReturnType<typeof setInterval> | null };
};

function mem() {
  const g = globalThis as Globals;
  g.__acChatMoves ??= { seen: new Map(), moved: new Map(), pending: new Map(), timer: null };
  return g.__acChatMoves;
}

function bump(key: string, field: keyof Counts) {
  const m = mem();
  const p = m.pending.get(key) ?? { n: 0, stay: 0, back: 0 };
  p[field]++;
  m.pending.set(key, p);
  m.timer ??= setInterval(() => void flushChatMoves(), FLUSH_MS);
}

/** Eine Chat-Nachricht von `user` (Twitch-Nutzer-ID) im Kanal des Spielers `chan` zur Zeit `at` (ms) */
export function noteChatter(chan: string, user: string | undefined, at: number) {
  if (!user || !Number.isFinite(at)) return;
  const m = mem();
  const mv = m.moved.get(user);
  if (mv) {
    if (!mv.stay && chan === mv.to && at - mv.at >= STAY_AFTER_MS && at - mv.at <= FOLLOW_MS) {
      mv.stay = true;
      bump(mv.key, "stay");
    }
    if (!mv.back && chan === mv.from && at - mv.at <= FOLLOW_MS) {
      mv.back = true;
      bump(mv.key, "back");
    }
  }
  const prev = m.seen.get(user);
  if (prev && prev.chan !== chan && at - prev.at <= MOVE_WINDOW_MS && at >= prev.at) {
    const key = `${Math.floor(at / 60_000 / 5)}|${prev.chan}|${chan}`;
    bump(key, "n");
    m.moved.set(user, { from: prev.chan, to: chan, key, at, stay: false, back: false });
  }
  m.seen.set(user, { chan, at });
}

/** Summen schreiben und alte Einträge vergessen */
export async function flushChatMoves() {
  const m = mem();
  const now = Date.now();
  for (const [u, s] of m.seen) if (now - s.at > MOVE_WINDOW_MS) m.seen.delete(u);
  for (const [u, s] of m.moved) if (now - s.at > FOLLOW_MS) m.moved.delete(u);
  if (!m.pending.size) return;
  const rows = [...m.pending];
  m.pending.clear();
  const values: unknown[] = [];
  const ph = rows.map(([key, c], i) => {
    const [bin, from, to] = key.split("|");
    values.push(Number(bin), from, to, c.n, c.stay, c.back);
    const o = i * 6;
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
  });
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO viewer_chat_moves (bin, from_id, to_id, n, stay, back) VALUES ${ph.join(", ")}
       ON CONFLICT (bin, from_id, to_id) DO UPDATE SET n = viewer_chat_moves.n + EXCLUDED.n, stay = viewer_chat_moves.stay + EXCLUDED.stay, back = viewer_chat_moves.back + EXCLUDED.back`,
      values,
    );
  } catch (e) {
    // Beim nächsten Mal erneut versuchen
    for (const [key, c] of rows) {
      const p = m.pending.get(key) ?? { n: 0, stay: 0, back: 0 };
      m.pending.set(key, { n: p.n + c.n, stay: p.stay + c.stay, back: p.back + c.back });
    }
    console.error("[chat-moves] Speichern fehlgeschlagen:", e instanceof Error ? e.message : e);
  }
}

/** Gespeicherte Summen (für die Auswertung) */
export async function loadChatMoves(): Promise<{ bin: number; from: string; to: string; n: number; stay: number; back: number }[]> {
  const db = await getDb();
  const r = await db.query<{ bin: number; from_id: string; to_id: string; n: number; stay: number; back: number }>(`SELECT bin, from_id, to_id, n, stay, back FROM viewer_chat_moves`).catch(() => ({ rows: [] }));
  return r.rows.map((x) => ({ bin: x.bin, from: x.from_id, to: x.to_id, n: x.n, stay: x.stay, back: x.back }));
}
