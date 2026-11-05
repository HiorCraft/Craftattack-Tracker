import { headUrl } from "@/lib/format";

/**
 * Spielerkopf. Der Name erscheint beim Überfahren oder Fokussieren als Tooltip (`HeadTip`, über `data-name`)
 * und für Screenreader als `alt`. Steht der Name ohnehin daneben, `decorative` setzen: dann bleibt `alt` leer.
 */
export function Head({
  id,
  uuid,
  name,
  size = 28,
  src = size,
  className = "head",
  decorative = false,
}: {
  id: string;
  uuid?: string | null;
  name?: string | null;
  /** Anzeigegröße in px */
  size?: number;
  /** Größe des angefragten Bilds, falls abweichend (z. B. scharf auf Retina) */
  src?: number;
  className?: string;
  decorative?: boolean;
}) {
  const label = name || id;
  return (
    <img
      className={className}
      src={headUrl(uuid ?? undefined, src, id)}
      alt={decorative ? "" : label}
      data-name={label}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}
