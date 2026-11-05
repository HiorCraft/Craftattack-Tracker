import Link from "next/link";
import { Fold } from "./Fold";
import { Explain } from "./Explain";
import type { PlayerState } from "@/lib/types";
import { EVENT_META } from "@/lib/events";
import { distance, duration, num, time } from "@/lib/format";
import { BOARD_TONE, METRIC_TONE } from "@/lib/statTone";
import { berlinDay, type DaySummary, type Highlight } from "@/lib/highlights";
import { EVENT_ICON, Icon } from "./Icons";
import { Head } from "./Head";

const dayLabelFmt = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" });
const FRAME_LABEL: Record<string, string> = { challenge: "Aufgabe", goal: "Ziel", task: "Fortschritt" };

/** "Heute", "Gestern" oder "Mi., 21. Okt." */
function dayLabel(day: string, now: number): string {
  if (day === berlinDay(now)) return "Heute";
  if (day === berlinDay(now - 24 * 3600_000)) return "Gestern";
  return dayLabelFmt.format(new Date(`${day}T12:00:00Z`));
}

/** Satz und Zusatz eines Highlights aus Sicht des Spielers */
function describe(h: Highlight, players: Record<string, PlayerState>): { text: string; sub: string | null; other: { id: string; name: string; uuid?: string } | null } {
  const e = h.event;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  if (h.kind === "kill") {
    const victim = { id: e.player!, name: e.playerName ?? e.player!, uuid: e.uuid };
    return { text: `hat ${victim.name} erledigt`, sub: str(e.meta?.deathMessage), other: victim };
  }
  if (e.type === "death" && str(e.meta?.killerId)) {
    const id = str(e.meta?.killerId)!;
    const killer = { id, name: str(e.meta?.killerName) ?? id, uuid: str(e.meta?.killerUuid) ?? players[id]?.uuid };
    return { text: `wurde von ${killer.name} erledigt`, sub: str(e.meta?.deathMessage), other: killer };
  }
  if (e.type === "death") return { text: "ist gestorben", sub: str(e.meta?.deathMessage), other: null };
  if (e.type === "achievement") return { text: EVENT_META.achievement.text(e), sub: FRAME_LABEL[String(e.meta?.frame)] ?? null, other: null };
  const meta = EVENT_META[e.type];
  return { text: meta.text(e), sub: meta.sub?.(e) ?? null, other: null };
}

/**
 * Tageshighlights im Profil: Auswahl der aktiven Tage, Tagesbilanz und die wichtigsten Momente des Tages
 * (Gewichtung in lib/highlights.ts).
 */
export function DayHighlights({
  id,
  name,
  day,
  days,
  highlights,
  summary,
  players,
  now,
}: {
  id: string;
  name: string;
  day: string;
  days: string[];
  highlights: Highlight[];
  summary: DaySummary;
  players: Record<string, PlayerState>;
  now: number;
}) {
  const href = (d: string) => `/spieler/${encodeURIComponent(id)}?tag=${d}#highlights`;
  const facts: { tone: string; text: string }[] = [
    summary.kills > 0 ? { tone: BOARD_TONE.deaths, text: `${num(summary.kills)} Spieler erledigt` } : null,
    summary.deaths > 0 ? { tone: BOARD_TONE.deaths, text: `${num(summary.deaths)} ${summary.deaths === 1 ? "Tod" : "Tode"}` } : null,
    summary.achievements > 0 ? { tone: "white", text: `${num(summary.achievements)} Achievement${summary.achievements === 1 ? "" : "s"}` } : null,
    summary.diamonds > 0 ? { tone: BOARD_TONE.diamonds, text: `${num(summary.diamonds)} Diamanten` } : null,
    summary.blocksBroken > 0 ? { tone: BOARD_TONE.blocksBroken, text: `${num(summary.blocksBroken)} Blöcke` } : null,
    summary.mobsKilled > 0 ? { tone: BOARD_TONE.mobsKilled, text: `${num(summary.mobsKilled)} Mobs` } : null,
    summary.distance > 0 ? { tone: BOARD_TONE.distance, text: `${distance(summary.distance)} gelaufen` } : null,
    summary.streamSeconds > 0 ? { tone: METRIC_TONE.liveCount, text: `${duration(summary.streamSeconds)} gestreamt` } : null,
  ].filter((f): f is { tone: string; text: string } => f !== null);

  return (
    <section className="block block--tight" data-tone="paper" id="highlights" aria-labelledby="highlights-h">
      <div className="wrap">
        <Fold
          id="profil.highlights"
          titleId="highlights-h"
          title={
            <>
              Tageshighlights <Explain>Die Momente, von denen {name} an diesem Tag erzählen würde.</Explain>
            </>
          }
        >
        {days.length > 1 && (
          <ul className="filters filters--scroll" aria-label="Tag wählen">
            {days.map((d) => (
              <li key={d}>
                <Link className="tag" data-tone="white" aria-current={d === day ? "true" : undefined} href={href(d)} scroll={false}>
                  {dayLabel(d, now)}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {facts.length > 0 && (
          <ul className="hl__facts" aria-label="Tagesbilanz">
            {facts.map((f) => (
              <li key={f.text} className="tag" data-tone="white">
                <span className="swatch" data-tone={f.tone} aria-hidden="true" />
                {f.text}
              </li>
            ))}
          </ul>
        )}
        {highlights.length === 0 ? (
          <p className="muted">Ein ruhiger Tag – nichts, wovon man im Stream erzählen würde.</p>
        ) : (
          <ol className="hl">
            {highlights.map((h) => {
              const e = h.event;
              const { text, sub, other } = describe(h, players);
              const tone = h.kind === "kill" ? BOARD_TONE.deaths : EVENT_META[e.type].tone;
              const IconCmp = h.kind === "kill" ? Icon.sword : Icon[EVENT_ICON[e.type]];
              const vod = typeof e.meta?.vodUrl === "string" ? e.meta.vodUrl : null;
              return (
                <li key={`${h.kind}-${e.id}`} className="box hl__item" data-tone={tone}>
                  <time className="hl__time num" dateTime={e.at}>
                    {time(e.at)}
                  </time>
                  <span className="hl__icon" data-tone={tone} aria-hidden="true">
                    <IconCmp width={18} height={18} />
                  </span>
                  <div className="hl__body">
                    <p className="hl__text">
                      {name} {text}
                    </p>
                    {sub && <p className="hl__sub muted">{sub}</p>}
                  </div>
                  {other && (
                    <Link className="hl__other" href={`/spieler/${encodeURIComponent(other.id)}`} aria-label={other.name}>
                      <Head id={other.id} uuid={other.uuid ?? players[other.id]?.uuid} name={other.name} size={32} />
                    </Link>
                  )}
                  {vod && (
                    <a className="hl__vod" href={vod} target="_blank" rel="noopener" title="Diesen Moment im VOD ansehen">
                      <Icon.twitch width={14} height={14} aria-hidden="true" /> VOD
                    </a>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        </Fold>
      </div>
    </section>
  );
}
