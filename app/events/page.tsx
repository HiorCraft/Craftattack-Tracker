import Link from "next/link";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import type { Metadata } from "next";
import { connection } from "next/server";
import { eventState, getOfficialEvents, type EventState, type OfficialEvent } from "@/lib/officialEvents";
import { loadTracker } from "@/lib/data";
import { ago } from "@/lib/format";
import { EventFeed } from "@/components/EventFeed";
import type { TrackerState } from "@/lib/types";
import { Head } from "@/components/Head";

export const metadata: Metadata = { title: "Events" };

const dateFmt = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Berlin",
});
const berlinFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Aktuelle Zeit als "YYYY-MM-DDTHH:MM" in Europe/Berlin */
function berlinNow() {
  const p = Object.fromEntries(berlinFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const STATE_LABEL: Record<EventState, string> = { upcoming: "Kommt noch", today: "Heute", live: "Läuft", past: "Vorbei" };
const STATE_TONE: Record<EventState, string> = { upcoming: "grass", today: "gold", live: "redstone", past: "paper" };
/** So viele Köpfe zeigt eine Karte, der Rest steht als "+N" dahinter */
const MAX_HEADS = 5;

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Offizielle Termine" title="Events" />}>
      <Events />
    </Suspense>
  );
}

function timeLabel(e: OfficialEvent) {
  if (!e.time) return null;
  return e.endTime ? `${e.time} bis ${e.endTime} Uhr` : `${e.time} Uhr`;
}

function Card({ e, state, players }: { e: OfficialEvent; state: EventState; players: TrackerState["players"] }) {
  const time = timeLabel(e);
  const total = Math.max(e.participantCount, e.participants.length);
  const shown = e.participants.slice(0, MAX_HEADS);
  return (
    <li>
      <a className="box event-card" href={e.href} target="_blank" rel="noopener" data-tone="white">
        <div className="event-card__tags">
          <span className="tag" data-tone="amethyst">
            <time dateTime={e.date}>{dateFmt.format(new Date(e.date + "T12:00:00Z"))}</time>
            {e.end !== e.date && <> – {dateFmt.format(new Date(e.end + "T12:00:00Z"))}</>}
          </span>
          {time && (
            <span className="tag" data-tone="white">
              {time}
            </span>
          )}
          <span className="tag" data-tone={STATE_TONE[state]}>
            {STATE_LABEL[state]}
          </span>
        </div>
        <h3 className="t-3">{e.title}</h3>
        {e.text && <p>{e.text}</p>}
        <div className="event-card__foot">
          {total > 0 ? (
            <ul className="event-card__heads" aria-label={`${total} dabei`}>
              {shown.map((id) => {
                const name = players[id]?.name ?? id;
                return (
                  <li key={id}>
                    <Head id={id} uuid={players[id]?.uuid} name={name} />
                  </li>
                );
              })}
              {total > shown.length && <li className="event-card__more">+{total - shown.length}</li>}
            </ul>
          ) : (
            <span className="muted" style={{ fontSize: ".9375rem" }}>
              {e.season}
            </span>
          )}
          <span className="event-card__go" aria-hidden="true">
            Ansehen →
          </span>
        </div>
      </a>
    </li>
  );
}

function CardList({ events, now, players }: { events: OfficialEvent[]; now: string; players: TrackerState["players"] }) {
  return (
    <ol className="grid" style={{ "--min": "280px", listStyle: "none", margin: 0, padding: 0 } as React.CSSProperties}>
      {events.map((e) => (
        <Card key={e.href} e={e} state={eventState(e, now)} players={players} />
      ))}
    </ol>
  );
}

async function Events() {
  await connection();
  const [{ events, error, fetchedAt }, { state: tracker, events: tracked }] = await Promise.all([getOfficialEvents(), loadTracker()]);
  const now = berlinNow();
  const players = tracker.players;
  const current = events.filter((e) => e.season.includes("14"));
  const older = events.filter((e) => !e.season.includes("14"));
  const live = current.filter((e) => eventState(e, now) === "live");
  // Nächstes Event zuerst
  const upcoming = current.filter((e) => ["upcoming", "today"].includes(eventState(e, now))).reverse();
  const past = current.filter((e) => eventState(e, now) === "past");
  const serverEvents = [...tracked].reverse().filter((e) => e.type === "server_online" || e.type === "server_offline" || e.type === "tracker_start").slice(0, 20);

  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Offizielle Termine</p>
          <h1 className="t-1">Events</h1>
          <p>
            Was auf dem Server geplant ist und wann. Die Termine kommen von der{" "}
            <a href="https://craftattack.one/events/" target="_blank" rel="noopener">
              offiziellen Events-Seite
            </a>{" "}
            und werden stündlich abgeglichen.
            {fetchedAt && <span className="muted"> Stand: {ago(fetchedAt)}.</span>}
          </p>
        </div>
      </section>

      <section className="block" data-tone="ender-2">
        <div className="wrap stack" style={{ "--stack": "32px" } as React.CSSProperties}>
          <div className="section-head">
            <div className="stack" style={{ "--stack": "8px" } as React.CSSProperties}>
              <p className="eyebrow">Läuft gerade</p>
              <h2 className="t-2">CraftAttack 14</h2>
            </div>
            <a className="btn btn--small" data-tone="white" href="https://craftattack.one/staffeln/craftattack-14/" target="_blank" rel="noopener">
              Zur Staffel
            </a>
          </div>

          {error && (
            <div className="box" data-tone="gold">
              <p className="t-3">Events gerade nicht abrufbar.</p>
              <p>{error}</p>
            </div>
          )}

          {live.length > 0 && (
            <div className="stack">
              <h3 className="eyebrow">Läuft gerade</h3>
              <CardList events={live} now={now} players={players} />
            </div>
          )}

          <div className="stack">
            <h3 className="eyebrow">Kommt noch</h3>
            {upcoming.length === 0 ? (
              <p className="st-online__empty">Nichts angekündigt. Kommt bestimmt noch.</p>
            ) : (
              <CardList events={upcoming} now={now} players={players} />
            )}
          </div>

          {past.length > 0 && (
            <div className="stack">
              <h3 className="eyebrow">Schon vorbei</h3>
              <CardList events={past} now={now} players={players} />
            </div>
          )}
        </div>
      </section>

      {older.length > 0 && (
        <section className="block" data-tone="paper">
          <div className="wrap stack" style={{ "--stack": "24px" } as React.CSSProperties}>
            <h2 className="t-2">Frühere Staffeln</h2>
            <CardList events={older} now={now} players={players} />
          </div>
        </section>
      )}

      <section className="block" data-tone="paper" style={older.length > 0 ? { paddingTop: 0 } : undefined}>
        <div className="wrap">
          <div className="section-head">
            <div className="stack" style={{ "--stack": "8px" } as React.CSSProperties}>
              <h2 className="t-2">Server-Chronik</h2>
              <p className="lead">Was der Tracker selbst gesehen hat: Server an, Server aus, Start der Aufzeichnung.</p>
            </div>
            <Link className="btn btn--small" data-tone="white" href="/ereignisse?g=server">
              Alle Server-Ereignisse
            </Link>
          </div>
          <EventFeed events={serverEvents} empty="Seit Start des Trackers war der Server durchgehend online." />
        </div>
      </section>
    </>
  );
}
