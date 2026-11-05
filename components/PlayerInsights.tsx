import type { PlayerPoint, PlayerState, TrackerEvent } from "@/lib/types";
import { Fold } from "./Fold";
import type { StoredSession } from "@/lib/store";
import { RATE_KEYS, type PlayerRates, type RateKey } from "@/lib/analytics";
import { distance, duration, num, dateTime } from "@/lib/format";
import { BOARD_ICON, Icon } from "./Icons";
import { BOARD_TONE } from "@/lib/statTone";

const LABEL: Record<RateKey, string> = { deaths: "Tode", diamonds: "Diamanten", blocksBroken: "Blöcke", mobsKilled: "Mobs", distance: "Strecke" };
const TONE: Record<RateKey, string> = BOARD_TONE;

const nf1 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const fmtRate = (k: RateKey, v: number) => (k === "distance" ? distance(v) : k === "blocksBroken" || k === "mobsKilled" ? num(v) : nf1.format(v));
const fmtDelta = (k: RateKey, v: number) => (k === "distance" ? distance(v) : num(v));

/** Mitternacht (Europe/Berlin) des Tages, der `ms` enthält */
function berlinMidnight(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  // Offset der Zeitzone bestimmen: lokale Berlin-Zeit vs. UTC des gleichen Zeitpunkts
  const probe = new Date(`${parts}T00:00:00Z`).getTime();
  const hourPart = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hour: "numeric", hourCycle: "h23" }).formatToParts(new Date(probe)).find((x) => x.type === "hour");
  const h = Number(hourPart?.value ?? 0) % 24;
  return probe - h * 3600_000;
}

/** Letzter Wert einer Kennzahl bis zum Zeitpunkt `t`; ohne Punkt davor der erste bekannte Wert (Tracker-Start) */
function valueAt(points: PlayerPoint[], k: RateKey, t: number): number | null {
  let v: number | null = null;
  for (const p of points) {
    if (p[k] === null) continue;
    if (Date.parse(p.at) > t) {
      if (v === null) return p[k];
      break;
    }
    v = p[k];
  }
  return v;
}
function latest(points: PlayerPoint[], k: RateKey): number | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i][k] !== null) return points[i][k];
  return null;
}

function overlapSeconds(sessions: StoredSession[], from: number, to: number, now: number) {
  let s = 0;
  for (const x of sessions) {
    const a = Date.parse(x.start);
    const b = x.end ? Date.parse(x.end) : now;
    const o = Math.min(b, to) - Math.max(a, from);
    if (o > 0) s += o / 1000;
  }
  return s;
}

export function PlayerInsights({
  p,
  history,
  sessions,
  events,
  rates,
  server,
  now,
}: {
  p: PlayerState;
  history: PlayerPoint[];
  /** Nur die Sessions dieses Spielers */
  sessions: StoredSession[];
  /** Nur die Ereignisse dieses Spielers, chronologisch */
  events: TrackerEvent[];
  rates: PlayerRates | undefined;
  server: Record<RateKey, number | null>;
  now: number;
}) {
  /* ---- Zeitfenster ---- */
  const today0 = berlinMidnight(now);
  const windows = [
    { label: "Heute", from: today0, to: now },
    { label: "Gestern", from: today0 - 86400_000, to: today0 },
    { label: "7 Tage", from: now - 7 * 86400_000, to: now },
  ];
  const firstAt = history.length ? Date.parse(history[0].at) : now;
  const rows = RATE_KEYS.map((k) => ({
    k,
    cells: windows.map((w) => {
      const a = valueAt(history, k, w.from);
      const b = w.to === now ? latest(history, k) : valueAt(history, k, w.to);
      if (a === null || b === null) return null;
      return Math.max(0, b - a);
    }),
  }));
  const onlineCells = windows.map((w) => overlapSeconds(sessions, w.from, w.to, now));
  const hasAny = rows.some((r) => r.cells.some((c) => c !== null && c > 0)) || onlineCells.some((s) => s > 0);

  /* ---- Streams ---- */
  const ends = events.filter((e) => e.type === "stream_end");
  const streamCount = ends.length + (p.live ? 1 : 0);
  const secsDone = ends.reduce((s, e) => s + Number(e.meta?.streamSeconds ?? 0), 0);
  const currentSecs = p.live && p.liveSince ? (now - Date.parse(p.liveSince)) / 1000 : 0;
  const longest = Math.max(currentSecs, ...ends.map((e) => Number(e.meta?.streamSeconds ?? 0)));
  const vOn: number[] = [];
  const vOff: number[] = [];
  for (const h of history) if (h.viewers !== null) (h.online ? vOn : vOff).push(h.viewers);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const avgOn = avg(vOn);
  const avgOff = avg(vOff);
  const liveDeaths = events.filter((e) => e.type === "death" && e.meta?.live);
  const liveDeathCount = liveDeaths.reduce((s, e) => s + (e.delta ?? 1), 0);
  const withVod = [...liveDeaths].reverse().filter((e) => typeof e.meta?.vodUrl === "string").slice(0, 5);

  return (
    <section className="block block--tight" data-tone="paper" aria-labelledby="ins-h">
      <div className="wrap">
        <Fold id="profil.auswertung" titleId="ins-h" title="Auswertung">
        <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
          {/* Raten */}
          <div className="box" data-tone="white">
            <p className="eyebrow" style={{ marginBottom: 4 }}>
              Pro Online-Stunde
            </p>
            <p className="muted" style={{ fontSize: ".875rem", marginBottom: 12 }}>
              {rates && rates.hours >= 0.5 ? `Pro Stunde in ${duration(rates.hours * 3600)} gemessener Online-Zeit, daneben der Server.` : "Noch zu wenig gemessene Online-Zeit für belastbare Raten."}
            </p>
            {rates && rates.hours >= 0.5 && (
              <ul className="rates">
                {RATE_KEYS.map((k) => {
                  const mine = rates.perHour[k];
                  const srv = server[k];
                  const IconCmp = Icon[BOARD_ICON[k]];
                  const ratio = mine !== null && srv ? mine / srv : null;
                  return (
                    <li key={k} className="rates__row" data-tone={TONE[k]}>
                      <span className="rates__icon">
                        <IconCmp aria-hidden="true" />
                      </span>
                      <span className="rates__label">{LABEL[k]}</span>
                      <span className="rates__val num">{mine === null ? "–" : fmtRate(k, mine)}</span>
                      <span className="rates__srv num" title="Serverdurchschnitt pro Online-Stunde">
                        Ø {srv === null ? "–" : fmtRate(k, srv)}
                      </span>
                      <span className={`rates__cmp num${ratio !== null && ratio >= 1.15 ? " rates__cmp--up" : ratio !== null && ratio <= 0.85 ? " rates__cmp--down" : ""}`} title="Verhältnis zum Serverdurchschnitt">
                        {ratio === null ? "" : `${nf1.format(ratio)}×`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Zeitfenster */}
          <div className="box" data-tone="white">
            <p className="eyebrow" style={{ marginBottom: 4 }}>
              Zuwachs
            </p>
            <p className="muted" style={{ fontSize: ".875rem", marginBottom: 12 }}>
              {firstAt > now - 7 * 86400_000 ? `Tracker läuft seit ${dateTime(new Date(firstAt).toISOString())}, ältere Fenster sind entsprechend kürzer.` : "Nach Kalendertag (Berlin) bzw. den letzten 7 Tagen."}
            </p>
            {hasAny ? (
              <table className="windows">
                <thead>
                  <tr>
                    <th scope="col" />
                    {windows.map((w) => (
                      <th key={w.label} scope="col">
                        {w.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">
                      <Icon.clock aria-hidden="true" /> Online
                    </th>
                    {onlineCells.map((s, i) => (
                      <td key={i} className="num">
                        {s > 0 ? duration(s) : "–"}
                      </td>
                    ))}
                  </tr>
                  {rows.map((r) => {
                    const IconCmp = Icon[BOARD_ICON[r.k]];
                    return (
                      <tr key={r.k}>
                        <th scope="row">
                          <IconCmp aria-hidden="true" /> {LABEL[r.k]}
                        </th>
                        {r.cells.map((c, i) => (
                          <td key={i} className="num">
                            {c === null ? "–" : c > 0 ? `+${fmtDelta(r.k, c)}` : "0"}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="muted">Noch keine Veränderung gesehen.</p>
            )}
          </div>

          {/* Streams */}
          <div className="box" data-tone="white">
            <p className="eyebrow" style={{ marginBottom: 4 }}>
              Streams
            </p>
            {streamCount === 0 ? (
              <p className="muted" style={{ fontSize: ".875rem" }}>
                Seit Tracker-Start keinen Stream gesehen.
              </p>
            ) : (
              <>
                <p className="muted" style={{ fontSize: ".875rem", marginBottom: 12 }}>
                  Seit Tracker-Start, Zuschauer als Durchschnitt aller Messpunkte.
                </p>
                <dl className="player-card__stats" style={{ borderTop: 0, paddingTop: 0 }}>
                  <dt>Streams</dt>
                  <dd className="num">{num(streamCount)}</dd>
                  <dt>Stream-Zeit</dt>
                  <dd className="num">{duration(secsDone + currentSecs)}</dd>
                  <dt>Längster Stream</dt>
                  <dd className="num">{longest > 0 ? duration(longest) : "–"}</dd>
                  <dt>Davon auf dem Server</dt>
                  <dd className="num">{duration(p.streamOnServerSeconds ?? 0)}</dd>
                  <dt>Ø Zuschauer auf dem Server</dt>
                  <dd className="num">{avgOn === null ? "–" : num(avgOn)}</dd>
                  <dt>Ø Zuschauer ohne Server</dt>
                  <dd className="num">{avgOff === null ? "–" : num(avgOff)}</dd>
                  <dt>Peak</dt>
                  <dd className="num">{num(p.peakViewers)}</dd>
                  <dt>Tode im Stream</dt>
                  <dd className="num">{num(liveDeathCount)}</dd>
                </dl>
                {withVod.length > 0 && (
                  <ul className="vods">
                    {withVod.map((e) => (
                      <li key={e.id}>
                        <a href={String(e.meta!.vodUrl)} target="_blank" rel="noopener" title="Diesen Tod im VOD ansehen">
                          <Icon.twitch aria-hidden="true" /> Tod {dateTime(e.at)}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
        </Fold>
      </div>
    </section>
  );
}
