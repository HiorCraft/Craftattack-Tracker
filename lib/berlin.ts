/** Kalendertage in Berlin (ohne `server-only`, läuft auch im Browser) */
const DAY_FMT = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/** Tag in Berlin als „YYYY-MM-DD“ */
export function berlinDay(ms: number): string {
  return DAY_FMT.format(ms);
}

/** Abstand Berlin zu UTC in Millisekunden zu diesem Zeitpunkt (+1 Std Winter, +2 Std Sommer) */
function offsetMs(ms: number): number {
  const d = new Date(ms);
  const local = Date.parse(d.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const utc = Date.parse(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return local - utc;
}

/** Nächste Mitternacht (Berlin) nach `ms` */
export function nextBerlinMidnight(ms: number): number {
  const start = Date.parse(`${berlinDay(ms)}T00:00:00Z`) + 86_400_000;
  return start - offsetMs(start - 3 * 3600_000);
}

/** Zeitraum [from, to) in Stücke je Berliner Tag zerlegen */
export function splitByBerlinDay(from: number, to: number, each: (day: string, from: number, to: number) => void) {
  let a = from;
  while (a < to) {
    const next = Math.min(to, nextBerlinMidnight(a));
    each(berlinDay(a), a, next);
    a = next;
  }
}
