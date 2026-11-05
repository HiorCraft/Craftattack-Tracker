/** Alle Tage von `from` bis `to` (einschließlich), YYYY-MM-DD */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T12:00:00Z`), end = Date.parse(`${to}T12:00:00Z`); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
