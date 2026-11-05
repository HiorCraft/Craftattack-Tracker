/**
 * Eine Definition für „auf dem Server“ bei Twitch-Abos, Bits und Einnahmen: Der Verlauf hat kurz davor (höchstens
 * 5 Minuten) einen Punkt, an dem der Streamer online auf CraftAttack und live war.
 *
 * Früher galten Abos und Bits als „auf dem Server“, wenn der Tracker das beim Eingang glaubte. Sperrt craftattack.one
 * den Tracker, bleibt aber der letzte Online-Stand stehen; Abos und Bits zählten dann weiter, die Einnahmen
 * (die schon diese Regel nutzten) nicht. Jetzt zählen alle drei gleich.
 *
 * `player` und `at` sind SQL-Ausdrücke mit Tabellennamen (z. B. `events.player`), sonst greifen sie im
 * Unterabfrage-Bereich auf den Verlauf selbst.
 */
export const ON_SERVER_GAP = "5 minutes";

export const onServerSql = (player: string, at: string) =>
  `EXISTS (SELECT 1 FROM player_history h WHERE h.player = ${player} AND h.at > ${at} - interval '${ON_SERVER_GAP}'
     AND h.at <= ${at} + interval '1 minute' AND h.online AND h.viewers IS NOT NULL)`;
