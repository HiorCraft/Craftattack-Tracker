import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { PageSkeleton } from "@/components/Skeletons";
import { FigValue } from "@/components/FigValue";
import { ExampleChart, HeirsTable, heatmapAxes, MagnetTable, PairHeatmap, RaidStayTable, RaidTable, RaidTargetTable, WaitingRoomTable } from "@/components/ViewerMigration";
import { DayStackChart, OverlayChart, PlayerViewerChart, RetentionChart, type OverlayMode, type ViewBand, type ViewMarker } from "@/components/ViewerCharts";
import { loadTracker } from "@/lib/data";
import { ALL_STREAMS, dayBounds, getDays, getDayStack, getOverlay, getPlayerDay, getStreamers, getViewerMigration, type ChartMarker, type Migration } from "@/lib/viewerMigration";
import { num } from "@/lib/format";
import { parseShareMode } from "@/lib/earnings";
import { EarningsView } from "./EarningsView";
import { PlayerSearch } from "@/components/PlayerSearch";
import { Explain } from "@/components/Explain";

export const metadata: Metadata = { title: "Zuschauer", description: "Wohin Zuschauer wandern, wenn CraftAttack-Streamer live gehen, aufhören oder raiden." };

const pct = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1, signDisplay: "exceptZero" });
const signed = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0, signDisplay: "exceptZero" });
const day = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short", timeZone: "Europe/Berlin" });
const dayLong = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Berlin" });
const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

/** Zeitraum kurz, z. B. „10.–25. Okt.“ (passt in die Kennzahl-Kachel) */
const span = (a: number, b: number) => {
  const x = day.formatToParts(a);
  const y = day.formatToParts(b);
  const month = (p: Intl.DateTimeFormatPart[]) => p.find((q) => q.type === "month")?.value;
  const d = (p: Intl.DateTimeFormatPart[]) => p.find((q) => q.type === "day")?.value;
  return month(x) === month(y) ? `${d(x)}.–${d(y)}. ${month(y)}` : `${day.format(a)} – ${day.format(b)}`;
};

const VIEWS = [
  { key: "uebersicht", label: "Starts" },
  { key: "offline", label: "Offline & Raids" },
  { key: "tag", label: "Tagesverlauf" },
  { key: "spieler", label: "Spieler" },
  { key: "muster", label: "Tage überlagern" },
  { key: "einnahmen", label: "Einnahmen (experimentell)" },
] as const;
type View = (typeof VIEWS)[number]["key"];

type Names = Record<string, { name: string; uuid: string } | undefined>;

export default function Page(props: PageProps<"/zuschauer">) {
  return (
    <Suspense fallback={<PageSkeleton eyebrow="Community" title="Zuschauer" tone="ender" />}>
      <Analysis searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Analysis({ searchParams }: { searchParams: PageProps<"/zuschauer">["searchParams"] }) {
  await connection();
  const sp = await searchParams;
  const view: View = VIEWS.some((v) => v.key === sp.ansicht) ? (sp.ansicht as View) : "uebersicht";
  const earnings = view === "einnahmen";
  const [{ state }, m] = await Promise.all([loadTracker(), earnings ? null : getViewerMigration()]);
  const names: Names = Object.fromEntries(Object.values(state.players).map((p) => [p.id, { name: p.name, uuid: p.uuid }]));
  const href = (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/zuschauer?${s}` : "/zuschauer";
  };

  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Community</p>
          <h1 className="t-1 mig__title">Zuschauer</h1>
          <p>
            Wohin Zuschauer gehen, wenn ein CraftAttack-Streamer live geht, aufhört oder raidet.{" "}
            <Explain>
              Gezählt wird jeder Start, egal wie groß, und der Gesamtverlust der übrigen Streams 20–40 Min danach, gegenüber dem, was diese Streams sonst
              bei gleichem Streamalter und gleicher Tageszeit tun. Raids sind kein Abwandern: Streams, die im Zeitfenster raiden oder geraidet werden,
              zählen nicht mit; Raids stehen getrennt. Die Werte sind Hinweise, keine Beweise.
            </Explain>
          </p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <ul className="mig__tabs filters" aria-label="Ansicht">
            {VIEWS.map((v) => (
              <li key={v.key}>
                <Link className="tag" aria-current={view === v.key ? "true" : undefined} href={href({ ansicht: v.key === "uebersicht" ? undefined : v.key })}>
                  {v.label}
                </Link>
              </li>
            ))}
          </ul>
          {m && (
            <>
              <dl className="grid st-figs st-figs--6">
                <div className="box st-fig" data-tone="white" style={{ gridColumn: "span 2" }}>
                  <dt>Zeitraum</dt>
                  <FigValue>{m.from && m.to ? span(m.from, m.to) : "–"}</FigValue>
                </div>
                <div className="box st-fig" data-tone="white">
                  <dt>Starts ausgewertet</dt>
                  <FigValue>{num(m.starts)}</FigValue>
                </div>
                <div className="box st-fig" data-tone="white">
                  <dt title="Stream-Enden aus dem Verlauf, bei denen der Tracker danach weiterlief">Stream-Enden</dt>
                  <FigValue>{num(m.ends)}</FigValue>
                </div>
                <div className="box st-fig" data-tone="white">
                  <dt title="Mittlere Abweichung aller laufenden Streams nach einem fremden Start (sollte nahe 0 liegen)">Ø alle Streams</dt>
                  <FigValue>{`${pct.format(m.overall.effect * 100)} %`}</FigValue>
                </div>
              </dl>
              <p className="muted mig__note">
                Wie sicher ist das?{" "}
                <Explain label="Wie sicher">
                  „Unsicher“: wenige Fälle oder der Effekt ist kleiner als das Zweifache seines Standardfehlers. Starts und Enden überlagern sich und
                  betreffen viele Streams gleichzeitig. Wegen Raids ausgelassen: {num(m.skippedRaid)} Beobachtungen. Startzeit laut Twitch, nicht der
                  Zeitpunkt, an dem der Tracker den Start bemerkte.
                </Explain>
              </p>
            </>
          )}
        </div>
      </section>

      <section className="block block--tight mig" data-tone="paper">
        <div className="wrap stack">
          {m && view === "uebersicht" && <StartsView m={m} names={names} />}
          {m && view === "offline" && <OfflineView m={m} names={names} />}
          {earnings && (
            <EarningsView
              names={names}
              id={typeof sp.spieler === "string" ? sp.spieler : undefined}
              share={parseShareMode(sp.anteil)}
              hidden={{ ansicht: "einnahmen" }}
              playerHref={(id) => href({ ansicht: "einnahmen", spieler: id, anteil: typeof sp.anteil === "string" ? sp.anteil : undefined })}
            />
          )}
          {view === "tag" && <DayView names={names} day={typeof sp.tag === "string" ? sp.tag : undefined} hidden={{ ansicht: "tag" }} />}
          {view === "muster" && (
            <OverlayView
              names={names}
              id={typeof sp.spieler === "string" ? sp.spieler : undefined}
              from={typeof sp.von === "string" ? sp.von : undefined}
              to={typeof sp.bis === "string" ? sp.bis : undefined}
              mode={sp.darstellung === "summe" || sp.darstellung === "schnitt" ? sp.darstellung : "linien"}
              hidden={{ ansicht: "muster" }}
            />
          )}
          {view === "spieler" && (
            <PlayerView
              names={names}
              id={typeof sp.spieler === "string" ? sp.spieler : undefined}
              day={typeof sp.tag === "string" ? sp.tag : undefined}
              hidden={{ ansicht: "spieler" }}
              dayHref={(id, d) => href({ ansicht: "spieler", spieler: id, tag: d })}
            />
          )}
        </div>
      </section>
    </>
  );
}

function StartsView({ m, names }: { m: Migration; names: Names }) {
  const losers = m.waitingRooms.filter((r) => r.effect < 0).slice(0, 20);
  const gainers = m.waitingRooms.filter((r) => r.effect > 0).reverse().slice(0, 8);
  const { rows, cols } = heatmapAxes(m);
  return (
    <>
      <div className="section-head">
        <h2 className="t-2">Wartezimmer</h2>
        <p className="muted">Streams, die nach fremden Starts mehr Zuschauer verlieren als sonst (mind. 15 Starts)</p>
      </div>
      <div className="box" data-tone="white">
        <WaitingRoomTable rows={losers} names={names} title="Streams mit Zuschauerverlust nach fremden Starts" />
      </div>
      <div className="section-head">
        <h2 className="t-2">Magneten</h2>
        <p className="muted">Wessen Start allen anderen CraftAttack-Streams zusammen am meisten Zuschauer abzieht (mind. 3 Starts)</p>
      </div>
      <div className="box" data-tone="white">
        <MagnetTable rows={m.magnets.slice(0, 15)} names={names} />
      </div>
      {rows.length > 0 && cols.length > 0 && (
        <>
          <div className="section-head">
            <h2 className="t-2">Wer verliert an wen</h2>
            <p className="muted">Zeilen: deutlichste Wartezimmer · Spalten: stärkste Magneten · Wert beim Überfahren</p>
          </div>
          <div className="box" data-tone="white">
            <PairHeatmap rows={rows} cols={cols} pairs={m.pairs} names={names} />
          </div>
        </>
      )}
      <div className="section-head">
        <h2 className="t-2">Beispiele</h2>
        <p className="muted">Die sechs Starts mit dem größten Gesamtverlust der anderen: die drei größten Verlierer in % des Stands vorher</p>
      </div>
      <div className="grid mig__examples">
        {m.examples.map((ex) => (
          <ExampleChart key={`${ex.b}-${ex.at}`} ex={ex} names={names} />
        ))}
      </div>
      {gainers.length > 0 && (
        <>
          <div className="section-head">
            <h2 className="t-2">Gegenrichtung</h2>
            <p className="muted">Streams, die nach fremden Starts eher Zuschauer dazugewinnen</p>
          </div>
          <div className="box" data-tone="white">
            <WaitingRoomTable rows={gainers} names={names} title="Streams mit Zuschauergewinn nach fremden Starts" />
          </div>
        </>
      )}
    </>
  );
}

function OfflineView({ m, names }: { m: Migration; names: Names }) {
  const heirs = m.heirs.filter((h) => h.n >= 3 && h.perEvent > 0).sort((x, y) => y.perEvent - x.perEvent).slice(0, 25);
  return (
    <>
      <div className="section-head">
        <h2 className="t-2">Erben</h2>
        <p className="muted">
          Wer nach dem Ende eines Streams mehr Zuschauer bekommt als üblich (mind. 3 Enden, ohne Raids). {num(m.ends)} Enden, davon{" "}
          {num(m.endsWithRaid)} mit Raid.
        </p>
      </div>
      <div className="box" data-tone="white">
        <HeirsTable rows={heirs} names={names} />
      </div>
      <RaidRetentionSection m={m} names={names} />
      <div className="section-head">
        <h2 className="t-2">Raids</h2>
        <p className="muted">Ausdrücklicher Wechsel mit der Zuschauerzahl laut Twitch – getrennt von den Berechnungen oben</p>
      </div>
      <div className="box" data-tone="white">
        <RaidTable rows={m.raidFlows.slice(0, 25)} names={names} />
      </div>
    </>
  );
}

const pct0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

function RaidRetentionSection({ m, names }: { m: Migration; names: Names }) {
  const rr = m.raidRetention;
  const at = (min: number) => rr.curve[min]?.median ?? 0;
  return (
    <>
      <div className="section-head">
        <h2 className="t-2">Wie viele Raid-Zuschauer bleiben</h2>
        <p className="muted">
          {num(rr.raids.length)} Raids ab 50 Zuschauern, bei denen das Ziel von 20 Min davor bis 60 Min danach durchgehend live war
          (ausgelassen: {num(rr.skipped)}).{" "}
          <Explain>Im Median kommen {pct0.format(rr.arrived * 100)} % der gemeldeten Raid-Zuschauer an; nach 10 Min
          sind {pct0.format(at(10) * 100)} % noch da, nach 30 Min {pct0.format(at(30) * 100)} %, nach 60 Min {pct0.format(at(60) * 100)} %
          (abzüglich des Trends, den das Ziel vorher hatte).</Explain>
        </p>
      </div>
      <div className="box" data-tone="white">
        <RetentionChart curve={rr.curve} />
      </div>
      {rr.byTarget.length > 0 && (
        <div className="box" data-tone="white">
          <RaidTargetTable rows={rr.byTarget} names={names} />
        </div>
      )}
      <div className="box" data-tone="white">
        <RaidStayTable rows={rr.raids.slice(0, 40)} names={names} />
      </div>
    </>
  );
}

async function OverlayView({
  names,
  id: wanted,
  from: wantedFrom,
  to: wantedTo,
  mode,
  hidden,
}: {
  names: Names;
  id?: string;
  from?: string;
  to?: string;
  mode: OverlayMode;
  hidden: Record<string, string>;
}) {
  const [days, streamers] = await Promise.all([getDays(), getStreamers()]);
  if (!days.length) return <p className="muted">Keine Zuschauerdaten.</p>;
  const id = wanted === ALL_STREAMS || (wanted && streamers.includes(wanted)) ? wanted : ALL_STREAMS;
  // Standard: die letzten 7 Tage mit Daten
  const to = wantedTo && days.includes(wantedTo) ? wantedTo : days[0];
  const from = wantedFrom && days.includes(wantedFrom) ? wantedFrom : days[Math.min(6, days.length - 1)];
  const ov = await getOverlay(id, from, to);
  const sorted = [...streamers].sort((a, b) => (names[a]?.name ?? a).localeCompare(names[b]?.name ?? b, "de"));
  const label = (d: string) => dayLong.format(dayBounds(d)[0] + 3_600_000);
  const who = id === ALL_STREAMS ? "alle Streams zusammen" : (names[id]?.name ?? id);
  return (
    <>
      <div className="section-head">
        <h2 className="t-2">Tage überlagern</h2>
        <p className="muted">
          Mehrere Tage auf einer Achse von 0 bis 24 Uhr: {who}, {ov.days.length} Tage.{" "}
          <Explain>
            Statt Tag und Nacht hintereinander zeigt das, wie ein typischer Tag aussieht. Lücken: Der Tracker lief nicht (zählen weder in Summe noch
            Durchschnitt).
          </Explain>
        </p>
      </div>
      <form className="mig__pick" method="get" action="/zuschauer">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="gb__select">
          <span className="eyebrow">Streams</span>
          <PlayerSearch
            name="spieler"
            defaultValue={id}
            label="Streams"
            empty={{ label: "Alle Streams zusammen", value: ALL_STREAMS }}
            players={sorted.map((s) => ({ id: s, name: names[s]?.name ?? s, uuid: names[s]?.uuid }))}
          />
        </label>
        <label className="gb__select">
          <span className="eyebrow">Von</span>
          <select name="von" defaultValue={from}>
            {days.map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="gb__select">
          <span className="eyebrow">Bis</span>
          <select name="bis" defaultValue={to}>
            {days.map((d) => (
              <option key={d} value={d}>
                {label(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="gb__select">
          <span className="eyebrow">Darstellung</span>
          <select name="darstellung" defaultValue={mode}>
            <option value="linien">Linie je Tag</option>
            <option value="summe">Summe</option>
            <option value="schnitt">Durchschnitt</option>
          </select>
        </label>
        <button type="submit" className="tag">
          Anzeigen
        </button>
      </form>
      <div className="box" data-tone="white">
        <OverlayChart minutes={ov.minutes} days={ov.days.map((d, k) => ({ label: label(d), values: ov.values[k] }))} mode={mode} />
      </div>
    </>
  );
}

function DayPicker({ days, current, hidden, extra }: { days: string[]; current: string; hidden: Record<string, string>; extra?: React.ReactNode }) {
  return (
    <form className="mig__pick" method="get" action="/zuschauer">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {extra}
      <label className="gb__select">
        <span className="eyebrow">Tag</span>
        <select name="tag" defaultValue={current}>
          {days.map((d) => (
            <option key={d} value={d}>
              {dayLong.format(dayBounds(d)[0] + 3_600_000)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="tag">
        Anzeigen
      </button>
    </form>
  );
}

async function DayView({ names, day: wanted, hidden }: { names: Names; day?: string; hidden: Record<string, string> }) {
  const days = await getDays();
  const d = wanted && days.includes(wanted) ? wanted : days[0];
  if (!d) return <p className="muted">Keine Zuschauerdaten.</p>;
  const stack = await getDayStack(d);
  const series = stack.series.map((s) => ({ id: s.id, name: s.id ? (names[s.id]?.name ?? s.id) : "Andere", values: s.values }));
  const total = stack.table.reduce((s, r) => s + r.hours, 0);
  return (
    <>
      <div className="section-head">
        <h2 className="t-2">Tagesverlauf</h2>
        <p className="muted">Zuschauer aller CraftAttack-Streams, gestapelt; die sieben größten Streams der Staffel mit fester Farbe</p>
      </div>
      <DayPicker days={days} current={d} hidden={hidden} />
      <div className="box" data-tone="white">
        <DayStackChart times={stack.times} covered={stack.covered} series={series} />
      </div>
      <div className="box" data-tone="white">
        <div className="tbl-wrap">
          <table className="tbl mig__tbl">
            <caption className="sr-only">Zuschauerstunden je Streamer an diesem Tag</caption>
            <thead>
              <tr>
                <th>Streamer</th>
                <th className="num">Zuschauerstunden</th>
                <th className="num">Anteil am Tag</th>
                <th className="num">Spitze</th>
              </tr>
            </thead>
            <tbody>
              {stack.table.slice(0, 30).map((r) => (
                <tr key={r.id}>
                  <td>{names[r.id]?.name ?? r.id}</td>
                  <td className="num">{num(r.hours)}</td>
                  <td className="num">{pct.format((100 * r.hours) / Math.max(1, total)).replace("+", "")} %</td>
                  <td className="num">{num(r.peak)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** Text und Farbe je Ereignis im Spielerverlauf */
function markerView(mk: ChartMarker, names: Names): ViewMarker {
  const other = mk.other ? (names[mk.other]?.name ?? mk.other) : "";
  const v = mk.viewers ?? 0;
  switch (mk.kind) {
    case "own_start":
      return { at: mk.at, tone: "own", label: "Stream startet" };
    case "own_end":
      return { at: mk.at, tone: "own", label: "Stream endet" };
    case "title":
      return { at: mk.at, tone: "own", label: `Neuer Titel: ${(mk.text ?? "").slice(0, 80)}` };
    case "raid_in":
      return { at: mk.at, tone: "gain", label: `Raid von ${other} (${num(v)} Zuschauer)` };
    case "raid_out":
      return { at: mk.at, tone: "loss", label: `Raidet ${other} (${num(v)} Zuschauer)` };
    case "shared_start":
      return { at: mk.at, tone: "own", label: `Geteilter Chat beginnt${mk.text ? ` (${mk.text})` : ""}` };
    case "shared_end":
      return { at: mk.at, tone: "own", label: "Geteilter Chat endet" };
    case "server_event":
      return { at: mk.at, tone: "own", label: `Server-Event: ${mk.text ?? ""}` };
    case "other_start":
      return { at: mk.at, tone: "loss", label: `${other} geht live: ${signed.format(v)} ggü. üblich` };
    case "other_end":
      return { at: mk.at, tone: "gain", label: `${other} geht offline: ${signed.format(v)} ggü. üblich` };
  }
}

async function PlayerView({
  names,
  id: wanted,
  day: wantedDay,
  hidden,
  dayHref,
}: {
  names: Names;
  id?: string;
  day?: string;
  hidden: Record<string, string>;
  dayHref: (id: string, day: string) => string;
}) {
  const streamers = await getStreamers();
  const id = wanted && streamers.includes(wanted) ? wanted : streamers[0];
  if (!id) return <p className="muted">Keine Zuschauerdaten.</p>;
  const pd = await getPlayerDay(id, wantedDay);
  if (!pd) return <p className="muted">Keine Zuschauerdaten für diesen Spieler.</p>;
  const d = pd.day;
  const [dayStart, dayEnd] = dayBounds(d);
  // Zeitachse auf den Bereich mit Daten (±30 Min), nicht den ganzen Tag
  const first = pd.points[0]?.[0] ?? dayStart;
  const last = pd.points.at(-1)?.[0] ?? dayEnd;
  const from = Math.max(dayStart, first - 30 * 60_000);
  const to = Math.min(dayEnd, Math.max(last + 30 * 60_000, from + 2 * 3_600_000));
  const markers = pd.markers.map((mk) => markerView(mk, names));
  const bands: ViewBand[] = pd.anomalies.map((a) => ({
    from: a.from,
    to: a.to,
    kind: a.kind,
    label: `${a.kind === "dip" ? "Ungeklärter Einbruch" : "Ungeklärter Anstieg"}: ${signed.format(a.change)} Zuschauer, erwartet ${signed.format(a.expected)} (alle anderen Streams ${pct.format(a.market * 100)} %)`,
  }));
  const sorted = [...streamers].sort((a, b) => (names[a]?.name ?? a).localeCompare(names[b]?.name ?? b, "de"));
  const idx = pd.days.indexOf(d);
  return (
    <>
      <div className="section-head">
        <h2 className="t-2">{names[id]?.name ?? id}</h2>
        <p className="muted">
          Zuschauer am {dayLong.format(dayStart + 3_600_000)} mit allem, was sie verändert hat.
          {pd.vods.length > 0 ? " Klick in den Graphen öffnet das VOD an dieser Stelle." : " Für diesen Tag ist kein VOD verfügbar."}{" "}
          <Explain label="Was heißt ungeklärt">
            Ungeklärt: Änderung weit über dem Erwarteten (dem, was dieser Stream sonst bei diesem Streamalter, auch in der Aufwärmphase, und dieser
            Tageszeit tut, plus dem, was gleichzeitig mit allen anderen Streams passiert) und kein Ereignis in der Nähe: vermutlich der Stream selbst.
          </Explain>
        </p>
      </div>
      <DayPicker
        days={pd.days}
        current={d}
        hidden={hidden}
        extra={
          <label className="gb__select">
            <span className="eyebrow">Spieler</span>
            <PlayerSearch name="spieler" defaultValue={id} label="Spieler" players={sorted.map((s) => ({ id: s, name: names[s]?.name ?? s, uuid: names[s]?.uuid }))} />
          </label>
        }
      />
      <p className="mig__pick">
        {idx < pd.days.length - 1 && (
          <Link className="tag" href={dayHref(id, pd.days[idx + 1])}>
            ← Tag davor
          </Link>
        )}
        {idx > 0 && (
          <Link className="tag" href={dayHref(id, pd.days[idx - 1])}>
            Tag danach →
          </Link>
        )}
      </p>
      <div className="box" data-tone="white">
        <PlayerViewerChart points={pd.points} markers={markers} bands={bands} vods={pd.vods} from={from} to={to} />
      </div>
      <div className="box" data-tone="white">
        <div className="tbl-wrap">
          <table className="tbl mig__tbl">
            <caption className="sr-only">Ereignisse und ungeklärte Änderungen an diesem Tag</caption>
            <thead>
              <tr>
                <th>Zeit</th>
                <th>Ereignis</th>
              </tr>
            </thead>
            <tbody>
              {[...markers.map((mk) => ({ at: mk.at, tone: mk.tone, label: mk.label })), ...bands.map((b) => ({ at: b.from, tone: b.kind === "dip" ? "loss" : "gain", label: b.label }))]
                .sort((x, y) => x.at - y.at)
                .map((r, i) => (
                  <tr key={`${r.at}-${i}`}>
                    <td className="num">{time.format(r.at)}</td>
                    <td>
                      <i className={`mig__key mig__mk-${r.tone}`} aria-hidden="true" /> {r.label}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
