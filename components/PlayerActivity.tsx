import Link from "next/link";
import { Fold } from "./Fold";
import { Explain } from "./Explain";
import type { StoredSession } from "@/lib/store";
import type { RankHistory, Span } from "@/lib/analytics";
import type { BoardKey, PlayerRank } from "@/lib/types";
import { duration, num } from "@/lib/format";
import { BOARD_ORDER, BOARD_STYLE } from "@/lib/boards";
import { Sparkline } from "./Sparkline";
import { BoardValue } from "./BoardValue";
import { BOARD_ICON, Icon } from "./Icons";
import { EXTRA_HISTORY_KEYS, EXTRA_STATS, STAT_GROUPS } from "@/lib/playerStats";
import { LEADERBOARDS, boardHref } from "@/lib/leaderboards";
import { graphHref, rankMetric } from "@/lib/graphQuery";
import { GROUP_TONE } from "@/lib/statTone";
import { classifiable, type Rhythm } from "@/lib/rhythmCore";
import { TraitBadges, clock } from "./Rhythm";

const DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Wochentag (0 = Montag) und Stunde in Berlin für einen Zeitpunkt */
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", weekday: "short", hour: "numeric", hourCycle: "h23" });
const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function cellOf(ms: number): [number, number] {
  const parts = partsFmt.formatToParts(new Date(ms));
  const d = DOW[parts.find((p) => p.type === "weekday")?.value ?? "Mon"] ?? 0;
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  return [d, h];
}

/** Online-Minuten je Wochentag × Stunde aus Zeitspannen (in 10-Minuten-Schritten abgetastet) */
function heat(spans: { start: string | number; end: string | number | null }[], now: number): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  const STEP = 10 * 60_000;
  for (const s of spans) {
    const a = typeof s.start === "number" ? s.start : Date.parse(s.start);
    const b = s.end === null ? now : typeof s.end === "number" ? s.end : Date.parse(s.end);
    for (let t = a; t < b; t += STEP) {
      const [d, h] = cellOf(t);
      grid[d][h] += Math.min(STEP, b - t) / 60_000;
    }
  }
  return grid;
}

export function PlayerActivity({
  id,
  sessions,
  afk,
  ranks,
  values,
  apiRanks,
  rhythm,
  now,
}: {
  id: string;
  /** Nur die Sessions dieses Spielers */
  sessions: StoredSession[];
  /** AFK-Phasen dieses Spielers (Teil der Sessions) */
  afk: Span[];
  ranks: RankHistory;
  /** Aktueller Wert je Hauptliste (Spielzeit inkl. Hochrechnung) */
  values: Partial<Record<BoardKey, number>>;
  /** Offizieller Rang laut API (für die Überschrift jeder Karte) */
  apiRanks: Partial<Record<BoardKey, PlayerRank>>;
  /** Spielrhythmus und Spielertyp (lib/rhythm.ts) */
  rhythm?: Rhythm | null;
  now: number;
}) {
  const afkGrid = heat(afk.map(([a, b]) => ({ start: a, end: b })), now);
  const afkTotal = afkGrid.flat().reduce((s, v) => s + v, 0);
  /* ---- Rang-Verlauf der neun Hauptlisten ---- */
  const mine = ranks.players[id] ?? {};
  const lastIndex = ranks.buckets.length - 1;
  const rankCharts = BOARD_ORDER.map((k) => {
    const series = mine[k] ?? [];
    const points = ranks.buckets.map((at, i) => ({ at: new Date(at).toISOString(), v: series[i] ?? null })).filter((p): p is { at: string; v: number } => p.v !== null);
    const best = points.length ? Math.min(...points.map((p) => p.v)) : null;
    const worst = points.length ? Math.max(...points.map((p) => p.v)) : null;
    const tracked = series[lastIndex] ?? null;
    // Überschrift aus derselben Berechnung wie Kurve und Bester/Schlechtester, damit alles zusammenpasst.
    // Der offizielle API-Rang (unter allen Teilnehmenden) steht im Tooltip; ohne Verlauf ist er die Überschrift.
    const head = tracked !== null ? { rank: tracked, of: ranks.of[k]?.[lastIndex] ?? 0 } : (apiRanks[k] ?? null);
    return { k, points, best, worst, head, official: apiRanks[k] ?? null };
  });
  // Zusatzwerte: kompakte Tabelle nach Rubriken
  const mineExtra = ranks.extra?.[id] ?? {};
  const extraCharts = EXTRA_HISTORY_KEYS.map((k) => {
    const series = mineExtra[k] ?? [];
    const points = ranks.buckets.map((at, i) => ({ at: new Date(at).toISOString(), v: series[i] ?? null })).filter((p): p is { at: string; v: number } => p.v !== null);
    return { k, points, best: points.length ? Math.min(...points.map((p) => p.v)) : null, nowRank: points.length ? points[points.length - 1].v : null };
  }).filter((c) => c.points.length > 0);
  const extraGroups = STAT_GROUPS.map((g) => ({ ...g, charts: extraCharts.filter((c) => EXTRA_STATS[c.k].group === g.key) })).filter((g) => g.charts.length > 0);

  /* ---- Heatmap ---- */
  const grid = heat(sessions, now);
  const max = Math.max(1, ...grid.flat());
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h], 0));
  const byDay = grid.map((row) => row.reduce((s, v) => s + v, 0));
  const total = byDay.reduce((s, v) => s + v, 0);
  // Typische Spielzeit: zusammenhängender Stundenblock, der ~60 % der Online-Zeit enthält (kleinster Block)
  let typical: [number, number] | null = null;
  if (total > 0) {
    let bestLen = 25;
    for (let start = 0; start < 24; start++) {
      let acc = 0;
      for (let len = 1; len <= 24; len++) {
        acc += byHour[(start + len - 1) % 24];
        if (acc >= total * 0.6) {
          if (len < bestLen) {
            bestLen = len;
            typical = [start, (start + len) % 24];
          }
          break;
        }
      }
    }
  }
  const topDay = total > 0 ? byDay.indexOf(Math.max(...byDay)) : null;

  const every = ranks.bucketMinutes >= 60 ? `${Math.round(ranks.bucketMinutes / 60)} Std` : `${ranks.bucketMinutes} Min`;

  return (
    <>
      <section className="block block--tight" data-tone="paper" aria-labelledby="ranks-h">
        <div className="wrap">
          <Fold
            id="profil.raenge"
            titleId="ranks-h"
            title={
              <>
                Rang-Verlauf <Explain>Platz unter allen erfassten Spielern, alle {every} neu berechnet. Oben ist besser.</Explain>
              </>
            }
          >
          <div className="grid st-boards">
            {rankCharts.map((c) => {
              const style = BOARD_STYLE[c.k];
              const IconCmp = Icon[BOARD_ICON[c.k]];
              const value = values[c.k];
              return (
                <section key={c.k} className="box st-board rankboard" data-tone={style.tone} aria-labelledby={`rank-${c.k}`}>
                  <header className="st-board__head">
                    <span className="st-board__icon">
                      <IconCmp aria-hidden="true" />
                    </span>
                    <div className="rankboard__title">
                      <h3 className="t-3" id={`rank-${c.k}`}>
                        {style.title}
                      </h3>
                      <p className="st-board__sub">{style.sub}</p>
                    </div>
                    <Link
                      className="rankboard__now"
                      href={boardHref(c.k)}
                      title={[c.head?.of ? `Platz ${c.head.rank} von ${c.head.of} erfassten Spielern` : null, c.official ? `Offiziell laut API: Platz ${c.official.rank} von ${c.official.of}` : null, "Bestenliste öffnen"].filter(Boolean).join(" · ")}
                    >
                      <span className="num">{c.head ? `#${c.head.rank}` : "–"}</span>
                      {c.head?.of ? <span className="rankboard__of num">von {c.head.of}</span> : null}
                    </Link>
                  </header>
                  <div className="rankboard__chart">
                    {c.points.length >= 2 ? (
                      <Link href={graphHref(rankMetric(c.k), [id])} title={`Platz in „${style.title}“ im Graphen öffnen`}>
                        <Sparkline points={c.points} width={320} height={84} kind="rank" invert label={`Platz ${style.title}`} />
                      </Link>
                    ) : (
                      <p className="rankboard__empty">Noch zu wenig Verlauf.</p>
                    )}
                  </div>
                  <ol className="st-board__list">
                    <li className="st-board__row rankboard__row">
                      <span className="st-board__name">Aktueller Wert</span>
                      <span className="st-board__val num">{value === undefined ? "–" : <BoardValue k={c.k} v={value} />}</span>
                    </li>
                    <li className="st-board__row rankboard__row">
                      <span className="st-board__name">Bester Platz</span>
                      <span className="st-board__val num">{c.best === null ? "–" : `#${c.best}`}</span>
                    </li>
                    <li className="st-board__row rankboard__row">
                      <span className="st-board__name">Schlechtester Platz</span>
                      <span className="st-board__val num">{c.worst === null ? "–" : `#${c.worst}`}</span>
                    </li>
                  </ol>
                </section>
              );
            })}
          </div>
          </Fold>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper" aria-labelledby="act-h">
        <div className="wrap">
          <Fold id="profil.aktivitaet" titleId="act-h" title="Weitere Ränge & Aktivität">
          <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
            {extraGroups.length > 0 && (
              <div className="box" data-tone="white" style={{ gridColumn: "span 2" }}>
                <p className="eyebrow" style={{ marginBottom: 8 }}>
                  Weitere Ränge <Explain>Rang-Verlauf der Zusatzwerte aus der Einzelstatistik, ebenfalls alle {every} neu berechnet.</Explain>
                </p>
                <div className="rankmore__body">
                  {extraGroups.map((g) => (
                    <div key={g.key} className="rankmore__group">
                      <p className="rankmore__label">{g.label}</p>
                      <ul className="rankmore__rows">
                        {g.charts.map((ch) => (
                          <li key={ch.k}>
                            <div className="rankmore__row">
                              <Link className="rankmore__name" href={boardHref(ch.k)} title={`Bestenliste „${LEADERBOARDS[ch.k].title}“ öffnen`}>
                                {EXTRA_STATS[ch.k].label}
                              </Link>
                              <Link className="rankmore__spark" data-tone={GROUP_TONE[g.key]} href={graphHref(rankMetric(ch.k), [id])} title={`Platz in „${LEADERBOARDS[ch.k].title}“ im Graphen öffnen`}>
                                {ch.points.length >= 2 ? <Sparkline points={ch.points} width={160} height={28} kind="rank" invert label={`Platz ${EXTRA_STATS[ch.k].label}`} /> : <span className="muted">–</span>}
                              </Link>
                              <Link className="rankmore__now num" href={boardHref(ch.k)} tabIndex={-1} data-top={ch.nowRank !== null && ch.nowRank <= 3 ? "true" : undefined}>
                                {ch.nowRank === null ? "–" : `#${ch.nowRank}`}
                              </Link>
                              <span className="rankmore__best muted num">{ch.best === null ? "" : `bester #${ch.best}`}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Heatmap */}
            <div className="box" data-tone="white">
              <p className="eyebrow" style={{ marginBottom: 4 }}>
                Wann online
              </p>
              {rhythm && rhythm.activeDays > 0 && (
                <div className="rh-profile">
                  <p className="rh-profile__type">
                    <span className="muted">Spielertyp</span>{" "}
                    {classifiable(rhythm) ? (
                      <TraitBadges traits={rhythm.traits} max={4} hrefOf={(k) => `/spielertypen?typ=${k}#liste`} />
                    ) : (
                      <span className="muted">noch zu wenig Daten</span>
                    )}{" "}
                    <Link className="rh-profile__all" href="/spielertypen">
                      Alle Typen
                    </Link>
                  </p>
                  <dl className="rh-profile__facts">
                    <div>
                      <dt>Session (Median)</dt>
                      <dd>{duration(rhythm.medianSession * 60)}</dd>
                    </div>
                    <div>
                      <dt>Aktive Tage</dt>
                      <dd>
                        {num(rhythm.activeDays)} von {num(rhythm.spanDays)}
                      </dd>
                    </div>
                    {rhythm.typicalStart !== null && (
                      <div>
                        <dt>Erster Login meist</dt>
                        <dd>um {clock(rhythm.typicalStart)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Wochenende</dt>
                      <dd>{Math.round(rhythm.weekend * 100)} %</dd>
                    </div>
                    {rhythm.liveShare !== null && (
                      <div>
                        <dt>Davon live</dt>
                        <dd>{Math.round(rhythm.liveShare * 100)} %</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
              {total === 0 ? (
                <p className="muted" style={{ fontSize: ".875rem" }}>
                  Noch keine Online-Zeit gemessen.
                </p>
              ) : (
                <>
                  <p className="muted" style={{ fontSize: ".875rem", marginBottom: 12 }}>
                    {typical ? `Meist zwischen ${typical[0]} und ${typical[1] === 0 ? 24 : typical[1]} Uhr` : ""}
                    {topDay !== null ? `, stärkster Tag ${DAYS[topDay]}` : ""}. Insgesamt {duration(total * 60)} seit Tracker-Start
                    {afkTotal > 0 ? `, davon ${duration(afkTotal * 60)} AFK` : ""}. Je grauer ein Feld, desto größer der AFK-Anteil.
                  </p>
                  <div className="heat" role="img" aria-label="Online-Zeit nach Wochentag und Uhrzeit">
                    <span />
                    {Array.from({ length: 24 }, (_, h) => (
                      <span key={h} className="heat__h">
                        {h % 6 === 0 ? h : ""}
                      </span>
                    ))}
                    {grid.map((row, d) => (
                      <div key={d} className="heat__row">
                        <span className="heat__d">{DAYS[d]}</span>
                        {row.map((v, h) => {
                          const afkMin = Math.min(v, afkGrid[d][h]);
                          const share = v > 0 ? afkMin / v : 0;
                          return (
                            <span
                              key={h}
                              className="heat__c tip"
                              style={{ "--a": v > 0 ? 0.15 + 0.85 * (v / max) : 0, "--afk": share } as React.CSSProperties}
                              data-tip={`${DAYS[d]} ${String(h).padStart(2, "0")}–${String(h + 1).padStart(2, "0")} Uhr · ${v > 0 ? `${num(Math.round(v))} Min online${afkMin >= 1 ? ` · davon ${num(Math.round(afkMin))} Min AFK` : ""}` : "nie"}`}
                              tabIndex={0}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          </Fold>
        </div>
      </section>
    </>
  );
}
