import Link from "next/link";
import { BOARD_ORDER, BOARD_STYLE } from "@/lib/boards";

/**
 * Platzhalter für die Spielerseite. Sie stehen sofort da und haben die Form des echten Inhalts
 * (gleiche Abschnitte, Überschriften und Kachel-Raster), damit beim Nachladen nichts springt.
 * Alles ist für Screenreader als „lädt" markiert, die grauen Balken selbst sind ausgeblendet.
 */

const Bar = ({ w = "60%", h = "0.9em", style }: { w?: string | number; h?: string | number; style?: React.CSSProperties }) => (
  <span className="st-sk" style={{ width: w, height: h, ...style }} aria-hidden="true" />
);

function Loading({ label }: { label: string }) {
  return (
    <span className="sr-only" role="status">
      {label} wird geladen …
    </span>
  );
}

export function HeadSkeleton() {
  return (
    <section className="block page-head" data-tone="ender" aria-busy="true">
      <div className="wrap">
        <p className="eyebrow">
          <Link href="/spieler" style={{ textDecoration: "none" }}>
            Spieler
          </Link>{" "}
          / Profil
        </p>
        <div className="player-head" style={{ marginTop: 16 }}>
          <Bar w={180} h={200} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <Bar w="min(320px, 80%)" h="2.6rem" />
            <div className="player-head__tags" style={{ marginTop: 16 }}>
              <Bar w={150} h={26} />
              <Bar w={130} h={26} />
              <Bar w={170} h={26} />
            </div>
          </div>
        </div>
        <Loading label="Profil" />
      </div>
    </section>
  );
}

export function TilesSkeleton() {
  return (
    <section className="block block--tight" data-tone="ink" aria-busy="true">
      <div className="wrap">
        <dl className="grid st-figs" aria-hidden="true">
          {Array.from({ length: 11 }).map((_, i) => (
            <div key={i} className="box st-fig st-fig--spark skel-fig" data-tone="white">
              <dd>
                <Bar w="55%" h="2.2rem" />
              </dd>
              <dt>
                <Bar w="45%" />
              </dt>
              <Bar w="100%" h={56} style={{ marginTop: "auto" }} />
            </div>
          ))}
        </dl>
        <Loading label="Statistiken" />
      </div>
    </section>
  );
}

/** Weiße Box mit echter Überschrift und Platzhalter-Zeilen */
function BoxSkeleton({ title, rows = 4 }: { title: string; rows?: number }) {
  return (
    <div className="box" data-tone="white">
      <p className="eyebrow" style={{ marginBottom: 12 }}>
        {title}
      </p>
      <div className="skel-rows">
        {Array.from({ length: rows }).map((_, i) => (
          <Bar key={i} w={`${85 - (i % 3) * 15}%`} />
        ))}
      </div>
    </div>
  );
}

export function InsightsSkeleton() {
  return (
    <section className="block block--tight" data-tone="paper" aria-busy="true">
      <div className="wrap">
        <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
          <BoxSkeleton title="Pro Online-Stunde" rows={6} />
          <BoxSkeleton title="Zuwachs" rows={6} />
          <BoxSkeleton title="Streams" rows={6} />
        </div>
        <Loading label="Auswertung" />
      </div>
    </section>
  );
}

export function RanksSkeleton() {
  return (
    <section className="block block--tight" data-tone="paper" aria-busy="true">
      <div className="wrap">
        <div className="section-head">
          <h2 className="t-2">Rang-Verlauf</h2>
          <p className="muted">Platz unter allen erfassten Spielern. Oben ist besser.</p>
        </div>
        <div className="grid st-boards">
          {BOARD_ORDER.map((k) => (
            <section key={k} className="box st-board rankboard" data-tone={BOARD_STYLE[k].tone} aria-hidden="true">
              <header className="st-board__head">
                <span className="st-board__icon" />
                <div className="rankboard__title">
                  <p className="t-3">{BOARD_STYLE[k].title}</p>
                  <p className="st-board__sub">{BOARD_STYLE[k].sub}</p>
                </div>
                <Bar w={52} h="1.75rem" />
              </header>
              <div className="rankboard__chart">
                <Bar w="100%" h={84} />
              </div>
              <div className="skel-rows">
                <Bar w="100%" />
                <Bar w="100%" />
                <Bar w="100%" />
              </div>
            </section>
          ))}
        </div>
        <Loading label="Rang-Verlauf" />
      </div>
    </section>
  );
}

export function DetailsSkeleton() {
  return (
    <section className="block" data-tone="paper" aria-busy="true">
      <div className="wrap">
        <div className="section-head">
          <h2 className="t-2">Weitere Statistiken</h2>
        </div>
        <div className="grid" style={{ "--min": "280px", "--gap": "16px" } as React.CSSProperties}>
          <BoxSkeleton title="Abbau & Bau" rows={3} />
          <BoxSkeleton title="Kampf" rows={3} />
          <BoxSkeleton title="Items & Handel" rows={5} />
        </div>
        <Loading label="Weitere Statistiken" />
      </div>
    </section>
  );
}

export function TimelineSkeleton() {
  return (
    <section className="block" data-tone="paper" aria-busy="true">
      <div className="wrap">
        <div className="grid" style={{ "--min": "300px", "--gap": "24px" } as React.CSSProperties}>
          <div style={{ gridColumn: "span 2" }}>
            <div className="section-head">
              <h2 className="t-2">Verlauf</h2>
            </div>
            <ul className="skel-rows" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-hidden="true">
              {Array.from({ length: 8 }).map((_, i) => (
                <li key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Bar w={44} />
                  <Bar w={32} h={32} />
                  <Bar w={`${30 + (i % 4) * 12}%`} h={28} />
                </li>
              ))}
            </ul>
          </div>
          <div className="stack" style={{ "--stack": "16px" } as React.CSSProperties}>
            <BoxSkeleton title="Vom Tracker gemessen" rows={8} />
            <BoxSkeleton title="Mitspieler" rows={5} />
          </div>
        </div>
        <Loading label="Verlauf" />
      </div>
    </section>
  );
}

export function ChatSkeleton() {
  return (
    <section className="block block--tight" data-tone="paper" aria-busy="true">
      <div className="wrap">
        <div className="section-head">
          <h2 className="t-2">Chat</h2>
        </div>
        <div className="chatpair">
          <BoxSkeleton title="Schreibt bei anderen" rows={4} />
          <BoxSkeleton title="Im eigenen Chat" rows={4} />
        </div>
        <Loading label="Chat" />
      </div>
    </section>
  );
}

/** Einfacher Platzhalter: Überschrift und eine graue Fläche in der ungefähren Höhe des Inhalts */
export function SectionSkeleton({ title, height = 220 }: { title: string; height?: number }) {
  return (
    <section className="block block--tight" data-tone="paper" aria-busy="true">
      <div className="wrap">
        <div className="section-head">
          <h2 className="t-2">{title}</h2>
        </div>
        <Bar w="100%" h={height} />
        <Loading label={title} />
      </div>
    </section>
  );
}
