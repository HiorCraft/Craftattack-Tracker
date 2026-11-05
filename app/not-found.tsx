import Link from "next/link";

export default function NotFound() {
  return (
    <section className="block page-head" data-tone="ender">
      <div className="wrap">
        <p className="eyebrow">404</p>
        <h1 className="t-1">Nicht gefunden</h1>
        <p>Diese Seite gibt es nicht, oder der Spieler ist dem Tracker noch nie begegnet.</p>
        <div className="cluster" style={{ marginTop: 24 }}>
          <Link className="btn" data-tone="white" href="/">
            Zur Übersicht
          </Link>
          <Link className="btn" data-tone="ink" href="/spieler">
            Alle Spieler
          </Link>
        </div>
      </div>
    </section>
  );
}
