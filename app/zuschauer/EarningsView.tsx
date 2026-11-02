import { FigValue } from "@/components/FigValue";
import { EarningsDailyChart, EarningsGrowthChart } from "@/components/ViewerCharts";
import { Person } from "@/components/ViewerMigration";
import { BIT_EUR, getEarnings, getEarningStreams, PLUS_POINTS, SHARES, SUB_PRICE_EUR, VAT, type ShareMode } from "@/lib/earnings";
import { num } from "@/lib/format";
import { PlayerSearch } from "@/components/PlayerSearch";

/**
 * Experimentell: geschätzte Twitch-Einnahmen aus Abos und Bits (lib/earnings.ts). Alles bezieht sich auf die Zeit
 * auf dem Server, weil nur dort Abos gezählt wurden.
 */

type Names = Record<string, { name: string; uuid: string } | undefined>;

const eur = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const eur2 = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const pct = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 0,
  signDisplay: "exceptZero",
});
const hrs = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const when = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});
const dayFmt = new Intl.DateTimeFormat("de-DE", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});
const dur = (minutes: number) => {
  const min = Math.round(minutes);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} Std.`;
};

const TOP = 7;

export async function EarningsView({
  names,
  id,
  share,
  hidden,
  playerHref,
}: {
  names: Names;
  id?: string;
  share: ShareMode;
  hidden: Record<string, string>;
  playerHref: (id: string) => string;
}) {
  const e = await getEarnings(share);
  const selected = id && e.players.some((p) => p.id === id) ? id : undefined;
  const streams = selected ? await getEarningStreams(selected, share) : [];
  const name = (pid: string) => names[pid]?.name ?? pid;
  const growth = e.players.slice(0, TOP).map((p) => {
    let run = 0;
    return {
      id: p.id,
      name: name(p.id),
      cum: (e.daily[p.id] ?? []).map((v) => (run += v)),
    };
  });
  const sumDays = (rec: Record<string, number[]>) => e.days.map((_, i) => Object.values(rec).reduce((s, v) => s + v[i], 0));
  const dailyValues = selected ? e.daily[selected] : sumDays(e.daily);
  const dailyHours = selected ? e.dailyHours[selected] : sumDays(e.dailyHours);
  const precise = e.players.filter((p) => p.preciseShare > 0 && p.tiers.t1 + p.tiers.t2 + p.tiers.t3 + p.tiers.prime > 0);
  const net1 = SUB_PRICE_EUR.t1 / (1 + VAT);

  return (
    <>
      <div className="section-head">
        <h2 className="t-2">Einnahmen (experimentell)</h2>
        <p className="muted">
          Geschätzt aus Abos und Bits, die während der Zeit auf dem Server im Chat gemeldet wurden. Werbung, Sponsoren und Spenden sind
          nicht sichtbar und fehlen; stille Verlängerungen auch. Eher eine Untergrenze als ein Kontoauszug.
        </p>
      </div>

      <form className="mig__pick" method="get" action="/zuschauer">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="gb__select">
          <span className="eyebrow">Streamer</span>
          <PlayerSearch
            name="spieler"
            defaultValue={selected ?? ""}
            label="Streamer"
            empty={{ label: "Alle" }}
            players={[...e.players].sort((a, b) => name(a.id).localeCompare(name(b.id), "de")).map((p) => ({ id: p.id, name: name(p.id), uuid: names[p.id]?.uuid }))}
          />
        </label>
        <label className="gb__select">
          <span className="eyebrow">Anteil des Streamers</span>
          <select name="anteil" defaultValue={String(share)}>
            <option value="auto">je Kanal (geschätzt)</option>
            {SHARES.map((s) => (
              <option key={s} value={s}>
                alle {s} %
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="tag">
          Anzeigen
        </button>
      </form>

      <dl className="grid st-figs">
        <div className="box st-fig" data-tone="white">
          <dt title="Summe aller Streamer, nur Zeit auf dem Server">Geschätzt gesamt</dt>
          <FigValue>{eur.format(e.totals.eur)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Gesamtsumme geteilt durch alle Stunden auf dem Server">Je Stunde (alle)</dt>
          <FigValue>{eur.format(e.totals.hours > 0 ? e.totals.eur / e.totals.hours : 0)}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Bezahlte Abo-Monate auf dem Server; vor der genauen Erfassung umgerechnet">Abos</dt>
          <FigValue>{num(Math.round(e.totals.subs))}</FigValue>
        </div>
        <div className="box st-fig" data-tone="white">
          <dt title="Bits auf dem Server (erfasst seit 25. Okt.)">Bits</dt>
          <FigValue>{num(e.totals.bits)}</FigValue>
        </div>
      </dl>

      <div className="box" data-tone="white">
        <h3 className="t-3">Wie schnell es wächst</h3>
        <p className="muted">Aufsummiert je Tag des Streamstarts, die {TOP} Streamer mit den höchsten Schätzungen</p>
        {e.days.length > 0 ? <EarningsGrowthChart days={e.days} series={growth} /> : <p className="muted">Noch keine Streams.</p>}
      </div>

      <div className="box" data-tone="white">
        <h3 className="t-3">Je Tag{selected ? `: ${name(selected)}` : ""}</h3>
        {e.days.length > 0 && (
          <EarningsDailyChart days={e.days} values={dailyValues} hours={dailyHours} label={selected ? name(selected) : "Alle Streamer"} />
        )}
      </div>

      {selected && (
        <div className="box" data-tone="white">
          <h3 className="t-3">Streams von {name(selected)}</h3>
          <div className="tbl-wrap">
            <table className="tbl mig__tbl">
              <caption className="sr-only">Geschätzte Einnahmen je Stream</caption>
              <thead>
                <tr>
                  <th>Start</th>
                  <th className="num" title="Stream gesamt / davon auf dem Server">
                    Dauer
                  </th>
                  <th className="num">Abos</th>
                  <th title="Nur mit genauer Erfassung">Stufen</th>
                  <th className="num">Bits</th>
                  <th className="num">Geschätzt</th>
                  <th className="num">je Stunde</th>
                  <th className="num" title="Inklusive der Zeit abseits des Servers (nur mit genauer Erfassung)">
                    ganzer Stream
                  </th>
                  <th>VOD</th>
                </tr>
              </thead>
              <tbody>
                {streams.map((s) => (
                  <tr key={s.start}>
                    <td>
                      {when.format(s.start)}
                      {s.running ? " · läuft" : ""}
                    </td>
                    <td className="num">
                      {dur(s.streamMin)} / {dur(s.serverMin)}
                    </td>
                    <td className="num">{s.tiers ? num(s.subs) : `ca. ${num(Math.round(s.subs))}`}</td>
                    <td>
                      {s.tiers
                        ? [
                            s.tiers.t1 && `${num(s.tiers.t1)}× S1`,
                            s.tiers.t2 && `${num(s.tiers.t2)}× S2`,
                            s.tiers.t3 && `${num(s.tiers.t3)}× S3`,
                            s.tiers.prime && `${num(s.tiers.prime)}× Prime`,
                            s.tiers.gift && `${num(s.tiers.gift)} verschenkt`,
                          ]
                            .filter(Boolean)
                            .join(", ") || "–"
                        : "–"}
                    </td>
                    <td className="num">{num(s.bits)}</td>
                    <td className="num">{eur.format(s.eur)}</td>
                    <td className="num">{s.serverMin > 0 ? eur.format(s.eur / (s.serverMin / 60)) : "–"}</td>
                    <td className="num">{s.eurAll !== null ? eur.format(s.eurAll) : "–"}</td>
                    <td>
                      {s.vod ? (
                        <a href={s.vod} target="_blank" rel="noreferrer">
                          ansehen
                        </a>
                      ) : (
                        "–"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="box" data-tone="white">
        <h3 className="t-3">Rangliste</h3>
        <p className="muted">
          „Je Stunde“ ist der Stundenlohn auf dem Server: Schätzung geteilt durch die Stunden live auf CraftAttack. Trend: Stundenlohn der
          letzten 7 Tage gegenüber den 7 Tagen davor (ab 3 Stunden in beiden Zeiträumen).
        </p>
        <div className="tbl-wrap">
          <table className="tbl mig__tbl">
            <caption className="sr-only">Geschätzte Einnahmen je Streamer</caption>
            <thead>
              <tr>
                <th>Streamer</th>
                <th className="num">Abos</th>
                <th className="num">Bits</th>
                <th className="num">Streams</th>
                <th className="num">Stunden</th>
                <th className="num" title="Geschätzte Plus Points im Monat (Untergrenze) und verwendeter Anteil">Anteil</th>
                <th className="num">Geschätzt</th>
                <th className="num">je Stream</th>
                <th className="num">je Stunde</th>
                <th className="num">Trend</th>
              </tr>
            </thead>
            <tbody>
              {e.players.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a href={playerHref(p.id)} className="conn__person" title="Streams anzeigen">
                      {name(p.id)}
                    </a>
                  </td>
                  <td className="num">{num(Math.round(p.subs))}</td>
                  <td className="num">{num(p.bits)}</td>
                  <td className="num">{num(p.streams)}</td>
                  <td className="num">{hrs.format(p.hours)}</td>
                  <td className="num" title={`ca. ${num(p.points)} Plus Points im Monat`}>
                    {p.share} %
                  </td>
                  <td className="num">{eur.format(p.eur)}</td>
                  <td className="num">{eur.format(p.perStream)}</td>
                  <td className="num">{eur.format(p.perHour)}</td>
                  <td className="num">{p.trend === null ? "–" : `${pct.format(p.trend * 100)} %`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="box" data-tone="white">
        <h3 className="t-3">Anteil je Kanal</h3>
        <p className="muted">
          Twitch zahlt bezahlte Abos zu 50 %, mit mindestens {PLUS_POINTS[60]} Plus Points im Monat (drei Monate in Folge) zu 60 % und ab{" "}
          {PLUS_POINTS[70]} zu 70 %, ohne Obergrenze. Punkte geben nur selbst bezahlte Abos: Stufe 1 = 1, Stufe 2 = 2, Stufe 3 = 6; Prime
          und Geschenke zählen nicht. Geschenke werden zum erhöhten Satz bezahlt, Prime immer zu 50 %. Gemessen werden nur Abos, die im
          Chat gemeldet werden – die Punkte sind eine Untergrenze, ein Kanal liegt also eher höher. Sonderverträge sind nicht sichtbar.
        </p>
        <dl className="grid st-figs">
          {([70, 60, 50] as const).map((s) => (
            <div key={s} className="box st-fig" data-tone="white">
              <dt>{s === 70 ? `70 % (ab ${PLUS_POINTS[70]} Punkten)` : s === 60 ? `60 % (ab ${PLUS_POINTS[60]} Punkten)` : "50 % (Standard)"}</dt>
              <FigValue>{`${num(e.shareCounts[s])} Kanäle`}</FigValue>
            </div>
          ))}
        </dl>
        <div className="tbl-wrap">
          <table className="tbl mig__tbl">
            <caption className="sr-only">Geschätzte Plus Points und Anteil je Kanal</caption>
            <thead>
              <tr>
                <th>Streamer</th>
                <th className="num">Plus Points im Monat (mind.)</th>
                <th className="num">Anteil</th>
              </tr>
            </thead>
            <tbody>
              {[...e.players]
                .sort((a, b) => b.points - a.points)
                .map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Person id={p.id} names={names} />
                    </td>
                    <td className="num">{num(p.points)}</td>
                    <td className="num">{p.points >= PLUS_POINTS[70] ? "70 %" : p.points >= PLUS_POINTS[60] ? "60 %" : "50 %"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="box" data-tone="white">
        <h3 className="t-3">Abo-Stufen</h3>
        {e.preciseFrom === null || precise.length === 0 ? (
          <p className="muted">
            Die Einzelerfassung mit Stufe (1, 2, 3, Prime) und Geschenken läuft ab dem nächsten Tracker-Deploy. Bis genug Daten da sind,
            gilt jedes ältere Abo als Stufe 1.
          </p>
        ) : (
          <>
            <p className="muted">Seit {dayFmt.format(e.preciseFrom)}, nur Zeit auf dem Server</p>
            <div className="tbl-wrap">
              <table className="tbl mig__tbl">
                <caption className="sr-only">Abo-Stufen je Streamer seit Beginn der genauen Erfassung</caption>
                <thead>
                  <tr>
                    <th>Streamer</th>
                    <th className="num">Stufe 1</th>
                    <th className="num">Stufe 2</th>
                    <th className="num">Stufe 3</th>
                    <th className="num">Prime</th>
                    <th className="num">davon verschenkt</th>
                  </tr>
                </thead>
                <tbody>
                  {precise.map((p) => {
                    const all = p.tiers.t1 + p.tiers.t2 + p.tiers.t3 + p.tiers.prime;
                    return (
                      <tr key={p.id}>
                        <td>
                          <Person id={p.id} names={names} />
                        </td>
                        <td className="num">{num(p.tiers.t1)}</td>
                        <td className="num">{num(p.tiers.t2)}</td>
                        <td className="num">{num(p.tiers.t3)}</td>
                        <td className="num">{num(p.tiers.prime)}</td>
                        <td className="num">
                          {num(p.tiers.gift)} ({pct.format((100 * p.tiers.gift) / all).replace("+", "")} %)
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="box" data-tone="white">
        <h3 className="t-3">Annahmen</h3>
        <ul className="muted">
          <li>
            Preise in Deutschland: Stufe 1 {eur2.format(SUB_PRICE_EUR.t1)}, Stufe 2 {eur2.format(SUB_PRICE_EUR.t2)}, Stufe 3{" "}
            {eur2.format(SUB_PRICE_EUR.t3)}, davon {Math.round(VAT * 100)} % Umsatzsteuer ab. Vom Rest bekommt der Streamer{" "}
            {share === "auto" ? "seinen geschätzten Anteil (siehe oben)" : `${share} %`}: Stufe 1 also ca. {eur2.format(net1 * 0.5)} bei 50 %,{" "}
            {eur2.format(net1 * 0.6)} bei 60 % und {eur2.format(net1 * 0.7)} bei 70 %.
          </li>
          <li>Prime bringt so viel wie Stufe 1 bei 50 %. Geschenkte Abos zählen wie gekaufte (der Schenkende zahlt).</li>
          <li>1 Bit = 1 US-Cent für den Streamer, hier {eur2.format(BIT_EUR * 100).replace(/\s?€/, "")} Cent.</li>
          <li>
            Ein Community-Geschenk zählt einmal, auch wenn Twitch zusätzlich jede einzelne Übergabe meldet. In der älteren Zählung
            (Abo-Ereignisse) fehlt diese Unterscheidung und die Stufe;{" "}
            {e.calibration
              ? `dort wird mit dem gemessenen Mix je Eintrag gerechnet: ${hrs.format(e.perEntry.units)} Abos, ${eur2.format(e.perEntry.paid)} bezahlt und ${eur2.format(e.perEntry.prime)} Prime (netto vor Aufteilung), ${hrs.format(e.perEntry.points)} Plus Points (aus ${num(e.calibration.entries)} Einträgen mit genauer Gegenprobe).`
              : `bis eine Gegenprobe mit genug Daten vorliegt, zählt dort jeder Eintrag als ein bezahltes Abo der Stufe 1 und als ${hrs.format(e.perEntry.points)} Plus Points (Wert aus den ersten Stunden der Einzelerfassung).`}
          </li>
          <li>
            Gezählt werden Streams ab 10 Minuten auf dem Server; Abos und Stunden nur während der Streamer auf dem Server war. Lücken im
            Verlauf (z. B. wenn craftattack.one den Tracker sperrt) zählen weder als Zeit noch für Abos und Bits. Tage nach Streamstart
            (Berlin).
          </li>
        </ul>
      </div>
    </>
  );
}
