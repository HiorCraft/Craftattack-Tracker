/**
 * Erklärung erst auf Klick: kleines „?“, der Text öffnet sich als Kasten darunter (ohne JavaScript, <details>).
 * Statt Absätzen unter Überschriften, die Platz kosten und meist niemand braucht.
 */
export function Explain({ children, label = "Erklärung" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="explain">
      <summary aria-label={label} title={label}>
        ?
      </summary>
      <div className="explain__box">{children}</div>
    </details>
  );
}
