import Link from "next/link";
import type { SharedChatSession } from "@/lib/store";
import type { PlayerState } from "@/lib/types";
import { ago, dateTime, duration } from "@/lib/format";
import { Head } from "./Head";

/** Geteilte Chats (Stream Together) eines Spielers: laufende zuerst, mit Partnern, Beginn und Dauer. */
export function SharedChatList({
  sessions,
  self,
  players,
  now,
}: {
  sessions: SharedChatSession[];
  /** Spieler, dessen Profil gezeigt wird (steht nicht in der Partnerliste) */
  self: string;
  players: Record<string, PlayerState>;
  now: number;
}) {
  const ordered = [...sessions].sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return (
    <ul className="shared">
      {ordered.map((s) => {
        const partners = s.participants.filter((id) => id !== self);
        const running = s.endedAt === null;
        const seconds = Math.max(0, ((running ? now : Date.parse(s.endedAt!)) - Date.parse(s.startedAt)) / 1000);
        return (
          <li key={s.key} className="shared__row" data-running={running ? "true" : undefined}>
            <span className="shared__state">{running ? "läuft" : "beendet"}</span>
            <span className="shared__who">
              {partners.map((id) => (
                <Link key={id} className="chat__who" data-role="to" href={`/spieler/${encodeURIComponent(id)}`}>
                  <Head id={id} uuid={players[id]?.uuid} name={players[id]?.name} size={20} src={32} className="chat__head" />
                </Link>
              ))}
              {s.otherCount > 0 && (
                <span className="muted shared__others">
                  +{s.otherCount} {s.otherCount === 1 ? "weiterer Kanal" : "weitere Kanäle"}
                </span>
              )}
              {partners.length === 0 && s.otherCount === 0 && <span className="muted">unbekannte Kanäle</span>}
            </span>
            <span className="shared__when muted" title={`${dateTime(s.startedAt)}${s.endedAt ? ` bis ${dateTime(s.endedAt)}` : ""}`}>
              {running ? `seit ${ago(s.startedAt, now).replace("vor ", "")}` : `${ago(s.startedAt, now)} · ${duration(seconds)}`}
              {s.source === "chat" && <span title="Ohne Twitch-API aus geteilten Chat-Nachrichten erkannt"> · erschlossen</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
