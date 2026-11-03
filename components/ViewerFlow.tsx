import Link from "next/link";
import { Head } from "./Head";
import { Explain } from "./Explain";
import type { FlowEvent, PairFlow, SourceSummary, StartSummary } from "@/lib/viewerFlowCore";
import { num } from "@/lib/format";

/**
 * Darstellung der Zuschauerwanderung (lib/viewerFlowCore.ts). Server-SVG; Werte stehen zusätzlich als Text
 * daneben bzw. als Tooltip (<title>). Farben aus der geprüften Palette unter `.mig` (globals.css).
 */

export type Names = Record<string, { name: string; uuid: string } | undefined>;

const pct0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
export const pct = (x: number) => `${pct0.format(x * 100)} %`;
const time = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });

export function Person({ id, names, size = 22, href }: { id: string; names: Names; size?: number; href?: string }) {
  const p = names[id];
  return (
    <Link href={href ?? `/spieler/${encodeURIComponent(id)}`} className="conn__person">
      <Head id={id} uuid={p?.uuid} name={p?.name ?? id} size={size} decorative />
      <span>{p?.name ?? id}</span>
    </Link>
  );
}

const KIND: Record<FlowEvent["kind"], string> = { ende: "beendet den Stream", einbruch: "verliert Zuschauer", raid: "raidet", start: "geht live" };

/** Farbe je Ziel innerhalb eines Ereignisses (Plätze 1–7, Rest grau) */
const slot = (i: number) => `mig__c${(i % 7) + 1}`;

/** Ein Ereignis: Quelle, frei gewordene Zuschauer, Balken nach Ziel, Ziele mit Zahl und Bleiben */
export function FlowRow({ e, names }: { e: FlowEvent; names: Names }) {
  const shown = e.shares.filter((x) => x.viewers >= Math.max(10, e.pool * 0.01)).slice(0, 6);
  const rest = Math.max(0, e.pool - e.found);
  return (
    <li className="vf__row">
      <span className="vf__time num">{time.format(e.at)}</span>
      <div className="vf__body">
        <p className="vf__head">
          <Person id={e.from} names={names} />
          <span className="muted">{KIND[e.kind]}</span>
          {e.kind === "raid" && e.raidTo && <Person id={e.raidTo} names={names} />}
          <b className="num">{num(e.pool)}</b>
          <span className="muted">{e.kind === "raid" ? "Zuschauer" : e.kind === "start" ? "Zuschauer nach 30 Min, davon kamen von:" : "frei"}</span>
          {e.overlapping > 0 && (
            <span
              className="tag vf__ovl"
              title={e.kind === "start" ? "Weitere Streams gingen in denselben 15 Minuten live; Verluste wurden nach dem üblichen Muster aufgeteilt" : "Weitere Streams endeten oder verloren Zuschauer in denselben 15 Minuten; ihr Zuwachs wurde nach dem üblichen Muster aufgeteilt"}
            >
              +{e.overlapping} gleichzeitig
            </span>
          )}
        </p>
        <svg className="vf__bar" viewBox="0 0 1000 12" preserveAspectRatio="none" role="img" aria-label={`${pct(e.found / Math.max(1, e.pool))} wiedergefunden`}>
          {shown.map((s, i) => {
            const x = shown.slice(0, i).reduce((a, o) => a + (1000 * o.viewers) / Math.max(1, e.pool), 0);
            const w = (1000 * s.viewers) / Math.max(1, e.pool);
            return (
              <rect key={s.to} x={x} y={0} width={Math.max(2, w)} height={12} className={slot(i)}>
                <title>{`${names[s.to]?.name ?? s.to}: ${num(s.viewers)}`}</title>
              </rect>
            );
          })}
        </svg>
        <ul className="vf__dest">
          {shown.map((s, i) => (
            <li key={s.to}>
              <i className={slot(i)} aria-hidden="true" />
              <Person id={s.to} names={names} size={18} />
              <b className="num">{num(s.viewers)}</b>
              {s.stay !== null &&
                (e.kind === "start" ? (
                  <span className={s.stay < 0.4 ? "vf__leave" : "muted"}>{s.stay < 0.4 ? "kommen bald zurück" : `bleiben weg ${pct(s.stay)}`}</span>
                ) : (
                  <span className={s.stay < 0.4 ? "vf__leave" : "muted"}>{s.stay < 0.4 ? "gehen schnell wieder" : `bleiben ${pct(s.stay)}`}</span>
                ))}
              {s.chat > 0 && <span className="muted" title="Chat-Schreiber, die von hier nach dort wechselten">· {num(s.chat)} im Chat gesehen</span>}
            </li>
          ))}
          {e.kind === "start" ? (
            <li className="muted">
              <i className="mig__c0" aria-hidden="true" /> {num(rest)} neu oder von anderswo
              {e.usualFound !== null && <> (um diese Uhrzeit kommen üblich {pct(e.usualFound)} von CraftAttack-Streams)</>}
            </li>
          ) : (
            <li className="muted">
              <i className="mig__c0" aria-hidden="true" /> {num(rest)} nicht wiedergefunden
              {e.kind !== "raid" && e.usualFound !== null && <> (um diese Uhrzeit üblich: {pct(1 - e.usualFound)})</>}
            </li>
          )}
        </ul>
      </div>
    </li>
  );
}

export function FlowList({ events, names }: { events: FlowEvent[]; names: Names }) {
  return (
    <ol className="vf__list">
      {events.map((e) => (
        <FlowRow key={e.id} e={e} names={names} />
      ))}
    </ol>
  );
}

/** Anteil wiedergefunden je Uhrzeit (Balken je Stunde) */
export function HourlyChart({ hourly, tone = "mig__c1" }: { hourly: { hour: number; pool: number; found: number; n: number }[]; tone?: string }) {
  const W = 520;
  const H = 210;
  const L = 40;
  const B = 22;
  const T = 8;
  const max = Math.max(0.1, ...hourly.filter((h) => h.n >= 10).map((h) => h.found / h.pool));
  const yMax = Math.ceil(max * 10) / 10;
  const bw = (W - L) / 24;
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Anteil der frei gewordenen Zuschauer, die bei anderen CraftAttack-Streams auftauchen, je Uhrzeit">
      {[0, yMax / 2, yMax].map((v) => (
        <g key={v}>
          <line x1={L} x2={W} y1={y(v)} y2={y(v)} className="mig__grid" />
          <text x={L - 6} y={y(v) + 4} textAnchor="end" className="mig__tick">
            {pct(v)}
          </text>
        </g>
      ))}
      {hourly.map((h) => {
        const v = h.n >= 10 ? h.found / h.pool : 0;
        return (
          <g key={h.hour}>
            <rect x={L + h.hour * bw + 3} y={y(v)} width={bw - 6} height={H - B - y(v)} className={tone} opacity={h.n >= 10 ? 1 : 0.25}>
              <title>{`${h.hour}–${h.hour + 1} Uhr: ${h.n >= 10 ? pct(v) : "zu wenige Fälle"} (${num(h.n)} Ereignisse)`}</title>
            </rect>
            {h.hour % 6 === 0 && (
              <text x={L + h.hour * bw + bw / 2} y={H - 6} textAnchor="middle" className="mig__tick">
                {h.hour} Uhr
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Anlauf: übliche Zuschauer nach Streamalter, Anteil des Stands nach 2 Std (alle Streams, optional einer dazu) */
export function RampChart({
  all,
  own,
  ownLabel,
  compact = false,
}: {
  all: { age: number; median: number; n: number }[];
  own?: { age: number; median: number; n: number }[];
  ownLabel?: string;
  compact?: boolean;
}) {
  const W = compact ? 520 : 960;
  const H = compact ? 210 : 240;
  const L = 44;
  const R = 12;
  const B = 22;
  const T = 10;
  const maxAge = all[all.length - 1]?.age ?? 240;
  const ownOk = own?.filter((p) => p.n >= 3) ?? [];
  const yMax = Math.max(1.1, ...all.map((p) => p.median), ...ownOk.map((p) => p.median));
  const x = (a: number) => L + (a / maxAge) * (W - L - R);
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const line = (l: { age: number; median: number }[]) => l.map((p) => `${x(p.age).toFixed(1)},${y(p.median).toFixed(1)}`).join(" ");
  return (
    <div className="mig__chart">
      <ul className="mig__keys" aria-label="Legende">
        <li>
          <i className="mig__c0" aria-hidden="true" /> alle Streams
        </li>
        {ownOk.length > 1 && (
          <li>
            <i className="mig__c1" aria-hidden="true" /> {ownLabel}
          </li>
        )}
      </ul>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Üblicher Zuschaueranstieg nach dem Streamstart">
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 1 ? "mig__ref" : "mig__grid"} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="mig__tick">
              {pct(v)}
            </text>
          </g>
        ))}
        {(compact ? [0, 60, 120, 240] : [0, 30, 60, 120, 180, 240]).map((a) => (
          <text key={a} x={x(a)} y={H - 6} textAnchor="middle" className="mig__tick">
            {a === 0 ? "Start" : a < 60 ? `${a} Min` : `${a / 60} Std`}
          </text>
        ))}
        <polyline points={line(all)} className="mig__line mig__c0line" />
        {ownOk.length > 1 && <polyline points={line(ownOk)} className="mig__line mig__l1" />}
        {all.map((p) => (
          <circle key={p.age} cx={x(p.age)} cy={y(p.median)} r={3} className="mig__c0">
            <title>{`${p.age} Min nach dem Start: ${pct(p.median)} des Stands nach 2 Std`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/** Quellen der Staffel: wie viele frei wurden, wie viel davon wo auftauchte */
export function SourceTable({ rows, names, streamerHref }: { rows: SourceSummary[]; names: Names; streamerHref: (id: string) => string }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl vf__tbl">
        <thead>
          <tr>
            <th>Streamer</th>
            <th className="num" title="Enden · Einbrüche · Raids">Ereignisse</th>
            <th className="num">Frei geworden</th>
            <th className="num">Wiedergefunden</th>
            <th>Wohin vor allem</th>
            <th className="num" title="Anteil des Zuwachses beim Ziel, der nach 60 Min noch da ist (Median)">Bleiben</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Person id={r.id} names={names} href={streamerHref(r.id)} />
              </td>
              <td className="num muted">
                {r.ends} · {r.drops} · {r.raids}
              </td>
              <td className="num">{num(r.pool)}</td>
              <td className="num">{pct(r.found / Math.max(1, r.pool))}</td>
              <td>
                <span className="vf__heads">
                  {r.top.slice(0, 4).map((p) => (
                    <Link key={p.to} href={streamerHref(p.to)} title={`${names[p.to]?.name ?? p.to}: ${num(p.viewers)} Zuschauer${p.raid ? `, davon ${num(p.raid)} per Raid` : ""}`}>
                      <Head id={p.to} uuid={names[p.to]?.uuid} name={names[p.to]?.name ?? p.to} size={22} decorative />
                    </Link>
                  ))}
                </span>
              </td>
              <td className="num">{r.stay === null ? "–" : pct(r.stay)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Paare eines Streamers: wohin (dir = "von") bzw. woher (dir = "zu") */
export function PairTable({ rows, names, dir, streamerHref }: { rows: PairFlow[]; names: Names; dir: "von" | "zu"; streamerHref: (id: string) => string }) {
  if (!rows.length) return <p className="muted">Keine deutlichen Wanderungen.</p>;
  const legend = (
    <ul className="mig__keys" aria-label="Legende">
      <li>
        <i className="mig__c1" aria-hidden="true" /> nach Ende/Einbruch
      </li>
      <li>
        <i className="mig__c4" aria-hidden="true" /> Raid
      </li>
      <li>
        <i className="mig__c3" aria-hidden="true" /> als {dir === "von" ? "der andere" : "dieser"} live ging
      </li>
    </ul>
  );
  const max = Math.max(...rows.map((r) => r.viewers));
  return (
    <>
    {legend}
    <ol className="vf__pairs">
      {rows.map((r) => {
        const other = dir === "von" ? r.to : r.from;
        const unsure = r.beta > 0 && r.beta < 2 * r.se;
        return (
          <li key={other}>
            <Person id={other} names={names} href={streamerHref(other)} />
            <span className="vf__pbar" aria-hidden="true">
              <i style={{ width: `${(100 * (r.viewers - r.raid - r.start)) / max}%` }} className="mig__c1" />
              <i style={{ width: `${(100 * r.raid) / max}%` }} className="mig__c4" />
              <i style={{ width: `${(100 * r.start) / max}%` }} className="mig__c3" />
            </span>
            <b className="num">{num(r.viewers)}</b>
            <span className="muted">
              {r.beta > 0 && <>{pct(r.beta)} je Ende{unsure ? " (unsicher)" : ""}</>}
              {r.raid > 0 && <>{r.beta > 0 ? " · " : ""}Raid {num(r.raid)}</>}
              {r.start > 0 && <>{r.beta > 0 || r.raid > 0 ? " · " : ""}beim Start {num(r.start)}</>}
              {r.stay !== null && <> · bleiben {pct(r.stay)}</>}
            </span>
          </li>
        );
      })}
    </ol>
    </>
  );
}

/** Starts der Staffel: wie viel des Anlaufs von anderen erfassten Streams kam und von wem */
export function StartTable({ rows, names, streamerHref }: { rows: StartSummary[]; names: Names; streamerHref: (id: string) => string }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl vf__tbl">
        <thead>
          <tr>
            <th>Streamer</th>
            <th className="num">Starts</th>
            <th className="num" title="Zuschauer 30 Min nach dem Start, Durchschnitt">Ø nach 30 Min</th>
            <th className="num" title="Anteil des Anlaufs, der anderen erfassten Streams über das Übliche hinaus fehlte">Von CraftAttack</th>
            <th>Von wem vor allem</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <Person id={r.id} names={names} href={streamerHref(r.id)} />
              </td>
              <td className="num">{num(r.starts)}</td>
              <td className="num">{num(r.avg)}</td>
              <td className="num">{pct(r.pulled / Math.max(1, r.inflow))}</td>
              <td>
                <span className="vf__heads">
                  {r.top.slice(0, 4).map((p) => (
                    <Link key={p.from} href={streamerHref(p.from)} title={`${names[p.from]?.name ?? p.from}: ${num(p.start)} Zuschauer über alle Starts`}>
                      <Head id={p.from} uuid={names[p.from]?.uuid} name={names[p.from]?.name ?? p.from} size={22} decorative />
                    </Link>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MethodNote() {
  return (
    <Explain label="Wie das gerechnet wird">
      1. Normalverlauf: Für jeden Stream die übliche Änderung je 5 Minuten nach Streamalter (in der ersten Stunde wächst jeder Stream von selbst) und
      Tageszeit. Gezählt wird nur, was davon abweicht. 2. Frei werden Zuschauer, wenn ein Stream endet, deutlich einbricht (und sich nicht gleich wieder
      erholt; kurze Zählaussetzer von Twitch zählen nicht) oder raidet. Geht ein Stream live, wird geprüft, wie viel laufenden Streams in den 30
      Minuten danach über das Übliche hinaus fehlt; das ist der Teil seines Anlaufs, der von dort kam. 3. Über die ganze Staffel wird geschätzt, welcher Anteil der frei gewordenen
      Zuschauer von A in den 5–20 Minuten danach bei B zusätzlich auftaucht. Weil verschiedene Streams zu verschiedenen Zeiten zusammen enden, lassen
      sich die Anteile so trennen. 4. An einem Abend teilen sich gleichzeitige Quellen den Zuwachs von B nach diesem Muster; was B ohnehin schwankt,
      wird nicht zugeordnet. Chat-Spuren (wer erst bei A, dann bei B schreibt; nur als Summe gespeichert) gehen als zusätzlicher Beleg ein. 5. Bleiben:
      wie viel des Zuwachses nach 60 Minuten noch da ist. Nicht wiedergefunden heißt: offline gegangen oder bei Streams, die hier nicht erfasst sind;
      das lässt sich nicht trennen.
    </Explain>
  );
}
