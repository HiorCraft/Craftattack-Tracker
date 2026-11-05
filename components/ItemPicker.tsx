"use client";

import Link from "next/link";
import { fuzzyFilter } from "@/lib/fuzzy";
import { useState } from "react";
import { TOP_CATEGORIES, topCategoryLabel, type ItemOptions, type TopCategory } from "@/lib/leaderboards";

/** So viele Items zeigt die Auswahl ohne Suche (die häufigsten zuerst) */
const SHOWN = 24;

/**
 * Auswahl einzelner Blöcke, Mobs und Tiere ohne endlose Liste: Kategorie wählen, häufigste Items als Chips,
 * alles andere über die Suche. Mit `hrefPrefix` sind die Chips Links (Bestenlisten), mit `onPick` Schalter (Graph).
 */
export function ItemPicker({
  options,
  selected = [],
  hrefPrefix,
  onPick,
  initialCategory,
}: {
  options: ItemOptions;
  /** Gewählte Items als `<Kategorie>|<Key>` */
  selected?: string[];
  /** Chips als Links: `<hrefPrefix><Kategorie>|<Key>` (URL-kodiert) – Funktionen kann eine Server-Seite nicht übergeben */
  hrefPrefix?: string;
  onPick?: (category: TopCategory, key: string) => void;
  initialCategory?: TopCategory;
}) {
  const [category, setCategory] = useState<TopCategory>(initialCategory ?? TOP_CATEGORIES[0]);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const all = options[category] ?? [];
  const items = needle ? fuzzyFilter(all, needle, (o) => [o.name, o.key]).slice(0, 60) : all.slice(0, SHOWN);

  return (
    <div className="itempick">
      <div className="itempick__bar">
        <div className="gb__seg" role="group" aria-label="Kategorie">
          {TOP_CATEGORIES.map((c) => (
            <button key={c} type="button" aria-pressed={c === category} onClick={() => setCategory(c)}>
              {topCategoryLabel(c).replace(/^Meist/, "")}
            </button>
          ))}
        </div>
        <input type="search" placeholder={`${all.length} durchsuchen …`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Item suchen" />
      </div>
      <ul className="gb__chips itempick__list" aria-label={topCategoryLabel(category)}>
        {items.map((o) => {
          const on = selected.includes(`${category}|${o.key}`);
          const content = (
            <>
              {o.name} <span className="muted num">{o.players}</span>
            </>
          );
          return (
            <li key={o.key}>
              {hrefPrefix ? (
                <Link className="gb__chip" data-tone={on ? "ink" : "white"} href={`${hrefPrefix}${encodeURIComponent(`${category}|${o.key}`)}`} aria-current={on ? "true" : undefined} title={`${o.players} Spieler haben es in den Top 10`}>
                  {content}
                </Link>
              ) : (
                <button type="button" className="gb__chip" data-tone={on ? "ink" : "white"} aria-pressed={on} onClick={() => onPick?.(category, o.key)} title={`${o.players} Spieler haben es in den Top 10`}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
        {items.length === 0 && <li className="muted">Nichts gefunden.</li>}
        {!needle && all.length > SHOWN && <li className="muted itempick__more">+ {all.length - SHOWN} weitere über die Suche</li>}
      </ul>
    </div>
  );
}
