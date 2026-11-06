import Link from "next/link";
import { TRAITS, type TraitHit, type TraitKey } from "@/lib/rhythmCore";

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Abzeichen eines Spielertyps; Erklärung und Deutlichkeit im Tooltip */
export function TraitBadge({ k, score, href }: { k: TraitKey; score?: number; href?: string }) {
  const t = TRAITS[k];
  const title = `${t.hint}${score !== undefined ? ` · auffälliger als ${pct(score)} der Spieler` : ""}`;
  const style = { "--tone": `var(${t.tone})` } as React.CSSProperties;
  return href ? (
    <Link className="rh-badge" style={style} href={href} title={title}>
      {t.label}
    </Link>
  ) : (
    <span className="rh-badge" style={style} title={title}>
      {t.label}
    </span>
  );
}

export function TraitBadges({ traits, max = 3, hrefOf }: { traits: TraitHit[]; max?: number; hrefOf?: (k: TraitKey) => string }) {
  if (!traits.length)
    return (
      <span className="rh-badge" data-plain title="Kein Merkmal sticht heraus">
        Ausgeglichen
      </span>
    );
  return (
    <span className="rh-badges">
      {traits.slice(0, max).map((t) => (
        <TraitBadge key={t.key} k={t.key} score={t.score} href={hrefOf?.(t.key)} />
      ))}
    </span>
  );
}

/** Tagesprofil: Online-Zeit je Stunde (0–23 Uhr) als 24 kleine Balken, Nacht leicht hinterlegt */
export function HourBars({ hours, label }: { hours: number[]; label: string }) {
  const max = Math.max(1, ...hours);
  return (
    <svg className="rh-hours" viewBox="0 0 96 24" preserveAspectRatio="none" role="img" aria-label={label}>
      <rect x="0" y="0" width="24" height="24" className="rh-hours__night" />
      {hours.map((v, h) => {
        const hgt = v > 0 ? Math.max(1.5, (v / max) * 22) : 0;
        return <rect key={h} x={h * 4 + 0.5} y={24 - hgt} width="3" height={hgt} className="rh-hours__bar" />;
      })}
    </svg>
  );
}

/** Uhrzeit aus Dezimalstunden, z. B. 19.5 → „19:30“ */
export const clock = (h: number) => {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
