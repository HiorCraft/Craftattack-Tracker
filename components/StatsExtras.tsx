import Link from "next/link";
import type { StatsExtras as Data } from "@/lib/analytics";
import { dateTime, duration, num } from "@/lib/format";
import { Sparkline } from "./Sparkline";
import { METRIC_TONE } from "@/lib/statTone";
import { Head } from "@/components/Head";
import { graphHref } from "@/lib/graphQuery";

const DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dayShort = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
const dayLabel = (day: string) => dayShort.format(new Date(`${day}T12:00:00Z`));

function Card({ title, sub, children, wide = false, tone = "white", href }: { title: string; sub?: string; children: React.ReactNode; wide?: boolean; tone?: string; href?: string }) {
  return (
    <section className="box stat-card" data-tone={tone} style={wide ? { gridColumn: "1 / -1" } : undefined}>
      <header className="stat-card__head">
        <h3 className="t-3">
          {title}
          {href && (
            <Link href={href} className="chart__link stat-card__graph" title={`${title} im Graphen öffnen`}>
              Graph <span aria-hidden="true">→</span>
            </Link>
          )}
        </h3>
        {sub && <p className="muted">{sub}</p>}
      </header>
      {children}
    </section>
  );
}

function Person({ id, name, uuid, right }: { id: string; name: string; uuid: string; right: React.ReactNode }) {
  return (
    <li className="plist__row">
      <Link className="plist__who" href={`/spieler/${encodeURIComponent(id)}`}>
        <Head id={id} uuid={uuid} name={name} size={24} decorative />
        <span>{name}</span>
      </Link>
      <span className="plist__val num">{right}</span>
    </li>
  );
}

/** Heatmap Wochentag × Stunde */
function Heatmap({ values, afk }: { values: (number | null)[][]; afk: (number | null)[][] }) {
  const flat = values.flat().filter((v): v is number => v !== null);
  if (!flat.length) return <p className="muted">Noch keine Daten.</p>;
  const max = Math.max(1, ...flat);
  return (
    <div className="hm" role="img" aria-label="Durchschnittlich online nach Wochentag und Uhrzeit">
      <div className="hm__row hm__head num" aria-hidden="true">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? h : ""}</span>)}
      </div>
      {values.map((row, d) => (
        <div className="hm__row" key={d}>
          <span className="hm__day">{DAYS[d]}</span>
          {row.map((v, h) => (
            <span
              key={h}
              className="hm__cell tip"
              style={{ "--a": v === null ? 0 : Math.max(0.08, v / max), "--afk": afk[d]?.[h] ?? 0 } as React.CSSProperties}
              data-tip={`${DAYS[d]} ${String(h).padStart(2, "0")}–${String(h + 1).padStart(2, "0")} Uhr · ${v === null ? "keine Daten" : `Ø ${num(v)} online${afk[d]?.[h] ? ` · ${Math.round(afk[d][h]! * 100)} % AFK` : ""}`}`}
              tabIndex={0}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 24 Balken, einer je Tagesstunde */
function HourBars({ values, unit, tone = "redstone" }: { values: { hour: number; v: number | null; afk?: number; title: string }[]; unit: string; tone?: string }) {
  const max = Math.max(1, ...values.map((v) => v.v ?? 0));
  return (
    <div className="hbars" role="img" aria-label={unit} style={{ "--bar": `var(--${tone})` } as React.CSSProperties}>
      {values.map((v) => (
        <span key={v.hour} className="tip" data-tip={`${String(v.hour).padStart(2, "0")}–${String(v.hour + 1).padStart(2, "0")} Uhr · ${v.title}`} tabIndex={0}>
          <i style={{ height: `${v.v === null ? 0 : Math.max(2, (v.v / max) * 100)}%` }}>
            {v.afk && v.v ? <em style={{ height: `${Math.min(100, (v.afk / v.v) * 100)}%` }} /> : null}
          </i>
          <b className="num">{v.hour % 3 === 0 ? v.hour : ""}</b>
        </span>
      ))}
    </div>
  );
}

export function StatsExtras({ d, tag }: { d: Data; tag: (day: string) => number }) {
  return (
    <>
      <dl className="grid st-figs st-figs--6" style={{ marginBottom: 32 }}>
        <div className="box st-fig" data-tone={METRIC_TONE.onlineCount}>
          <dt>Server erreichbar</dt>
          <dd className="num">{d.availability.ratio === null ? "–" : `${(Math.round(d.availability.ratio * 1000) / 10).toLocaleString("de-DE")} %`}</dd>
        </div>
        <div className="box st-fig" data-tone={METRIC_TONE.tracked}>
          <dt>Spielerstunden</dt>
          <dd className="num">{num(d.totals.playerHours)}</dd>
        </div>
        <div className="box st-fig" data-tone={METRIC_TONE.onlineCount}>
          <dt>Spieler bisher</dt>
          <dd className="num">{num(d.totals.players)}</dd>
        </div>
        <div className="box st-fig" data-tone={METRIC_TONE.onlineCount}>
          <dt>Aktiv in 24 h</dt>
          <dd className="num">{num(d.loyalty.groups.h24)}</dd>
        </div>
        <div className="box st-fig" data-tone={METRIC_TONE.onlineCount}>
          <dt>Länger als 1 Tag weg</dt>
          <dd className="num">{num(d.loyalty.groups.d3 + d.loyalty.groups.d7 + d.loyalty.groups.gone)}</dd>
        </div>
        <div className="box st-fig" data-tone={METRIC_TONE.afkSeconds}>
          <dt title="Laut Server: online, aber mindestens 5 Minuten keine Bewegung">AFK-Stunden</dt>
          <dd className="num">
            {num(d.afk.totalHours)}
            {d.totals.playerHours > 0 && <small className="muted"> {Math.round((d.afk.totalHours / d.totals.playerHours) * 100)} %</small>}
          </dd>
        </div>
      </dl>

      <div className="grid stat-grid" style={{ "--min": "340px" } as React.CSSProperties}>
        <Card title="Tag für Tag" href={graphHref(["playtimeSeconds", "afkSeconds"], [], "alle", { modus: "zuwachs", raster: "1440" })} sub="Jeder Tag der Staffel, soweit der Tracker ihn gesehen hat" wide>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th className="num">Spieler</th>
                  <th className="num">Max. online</th>
                  <th className="num">Spielerstunden</th>
                  <th className="num">AFK</th>
                  <th className="num">Tode</th>
                  <th className="num">Zuschauer-Spitze</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...d.days].reverse().map((r) => (
                  <tr key={r.day}>
                    <td>
                      Tag {tag(r.day)} <span className="muted">{dayLabel(r.day)}</span>
                    </td>
                    <td className="num">{num(r.players)}</td>
                    <td className="num">{num(r.maxOnline)}</td>
                    <td className="num">{num(r.playerHours)}</td>
                    <td className="num">{r.afkHours > 0 ? `${num(r.afkHours)} h` : "–"}</td>
                    <td className="num">{num(r.deaths)}</td>
                    <td className="num">{num(r.maxViewers)}</td>
                    <td>
                      <Link href={`/zeitstrahl?tag=${r.day}`}>Zeitstrahl</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Wann ist der Server voll?" href={graphHref("onlineCount", [], "7d")} sub="Ø Spieler online je Wochentag und Stunde (Berliner Zeit) – je grauer, desto mehr davon AFK">
          <Heatmap values={d.heatmap} afk={d.heatmapAfk} />
        </Card>

        <Card title="Vollste Momente" sub="Mindestens zwei Stunden auseinander">
          <ol className="plist">
            {d.fullest.map((r, i) => (
              <li className="plist__row" key={r.at}>
                <span>
                  <b className="num">{i + 1}.</b> {num(r.value)} Spieler gleichzeitig
                </span>
                <span className="plist__val muted">{dateTime(r.at)}</span>
              </li>
            ))}
            {d.fullest.length === 0 && <li className="muted">Noch nichts.</li>}
          </ol>
          <h4 className="eyebrow" style={{ margin: "16px 0 8px" }}>
            Meiste Zuschauer gleichzeitig
          </h4>
          <ol className="plist">
            {d.mostViewers.slice(0, 5).map((r) => (
              <li className="plist__row" key={r.at}>
                <span className="num">{num(r.value)} Zuschauer</span>
                <span className="plist__val muted">{dateTime(r.at)}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Wann wird gespielt?" href={graphHref(["playtimeSeconds", "afkSeconds"], [], "3d", { modus: "zuwachs", raster: "60" })} sub="Spielerstunden je Tagesstunde (Berliner Zeit), über alle Tage – der graue Teil ist AFK" tone="white">
          <HourBars values={d.playHours.map((p) => ({ hour: p.hour, v: p.hours, afk: p.afkHours, title: `${num(p.hours)} Spielerstunden${p.afkHours > 0 ? ` · davon ${num(p.afkHours)} AFK` : ""}` }))} unit="Spielerstunden je Tagesstunde, AFK-Anteil in Gold" tone="sky" />
        </Card>

        <Card title="Marathon-Sessions" sub="Die längsten Sessions am Stück laut Tracker">
          <ol className="plist">
            {d.marathons.map((s) => (
              <Person key={`${s.id}${s.start}`} id={s.id} name={s.name} uuid={s.uuid} right={`${duration(s.seconds)} · ${dateTime(s.start)}${s.end ? "" : " · läuft"}`} />
            ))}
            {d.marathons.length === 0 && <li className="muted">Noch keine Sessions.</li>}
          </ol>
        </Card>

        <Card title="AFK-Zeit" href={graphHref("afkSeconds", d.afk.perPlayer.slice(0, 5).map((p) => p.id))} sub="Laut Server: online, aber mindestens 5 Minuten keine Bewegung – mit Anteil an der Online-Zeit">
          <ol className="plist">
            {d.afk.perPlayer.map((r) => (
              <Person key={r.id} id={r.id} name={r.name} uuid={r.uuid} right={`${duration(r.seconds)} · ${Math.round(r.share * 100)} %`} />
            ))}
            {d.afk.perPlayer.length === 0 && <li className="muted">Noch niemand AFK gewesen.</li>}
          </ol>
        </Card>

        <Card title="AFK-Farmen" href={graphHref(["afkMobsSeconds", "afkBlocksSeconds"])} sub="AFK-Zeit, in der trotzdem Mobs starben oder Blöcke fielen (ab zehn pro Minute) – wer steht am längsten an der Farm?" tone="white">
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            {(["mobs", "blocks"] as const).map((kind) => (
              <div key={kind}>
                <p className="eyebrow" style={{ marginBottom: 8 }}>
                  {kind === "mobs" ? "Mobs farmen" : "Blöcke farmen"} · {num(Math.round(d.afk.farm[kind].hours * 10) / 10)} h
                </p>
                <ol className="plist">
                  {d.afk.farm[kind].perPlayer.map((r) => (
                    <Person key={r.id} id={r.id} name={r.name} uuid={r.uuid} right={duration(r.seconds)} />
                  ))}
                  {d.afk.farm[kind].perPlayer.length === 0 && <li className="muted">Noch keine erkannt.</li>}
                </ol>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Todesrate" href={graphHref("deaths")} sub="Tode pro Online-Stunde laut Tracker, ab zwei Toden und einer Stunde">
          <ol className="plist">
            {d.deathRate.map((r) => (
              <Person key={r.id} id={r.id} name={r.name} uuid={r.uuid} right={`${r.perHour.toLocaleString("de-DE")} / h · ${num(r.deaths)} in ${r.hours.toLocaleString("de-DE")} h`} />
            ))}
            {d.deathRate.length === 0 && <li className="muted">Noch zu wenige Daten.</li>}
          </ol>
        </Card>

        <Card title="Treue" href={graphHref("onlineCount", [], "alle", { raster: "1440" })} sub="Wie viele Spieler pro Tag da waren und wer länger fehlt">
          {d.loyalty.perDay.length > 1 && <Sparkline points={d.loyalty.perDay.map((p) => ({ at: `${p.day}T12:00:00Z`, v: p.players }))} width={320} height={80} step label="Spieler pro Tag" />}
          <ul className="filters" style={{ margin: "12px 0" }}>
            <li>
              <span className="tag" data-tone="grass">
                ≤ 24 h: {num(d.loyalty.groups.h24)}
              </span>
            </li>
            <li>
              <span className="tag">1–3 Tage: {num(d.loyalty.groups.d3)}</span>
            </li>
            <li>
              <span className="tag">3–7 Tage: {num(d.loyalty.groups.d7)}</span>
            </li>
            <li>
              <span className="tag" data-tone="redstone">
                &gt; 7 Tage: {num(d.loyalty.groups.gone)}
              </span>
            </li>
          </ul>
          <h4 className="eyebrow" style={{ margin: "8px 0" }}>
            Seit über drei Tagen nicht gesehen
          </h4>
          <ol className="plist">
            {d.loyalty.gone.slice(0, 10).map((p) => (
              <Person key={p.id} id={p.id} name={p.name} uuid={p.uuid} right={`seit ${num(p.days)} Tagen · zuletzt ${dayLabel(p.lastSeen.slice(0, 10))}`} />
            ))}
            {d.loyalty.gone.length === 0 && <li className="muted">Alle sind noch dabei.</li>}
          </ol>
        </Card>

        <Card title="Server-Verfügbarkeit" href={graphHref("onlineCount")} sub="Ausfälle laut Stats-API und Lücken in der Aufzeichnung">
          <ol className="plist">
            {d.availability.outages.map((o) => (
              <li className="plist__row" key={o.from}>
                <span>
                  <span className="dot dot--off" aria-hidden="true" /> Ausfall {dateTime(o.from)}
                </span>
                <span className="plist__val num">{o.minutes === null ? "läuft noch" : `${num(o.minutes)} Min`}</span>
              </li>
            ))}
            {d.availability.outages.length === 0 && (
              <li className="plist__row">
                <span>
                  <span className="dot" aria-hidden="true" /> Bisher kein Ausfall beobachtet.
                </span>
              </li>
            )}
          </ol>
          {d.availability.gaps.length > 0 && (
            <>
              <h4 className="eyebrow" style={{ margin: "16px 0 8px" }}>
                Datenlücken (Tracker oder Quelle nicht erreichbar)
              </h4>
              <ol className="plist">
                {d.availability.gaps.slice(0, 8).map((g) => (
                  <li className="plist__row" key={g.from}>
                    <span>{dateTime(g.from)}</span>
                    <span className="plist__val num">{g.minutes >= 60 ? duration(g.minutes * 60) : `${num(g.minutes)} Min`}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
