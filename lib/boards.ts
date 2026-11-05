import type { BoardKey } from "./types";
import { BOARD_TONE, type Tone } from "./statTone";

/**
 * Titel, Untertitel und Farbton der neun Hauptlisten, wie auf https://craftattack.one/stats/.
 * Der Farbton kommt aus `BOARD_TONE`, damit jede Kennzahl überall gleich aussieht.
 */
export const BOARD_STYLE: Record<BoardKey, { title: string; sub: string; tone: Tone }> = {
  playtimeSeconds: { title: "Dauerzocker", sub: "Meiste Spielzeit", tone: BOARD_TONE.playtimeSeconds },
  diamonds: { title: "Diamantenbank", sub: "Wer hat, der hat", tone: BOARD_TONE.diamonds },
  deaths: { title: "Friedhof", sub: "Hier liegen sie. Immer wieder.", tone: BOARD_TONE.deaths },
  blocksBroken: { title: "Abrissbirne", sub: "Meiste Blöcke abgebaut", tone: BOARD_TONE.blocksBroken },
  mobsKilled: { title: "Monsterjäger", sub: "Meiste Mobs erledigt", tone: BOARD_TONE.mobsKilled },
  distance: { title: "Weltenbummler", sub: "Weiteste Strecke", tone: BOARD_TONE.distance },
  totemsUsed: { title: "Unsterblich", sub: "Meiste Totems verbraucht", tone: BOARD_TONE.totemsUsed },
  damageDealt: { title: "Kampfmaschine", sub: "Meisten Schaden ausgeteilt", tone: BOARD_TONE.damageDealt },
  foodEaten: { title: "Vielfraß", sub: "Meiste Mahlzeiten verdrückt", tone: BOARD_TONE.foodEaten },
};

/** Reihenfolge wie auf craftattack.one/stats */
export const BOARD_ORDER: BoardKey[] = ["playtimeSeconds", "diamonds", "deaths", "blocksBroken", "mobsKilled", "distance", "totemsUsed", "damageDealt", "foodEaten"];
