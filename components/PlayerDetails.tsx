import Link from "next/link";
import { Fold } from "./Fold";
import type { PlayerDetail } from "@/lib/types";
import type { TopSnapshot } from "@/lib/store";
import { ago, dateTime, num } from "@/lib/format";
import { EXTRA_STATS, EXTRA_STAT_KEYS, FORMATTERS, STAT_GROUPS, TOP_LABELS } from "@/lib/playerStats";
import { Icon } from "@/components/Icons";
import { GROUP_TONE } from "@/lib/statTone";
import { LEADERBOARDS, boardHref, isTopCategory, itemHref, type TopCategory } from "@/lib/leaderboards";
import { graphHref, itemMetric, type Metric } from "@/lib/graphQuery";

const GROUP_ICON: Record<string, keyof typeof Icon> = {
  abbau: "pickaxe",
  kampf: "sword",
  bewegung: "boots",
  items: "bolt",
  tiere: "heart",
  afk: "clock",
};

export interface ListPlace {
  rank: number;
  of: number;
}
export interface TopPlaces {
  /** Schlüssel `<Kategorie>|<Item-Key>` */
  items: Record<string, ListPlace>;
  rest: Partial<Record<TopCategory, ListPlace>>;
}

/** Platz in einer Bestenliste als kleines Abzeichen mit Link */
function Place({ place, href, list }: { place?: ListPlace; href: string; list: string }) {
  if (!place || place.rank < 1) return null;
  return (
    <Link className="tag ptop__place" data-tone={place.rank <= 3 ? "gold" : "ink"} href={href} title={`Platz ${place.rank} von ${place.of} in der Bestenliste „${list}“`}>
      #{place.rank}
    </Link>
  );
}

/** Alles außerhalb der eigenen Top 10 einer Kategorie, verlinkt auf die Vielfalt-Bestenliste */
function RestRow({ category, list, total, place }: { category: TopCategory; list: { count: number }[]; total: number | undefined; place?: ListPlace }) {
  if (typeof total !== "number") return null;
  const rest = Math.max(0, total - list.reduce((s, e) => s + e.count, 0));
  if (rest <= 0) return null;
  return (
    <li className="ptop__row ptop__row--rest">
      <span className="ptop__name">
        <Link href={boardHref(`rest-${category}`)} title={`Bestenliste „${LEADERBOARDS[`rest-${category}`].title}“`}>
          Sonstiges
        </Link>
      </span>
      <span className="ptop__count num">
        {num(rest)}
        <Place place={place} href={boardHref(`rest-${category}`)} list={LEADERBOARDS[`rest-${category}`].title} />
      </span>
      <span className="ptop__track muted">{Math.round((rest / total) * 100)} % von {num(total)}</span>
    </li>
  );
}

/** Winzige Verlaufslinie (serverseitig, ohne JavaScript) */
function MiniTrend({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 60).toFixed(1)},${(14 - ((v - min) / span) * 12).toFixed(1)}`).join(" ");
  return (
    <svg className="ptop__trend" viewBox="0 0 60 16" width={60} height={16} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const DAY_MS = 24 * 3600_000;

/** Zusatzwerte aus /api/player/<id> im Profil: nach Rubrik gruppiert, jede Zeile öffnet den Graphen. */
export function PlayerDetails({
  id,
  detail,
  name,
  now,
  topHistory = [],
  totals = {},
  places = { items: {}, rest: {} },
}: {
  id: string;
  detail: PlayerDetail | null;
  /** Gesamtwerte der Top-Kategorien, die nicht in `detail.stats` stehen (Abgebaut, Mobs) */
  totals?: Partial<Record<string, number>>;
  /** Platz in den Bestenlisten der eigenen Top-Items und der Vielfalt */
  places?: TopPlaces;
  name: string;
  now: number;
  /** Gespeicherte Stände der Top-Listen, älteste zuerst */
  topHistory?: { at: string; tops: TopSnapshot }[];
}) {
  if (!detail) return null;
  // Vergleichsstand: der letzte vor 24 Stunden, sonst der älteste (mindestens eine Stunde alt)
  const older = topHistory.filter((h) => now - Date.parse(h.at) >= 3600_000);
  const compare = [...older].reverse().find((h) => now - Date.parse(h.at) >= DAY_MS) ?? older[0] ?? null;
  const toGraph = (metric: string) => graphHref(metric as Metric, [id]);
  const groups = STAT_GROUPS.map((g) => ({
    ...g,
    keys: EXTRA_STAT_KEYS.filter((k) => EXTRA_STATS[k].group === g.key && typeof detail.stats[k] === "number"),
  })).filter((g) => g.keys.length > 0);
  const tops = Object.entries(detail.tops).filter(([, list]) => list.length > 0);
  if (groups.length === 0 && tops.length === 0) return null;

  return (
    <section className="block" data-tone="paper">
      <div className="wrap">
        <Fold
          id="profil.details"
          title="Weitere Statistiken"
          aside={
            <span className="muted pdetail__stamp" title={dateTime(detail.fetchedAt)}>
              Stand {ago(detail.fetchedAt, now)}
              {detail.firstJoin ? ` · erster Join ${dateTime(detail.firstJoin)}` : ""}
            </span>
          }
        >

        {groups.length > 0 && (
          <div className="pdetail__grid">
            {groups.map((g) => {
              const IconCmp = Icon[GROUP_ICON[g.key] ?? "bolt"];
              return (
                <div key={g.key} className="box pdetail__card" data-tone="white">
                  <p className="pdetail__head" data-tone={GROUP_TONE[g.key] ?? "paper"}>
                    <IconCmp width={16} height={16} aria-hidden="true" />
                    <span>{g.label}</span>
                  </p>
                  <dl className="pdetail__rows">
                    {g.keys.map((k) => {
                      const meta = EXTRA_STATS[k];
                      const rank = detail.ranks[k];
                      return (
                        <div key={k} className="pdetail__row">
                          <dt>
                            <Link href={toGraph(meta.metric)} title={`${meta.label} von ${name} im Graphen öffnen`}>
                              {meta.label}
                            </Link>
                          </dt>
                          <dd className="num">{FORMATTERS[meta.format](detail.stats[k])}</dd>
                          <dd className="pdetail__rank">
                            {rank && (
                              <Link className="tag" data-tone={rank.rank <= 3 ? "gold" : "ink"} href={boardHref(k)} title={`Platz ${rank.rank} von ${rank.of} – Bestenliste „${LEADERBOARDS[k].title}“ öffnen`}>
                                #{rank.rank}
                              </Link>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              );
            })}
          </div>
        )}

        {tops.length > 0 && (
          <>
            <h3 className="t-3 pdetail__subhead">
              Top-Listen
              {compare && <span className="muted pdetail__since"> · Zuwachs seit {ago(compare.at, now)}</span>}
            </h3>
            <div className="pdetail__tops">
              {tops.map(([key, list]) => {
                const max = Math.max(1, ...list.map((e) => e.count));
                return (
                  <div key={key} className="box pdetail__card" data-tone="white">
                    <p className="pdetail__head" data-tone="paper">
                      <span>{TOP_LABELS[key] ?? key}</span>
                    </p>
                    <ol className="ptop">
                      {list.map((entry) => {
                        const before = compare?.tops[key]?.[entry.key];
                        const delta = before === undefined ? null : entry.count - before;
                        const trend = [...topHistory.map((h) => h.tops[key]?.[entry.key]).filter((v): v is number => typeof v === "number"), entry.count];
                        return (
                        <li key={entry.key} className="ptop__row">
                          <span className="ptop__name">
                            {isTopCategory(key) ? (
                              <Link href={itemHref(key, entry.key)} title={`Bestenliste für ${entry.name}`}>
                                {entry.name}
                              </Link>
                            ) : (
                              entry.name
                            )}
                          </span>
                          <span className="ptop__count num">
                            {num(entry.count)}
                            {isTopCategory(key) && <Place place={places.items[`${key}|${entry.key}`]} href={itemHref(key, entry.key)} list={entry.name} />}
                          </span>
                          <span className="ptop__track">
                            <span className="ptop__bar" aria-hidden="true">
                              <span style={{ width: `${(entry.count / max) * 100}%` }} />
                            </span>
                            {isTopCategory(key) ? (
                              <Link className="ptop__trend" href={toGraph(itemMetric(key, entry.key))} title={`${entry.name} im Graphen öffnen`}>
                                <MiniTrend values={trend.slice(-48)} />
                              </Link>
                            ) : (
                              <MiniTrend values={trend.slice(-48)} />
                            )}
                            {compare && (delta === null ? <span className="ptop__delta" data-new="true">neu</span> : delta > 0 ? <span className="ptop__delta num">+{num(delta)}</span> : <span className="ptop__delta" data-zero="true">±0</span>)}
                          </span>
                        </li>
                        );
                      })}
                      {isTopCategory(key) && <RestRow category={key} list={list} total={totals[key] ?? detail.stats[key]} place={places.rest[key]} />}
                    </ol>
                  </div>
                );
              })}
            </div>
          </>
        )}

        </Fold>
      </div>
    </section>
  );
}
