function FigsSkeleton({ n = 4 }: { n?: number }) {
  return (
    <dl className={`grid st-figs${n === 6 ? " st-figs--6" : ""}`} aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="box st-fig st-fig--sk" data-tone="white">
          <dt>…</dt>
          <dd className="num">00</dd>
        </div>
      ))}
    </dl>
  );
}

function RowsSkeleton({ n = 6 }: { n?: number }) {
  return (
    <ul className="feed" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <li key={i} className="feed__min">
          <span className="st-sk st-sk--text" style={{ width: 40 }} />
          <ul className="tiles">
            {Array.from({ length: 1 + (i % 3) }).map((_, j) => (
              <li key={j} className="tile" data-tone="paper">
                <span className="st-sk st-sk--head" style={{ width: 32, height: 32, margin: 2 }} />
                <span className="st-sk st-sk--text" style={{ width: 40 }} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Platzhalter für eine ganze Seite: echte Überschrift und Farbe sofort, darunter Kacheln und Zeilen,
 * bis die Daten gestreamt sind. So reagiert jeder Klick auf einen Link ohne Wartezeit.
 */
export function PageSkeleton({ eyebrow = "Lädt", title = "…", tone = "ender", figs = 4 }: { eyebrow?: string; title?: string; tone?: string; figs?: number }) {
  return (
    <>
      <section className="block page-head" data-tone={tone} aria-busy="true">
        <div className="wrap">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="t-1">{title}</h1>
          <span className="st-sk st-sk--text" style={{ width: "min(560px, 90%)", marginTop: 16 }} aria-hidden="true" />
          <span className="sr-only" role="status">
            {title} wird geladen …
          </span>
        </div>
      </section>
      <section className="block block--tight" data-tone="ink" aria-hidden="true">
        <div className="wrap">
          <FigsSkeleton n={figs} />
        </div>
      </section>
      <section className="block block--tight" data-tone="paper" aria-hidden="true">
        <div className="wrap">
          <RowsSkeleton n={8} />
        </div>
      </section>
    </>
  );
}
