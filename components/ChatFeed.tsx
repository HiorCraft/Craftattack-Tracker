import Link from "next/link";
import type { TwitchChatMessage } from "@/lib/store";
import { ago, dateTime } from "@/lib/format";
import { Head } from "./Head";
import { Icon } from "./Icons";

const dayFmt = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

function dayLabel(iso: string, now: number) {
  const key = keyFmt.format(new Date(iso));
  if (key === keyFmt.format(new Date(now))) return "Heute";
  if (key === keyFmt.format(new Date(now - 24 * 3600_000))) return "Gestern";
  return dayFmt.format(new Date(iso));
}

/** Kopf eines Spielers als Link; der Absender behält den Namen daneben, der Kanal nur den Kopf (Name im Tooltip) */
function Who({ id, name, uuid, role }: { id: string; name: string; uuid: string | undefined; role: "from" | "to" }) {
  const showName = role === "from";
  return (
    <Link className="chat__who" data-role={role} href={`/spieler/${encodeURIComponent(id)}`}>
      <Head id={id} uuid={uuid} name={name} size={20} src={32} className="chat__head" decorative={showName} />
      {showName && <span className="chat__name">{name}</span>}
    </Link>
  );
}

/**
 * Nachrichten von Spielern in Twitch-Chats anderer Spieler, nach Tagen gruppiert.
 * Jede Zeile zeigt Absender → Empfänger (Kanal) mit Kopf und Namen, darunter die Nachricht.
 */
export function ChatFeed({
  messages,
  uuidOf,
  nameOf = (id) => id,
  now,
  empty,
  label,
  vodOf,
}: {
  messages: TwitchChatMessage[];
  /** Spieler-ID → Minecraft-UUID für den Kopf */
  uuidOf: (id: string) => string | undefined;
  /** Spieler-ID → Anzeigename (für „geteilt mit …") */
  nameOf?: (id: string) => string;
  now: number;
  empty: string;
  label: string;
  /** Nachrichten-ID → VOD-Link an der Stelle, an der die Nachricht geschrieben wurde */
  vodOf?: (messageId: string) => string | undefined;
}) {
  if (messages.length === 0) return <p className="muted chat__empty">{empty}</p>;
  const days: { label: string; items: TwitchChatMessage[] }[] = [];
  for (const m of messages) {
    const l = dayLabel(m.at, now);
    const last = days[days.length - 1];
    if (last?.label === l) last.items.push(m);
    else days.push({ label: l, items: [m] });
  }
  return (
    <ol className="chat" aria-label={label}>
      {days.map((day) => (
        <li key={day.label} className="chat__day">
          <p className="chat__daylabel">{day.label}</p>
          <ol className="chat__list">
            {day.items.map((m) => (
              <li key={m.id} className="chat__msg">
                <p className="chat__route">
                  <Who id={m.senderId} name={m.senderName} uuid={uuidOf(m.senderId)} role="from" />
                  {/* Pfeil als SVG: die Pixel-Schrift hat kein „→" */}
                  <svg className="chat__arrow" viewBox="0 0 16 10" width={14} height={9} role="img" aria-label="schreibt im Chat von">
                    <path d="M0 4h11V1l5 4-5 4V6H0z" fill="currentColor" />
                  </svg>
                  <Who id={m.channelId} name={m.channelName} uuid={uuidOf(m.channelId)} role="to" />
                  {m.sharedWith && m.sharedWith.length > 0 && (
                    <span className="chat__shared" title={`Geteilter Chat: erschien auch bei ${m.sharedWith.map(nameOf).join(", ")}`}>
                      <span className="chat__shared-label">geteilt</span>
                      {m.sharedWith.slice(0, 4).map((id) => (
                        <Link key={id} href={`/spieler/${encodeURIComponent(id)}`} aria-label={`auch bei ${nameOf(id)}`}>
                          <Head id={id} uuid={uuidOf(id)} name={`auch bei ${nameOf(id)}`} size={16} src={32} className="chat__head chat__head--small" decorative />
                        </Link>
                      ))}
                    </span>
                  )}
                  <time className="chat__time" dateTime={m.at} title={dateTime(m.at)}>
                    {ago(m.at, now)}
                  </time>
                </p>
                {vodOf?.(m.id) ? (
                  <a className="chat__text chat__text--vod" href={vodOf(m.id)} target="_blank" rel="noopener" title="Diese Stelle im VOD ansehen">
                    {m.message}
                    <span className="chat__vod" aria-hidden="true">
                      <Icon.twitch width={14} height={14} /> VOD
                    </span>
                  </a>
                ) : (
                  <p className="chat__text">{m.message}</p>
                )}
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/** Häufigste Chat-Partner als Chips mit Anzahl */
export function ChatPartners({ partners, label }: { partners: { id: string; name: string; count: number }[]; label: string }) {
  if (partners.length === 0) return null;
  return (
    <ul className="chat__partners" aria-label={label}>
      {partners.map((p) => (
        <li key={p.id}>
          <Link className="tag chat__partner" href={`/spieler/${encodeURIComponent(p.id)}`} aria-label={`${p.name}: ${p.count}`}>
            <Head id={p.id} name={p.name} size={20} src={32} className="chat__head" decorative /> <span className="num">{p.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
