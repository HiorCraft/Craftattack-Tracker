import "server-only";
import { getDb } from "./db";
import { createSwrCache } from "./swrCache";
import { ADVANCEMENTS, ADV_BY_ID } from "./advancements";
import type { PlayerState } from "./types";

/**
 * Fortschritte je Spieler. Sicher ist nur, was der Feed von craftattack.one gemeldet hat (seit dem 10. Okt., und nur,
 * was der Tracker mitbekam). Vieles fehlt; deshalb wird zusätzlich vermutet:
 * - aus dem Baum: Wer einen Fortschritt hat, hat sehr wahrscheinlich auch die davor (Netheritrüstung → im Nether),
 * - aus Statistiken und Top-Listen: Diamanten abgebaut, Totem benutzt, gehandelt, Netherrack abgebaut, …
 * Vermutungen sind als solche gekennzeichnet und haben einen Grund.
 */

export interface AdvStatus {
  /** ms: wann erzielt (laut Feed) */
  at?: number;
  /** Grund der Vermutung, wenn nicht gemeldet */
  guess?: string;
}

export interface AdvancementBoard {
  /** id → Status für diesen Spieler */
  mine: Record<string, AdvStatus>;
  /** id → [gemeldet, nur vermutet] über alle Spieler */
  others: Record<string, [number, number]>;
  players: number;
}

const swr = createSwrCache();

/** Gemeldete Fortschritte aller Spieler: Spieler → id → frühester Zeitpunkt */
function loadReported(): Promise<Map<string, Map<string, number>>> {
  return swr("advancements", 5 * 60_000, async () => {
    const db = await getDb();
    const r = await db.query<{ player: string; adv: string; at: Date }>(
      `SELECT player, meta->>'advancement' AS adv, min(at) AS at FROM events
        WHERE type = 'achievement' AND player IS NOT NULL AND meta->>'advancement' IS NOT NULL GROUP BY 1, 2`,
    );
    const out = new Map<string, Map<string, number>>();
    for (const row of r.rows) (out.get(row.player) ?? out.set(row.player, new Map()).get(row.player)!).set(row.adv, row.at.getTime());
    return out;
  });
}

const has = (tops: { key: string }[] | undefined, keys: string[]) => (tops ?? []).some((t) => keys.includes(t.key));

/** Vermutungen aus Statistiken und Top-Listen (nur, was sehr wahrscheinlich ist) */
function fromStats(p: PlayerState): [string, string][] {
  const s = { ...(p.stats ?? {}), ...((p.detail?.stats as Record<string, number> | undefined) ?? {}) } as Record<string, number>;
  const tops = p.detail?.tops ?? {};
  const out: [string, string][] = [];
  const add = (id: string, why: string) => out.push([`minecraft:${id}`, why]);
  if ((s.blocksBroken ?? 0) > 0) add("story/mine_stone", "hat Blöcke abgebaut");
  if ((s.diamonds ?? 0) > 0) add("story/mine_diamond", "hat Diamanten abgebaut");
  if ((s.totemsUsed ?? 0) > 0) add("adventure/totem_of_undying", "hat ein Totem benutzt");
  if ((s.mobsKilled ?? 0) > 0) add("adventure/kill_a_mob", "hat Monster getötet");
  if ((s.tradedWithVillagers ?? 0) > 0) add("adventure/trade", "hat mit Dorfbewohnern gehandelt");
  if ((s.itemsEnchanted ?? 0) > 0) add("story/enchant_item", "hat Gegenstände verzaubert");
  if ((s.animalsBred ?? 0) > 0) add("husbandry/breed_an_animal", "hat Tiere gezüchtet");
  if ((s.fishCaught ?? 0) > 0) add("husbandry/fishy_business", "hat Fische gefangen");
  if ((s.raidsWon ?? 0) > 0) add("adventure/hero_of_the_village", "hat einen Überfall gewonnen");
  if ((s.foodEaten ?? 0) > 0) add("husbandry/root", "hat gegessen");
  const broken = tops.blocksBroken;
  const placed = tops.blocksPlaced;
  const mobs = tops.mobsKilled;
  if (has(broken, ["netherrack", "basalt", "blackstone", "soul_sand", "soul_soil", "nether_quartz_ore", "crimson_stem", "warped_stem"]) || has(placed, ["netherrack"]))
    add("story/enter_the_nether", "hat Nether-Blöcke abgebaut");
  if (has(broken, ["ancient_debris"])) add("nether/obtain_ancient_debris", "hat antiken Schutt abgebaut");
  if (has(broken, ["end_stone", "purpur_block", "chorus_plant"])) add("story/enter_the_end", "hat Endstein abgebaut");
  if (has(mobs, ["wither_skeleton", "blaze"])) add("nether/find_fortress", "hat Wither-Skelette oder Lohen getötet");
  if (has(mobs, ["shulker"])) add("end/find_end_city", "hat Shulker getötet");
  if (has(mobs, ["piglin_brute"])) add("nether/find_bastion", "hat Piglin-Barbaren getötet");
  if (has(mobs, ["warden"])) add("adventure/kill_a_mob", "hat einen Wärter getötet");
  return out;
}

/** Status aller Fortschritte für einen Spieler */
function statusOf(p: PlayerState | undefined, reported: Map<string, number> | undefined): Record<string, AdvStatus> {
  const st: Record<string, AdvStatus> = {};
  for (const [id, at] of reported ?? []) if (ADV_BY_ID.has(id)) st[id] = { at };
  if (p) for (const [id, why] of fromStats(p)) if (ADV_BY_ID.has(id) && !st[id]) st[id] = { guess: why };
  // Baum: Vorgänger von allem, was er hat (gemeldet oder vermutet), sind vermutlich auch erreicht
  for (const id of Object.keys(st)) {
    let parent = ADV_BY_ID.get(id)?.parent ?? null;
    const child = ADV_BY_ID.get(id)!;
    while (parent) {
      if (!st[parent]) st[parent] = { guess: `kommt vor „${child.title}“` };
      parent = ADV_BY_ID.get(parent)?.parent ?? null;
    }
  }
  return st;
}

export async function getAdvancementBoard(id: string, players: Record<string, PlayerState>): Promise<AdvancementBoard> {
  const reported = await loadReported();
  const others: Record<string, [number, number]> = Object.fromEntries(ADVANCEMENTS.map((a) => [a.id, [0, 0]]));
  let count = 0;
  for (const p of Object.values(players)) {
    const st = statusOf(p, reported.get(p.id));
    if (!Object.keys(st).length) continue;
    count++;
    for (const [aid, s] of Object.entries(st)) if (others[aid]) others[aid][s.at ? 0 : 1]++;
  }
  return { mine: statusOf(players[id], reported.get(id)), others, players: count };
}
