"use client";

import { useRouter } from "next/navigation";
import { PlayerMulti } from "./PlayerSearch";

export interface FilterPlayer {
  id: string;
  name: string;
  uuid: string;
  online: boolean;
}

/** Spielerauswahl für Filterseiten: mehrere Spieler, die Auswahl landet als `spieler=a,b` in der URL. */
export function PlayerFilter({ players, selected, path, query }: { players: FilterPlayer[]; selected: string[]; path: string; query: Record<string, string | undefined> }) {
  const router = useRouter();
  const href = (ids: string[]) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
    if (ids.length) p.set("spieler", ids.join(","));
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };
  return (
    <PlayerMulti
      players={players}
      selected={selected}
      onAdd={(id) => router.push(href([...selected, id]), { scroll: false })}
      hrefRemove={(id) => href(selected.filter((x) => x !== id))}
      hrefClear={href([])}
    />
  );
}
