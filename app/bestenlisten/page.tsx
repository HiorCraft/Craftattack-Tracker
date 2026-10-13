import Link from "next/link";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { getFullBoard, getTwitchSubscriptionBoard } from "@/lib/store";
import { getAfkBoard, getAfkRanksBefore, getBoardRanksBefore, getFollowerRanksBefore, getTrackedRanksBefore } from "@/lib/analytics";
import { BOARD_KEYS, type AfkKind, type BoardKey } from "@/lib/types";
import { ago, boardValue, duration, headUrl, num } from "@/lib/format";
import { BOARD_ICON, Icon } from "@/components/Icons";

// Kein Skeleton: die Seite wird komplett auf dem Server gerendert (SSR) und blockiert bis die Daten da sind.
export const instant = false;

export const metadata: Metadata = { title: "Bestenlisten" };

const BOARDS: Record<BoardKey | "followers" | "twitchSubs" | "tracked" | "afk" | "afkmobs" | "afkblocks", { title: string; sub: string; tone: string }> = {
  playtimeSeconds: { title: "Dauerzocker", sub: "Spielzeit laut API, außerhalb der Top 10 aus Join/Leave weitergerechnet", tone: "sky" },
  diamonds: { title: "Diamantenbank", sub: "Diamanten", tone: "diamond" },
  deaths: { title: "Friedhof", sub: "Tode", tone: "redstone" },
  blocksBroken: { title: "Abrissbirne", sub: "Abgebaute Blöcke", tone: "gold" },
  mobsKilled: { title: "Monsterjäger", sub: "Erledigte Mobs", tone: "grass" },
  distance: { title: "Weltenbummler", sub: "Gelaufene Strecke", tone: "pink" },
  followers: { title: "Follower-Zuwachs auf dem Server", sub: "Neue Twitch-Follower während der Streamer auf dem Server waren", tone: "twitch" },
  twitchSubs: { title: "Sub-Stars", sub: "Twitch-Abos auf dem Server seit Beginn der IRC-Erfassung", tone: "amethyst" },
  tracked: { title: "Dauergäste", sub: "Online-Zeit laut Tracker, alle Spieler", tone: "lava" },
  afk: { title: "Standbilder", sub: "AFK-Zeit laut Tracker: online, aber ≥ 5 Min keine Bewegung", tone: "gold" },
  afkmobs: { title: "Mob-Farmer", sub: "AFK-Zeit, in der trotzdem ≥ 10 Mobs pro Minute gestorben sind (AFK-Mobfarm)", tone: "gold" },
  afkblocks: { title: "Block-Farmer", sub: "AFK-Zeit, in der trotzdem ≥ 10 Blöcke pro Minute abgebaut wurden (AFK-Blockfarm)", tone: "gold" },
};
const KEYS = [...BOARD_KEYS, "followers", "twitchSubs", "tracked", "afk", "afkmobs", "afkblocks"] as const;
const AFK_KEYS = ["afk", "afkmobs", "afkblocks"] as const;
const isAfkKey = (k: string): k is (typeof AFK_KEYS)[number] => (AFK_KEYS as readonly string[]).includes(k);
const afkKindOf = (k: string): AfkKind | undefined => (k === "afkmobs" ? "mobs" : k === "afkblocks" ? "blocks" : undefined);
type Key = (typeof KEYS)[number];
/** Vergleichszeitraum für die ▲/▼-Anzeige */
const SPANS = {
  "1h": { hours: 1, label: "1 Stunde" },
  "6h": { hours: 6, label: "6 Stunden" },
  "12h": { hours: 12, label: "12 Stunden" },
  "24h": { hours: 24, label: "24 Stunden" },
  "7d": { hours: 168, label: "7 Tagen" },
} as const;
type Span = keyof typeof SPANS;

function listHref(key: Key, span: Span) {
  const q = new URLSearchParams();
  if (key !== "playtimeSeconds") q.set("liste", key);
  if (span !== "24h") q.set("seit", span);
  const qs = q.toString();
  return qs ? `/bestenlisten?${qs}` : "/bestenlisten";
}

export default async function Page(props: PageProps<"/bestenlisten">) {
  const sp = await props.searchParams;
  const raw = typeof sp.liste === "string" ? sp.liste : "playtimeSeconds";
  const key: Key = (KEYS as readonly string[]).includes(raw) ? (raw as Key) : "playtimeSeconds";
  const span: Span = typeof sp.seit === "string" && sp.seit in SPANS ? (sp.seit as Span) : "24h";
  const hours = SPANS[span].hours;
  const [{ state, now }, ranksBefore]: [{ state: Awaited<ReturnType<typeof loadTracker>>["state"]; now: number }, Record<string, number>] = await Promise.all([
    loadTracker(),
    key === "tracked"
      ? getTrackedRanksBefore(hours)
      : isAfkKey(key)
        ? getAfkRanksBefore(hours, afkKindOf(key))
        : key === "followers"
          ? getFollowerRanksBefore(hours)
        : key === "twitchSubs"
          ? Promise.resolve({})
          : getBoardRanksBefore(hours).then((r) => r[key] ?? {}),
  ]);
  const b = BOARDS[key];

  let rows: { id: string; name: string; uuid: string; value: number; at: string | null; online: boolean; afkNow?: boolean }[];
  if (isAfkKey(key)) {
    rows = (await getAfkBoard(afkKindOf(key))).map((r) => ({ ...r, at: null }));
  } else if (key === "tracked") {
    rows = Object.values(state.players)
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
  } else if (key === "twitchSubs") {
    rows = await getTwitchSubscriptionBoard();
  } else {
    rows = await getFullBoard(key);
  }
  const inApi = new Set((key === "tracked" || key === "followers" || key === "twitchSubs" || isAfkKey(key) ? [] : state.latest?.boards?.[key] ?? []).map((e) => e.id));
  const fmt = (v: number) => (key === "tracked" || isAfkKey(key) ? duration(v) : key === "followers" ? num(v) : boardValue(key, v));
  const IconCmp = key === "followers" || key === "tracked" ? Icon.users : key === "twitchSubs" ? Icon.gift : key === "afkmobs" ? Icon.sword : key === "afkblocks" ? Icon.pickaxe : key === "afk" ? Icon.clock : Icon[BOARD_ICON[key]];

  return (
    <>
      <section className="block page-head" data-tone={b.tone}>
        <div className="wrap">
          <p className="eyebrow">Mehr als Top 10</p>
          <h1 className="t-1">Bestenlisten</h1>
          <p>
            Die API zeigt pro Spielstatistik nur zehn Namen. Der Tracker merkt sich aber jeden, der dort je aufgetaucht ist,
            mit seinem letzten bekannten Wert. Twitch-Follower werden minütlich für alle erfassten Kanäle gelesen.
            Twitch-Abos werden ab Beginn der IRC-Erfassung gezählt, aber nur wenn der Streamer beim Eingang auf dem Server online war (AFK zählt als online).
          </p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <ul className="filters" aria-label="Liste wählen">
            {KEYS.map((k) => (
              <li key={k}>
                <Link className="tag" data-tone={k === key ? undefined : BOARDS[k].tone} aria-current={k === key ? "true" : undefined} href={listHref(k, span)}>
                  {BOARDS[k].title}
                </Link>
              </li>
            ))}
          </ul>
          <ul className="filters" aria-label="Vergleichszeitraum" style={{ marginTop: 8 }}>
            {(Object.keys(SPANS) as Span[]).map((sKey) => (
              <li key={sKey}>
                <Link className="tag" data-tone={sKey === span ? undefined : "white"} aria-current={sKey === span ? "true" : undefined} href={listHref(key, sKey)}>
                  ▲▼ vs. {SPANS[sKey].label}
                </Link>
              </li>
            ))}
          </ul>

          <section className="box st-board" data-tone={b.tone} style={{ maxWidth: 760 }} aria-labelledby="fb-h">
            <header className="st-board__head">
              <span className="st-board__icon">
                <IconCmp aria-hidden="true" />
              </span>
              <div>
                <h2 className="t-3" id="fb-h">
                  {b.title} <span className="num">({num(rows.length)})</span>
                </h2>
                <p className="st-board__sub">{b.sub}</p>
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
                      <img className="head" src={headUrl(e.uuid, 28, e.id)} alt="" width={28} height={28} loading="lazy" />
                      <span className="st-board__name">
                        {e.name}
                        {e.online && <span className="dot" style={{ display: "inline-block", marginLeft: 8, verticalAlign: "middle" }} title="online" />}
                      </span>
                      <span className="st-board__meta">
                        {isAfkKey(key) ? (e.afkNow ? (key === "afk" ? "gerade AFK" : "farmt gerade") : "") : key === "tracked" ? (e.online ? "läuft" : "") : inApi.has(e.id) ? "aktuell" : e.at ? `Stand ${ago(e.at, now)}` : ""}
                      </span>
                      <span className="st-board__val num">{fmt(e.value)}</span>
                      {diff === null ? (
                        <span className="st-board__mv st-board__mv--new" title={`Vor ${SPANS[span].label} noch nicht erfasst`}>
                          neu
                        </span>
                      ) : diff > 0 ? (
                        <span className="st-board__mv st-board__mv--up num" title={title}>
                          ▲{diff}
                        </span>
                      ) : diff < 0 ? (
                        <span className="st-board__mv st-board__mv--down num" title={title}>
                          ▼{-diff}
                        </span>
                      ) : (
                        <span className="st-board__mv" aria-hidden="true" />
                      )}
                    </Link>
                  </li>
                  );
                })
              )}
            </ol>
          </section>
          <p className="muted" style={{ marginTop: 16, fontSize: ".9375rem", maxWidth: 760 }}>
            „Aktuell“ heißt: steht gerade in der Top 10 der API. Bei allen anderen API-Listen ist der Wert der letzte, den der
            Tracker gesehen hat, der echte Wert kann inzwischen höher sein. „Dauergäste“, „Standbilder“ und die AFK-Farmer misst der Tracker selbst, für alle. ▲▼ zeigt die
            Bewegung gegenüber dem Stand vor {SPANS[span].label}, „neu“ heißt: damals noch nicht in der Liste.
          </p>
        </div>
      </section>
    </>
  );
}
