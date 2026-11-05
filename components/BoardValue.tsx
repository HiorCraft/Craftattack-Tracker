import { boardParts } from "@/lib/format";

/** Wert einer Hauptliste; die Einheit (z. B. „Herzen") steht kleiner dahinter, damit Namen in engen Listen Platz behalten. */
export function BoardValue({ k, v }: { k: string; v: number }) {
  const { value, unit } = boardParts(k, v);
  return (
    <>
      {value}
      {unit && <span className="unit"> {unit}</span>}
    </>
  );
}
