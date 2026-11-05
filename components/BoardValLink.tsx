import Link from "next/link";

/**
 * Wert in einer Bestenlisten-Zeile als eigener Link auf den Graphen (Verlauf dieses Werts beim Spieler). Liegt wie der
 * ▲/▼-Pfeil über der Zeile, die selbst zum Profil führt; in der Zeile steht derselbe Wert unsichtbar als Platzhalter.
 */
export function BoardValLink({ href, name, children }: { href: string; name: string; children: React.ReactNode }) {
  return (
    <Link className="st-board__vallink num" href={href} title={`Verlauf von ${name} im Graphen ansehen`}>
      {children}
    </Link>
  );
}
