import Link from "next/link";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { getFullBoard, getTwitchSubscriptionBoard } from "@/lib/store";
import { getAfkBoard, getAfkRanksBefore, getBoardRanksBefore, getExtraRanksBefore, getFollowerRanksBefore, getTopRanksBefore, getTrackedRanksBefore } from "@/lib/analytics";
import { BOARD_KEYS, type AfkKind, type BoardKey } from "@/lib/types";
import { ago, boardValue, duration, num } from "@/lib/format";
import { BoardValue } from "@/components/BoardValue";
import { BoardMove } from "@/components/BoardMove";
import { getBoardRows, passedPlayers } from "@/lib/boardRows";
import { Icon } from "@/components/Icons";
import { playtimeOf } from "@/lib/playtime";
import { Head } from "@/components/Head";
import { EXTRA_STATS, FORMATTERS, type ExtraStatKey } from "@/lib/playerStats";
import { HowLink } from "@/components/HowLink";
import { ItemPicker } from "@/components/ItemPicker";
import { graphHref, itemMetric, type Metric } from "@/lib/graphQuery";
import {
  LEADERBOARDS,
  LEADERBOARD_GROUPS,
  LEADERBOARD_KEYS,
  boardHref,
  isLeaderboardKey,
  itemBoardMeta,
  itemOptions,
  itemHref,
  itemRanking,
  restRanking,
  parseItemParam,
  type LeaderboardKey,
  type LeaderboardMeta,
  type TopCategory,
} from "@/lib/leaderboards";

export const metadata: Metadata = { title: "Bestenlisten" };

type Key = Exclude<LeaderboardKey, "top">;
const AFK_KEYS = ["afk", "afkmobs", "afkblocks"] as const;
const isAfkKey = (k: string): k is (typeof AFK_KEYS)[number] => (AFK_KEYS as readonly string[]).includes(k);
const afkKindOf = (k: string): AfkKind | undefined => (k === "afkmobs" ? "mobs" : k === "afkblocks" ? "blocks" : undefined);
const isBoardKey = (k: string): k is BoardKey => (BOARD_KEYS as readonly string[]).includes(k);
const isExtraKey = (k: string): k is ExtraStatKey => k in EXTRA_STATS;
const isRestKey = (k: string): k is `rest-${TopCategory}` => k.startsWith("rest-");
const restCategory = (k: `rest-${TopCategory}`) => k.slice("rest-".length) as TopCategory;

/** Vergleichszeitraum für die ▲/▼-Anzeige */
const SPANS = {
  "1h": { hours: 1, label: "1 Stunde" },
  "6h": { hours: 6, label: "6 Stunden" },
  "12h": { hours: 12, label: "12 Stunden" },
  "24h": { hours: 24, label: "24 Stunden" },
  "7d": { hours: 168, label: "7 Tagen" },
} as const;
type Span = keyof typeof SPANS;

type Row = {
  id: string;
  name: string;
  uuid: string;
  value: number;
  at: string | null;
  online: boolean;
  afkNow?: boolean;
  playtimeSource?: ReturnType<typeof playtimeOf>["source"];
  /** Zusatz rechts neben dem Namen */
  note?: string;
};

async function Boards(props: PageProps<"/bestenlisten">) {
  const sp = await props.searchParams;
  const raw = typeof sp.liste === "string" ? sp.liste : "playtimeSeconds";
  const item = raw === "top" ? parseItemParam(typeof sp.item === "string" ? sp.item : undefined) : null;
  const key: Key | "top" = item ? "top" : isLeaderboardKey(raw) ? raw : "playtimeSeconds";
  const span: Span = typeof sp.seit === "string" && sp.seit in SPANS ? (sp.seit as Span) : "24h";
  const hours = SPANS[span].hours;
  // ▲▼ gibt es überall, wo der Tracker einen früheren Stand kennt (Twitch-Abos zählen erst seit der IRC-Erfassung)
  const hasMovement = key !== "twitchSubs";
  const [{ state, now }, ranksBefore]: [{ state: Awaited<ReturnType<typeof loadTracker>>["state"]; now: number }, Record<string, number>] = await Promise.all([
    loadTracker(),
    key === "tracked"
      ? getTrackedRanksBefore(hours)
      : isAfkKey(key)
        ? getAfkRanksBefore(hours, afkKindOf(key))
        : key === "followers"
          ? getFollowerRanksBefore(hours)
          : isBoardKey(key)
            ? getBoardRanksBefore(hours).then((r) => r[key] ?? {})
            : isExtraKey(key)
              ? getExtraRanksBefore(key, hours)
              : isRestKey(key)
                ? getTopRanksBefore(restCategory(key), hours)
                : key === "top" && item
                  ? getTopRanksBefore(item.category, hours, item.key)
                  : Promise.resolve({}),
  ]);
  const players = Object.values(state.players);
  const options = itemOptions(players);
  const itemName = item ? (options[item.category]?.find((o) => o.key === item.key)?.name ?? item.key) : "";
  const b: LeaderboardMeta = key === "top" ? itemBoardMeta(item!.category, itemName) : LEADERBOARDS[key];

  let rows: Row[];
  let fmt: (v: number) => string = num;
  if (key === "playtimeSeconds") {
    rows = await getBoardRows("playtimeSeconds", state, now);
    fmt = (v) => boardValue("playtimeSeconds", v);
  } else if (isAfkKey(key)) {
    rows = (await getAfkBoard(afkKindOf(key))).map((r) => ({ ...r, at: null }));
    fmt = duration;
  } else if (key === "tracked") {
    rows = players
      .map((p) => ({
        id: p.id,
        name: p.name,
        uuid: p.uuid,
        value: p.trackedSeconds + (p.online && p.sessionStart ? (now - Date.parse(p.sessionStart)) / 1000 : 0),
        at: null,
        online: p.online,
      }))
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value);
    fmt = duration;
  } else if (key === "twitchSubs") {
    rows = await getTwitchSubscriptionBoard();
  } else if (key === "followers") {
    rows = await getFullBoard("followers");
  } else if (isBoardKey(key)) {
    rows = await getBoardRows(key, state, now);
    fmt = (v) => boardValue(key, v);
  } else if (isExtraKey(key)) {
    // Zusatzwerte: letzter Stand aus /api/player für jeden Spieler, den der Tracker je abgefragt hat
    rows = players
      .flatMap((p) => {
        const v = p.detail?.stats[key];
        return typeof v === "number" && v > 0 ? [{ id: p.id, name: p.name, uuid: p.uuid, value: v, at: p.detail!.fetchedAt, online: p.online }] : [];
      })
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "de"));
    fmt = FORMATTERS[EXTRA_STATS[key].format];
  } else if (isRestKey(key)) {
    // Vielfalt: Gesamtwert minus Summe der eigenen Top 10
    rows = restRanking(players, restCategory(key)).map(({ player: p, rest, total }) => ({
      id: p.id,
      name: p.name,
      uuid: p.uuid,
      value: rest,
      at: p.detail!.fetchedAt,
      online: p.online,
      note: `${Math.round((rest / total) * 100)} % von ${num(total)}`,
    }));
  } else {
    // Einzelnes Item: nur Spieler, bei denen es in den eigenen Top 10 steht
    rows = itemRanking(players, item!.category, item!.key).map(({ player: p, count }) => ({
      id: p.id,
      name: p.name,
      uuid: p.uuid,
      value: count,
      at: p.detail!.fetchedAt,
      online: p.online,
    }));
  }
  const inApi = new Set((isBoardKey(key) ? (state.latest?.boards?.[key] ?? []) : []).map((e) => e.id));
  const IconCmp = Icon[b.icon as keyof typeof Icon] ?? Icon.trophy;
  // Dieselbe Liste als Verlauf im Graphen (Werte der besten fünf); Vielfalt hat keinen eigenen Verlauf
  const graphMetric: Metric | null =
    key === "top"
      ? itemMetric(item!.category, item!.key)
      : isExtraKey(key)
        ? (EXTRA_STATS[key].metric as Metric)
        : isAfkKey(key)
          ? key === "afk" ? "afkSeconds" : key === "afkmobs" ? "afkMobsSeconds" : "afkBlocksSeconds"
          : key === "tracked" || isRestKey(key)
            ? null
            : (key as Metric);
  const graphLink = graphMetric ? graphHref(graphMetric, rows.slice(0, 5).map((r) => r.id)) : null;
  // Zeitraum wechseln, ohne die gewählte Liste (bei Einzel-Items samt Item) zu verlieren
  const spanHref = (s: Span) =>
    key === "top" ? `${itemHref(item!.category, item!.key)}${s !== "24h" ? `&seit=${s}` : ""}` : boardHref(key, s);
  const meta = (e: Row) => {
    if (e.note) return e.note;
    if (isAfkKey(key)) return e.afkNow ? (key === "afk" ? "gerade AFK" : "farmt gerade") : "";
    if (key === "tracked") return e.online ? "läuft" : "";
    if (key === "playtimeSeconds") return inApi.has(e.id) ? "" : e.playtimeSource === "estimate" ? "geschätzt" : e.playtimeSource === "tracker" ? "Tracker" : "API-Wert";
    if (isBoardKey(key) && inApi.has(e.id)) return "";
    // Älter als eine Stunde: Stand dazuschreiben
    return e.at && now - Date.parse(e.at) > 3600_000 ? `Stand ${ago(e.at, now)}` : "";
  };

  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Mehr als Top 10</p>
          <h1 className="t-1">Bestenlisten</h1>
          <p>Jeder Spieler, den der Tracker je gesehen hat – nicht nur die Top 10 der API.</p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap bl-layout">
          {/* Auswahl links, die Liste daneben sofort sichtbar (schmal: Liste zuerst) */}
          <aside className="bl-side" id="listen" aria-label="Liste wählen">
          <div className="ev-filters">
            {LEADERBOARD_GROUPS.map((g) => {
              const keys = LEADERBOARD_KEYS.filter((k) => LEADERBOARDS[k].group === g.key);
              if (keys.length === 0) return null;
              return (
                <div key={g.key} className="ev-filters__row">
                  <p className="eyebrow">{g.label}</p>
                  <ul className="filters" aria-label={`Listen: ${g.label}`}>
                    {keys.map((k) => (
                      <li key={k}>
                        <Link className="tag" data-tone="white" aria-current={k === key ? "true" : undefined} href={boardHref(k, span)} title={LEADERBOARDS[k].sub}>
                          <span className="swatch" data-tone={LEADERBOARDS[k].tone} aria-hidden="true" />
                          {LEADERBOARDS[k].title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <div className="ev-filters__row">
              <p className="eyebrow">Einzeln</p>
              <ItemPicker options={options} selected={item ? [`${item.category}|${item.key}`] : []} hrefPrefix="/bestenlisten?liste=top&item=" initialCategory={item?.category} />
            </div>
          </div>
          {hasMovement && (
            <ul className="filters" aria-label="Vergleichszeitraum" style={{ marginTop: 8 }}>
              {(Object.keys(SPANS) as Span[]).map((sKey) => (
                <li key={sKey}>
                  <Link className="tag" data-tone={sKey === span ? undefined : "white"} aria-current={sKey === span ? "true" : undefined} href={spanHref(sKey)}>
                    ▲▼ vs. {SPANS[sKey].label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          </aside>

          <section className="box st-board bl-main" data-tone={b.tone} aria-labelledby="fb-h">
            <header className="st-board__head">
              <span className="st-board__icon">
                <IconCmp aria-hidden="true" />
              </span>
              <div>
                <h2 className="t-3" id="fb-h">
                  {b.title} <span className="num">({num(rows.length)})</span>
                </h2>
                <p className="st-board__sub">
                  {b.sub}
                  {graphLink && (
                    <>
                      {" · "}
                      <Link href={graphLink}>Im Graph</Link>
                    </>
                  )}
                </p>
              </div>
            </header>
            <ol className="st-board__list st-board__list--full">
              {rows.length === 0 ? (
                <li className="st-board__note">
                  Noch keiner. {key === "followers" ? "Die Liste füllt sich, sobald Follower-Zuwächse während Server-Sessions erfasst werden." : "Die Liste füllt sich, sobald Spieler in der API auftauchen."}
                </li>
              ) : (
                rows.map((e, i) => {
                  const before = ranksBefore[e.id];
                  const diff = before === undefined ? null : before - (i + 1);
                  const title = `Vor ${SPANS[span].label} Platz ${before}`;
                  return (
                    <li key={e.id}>
                      <Link className="st-board__row st-board__row--full" href={`/spieler/${encodeURIComponent(e.id)}`}>
                        <span className="st-board__rank num">{i + 1}</span>
                        <Head id={e.id} uuid={e.uuid} name={e.name} decorative />
                        <span className="st-board__name">
                          {e.name}
                          {e.online && <span className="dot" style={{ display: "inline-block", marginLeft: 8, verticalAlign: "middle" }} title="online" />}
                        </span>
                        <span className="st-board__meta">{meta(e)}</span>
                        <span className="st-board__val num">{key === "damageDealt" ? <BoardValue k={key} v={e.value} /> : fmt(e.value)}</span>
                        {/* Platzhalter: der Pfeil liegt als eigener Link darüber */}
                        <span className="st-board__mv" aria-hidden="true" />
                      </Link>
                      {hasMovement && (
                        <BoardMove
                          diff={diff}
                          title={title}
                          newTitle={`Vor ${SPANS[span].label} noch nicht erfasst`}
                          href={graphMetric ? graphHref(graphMetric, [e.id, ...passedPlayers(rows, i, ranksBefore)], span) : null}
                        />
                      )}
                    </li>
                  );
                })
              )}
            </ol>
          </section>
          <HowLink section="bestenlisten" />
          <a className="bl-jump" href="#listen">
            Liste wechseln ↓
          </a>
        </div>
      </section>
    </>
  );
}

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/bestenlisten">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Mehr als Top 10" title="Bestenlisten" />}>
      <Boards {...props} />
    </Suspense>
  );
}
