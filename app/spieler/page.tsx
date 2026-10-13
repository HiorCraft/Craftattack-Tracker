import Link from "next/link";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { duration, headUrl, num, ago } from "@/lib/format";
import { playtimeOf, trackedSecondsOf } from "@/lib/playtime";
import { getTwitchSubscriptionBoard } from "@/lib/store";

// Kein Skeleton: die Seite wird komplett auf dem Server gerendert (SSR) und blockiert bis die Daten da sind.
export const instant = false;

export const metadata: Metadata = { title: "Spieler" };

export default function Page(props: PageProps<"/spieler">) {
  return (
      <Players searchParams={props.searchParams} />
  );
}

async function Players({ searchParams }: { searchParams: PageProps<"/spieler">["searchParams"] }) {
  const sp = await searchParams;
  const filter = typeof sp.filter === "string" ? sp.filter : "alle";
  const [{ state, now }, subscriptionBoard] = await Promise.all([loadTracker(), getTwitchSubscriptionBoard()]);
  const subscriptions = new Map(subscriptionBoard.map((entry) => [entry.id, entry.value]));

  let players = Object.values(state.players);
  if (filter === "online") players = players.filter((p) => p.online);
  if (filter === "live") players = players.filter((p) => p.live);
  if (filter === "nurserver") players = players.filter((p) => p.online && !p.live);
  if (filter === "afk") players = players.filter((p) => p.online && p.afkSince);
  players.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const av = a.live?.viewers ?? -1;
    const bv = b.live?.viewers ?? -1;
    if (av !== bv) return bv - av;
    return playtimeOf(b, now).seconds - playtimeOf(a, now).seconds || a.name.localeCompare(b.name, "de");
  });

  const counts = {
    alle: Object.keys(state.players).length,
    online: Object.values(state.players).filter((p) => p.online).length,
    live: Object.values(state.players).filter((p) => p.live).length,
    nurserver: Object.values(state.players).filter((p) => p.online && !p.live).length,
  };

  return (
    <>
      <section className="block page-head" data-tone="grass">
        <div className="wrap">
          <p className="eyebrow">Alle, die der Tracker je gesehen hat</p>
          <h1 className="t-1">Spieler</h1>
          <p>
            Jeder, der seit Start des Trackers online war, gestreamt hat oder in einer Bestenliste aufgetaucht ist.
            Die Zahlen sind der letzte bekannte Stand.
          </p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <div className="section-head">
            <ul className="filters" aria-label="Filter">
              {(["alle", "online", "live", "nurserver"] as const).map((f) => (
                <li key={f}>
                  <Link className="tag" aria-current={filter === f ? "true" : undefined} href={f === "alle" ? "/spieler" : `/spieler?filter=${f}`}>
                    {f === "alle" ? "Alle" : f === "online" ? "Online" : f === "live" ? "Live" : "Online, nicht live"} <span className="num">({counts[f]})</span>
                  </Link>
                </li>
              ))}
            </ul>
            <p className="muted num">{num(players.length)} Spieler</p>
          </div>

          {players.length === 0 ? (
            <p className="st-online__empty">Noch niemand erfasst. Gib dem Tracker eine Minute.</p>
          ) : (
            <ul className="grid" style={{ "--min": "240px", "--gap": "16px", listStyle: "none", padding: 0, margin: 0 } as React.CSSProperties}>
              {players.map((p) => (
                <li key={p.id}>
                  <Link className="box player-card" data-tone="white" href={`/spieler/${encodeURIComponent(p.id)}`}>
                    <div className="player-card__top">
                      <span className={p.online && p.afkSince ? "head-afk" : undefined} title={p.online && p.afkSince ? "AFK" : undefined}>
                        <img className="head" src={headUrl(p.uuid, 48, p.id)} alt="" width={48} height={48} loading="lazy" />
                      </span>
                      <div>
                        <p className="player-card__name">{p.name}</p>
                        <div className="player-card__tags">
                          {p.online ? (
                            <span className="tag" data-tone="grass">
                              <span className="dot" /> Online
                            </span>
                          ) : (
                            <span className="tag" data-tone="paper">
                              Offline
                            </span>
                          )}
                          {p.online && p.afkSince && (
                            <span className="tag" data-tone="gold" title={`Keine Bewegung seit ${ago(p.afkSince).replace("vor ", "")}${p.afkFarm ? ` · ${p.afkFarm === "mobs" ? "farmt dabei Mobs" : "baut dabei Blöcke ab"}` : ""}`}>
                              AFK{p.afkFarm ? ` · ${p.afkFarm === "mobs" ? "Mobs" : "Blöcke"}` : ""}
                            </span>
                          )}
                          {p.live && (
                            <span className="tag" data-tone="twitch">
                              <span className="dot dot--live" /> {num(p.live.viewers)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <dl className="player-card__stats">
                      <dt>Spielzeit</dt>
                      <dd className="num">
                        {(() => {
                          const pt = playtimeOf(p, now);
                          if (pt.source === "api") return duration(pt.seconds);
                          const title = pt.source === "estimate" ? "Nicht mehr in der Top 10 der API – letzter API-Wert plus seitdem vom Tracker gemessene Online-Zeit" : "Nicht in der Top 10 der API – vom Tracker gemessene Online-Zeit";
                          return <span title={title}>{duration(pt.seconds)}*</span>;
                        })()}
                      </dd>
                      <dt>Tode</dt>
                      <dd className="num">{p.stats.deaths !== undefined ? num(p.stats.deaths) : "–"}</dd>
                      <dt>Twitch Subs</dt>
                      <dd className="num">
                        {num(subscriptions.get(p.id) ?? 0)}
                      </dd>
                      <dt title="Vom Tracker gemessen, für alle Spieler">Online (Tracker)</dt>
                      <dd className="num">
                        {duration(trackedSecondsOf(p, now))}
                      </dd>
                      <dt>Sessions</dt>
                      <dd className="num">{num(p.sessions)}</dd>
                      <dt>Zuletzt</dt>
                      <dd className="num">{p.online ? "jetzt" : ago(p.lastSeen)}</dd>
                    </dl>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
