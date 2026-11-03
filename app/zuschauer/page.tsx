import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { FigValue } from "@/components/FigValue";
import { Explain } from "@/components/Explain";
import { DataAge } from "@/components/DataAge";
import { Fold } from "@/components/Fold";
import { ShowMore } from "@/components/ShowMore";
import { PlayerSearch } from "@/components/PlayerSearch";
import { DayStackChart, RetentionChart, SeasonChart, StreamerDayChart, type ViewBand, type ViewMarker } from "@/components/ViewerCharts";
import { FlowList, HourlyChart, MethodNote, PairTable, RampChart, SourceTable, StartTable, pct, type Names } from "@/components/ViewerFlow";
import { loadTracker } from "@/lib/data";
import { dayBounds, getDays, getDayStack, getFlows, getPlayerDay, getStreamerSeason, getStreamers, type ChartMarker, type FlowAnalysis } from "@/lib/viewerMigration";
import { num } from "@/lib/format";

export const metadata: Metadata = {
  title: "Zuschauer",
  description: "Wohin Zuschauer gehen, wenn CraftAttack-Streamer aufhören, einbrechen oder raiden, und ob sie bleiben.",
};

const signed = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0, signDisplay: "exceptZero" });
const dayLong = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" });
const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

const VIEWS = [
  { key: "tag", label: "Tag" },
  { key: "staffel", label: "Staffel" },
  { key: "streamer", label: "Streamer" },
] as const;
type View = (typeof VIEWS)[number]["key"];

/** Kleine Ereignisse erst auf Wunsch */
const MIN_POOL_SHOWN = 150;

export default function Page(props: PageProps<"/zuschauer">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Community" title="Zuschauer" tone="ender" />}>
      <Viewers searchParams={props.searchParams} />
    </Suspense>
  );
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function href(params: Record<string, string | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `/zuschauer?${s}` : "/zuschauer";
}

async function Viewers({ searchParams }: { searchParams: PageProps<"/zuschauer">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const view: View = VIEWS.some((v) => v.key === sp.ansicht) ? (sp.ansicht as View) : "tag";
  const [{ state }, flows] = await Promise.all([loadTracker(), getFlows()]);
  const names: Names = Object.fromEntries(Object.values(state.players).map((p) => [p.id, { name: p.name, uuid: p.uuid }]));
  const streamerHref = (id: string) => href({ ansicht: "streamer", spieler: id });

  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Community</p>
          <h1 className="t-1">Zuschauer</h1>
          <p>
            Wohin Zuschauer gehen, wenn ein Stream endet, einbricht oder raidet, und ob sie bleiben. <MethodNote />{" "}
            <DataAge at={flows.computedAt} prefix="Auswertung" hint="wird alle 10 Minuten im Hintergrund neu berechnet" />
          </p>
        </div>
      </section>

      <section className="block mig" data-tone="paper">
        <div className="wrap stack">
          <div className="gb__seg" role="group" aria-label="Ansicht">
            {VIEWS.map((v) => (
              <Link key={v.key} href={href({ ansicht: v.key === "tag" ? undefined : v.key })} aria-current={view === v.key ? "true" : undefined}>
                {v.label}
              </Link>
            ))}
          </div>
          {view === "tag" && <DayView flows={flows} names={names} day={str(sp.tag)} all={sp.alle === "1"} />}
          {view === "staffel" && <SeasonView flows={flows} names={names} streamerHref={streamerHref} />}
          {view === "streamer" && <StreamerView flows={flows} names={names} id={str(sp.spieler)} day={str(sp.tag)} streamerHref={streamerHref} />}
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ Tag */

function DayNav({ days, current, mk }: { days: string[]; current: string; mk: (d: string) => string }) {
  const i = days.indexOf(current);
  return (
    <div className="vf__daynav">
      {i < days.length - 1 ? (
        <Link className="tag" href={mk(days[i + 1])} scroll={false}>
          ← {dayLong.format(dayBounds(days[i + 1])[0] + 3_600_000)}
        </Link>
      ) : (
        <span />
      )}
      <b>{dayLong.format(dayBounds(current)[0] + 3_600_000)}</b>
      {i > 0 ? (
        <Link className="tag" href={mk(days[i - 1])} scroll={false}>
          {dayLong.format(dayBounds(days[i - 1])[0] + 3_600_000)} →
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

async function DayView({ flows, names, day: wanted, all }: { flows: FlowAnalysis; names: Names; day?: string; all: boolean }) {
  const days = await getDays();
  const d = wanted && days.includes(wanted) ? wanted : days[0];
  if (!d) return <p className="muted">Keine Zuschauerdaten.</p>;
  const [a, b] = dayBounds(d);
  const stack = await getDayStack(d);
  const series = stack.series.map((s) => ({ id: s.id, name: s.id ? (names[s.id]?.name ?? s.id) : "Andere", values: s.values }));
  const events = flows.events.filter((e) => e.at >= a && e.at < b);
  const free = events.filter((e) => e.kind === "ende" || e.kind === "einbruch");
  const pool = free.reduce((s, e) => s + e.pool, 0);
  const found = free.reduce((s, e) => s + e.found, 0);
  const starts = events.filter((e) => e.kind === "start");
  const startIn = starts.reduce((s, e) => s + e.pool, 0);
  const startFrom = starts.reduce((s, e) => s + e.found, 0);
  const raids = events.filter((e) => e.kind === "raid");
  const raidArrived = raids.reduce((s, e) => s + (e.shares.find((x) => x.to === e.raidTo)?.viewers ?? 0), 0);
  const shown = all ? events : events.filter((e) => e.pool >= MIN_POOL_SHOWN);
  const mk = (day: string) => href({ tag: day === days[0] ? undefined : day });
  return (
    <>
      <DayNav days={days} current={d} mk={mk} />
      <dl className="grid st-figs st-figs--6">
        <div className="box st-fig" data-tone="white">
          <dt title="Zuschauer, die durch Stream-Enden und Einbrüche frei wurden (ohne Raids)">Frei geworden</dt>
          <FigValue>{num(pool)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Davon bei anderen erfassten CraftAttack-Streams wieder aufgetaucht">Wiedergefunden</dt>
          <FigValue>{pool ? pct(found / pool) : "–"}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt>Raids</dt>
          <FigValue>{num(raids.length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Laut Zuschauerzahl beim Ziel angekommen">Per Raid angekommen</dt>
          <FigValue>{num(raidArrived)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt>Starts</dt>
          <FigValue>{num(starts.length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Anteil des Anlaufs (Zuschauer nach 30 Min), der laufenden CraftAttack-Streams über das Übliche hinaus fehlte">Start-Zuschauer von CA</dt>
          <FigValue>{startIn ? pct(startFrom / startIn) : "–"}</FigValue>
        </div>
      </dl>
      <div className="box" data-tone="white">
        <DayStackChart times={stack.times} covered={stack.covered} series={series} />
      </div>
      <Fold
        id="zuschauer.tag"
        title="Was passiert ist"
        aside={
          events.length > shown.length || all ? (
            <Link className="btn btn--small" data-tone="white" href={href({ tag: d === days[0] ? undefined : d, alle: all ? undefined : "1" })} scroll={false}>
              {all ? `Nur ab ${MIN_POOL_SHOWN} Zuschauern` : `Alle ${events.length} zeigen`}
            </Link>
          ) : undefined
        }
      >
        {shown.length ? (
          <ShowMore height={1400}>
            <FlowList events={shown} names={names} />
          </ShowMore>
        ) : (
          <p className="muted">An diesem Tag ist nichts Größeres passiert.</p>
        )}
      </Fold>
    </>
  );
}

/* ------------------------------------------------------------------ Staffel */

function SeasonView({ flows, names, streamerHref }: { flows: FlowAnalysis; names: Names; streamerHref: (id: string) => string }) {
  const free = flows.events.filter((e) => e.kind === "ende" || e.kind === "einbruch");
  const starts = flows.events.filter((e) => e.kind === "start");
  const startShare = starts.reduce((s, e) => s + e.found, 0) / Math.max(1, starts.reduce((s, e) => s + e.pool, 0));
  const pool = free.reduce((s, e) => s + e.pool, 0);
  const found = free.reduce((s, e) => s + e.found, 0);
  const rr = flows.raidRetention;
  const at = (m: number) => rr.curve[m]?.median ?? 0;
  const day = (h: (typeof flows.hourly)[number][]) => {
    const p = h.reduce((s, x) => s + x.pool, 0);
    return p ? h.reduce((s, x) => s + x.found, 0) / p : 0;
  };
  return (
    <>
      <dl className="grid st-figs st-figs--6">
        <div className="box st-fig" data-tone="white">
          <dt>Stream-Enden</dt>
          <FigValue>{num(flows.events.filter((e) => e.kind === "ende").length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Deutlich mehr verloren als üblich, ohne gleich wieder zurückzukommen">Einbrüche</dt>
          <FigValue>{num(flows.events.filter((e) => e.kind === "einbruch").length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt>Raids</dt>
          <FigValue>{num(flows.events.filter((e) => e.kind === "raid").length)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Anteil der frei gewordenen Zuschauer (ohne Raids), der bei anderen erfassten Streams auftaucht">Wiedergefunden</dt>
          <FigValue>{pool ? pct(found / pool) : "–"}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Median der Raids: nach 30 Min noch beim Ziel">Raid bleibt 30 Min</dt>
          <FigValue>{pct(at(30))}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Anteil des Anlaufs neuer Streams, der laufenden CraftAttack-Streams fehlte">Start von CA</dt>
          <FigValue>{pct(startShare)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Wechsel von Chat-Schreibern zwischen erfassten Kanälen (seit 3. Nov.)">Chat-Wechsel</dt>
          <FigValue>{num(flows.chatMovesTotal)}</FigValue>
        </div>
      </dl>

      <div className="vf__two">
        <div className="box" data-tone="white">
          <h2 className="t-3">
            Wiedergefunden nach Uhrzeit{" "}
            <Explain>
              Wer abends um 21 Uhr frei wird, schaut oft weiter ({pct(day(flows.hourly.slice(18, 23)))} tauchen bei anderen CraftAttack-Streams auf), nachts
              gehen die meisten schlafen ({pct(day(flows.hourly.slice(1, 6)))} zwischen 1 und 6 Uhr). Der Rest ist offline oder bei Streams, die hier nicht
              erfasst sind. Diese Werte sind das „Übliche“, mit dem jedes einzelne Ende verglichen wird.
            </Explain>
          </h2>
          <HourlyChart hourly={flows.hourly} />
        </div>
        <div className="box" data-tone="white">
          <h2 className="t-3">
            Anlauf nach dem Start{" "}
            <Explain>
              Ohne besonderes Ereignis wächst jeder Stream nach dem Start: nach 15 Min ist er im Median bei {pct(flows.rampUp.find((p) => p.age === 15)?.median ?? 0)} des
              Stands nach 2 Std, nach 1 Std bei {pct(flows.rampUp.find((p) => p.age === 60)?.median ?? 0)}. Dieser Anstieg zählt nicht als Wanderung.
            </Explain>
          </h2>
          <RampChart all={flows.rampUp} compact />
        </div>
      </div>

      <Fold id="zuschauer.quellen" title="Wer Zuschauer abgibt und wohin">
        <div className="box" data-tone="white">
          <ShowMore height={900}>
            <SourceTable rows={flows.sources.filter((s) => s.pool >= 1000)} names={names} streamerHref={streamerHref} />
          </ShowMore>
        </div>
      </Fold>

      <Fold id="zuschauer.starts" title="Wer beim Start anderen Zuschauer abzieht">
        <div className="vf__two">
          <div className="box" data-tone="white">
            <h3 className="t-3">
              Von CraftAttack-Streams, nach Uhrzeit{" "}
              <Explain>
                Geht ein Stream live, wächst er zuerst von selbst (Anlauf). Fehlt laufenden Streams in den 30 Minuten danach mehr als sonst um diese Zeit,
                ist das der Teil, der zum neuen Stream ging. Abends ist das deutlich mehr als morgens, wenn kaum andere laufen.
              </Explain>
            </h3>
            <HourlyChart hourly={flows.hourlyStart} tone="mig__c3" />
          </div>
          <div className="box" data-tone="white">
            <ShowMore height={520}>
              <StartTable rows={flows.starts.filter((x) => x.inflow >= 1000)} names={names} streamerHref={streamerHref} />
            </ShowMore>
          </div>
        </div>
      </Fold>

      <Fold id="zuschauer.raids" title="Wie viele Raid-Zuschauer bleiben">
        <div className="box" data-tone="white">
          <p className="muted">
            {num(rr.raids.length)} Raids ab 50 Zuschauern. Im Median kommen {pct(rr.arrived)} an; nach 10 Min sind {pct(at(10))} noch da, nach 60 Min{" "}
            {pct(at(60))}.{" "}
            <Explain>
              Gemessen am Ziel: Stand vorher gegen den Stand je Minute danach, abzüglich des Trends, den das Ziel vorher hatte. Nur Raids, bei denen das Ziel
              durchgehend live war und keinen weiteren Raid in dieser Stunde bekam.
            </Explain>
          </p>
          <RetentionChart curve={rr.curve} />
        </div>
      </Fold>
    </>
  );
}

/* ------------------------------------------------------------------ Streamer */

const ICON: Record<ChartMarker["kind"], string> = {
  own_start: "▶",
  own_end: "■",
  own_drop: "↓",
  title: "T",
  raid_in: "R",
  raid_out: "R",
  shared_start: "≡",
  shared_end: "≡",
  server_event: "★",
  flow_in: "↘",
  start_loss: "▶",
};

function markerView(mk: ChartMarker, names: Names, day: string): ViewMarker {
  const other = mk.other ? (names[mk.other]?.name ?? mk.other) : "";
  const v = mk.viewers ?? 0;
  const icon = ICON[mk.kind];
  const o = mk.other ? { id: mk.other, name: other, uuid: names[mk.other]?.uuid, href: href({ ansicht: "streamer", spieler: mk.other, tag: day }) } : undefined;
  const base = { at: mk.at, icon, other: o };
  switch (mk.kind) {
    case "own_start":
      return { ...base, tone: "own", label: "Stream startet" };
    case "own_end":
      return { ...base, tone: "own", label: "Stream endet" };
    case "own_drop":
      return { ...base, tone: "loss", label: `Einbruch: ${signed.format(v)} Zuschauer gegenüber üblich` };
    case "title":
      return { ...base, tone: "own", label: `Neuer Titel: ${(mk.text ?? "").slice(0, 80)}` };
    case "raid_in":
      return { ...base, tone: "gain", label: `Raid von ${other} (${num(v)} Zuschauer)` };
    case "raid_out":
      return { ...base, tone: "loss", label: `Raidet ${other} (${num(v)} Zuschauer)` };
    case "shared_start":
      return { ...base, tone: "own", label: `Geteilter Chat beginnt${mk.text ? ` (${mk.text})` : ""}` };
    case "shared_end":
      return { ...base, tone: "own", label: "Geteilter Chat endet" };
    case "server_event":
      return { ...base, tone: "own", label: `Server-Event: ${mk.text ?? ""}` };
    case "start_loss":
      return { ...base, tone: "loss", label: `${signed.format(v)} Zuschauer an ${other} (geht live)` };
    case "flow_in":
      return { ...base, tone: "gain", label: `${signed.format(v)} Zuschauer von ${other} (${mk.text === "ende" ? "Stream-Ende" : "Einbruch"})` };
  }
}

type Reason = Awaited<ReturnType<typeof getPlayerDay>> extends infer P ? (P extends { anomalies: (infer A)[] } ? (A extends { reasons: (infer R)[] } ? R : never) : never) : never;

function reasonText(r: Reason, names: Names): string {
  const other = r.other ? (names[r.other]?.name ?? r.other) : "";
  const v = r.viewers ?? 0;
  switch (r.kind) {
    case "competition":
      return v > 0 ? `${v} weitere CraftAttack-Streams gingen live` : `${-v} andere CraftAttack-Streams gingen offline`;
    case "raid_in":
      return `Raid von ${other}`;
    case "raid_out":
      return `raidet ${other}`;
    case "flow_in":
      return `Zuschauer von ${other}`;
    case "start_loss":
      return `${other} ging live`;
    case "title":
      return `neuer Titel „${(r.text ?? "").slice(0, 50)}“`;
    case "shared_start":
      return "geteilter Chat beginnt";
    case "shared_end":
      return "geteilter Chat endet";
    case "server_event":
      return `Server-Event: ${r.text ?? ""}`;
    case "own_end":
      return "Stream endet";
    default:
      return "";
  }
}

async function StreamerView({
  flows,
  names,
  id: wanted,
  day: wantedDay,
  streamerHref,
}: {
  flows: FlowAnalysis;
  names: Names;
  id?: string;
  day?: string;
  streamerHref: (id: string) => string;
}) {
  const streamers = await getStreamers();
  const id = wanted && streamers.includes(wanted) ? wanted : streamers[0];
  if (!id) return <p className="muted">Keine Zuschauerdaten.</p>;
  const [pd, season] = await Promise.all([getPlayerDay(id, wantedDay), getStreamerSeason(id)]);
  const sorted = [...streamers].sort((a, b) => (names[a]?.name ?? a).localeCompare(names[b]?.name ?? b, "de"));
  const name = names[id]?.name ?? id;
  const src = flows.sources.find((s) => s.id === id);
  const st = flows.starts.find((s) => s.id === id);
  const out = flows.pairs.filter((p) => p.from === id && p.viewers > 0).slice(0, 10);
  const inn = flows.pairs.filter((p) => p.to === id && p.viewers > 0).slice(0, 10);
  const usual = flows.usual.get(id);
  const dayHref = (d: string) => href({ ansicht: "streamer", spieler: id, tag: d });

  return (
    <>
      <form className="mig__pick" method="get" action="/zuschauer">
        <input type="hidden" name="ansicht" value="streamer" />
        <PlayerSearch name="spieler" defaultValue={id} label="Streamer" submitOnPick players={sorted.map((s) => ({ id: s, name: names[s]?.name ?? s, uuid: names[s]?.uuid }))} />
        <noscript>
          <button type="submit" className="tag">
            Anzeigen
          </button>
        </noscript>
      </form>

      {src && (
        <dl className="grid st-figs st-figs--6">
          <div className="box st-fig" data-tone="white">
            <dt>Enden · Einbrüche · Raids</dt>
            <FigValue>{`${src.ends} · ${src.drops} · ${src.raids}`}</FigValue>
          </div>
          <div className="box st-fig" data-tone="white">
            <dt>Frei geworden</dt>
            <FigValue>{num(src.pool)}</FigValue>
          </div>
          <div className="box st-fig" data-tone="white">
            <dt title="Bei anderen erfassten Streams wieder aufgetaucht">Wiedergefunden</dt>
            <FigValue>{pct(src.found / Math.max(1, src.pool))}</FigValue>
          </div>
          <div className="box st-fig" data-tone="white">
            <dt title="Anteil des Zuwachses beim Ziel, der nach 60 Min noch da ist">Bleiben dort</dt>
            <FigValue>{src.stay === null ? "–" : pct(src.stay)}</FigValue>
          </div>
          {st && (
            <div className="box st-fig" data-tone="white">
              <dt title="Zuschauer 30 Min nach dem Start, Durchschnitt">Ø nach Start</dt>
              <FigValue>{num(st.avg)}</FigValue>
            </div>
          )}
          {st && (
            <div className="box st-fig" data-tone="white">
              <dt title="Anteil des Anlaufs, der laufenden CraftAttack-Streams fehlte">Start von CA</dt>
              <FigValue>{pct(st.pulled / Math.max(1, st.inflow))}</FigValue>
            </div>
          )}
        </dl>
      )}

      {pd && <StreamerDay pd={pd} names={names} name={name} dayHref={dayHref} />}

      {season && season.days.length >= 2 && (
        <Fold id="zuschauer.staffel-streamer" title={`${name} über die Staffel`}>
          <div className="box" data-tone="white">
            <p className="muted">
              {season.marketChange !== null && season.ownChange !== null && (
                <>
                  Seit den ersten Tagen: {name} {signed.format(season.ownChange * 100)} %, das ganze CraftAttack {signed.format(season.marketChange * 100)} % (die
                  ersten Tage waren für alle außergewöhnlich).{" "}
                </>
              )}
              {season.lessCompetition !== null && season.lessCompetition >= 0.05 && (
                <>
                  An Tagen mit halb so vielen anderen Streams live: {signed.format(season.lessCompetition * 100)} % Zuschauer.{" "}
                </>
              )}
              <Explain label="Wie gemessen">
                Ausreißer-Tage werden am Anteil am gesamten CraftAttack-Publikum gemessen, solange {name} live war, und mit den Tagen davor und danach
                verglichen. So zählt der allgemeine Rückgang seit Staffelstart nicht als Schwäche. Konkurrenz: Vergleich der Tage, an denen mehr oder
                weniger andere CraftAttack-Streams gleichzeitig liefen (wer online kommt, wählt unter denen, die gerade da sind). Hinweise, keine Beweise.
              </Explain>
            </p>
            <SeasonChart days={season.days} label={name} hrefPrefix={`/zuschauer?ansicht=streamer&spieler=${encodeURIComponent(id)}&tag=`} />
            {season.days.some((d) => d.outlier) && (
              <ul className="vf__outliers">
                {season.days
                  .filter((d) => d.outlier)
                  .map((d) => (
                    <li key={d.day}>
                      <Link href={dayHref(d.day)} className={d.outlier === "hype" ? "vf__up" : "vf__down"}>
                        {d.outlier === "hype" ? "▲" : "▼"} {dayLong.format(dayBounds(d.day)[0] + 3_600_000)}
                      </Link>{" "}
                      Ø {num(d.avg)} · {pct(d.share)} des Publikums{d.reasons.length ? ` · ${d.reasons.join(" · ")}` : " · ungeklärt"}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </Fold>
      )}

      <div className="vf__two">
        <div className="box" data-tone="white">
          <h2 className="t-3">Wohin Zuschauer von {name} gehen</h2>
          <PairTable rows={out} names={names} dir="von" streamerHref={streamerHref} />
        </div>
        <div className="box" data-tone="white">
          <h2 className="t-3">Woher Zuschauer zu {name} kommen</h2>
          <PairTable rows={inn} names={names} dir="zu" streamerHref={streamerHref} />
        </div>
      </div>

      {usual && (
        <Fold id="zuschauer.normal" title={`Normaler Verlauf bei ${name}`}>
          <div className="box" data-tone="white">
            <RampChart all={flows.rampUp} own={usual.ramp} ownLabel={name} />
          </div>
        </Fold>
      )}

    </>
  );
}

function StreamerDay({ pd, names, name, dayHref }: { pd: NonNullable<Awaited<ReturnType<typeof getPlayerDay>>>; names: Names; name: string; dayHref: (d: string) => string }) {
  const [dayStart, dayEnd] = dayBounds(pd.day);
  const first = pd.points[0]?.[0] ?? dayStart;
  const last = pd.points.at(-1)?.[0] ?? dayEnd;
  const from = Math.max(dayStart, first - 30 * 60_000);
  const to = Math.min(dayEnd, Math.max(last + 30 * 60_000, from + 2 * 3_600_000));
  const markers = pd.markers.map((mk) => markerView(mk, names, pd.day));
  const bands: ViewBand[] = pd.anomalies.map((a) => ({
    from: a.from,
    to: a.to,
    kind: a.kind,
    label: `${a.kind === "dip" ? "Absturz" : "Hype"}: ${signed.format(a.change)} Zuschauer, üblich wären ${signed.format(a.expected)}`,
    reasons: a.reasons.map((r) => reasonText(r, names)).filter(Boolean),
  }));
  const rows = [
    ...markers.map((mk) => ({ at: mk.at, tone: mk.tone, icon: mk.icon, label: mk.label, href: mk.other?.href })),
    ...bands.map((b) => ({
      at: b.from,
      tone: b.kind === "dip" ? "loss" : "gain",
      icon: b.kind === "dip" ? "▼" : "▲",
      label: `${b.label} · ${b.reasons.length ? b.reasons.join(" · ") : "ungeklärt, vermutlich der Stream selbst"}`,
      href: undefined,
    })),
  ].sort((x, y) => x.at - y.at);
  return (
    <Fold id="zuschauer.verlauf" title={`${name} an einem Tag`}>
      <DayNav days={pd.days} current={pd.day} mk={dayHref} />
      <div className="box" data-tone="white">
        <p className="muted">
          {pd.vods.length > 0 ? "Klick in den Graphen öffnet das VOD an dieser Stelle, Klick auf einen Kopf den Tag des anderen. " : "Klick auf einen Kopf öffnet den Tag des anderen. "}
          <Explain label="Trend, Ausschlag, Hype">
            Trend: gleitender Median über 25 Minuten. Ausschlag: kurz deutlich über oder unter dem Trend, kommt gleich wieder zurück (oft Twitch-Zählung,
            Werbepause, Clip). Hype bzw. Absturz: Das Niveau ändert sich in 45 Minuten deutlich stärker als sonst bei diesem Streamalter, um diese Uhrzeit
            und während das ganze CraftAttack gleichzeitig wächst oder schrumpft, und ist eine Stunde später noch da. Erklärungen sind Ereignisse im
            selben Zeitraum; ohne Ereignis war es vermutlich der Stream selbst.
          </Explain>
        </p>
        <StreamerDayChart points={pd.points} trend={pd.trend} noise={pd.noise} markers={markers} bands={bands} competition={pd.competition} vods={pd.vods} from={from} to={to} />
      </div>
      <div className="box" data-tone="white">
        <ShowMore height={420}>
          <div className="tbl-wrap">
            <table className="tbl mig__tbl">
              <caption className="sr-only">Ereignisse und ungeklärte Änderungen an diesem Tag</caption>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td className="num">{time.format(r.at)}</td>
                    <td>
                      <i className={`mig__key mig__mk-${r.tone}`} aria-hidden="true" /> <span className="vf__glyph">{r.icon}</span> {r.href ? <Link href={r.href}>{r.label}</Link> : r.label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ShowMore>
      </div>
    </Fold>
  );
}

