/**
 * Unscharfe Suche für Spieler, Kennzahlen und Items: findet Treffer auch mit Tippfehlern, fehlenden Buchstaben oder
 * Teilen aus der Mitte („bstig“ → BastiGHG, „palte“ → Papaplatte). Ohne `server-only`, läuft im Browser.
 *
 * Bewertung (höher = besser, 0 = kein Treffer):
 * - exakt > Anfang > Wortanfang > irgendwo enthalten
 * - sonst alle Buchstaben der Suche der Reihe nach (Bonus für zusammenhängende Stücke und Wortanfänge)
 * - sonst bis zu 1–2 Tippfehler (vertauscht, falsch, zu viel, zu wenig) gegen den Anfang eines Worts
 */

/** Kleinbuchstaben, ohne Akzente, ß/ä/ö/ü vereinfacht, Trennzeichen als Leerzeichen */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_\-.]+/g, " ")
    .trim();
}

/** Damerau-Levenshtein-Abstand (mit Vertauschung zweier Nachbarn), früh abgebrochen ab `max` */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Wie gut passt `query` (schon normalisiert) zu `text`? 0 = gar nicht */
function scoreOne(q: string, text: string): number {
  const t = normalize(text);
  if (!q) return 1;
  if (!t) return 0;
  const compact = t.replace(/ /g, "");
  const qc = q.replace(/ /g, "");
  if (t === q || compact === qc) return 1000;
  if (compact.startsWith(qc)) return 900 - Math.min(100, compact.length - qc.length);
  const words = t.split(" ");
  if (words.some((w) => w.startsWith(qc))) return 800 - Math.min(100, compact.length - qc.length);
  const at = compact.indexOf(qc);
  if (at >= 0) return 700 - at * 3 - Math.min(80, compact.length - qc.length);

  // Buchstaben der Reihe nach (Lücken erlaubt)
  let pos = 0;
  let run = 0;
  let score = 0;
  let firstAt = -1;
  for (const ch of qc) {
    const k = compact.indexOf(ch, pos);
    if (k < 0) {
      score = -1;
      break;
    }
    if (firstAt < 0) firstAt = k;
    run = k === pos ? run + 1 : 1;
    score += 2 + run * 3 + (k === 0 ? 6 : 0);
    pos = k + 1;
  }
  // Mindestens drei Zeichen und nicht zu verstreut, sonst passt fast alles
  if (score > 0 && qc.length >= 3 && pos - firstAt <= qc.length * 3) return 300 + score - firstAt;

  // Tippfehler gegen den Anfang des Namens bzw. eines Worts (ab 4 Zeichen 2 Fehler erlaubt)
  if (qc.length >= 3) {
    const max = qc.length >= 6 ? 2 : 1;
    let best = max + 1;
    for (const w of [compact, ...words]) {
      for (const len of [qc.length - 1, qc.length, qc.length + 1]) {
        if (len < 2 || len > w.length) continue;
        best = Math.min(best, editDistance(qc, w.slice(0, len), max));
      }
      if (w.length < qc.length + 2) best = Math.min(best, editDistance(qc, w, max));
    }
    if (best <= max) return 200 - best * 60;
  }
  return 0;
}

/** Bester Wert über alle Texte eines Eintrags (z. B. Anzeigename, ID, Twitch-Login) */
export function fuzzyScore(query: string, texts: (string | null | undefined)[]): number {
  const q = normalize(query);
  let best = 0;
  for (const t of texts) if (t) best = Math.max(best, scoreOne(q, t));
  return best;
}

/**
 * Filtert und sortiert: beste Treffer zuerst, bei Gleichstand nach `tie` (z. B. online zuerst) bzw. Reihenfolge.
 * Ohne Suche bleibt die Liste, wie sie ist (nur `tie`).
 */
export function fuzzyFilter<T>(items: T[], query: string, texts: (item: T) => (string | null | undefined)[], tie?: (a: T, b: T) => number): T[] {
  if (!query.trim()) return tie ? [...items].sort(tie) : items;
  return items
    .map((item) => ({ item, s: fuzzyScore(query, texts(item)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (tie ? tie(a.item, b.item) : 0))
    .map((x) => x.item);
}
