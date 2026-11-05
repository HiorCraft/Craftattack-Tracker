import "server-only";
import { getDailyNetwork, getNetwork, NETWORK_RANGES } from "./connections";
import { getFlows, SNAPSHOT_MS } from "./viewerMigration";
import { snapshot } from "./snapshots";
import { AFK_SNAPSHOT, AFK_SNAPSHOT_MS, computeAllAfkSpans } from "./analytics";
import { BOARD_TOTALS_MS, BOARD_TOTALS_SNAPSHOT, computeBoardTotals } from "./store";

/**
 * Im Tracker: teure Auswertungen regelmäßig vorberechnen und ablegen (lib/snapshots.ts). Nacheinander, mit Pausen,
 * damit Poller und Twitch-Chat dazwischen zum Zug kommen. Die Getter rechnen nur, wenn ihr Ergebnis älter als
 * SNAPSHOT_MS ist.
 */
const JOBS: [string, () => Promise<unknown>][] = [
  ["Zuschauerwanderung", () => getFlows()],
  ...NETWORK_RANGES.map((r): [string, () => Promise<unknown>] => [`Netz ${r.label}`, () => getNetwork(r.hours)]),
  ["Netz je Tag", () => getDailyNetwork()],
  ["AFK-Phasen", () => snapshot(AFK_SNAPSHOT, computeAllAfkSpans, AFK_SNAPSHOT_MS)],
  ["Summen-Kurven", () => snapshot(BOARD_TOTALS_SNAPSHOT, computeBoardTotals, BOARD_TOTALS_MS)],
];

let started = false;

export function startSnapshotJobs() {
  if (started) return;
  started = true;
  const run = async () => {
    for (const [name, job] of JOBS) {
      const t0 = Date.now();
      try {
        await job();
        const ms = Date.now() - t0;
        if (ms > 500) console.log(`[snapshot] ${name} in ${ms} ms`);
      } catch (e) {
        console.error(`[snapshot] ${name} fehlgeschlagen:`, e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };
  // Erster Lauf kurz nach dem Start, dann im Takt
  setTimeout(() => {
    void run();
    setInterval(() => void run(), SNAPSHOT_MS / 2).unref();
  }, 30_000).unref();
}
