import Link from "next/link";
import { ListSearch } from "@/components/ListSearch";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import type { Metadata } from "next";
import { connection } from "next/server";
import { loadTracker } from "@/lib/data";
import { duration, num, ago } from "@/lib/format";
import { playtimeOf } from "@/lib/playtime";
import { getRecentTwitchChatMessages, getTwitchSubscriptionBoard } from "@/lib/store";
import { ChatFeed } from "@/components/ChatFeed";
import { Head } from "@/components/Head";
import { chatVodLinks } from "@/lib/events";


export const metadata: Metadata = { title: "Spieler" };

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/spieler">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Alle, die der Tracker je gesehen hat" title="Spieler" />}>
      <Players searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Players({ searchParams }: { searchParams: PageProps<"/spieler">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const filter = typeof sp.filter === "string" ? sp.filter : "alle";
  const [{ state, events, now }, subscriptionBoard, chatMessages] = await Promise.all([
    loadTracker(),
    getTwitchSubscriptionBoard(),
    getRecentTwitchChatMessages(20),
  ]);
  const subscriptions = new Map(subscriptionBoard.map((entry) => [entry.id, entry.value]));
  const chatVods = chatVodLinks(events);

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
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Alle, die der Tracker je gesehen hat</p>
          <h1 className="t-1">Spieler</h1>
          <p>
            Jeder, der seit Start des Trackers online war, gestreamt hat oder in einer Bestenliste aufgetaucht ist.
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
          <ListSearch targetId="spieler-liste" label="Spieler suchen" placeholder="Spieler suchen …" />

          {players.length === 0 ? (
            <p className="st-online__empty">Noch niemand erfasst. Gib dem Tracker eine Minute.</p>
          ) : (
            <ul id="spieler-liste" className="grid" style={{ "--min": "240px", "--gap": "16px", listStyle: "none", padding: 0, margin: 0 } as React.CSSProperties}>
              {players.map((p) => (
                <li key={p.id} data-search={[p.name, p.id, p.twitchLogin].filter(Boolean).join("|")}>
                  <Link className="box player-card" data-tone="white" href={`/spieler/${encodeURIComponent(p.id)}`}>
                    <div className="player-card__top">
                      <span className={p.online && p.afkSince ? "head-afk" : undefined} title={p.online && p.afkSince ? "AFK" : undefined}>
                        <Head id={p.id} uuid={p.uuid} name={p.name} size={48} decorative />
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
                            <span className="tag" data-tone="idle" title={`Keine Bewegung seit ${ago(p.afkSince).replace("vor ", "")}${p.afkFarm ? ` · ${p.afkFarm === "mobs" ? "farmt dabei Mobs" : "baut dabei Blöcke ab"}` : ""}`}>
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
                      {/* Kurz halten: Online-Zeit laut Tracker und Sessions stehen im Profil */}
                      {(subscriptions.get(p.id) ?? 0) > 0 && (
                        <>
                          <dt>Twitch Subs</dt>
                          <dd className="num">{num(subscriptions.get(p.id) ?? 0)}</dd>
                        </>
                      )}
                      {!p.online && (
                        <>
                          <dt>Zuletzt</dt>
                          <dd className="num">{ago(p.lastSeen)}</dd>
                        </>
                      )}
                    </dl>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <section className="chatsection" aria-labelledby="recent-twitch-chat">
            <div className="section-head">
              <h2 className="t-2" id="recent-twitch-chat">
                Chat
              </h2>
              <p className="muted">Was Spieler in den Twitch-Chats anderer Spieler schreiben. Mehr im Profil jedes Spielers.</p>
            </div>
            <div className="chatpair chatpair--single">
              <div className="box chatbox" data-tone="white">
                <div className="chatbox__head">
                  <p className="eyebrow">
                    Neueste Nachrichten <span className="num">({num(chatMessages.length)})</span>
                  </p>
                </div>
                <div className="chatbox__scroll">
                  <ChatFeed
                    messages={chatMessages}
                    uuidOf={(id) => state.players[id]?.uuid}
                    nameOf={(id) => state.players[id]?.name ?? id}
                    now={now}
                    empty="Noch keine Nachrichten zwischen erfassten Spielern."
                    vodOf={(mid) => chatVods.get(mid)}
                    label="Neueste Nachrichten von Spielern in Twitch-Chats"
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </>
  );
}
