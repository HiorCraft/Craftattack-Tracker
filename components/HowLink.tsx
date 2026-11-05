import Link from "next/link";

/** Eine Zeile statt langer Erklärtexte: verlinkt auf den passenden Abschnitt von /so-funktionierts */
export function HowLink({ section, children = "Wie das gemessen wird" }: { section: string; children?: React.ReactNode }) {
  return (
    <p className="how-link">
      <Link href={`/so-funktionierts#${section}`}>{children} →</Link>
    </p>
  );
}

/** Legende für die farbigen Uhrzeiten in Ereignis-Listen (auf dem Server / live / beides) */
export function PresenceLegend() {
  return (
    <ul className="presence-legend" aria-label="Farbe der Uhrzeit">
      <li>
        <i data-presence="server" aria-hidden="true" /> auf dem Server
      </li>
      <li>
        <i data-presence="live" aria-hidden="true" /> live
      </li>
      <li>
        <i data-presence="both" aria-hidden="true" /> beides
      </li>
      <li>Uhrzeit anklicken: VOD an dieser Stelle</li>
    </ul>
  );
}
