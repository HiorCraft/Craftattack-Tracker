import Link from "next/link";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/Skeletons";
import type { Metadata } from "next";
import { loadTracker } from "@/lib/data";
import { dayKey, getDayTimeline, getTimelapse } from "@/lib/analytics";
import { duration, num, time } from "@/lib/format";
import { DateNav } from "@/components/DateNav";
import { Timelapse } from "@/components/Timelapse";
import { GanttLiveSegment } from "@/components/GanttLiveSegment";
import { findVodAt } from "@/lib/twitch";
import { Head } from "@/components/Head";
import { HowLink } from "@/components/HowLink";

export const metadata: Metadata = { title: "Zeitstrahl" };

const dayLong = new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" });
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

/** Sortierung der Gantt-Liste (?sortieren=…) */
const SORTS = [
  { key: "spielzeit", label: "Spielzeit", hint: "Online-Zeit an diesem Tag, inklusive AFK" },
  { key: "aktiv", label: "Aktiv auf dem Server", hint: "Online-Zeit ohne AFK" },
  { key: "afk", label: "AFK-Zeit", hint: "Laut Server: online, aber mindestens 5 Minuten keine Bewegung" },
  { key: "afkmobs", label: "AFK Mobs farmen", hint: "AFK-Zeit, in der trotzdem ≥ 10 Mobs pro Minute gestorben sind" },
  { key: "afkblocks", label: "AFK Blöcke farmen", hint: "AFK-Zeit, in der trotzdem ≥ 10 Blöcke pro Minute abgebaut wurden" },
  { key: "live", label: "Live auf Twitch", hint: "Stream-Dauer an diesem Tag" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];
const sortValue = (r: { seconds: number; afkSeconds: number; afkMobsSeconds: number; afkBlocksSeconds: number; liveSeconds: number }, key: SortKey) =>
  key === "aktiv" ? r.seconds - r.afkSeconds : key === "afk" ? r.afkSeconds : key === "afkmobs" ? r.afkMobsSeconds : key === "afkblocks" ? r.afkBlocksSeconds : key === "live" ? r.liveSeconds : r.seconds;
const AFK_TIP: Record<string, string> = { mobs: "AFK, farmt Mobs", blocks: "AFK, baut Blöcke ab" };

async function Timeline(props: PageProps<"/zeitstrahl">) {
  const sp = await props.searchParams;
  const { state } = await loadTracker();
  const tag = typeof sp.tag === "string" ? sp.tag : undefined;
  const sort: SortKey = SORTS.find((s) => s.key === sp.sortieren)?.key ?? "spielzeit";
  const [{ nav, rows: unsorted, now }, lapse] = await Promise.all([getDayTimeline(tag), getTimelapse(tag)]);
  // Nach gewähltem Wert sortieren, Gleichstand nach Spielzeit, dann Name
  const rows = [...unsorted].sort((a, b) => sortValue(b, sort) - sortValue(a, sort) || b.seconds - a.seconds || a.name.localeCompare(b.name, "de"));
  const vodOffsets = await Promise.all(
    rows.map(async (r) => {
      const login = state.players[r.id]?.twitchLogin ?? state.players[r.id]?.live?.login;
      if (!login) return r.live.map(() => null);
      return Promise.all(r.live.map(([a]) => findVodAt(login, a).catch(() => null)));
    }),
  );
  const sortHref = (key: SortKey) => {
    const q = new URLSearchParams();
    if (tag) q.set("tag", tag);
    if (key !== "spielzeit") q.set("sortieren", key);
    const s = q.toString();
    return `/zeitstrahl${s ? `?${s}` : ""}#balken`;
  };
  const span = nav.to - nav.from;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - nav.from) / span) * 100));
  const nowPct = now < nav.to && now > nav.from ? pct(now) : null;
  /** „12:30–14:05“ bzw. „… – jetzt“ für einen Balken */
  const fmtSpan = (a: number, b: number) => `${time(new Date(a).toISOString())}–${b >= now - 60_000 && !nav.next ? "jetzt" : time(new Date(b).toISOString())}`;
  /** Tooltip am Rand nach innen ausrichten */
  const edge = (a: number, b: number) => ((pct(a) + pct(b)) / 2 > 72 ? "right" : (pct(a) + pct(b)) / 2 < 18 ? "left" : undefined);
  const total = rows.reduce((s, r) => s + r.seconds, 0);
  const afkTotal = rows.reduce((s, r) => s + r.afkSeconds, 0);
  const farmTotal = rows.reduce((s, r) => s + r.afkMobsSeconds + r.afkBlocksSeconds, 0);
  const liveCount = rows.filter((r) => r.live.length).length;
  const peak = lapse.frames.reduce((m, f) => Math.max(m, f.online.length), 0);

  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Ein Tag auf dem Server</p>
          <h1 className="t-1">Zeitstrahl</h1>
          <p>
            Wer an diesem Tag wann auf dem Server und live war – im Zeitraffer und als Balken.
            {nav.dataFrom && <> Daten an diesem Tag ab {time(new Date(nav.dataFrom).toISOString())} Uhr.</>}
          </p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <div className="section-head">
            <div>
              <h2 className="t-2">{dayLong.format(nav.from + 12 * 3600_000)}</h2>
              <p className="muted num" style={{ marginTop: 8 }}>
                {num(rows.length)} Spieler · {duration(total)} Spielzeit zusammen{afkTotal > 0 ? ` (davon ${duration(afkTotal)} AFK${farmTotal > 0 ? `, ${duration(farmTotal)} AFK-Farm` : ""})` : ""} · {num(liveCount)} mit Stream · Spitze {num(peak)} gleichzeitig
              </p>
            </div>
            <DateNav base="/zeitstrahl" day={nav.day} prev={nav.prev} next={nav.next} max={dayKey(now)} />
          </div>

          <div className="box" data-tone="white" id="zeitraffer" style={{ marginBottom: 24 }}>
            <div className="stat-card__head">
              <h3 className="t-3">Zeitraffer</h3>
              <p className="muted">Alle fünf Minuten ein Bild. Abspielen oder mit dem Regler durch den Tag ziehen.</p>
            </div>
            <Timelapse data={lapse} />
          </div>

          <div className="box" data-tone="white" id="balken">
            <div className="stat-card__head">
              <h3 className="t-3">Wer war wann da</h3>
              <p className="muted">Sortiert nach {SORTS.find((s) => s.key === sort)!.label.toLowerCase()}, die Summenspalte zeigt den Wert.</p>
            </div>
            <ul className="filters" aria-label="Sortieren nach" style={{ marginBottom: 12 }}>
              {SORTS.map((s) => (
                <li key={s.key}>
                  <Link className="tag" aria-current={sort === s.key ? "true" : undefined} href={sortHref(s.key)} title={s.hint}>
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="legend" style={{ marginBottom: 12 }}>
              <li>
                <i style={{ background: "var(--presence)" }} /> auf dem Server
              </li>
              <li>
                <i className="legend__afk" /> AFK (laut Server, ≥ 5 Min keine Bewegung)
              </li>
              <li>
                <i className="legend__afk legend__afk--mobs" /> AFK, farmt Mobs (≥ 10 Mobs/Min)
              </li>
              <li>
                <i className="legend__afk legend__afk--blocks" /> AFK, baut Blöcke ab (≥ 10 Blöcke/Min)
              </li>
              <li>
                <i style={{ background: "var(--twitch)" }} /> live auf Twitch
              </li>
              {nowPct !== null && (
                <li>
                  <i style={{ background: "var(--ink)" }} /> jetzt
                </li>
              )}
            </ul>
            {rows.length === 0 ? (
              <p className="st-online__empty">An diesem Tag war niemand online{nav.dataFrom ? " – zumindest seit der Tracker läuft" : ""}.</p>
            ) : (
              <div className="gantt" role="table" aria-label="Online-Zeiten pro Spieler">
                <div className="gantt__row gantt__head" role="row">
                  <span />
                  <div className="gantt__axis num" aria-hidden="true">
                    {HOURS.map((h) => (
                      <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
                        {String(h).padStart(2, "0")}
                      </span>
                    ))}
                  </div>
                  <span className="gantt__sum muted">{sort === "spielzeit" ? "Summe" : SORTS.find((s) => s.key === sort)!.label}</span>
                </div>
                {rows.map((r, rowIndex) => (
                  <div className="gantt__row" role="row" key={r.id}>
                    <Link className="gantt__name" href={`/spieler/${encodeURIComponent(r.id)}`} role="rowheader">
                      <Head id={r.id} uuid={r.uuid} name={r.name} size={24} decorative />
                      <span>{r.name}</span>
                    </Link>
                    <div className="gantt__track" role="cell">
                      {r.online.map(([a, b], k) => (
                        <span key={`o${k}`} className="gantt__on tip" style={{ left: `${pct(a)}%`, width: `${Math.max(0.3, pct(b) - pct(a))}%` }} data-edge={edge(a, b)} data-tip={`${r.name} · ${fmtSpan(a, b)} · ${duration((b - a) / 1000)}`} tabIndex={0} />
                      ))}
                      {r.afk.map(([a, b, kind], k) => (
                        <span key={`a${k}`} className="gantt__afk tip" data-kind={kind} style={{ left: `${pct(a)}%`, width: `${Math.max(0.3, pct(b) - pct(a))}%` }} data-edge={edge(a, b)} data-tip={`${r.name} · ${kind ? AFK_TIP[kind] : "AFK"} ${fmtSpan(a, b)} · ${duration((b - a) / 1000)}`} tabIndex={0} />
                      ))}
                      {r.live.map(([a, b], k) => (
                        <GanttLiveSegment
                          key={`l${k}`}
                          vodId={vodOffsets[rowIndex]?.[k]?.vodId ?? null}
                          startOffset={vodOffsets[rowIndex]?.[k]?.offset ?? null}
                          start={a}
                          end={b}
                          style={{ left: `${pct(a)}%`, width: `${Math.max(0.3, pct(b) - pct(a))}%` }}
                          edge={edge(a, b)}
                          tip={`${r.name} · live ${fmtSpan(a, b)} · ${duration((b - a) / 1000)}`}
                        />
                      ))}
                      {nowPct !== null && <span className="gantt__now" style={{ left: `${nowPct}%` }} />}
                    </div>
                    <span
                      className="gantt__sum num"
                      role="cell"
                      title={`${duration(r.seconds)} online${r.afkSeconds > 0 ? ` · davon ${duration(r.afkSeconds)} AFK` : ""}${r.afkMobsSeconds > 0 ? ` · ${duration(r.afkMobsSeconds)} Mobs farmen` : ""}${r.afkBlocksSeconds > 0 ? ` · ${duration(r.afkBlocksSeconds)} Blöcke farmen` : ""}${r.liveSeconds > 0 ? ` · ${duration(r.liveSeconds)} live` : ""}`}
                    >
                      {sort === "spielzeit" ? (
                        <>
                          {duration(r.seconds)}
                          {r.afkSeconds > 0 && <small className="gantt__afk-sum">{duration(r.afkSeconds)} AFK</small>}
                        </>
                      ) : (
                        <>
                          {sortValue(r, sort) > 0 ? duration(sortValue(r, sort)) : "–"}
                          <small className="gantt__afk-sum">{duration(r.seconds)} online</small>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <HowLink section="afk">Wie Sessions und AFK erkannt werden</HowLink>
        </div>
      </section>
    </>
  );
}

/** Öffnet sofort mit Überschrift und Platzhaltern; die Daten werden nachgestreamt. */
export default function Page(props: PageProps<"/zeitstrahl">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Ein Tag auf dem Server" title="Zeitstrahl" />}>
      <Timeline {...props} />
    </Suspense>
  );
}
