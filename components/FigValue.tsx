/** Kennzahl in einer Kachel; `--len` (Zeichen) steuert per CSS die Schriftgröße: so groß, wie es in die Kachel passt. */
export function FigValue({ children, unit }: { children: string; unit?: string | null }) {
  // Die Einheit (mit Leerzeichen) ist auf 0,7em gesetzt und zählt entsprechend weniger zur Länge
  const len = Math.min(16, Math.max(1, children.length + Math.ceil(((unit ? unit.length + 1 : 0) * 3) / 4)));
  return (
    <dd className="num" data-len={len >= 6 ? String(Math.min(10, len)) : undefined} style={{ "--len": len } as React.CSSProperties}>
      {children}
      {unit && <span className="unit"> {unit}</span>}
    </dd>
  );
}
