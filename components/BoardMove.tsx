import Link from "next/link";

/**
 * ▲/▼ neben einem Listenplatz. Mit `href` ist der Pfeil ein Link auf den Graphen (Spieler und die, die er überholt hat
 * bzw. die ihn überholt haben, im gewählten Vergleichszeitraum). Liegt über der Zeile, die selbst aufs Profil führt.
 */
export function BoardMove({ diff, title, href, newTitle }: { diff: number | null; title: string; href: string | null; newTitle: string }) {
  if (diff === 0) return null;
  const cls = diff === null ? "st-board__mv st-board__mv--new" : diff > 0 ? "st-board__mv st-board__mv--up num" : "st-board__mv st-board__mv--down num";
  const text = diff === null ? "neu" : diff > 0 ? `▲${diff}` : `▼${-diff}`;
  const label = diff === null ? newTitle : title;
  return href ? (
    <Link className={`${cls} st-board__mvlink`} href={href} title={`${label} · Verlauf im Graphen ansehen`}>
      {text}
    </Link>
  ) : (
    <span className={`${cls} st-board__mvlink`} title={label}>
      {text}
    </span>
  );
}
