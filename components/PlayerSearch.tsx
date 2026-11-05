"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Head } from "./Head";
import { fuzzyFilter } from "@/lib/fuzzy";

export interface PickPlayer {
  id: string;
  name: string;
  uuid?: string;
  online?: boolean;
  /** Weitere Suchbegriffe (z. B. Twitch-Login) */
  alias?: string | null;
}

/**
 * Spielerauswahl überall im Stil der Graph-Seite: Gewähltes als Kopf-Chip, daneben ein Suchfeld; beim Tippen
 * (oder Anklicken) erscheinen passende Spieler als Chips direkt darunter, nicht als Ausklappliste.
 * Pfeiltasten wählen, Enter übernimmt, Escape schließt.
 */
function useSuggest(players: PickPlayer[], exclude: string[] | undefined, rank: ((a: PickPlayer, b: PickPlayer) => number) | undefined, limit: number) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const skip = new Set(exclude ?? []);
    return fuzzyFilter(
      skip.size ? players.filter((p) => !skip.has(p.id)) : players,
      query,
      (p) => [p.name, p.id, p.alias],
      rank ?? ((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)) || a.name.localeCompare(b.name, "de")),
    ).slice(0, limit);
  }, [players, query, limit, exclude, rank]);
  return { query, setQuery, results };
}

function SuggestField({
  label,
  placeholder,
  players,
  exclude,
  rank,
  limit,
  extra,
  current,
  disabled,
  onPick,
  onOpenChange,
}: {
  label: string;
  placeholder: string;
  players: PickPlayer[];
  exclude?: string[];
  rank?: (a: PickPlayer, b: PickPlayer) => number;
  limit: number;
  /** Zusätzlicher Eintrag vor den Spielern (z. B. „Niemand“), nur ohne Suchbegriff */
  extra?: { id: string; label: string };
  current?: string;
  disabled?: boolean;
  onPick: (id: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { query, setQuery, results } = useSuggest(players, exclude, rank, limit);
  const [open, setOpenState] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  const options: { id: string; label: string; p?: PickPlayer }[] = [...(extra && !query ? [extra] : []), ...results.map((p) => ({ id: p.id, label: p.name, p }))];
  const pick = (id: string) => {
    onPick(id);
    setQuery("");
    setOpen(false);
    input.current?.blur();
  };
  return (
    <div className="pick__field">
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        value={query}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            if (e.key === "ArrowRight" && input.current && input.current.selectionStart !== query.length) return;
            e.preventDefault();
            setActive((a) => Math.min(options.length - 1, a + 1));
          } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            if (e.key === "ArrowLeft" && query) return;
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (options[active]) pick(options[active].id);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      {open && (
        <ul className="gb__chips gb__suggest pick__list" id={listId} role="listbox" aria-label={`${label}: Vorschläge`}>
          {options.map((o, i) => (
            <li key={o.id || "_empty"} role="presentation">
              <button
                type="button"
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                data-current={o.id === current || undefined}
                className="gb__chip"
                data-tone={i === active ? "gold" : "white"}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.id)}
              >
                {o.p && <Head id={o.p.id} uuid={o.p.uuid} name={o.p.name} size={20} src={32} decorative />}
                {o.label}
                {o.p?.online && <span className="dot" title="online" />}
              </button>
            </li>
          ))}
          {options.length === 0 && <li className="muted">Niemand gefunden.</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Ein Spieler. Gesteuert (`value` + `onChange`) oder als Formularfeld (`name` + `defaultValue`, optional sofort
 * absenden). `empty` ist der Eintrag für „keiner/alle“ mit eigenem Wert (Standard "").
 */
export function PlayerSearch({
  players,
  value,
  defaultValue,
  onChange,
  name,
  label,
  placeholder,
  empty,
  submitOnPick = false,
  limit = 12,
}: {
  players: PickPlayer[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  name?: string;
  label: string;
  placeholder?: string;
  empty?: { label: string; value?: string };
  submitOnPick?: boolean;
  limit?: number;
}) {
  const [own, setOwn] = useState(defaultValue ?? empty?.value ?? "");
  const current = value ?? own;
  const box = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const emptyValue = empty?.value ?? "";
  const selected = byId.get(current);
  const pick = (id: string) => {
    if (value === undefined) setOwn(id);
    onChange?.(id);
    if (submitOnPick) {
      const form = box.current?.closest("form");
      // Erst nach dem Rendern, damit das versteckte Feld schon den neuen Wert hat
      if (form) setTimeout(() => form.requestSubmit(), 0);
    }
  };
  return (
    <div className="pick" ref={box}>
      {name && <input type="hidden" name={name} value={current} />}
      {selected ? (
        <span className="gb__chip gb__chip--head" data-tone="ink">
          <Head id={selected.id} uuid={selected.uuid} name={selected.name} size={20} src={32} decorative />
          {selected.name}
          {empty && (
            <button type="button" className="pick__x" onClick={() => pick(emptyValue)} aria-label={`${selected.name} abwählen`}>
              ×
            </button>
          )}
        </span>
      ) : (
        empty && (
          <span className="gb__chip" data-tone="white">
            {empty.label}
          </span>
        )
      )}
      <SuggestField
        label={label}
        placeholder={placeholder ?? (selected ? "Anderen suchen …" : "Spieler suchen …")}
        players={players}
        exclude={selected ? [selected.id] : undefined}
        limit={limit}
        extra={empty && current !== emptyValue ? { id: emptyValue, label: empty.label } : undefined}
        current={current}
        onPick={pick}
      />
    </div>
  );
}

/**
 * Mehrere Spieler: gewählte als Kopf-Chips (× entfernt), dahinter dieselbe Suche. Überall gleich, ob die Auswahl
 * in der Adresse landet (Ereignisse) oder im Zustand (Graph).
 */
export function PlayerMulti({
  players,
  selected,
  onAdd,
  onRemove,
  onClear,
  hrefRemove,
  hrefClear,
  label = "Spieler",
  max,
  allLabel,
  allHint,
  rank,
  onOpenChange,
}: {
  players: PickPlayer[];
  selected: string[];
  onAdd: (id: string) => void;
  onRemove?: (id: string) => void;
  onClear?: () => void;
  /** Statt `onRemove`/`onClear`: Links (Auswahl in der Adresse) */
  hrefRemove?: (id: string) => string;
  hrefClear?: string;
  label?: string;
  max?: number;
  /** Eintrag „keiner gewählt“ (z. B. „Alle“), aktiv solange nichts gewählt ist */
  allLabel?: string;
  allHint?: string;
  rank?: (a: PickPlayer, b: PickPlayer) => number;
  onOpenChange?: (open: boolean) => void;
}) {
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const full = max !== undefined && selected.length >= max;
  const chip = (id: string) => {
    const p = byId.get(id);
    const inner = (
      <>
        <Head id={id} uuid={p?.uuid} name={p?.name ?? id} size={20} src={32} decorative />
        {p?.name ?? id} <span aria-hidden="true">×</span>
      </>
    );
    return hrefRemove ? (
      <Link className="gb__chip gb__chip--head" data-tone="ink" href={hrefRemove(id)} scroll={false} aria-label={`${p?.name ?? id} entfernen`}>
        {inner}
      </Link>
    ) : (
      <button type="button" className="gb__chip gb__chip--head" data-tone="ink" onClick={() => onRemove?.(id)} aria-label={`${p?.name ?? id} entfernen`}>
        {inner}
      </button>
    );
  };
  const clear = (text: string, active: boolean) =>
    hrefClear !== undefined ? (
      <Link className="gb__chip" data-tone={active ? "ink" : "white"} href={hrefClear} scroll={false} aria-pressed={active} title={allHint}>
        {text}
      </Link>
    ) : (
      <button type="button" className="gb__chip" data-tone={active ? "ink" : "white"} onClick={() => onClear?.()} aria-pressed={active} title={allHint}>
        {text}
      </button>
    );
  return (
    <div className="pick">
      {(selected.length > 0 || allLabel) && (
        <ul className="pick__chips" aria-label={`${label}: Auswahl`}>
          {allLabel && <li>{clear(allLabel, selected.length === 0)}</li>}
          {selected.map((id) => (
            <li key={id}>{chip(id)}</li>
          ))}
          {!allLabel && selected.length > 1 && <li>{clear("Alle entfernen", false)}</li>}
        </ul>
      )}
      <SuggestField
        label={`${label} hinzufügen`}
        placeholder={full ? `Höchstens ${max}` : selected.length ? "+ Spieler" : "Spieler suchen …"}
        players={players}
        exclude={selected}
        rank={rank}
        limit={12}
        disabled={full}
        onPick={(id) => id && onAdd(id)}
        onOpenChange={onOpenChange}
      />
    </div>
  );
}
