import Link from "next/link";
import type { Metadata } from "next";
import { EstimateExplainer } from "@/components/Estimates";
import { ESTIMATE } from "@/lib/estimateMode";

export const metadata: Metadata = { title: "So funktioniert’s" };

/** Abschnitte der Seite; der Schlüssel ist der Anker, auf den andere Seiten verlinken (/so-funktionierts#…) */
const SECTIONS = [
  { id: "quellen", title: "Woher die Daten kommen" },
  { id: "ereignisse", title: "Ereignisse" },
  { id: "afk", title: "AFK und Farmen" },
  { id: "bestenlisten", title: "Bestenlisten" },
  { id: "profil", title: "Spielerprofil" },
  { id: "twitch", title: "Twitch" },
  { id: "zeitstrahl", title: "Zeitstrahl und Statistik" },
  { id: "grenzen", title: "Grenzen" },
] as const;

/** Erklärt, woher die Zahlen kommen und wie sie berechnet werden – statt langer Texte auf jeder Seite. */
export default function HowItWorks() {
  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Hinter den Zahlen</p>
          <h1 className="t-1">So funktioniert’s</h1>
          <p>Woher der Tracker seine Daten hat, wie oft er fragt und wie daraus Ereignisse, Bestenlisten und Graphen werden.</p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <div className="how">
          <nav aria-label="Inhalt">
            <ul className="filters">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <a className="tag" data-tone="white" href={`#${s.id}`}>
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {ESTIMATE && <EstimateExplainer />}

          <section className="box how__section" data-tone="white" id="quellen" aria-labelledby="quellen-h">
            <h2 className="t-3" id="quellen-h">
              Woher die Daten kommen
            </h2>
            <dl className="how__facts">
              <dt>Server-Stand</dt>
              <dd>
                <a href="https://craftattack.one/api/stats" target="_blank" rel="noopener">
                  craftattack.one/api/stats
                </a>{" "}
                in zufälligen Abständen von 45 bis 75 Sekunden: wer online ist, wer live ist, die offiziellen Top 10 und die Server-Summen.
              </dd>
              <dt>Spielerprofile</dt>
              <dd>
                <code>/api/player/&lt;id&gt;</code> für alle, die gerade online sind oder es beim vorigen Abruf waren: alle Werte mit Rang unter allen Teilnehmenden,
                die eigenen Top 10 an Blöcken, Mobs und Tieren und die letzten Erfolge und Tode. Höchstens 80 Profile pro Abruf mit mindestens einer halben Sekunde
                Abstand; offline ändert sich nichts, deshalb wird dann nicht gefragt.
              </dd>
              <dt>Feed</dt>
              <dd>
                <code>/api/feed</code>: die letzten zehn Erfolge und Tode des ganzen Servers. Was dort zwischen zwei Abrufen herausrutscht, kommt über die
                Spielerprofile trotzdem an.
              </dd>
              <dt>Events</dt>
              <dd>
                Die offiziellen Termine von{" "}
                <a href="https://craftattack.one/events/" target="_blank" rel="noopener">
                  craftattack.one/events
                </a>
                , stündlich abgeglichen, samt Teilnehmern.
              </dd>
              <dt>Twitch</dt>
              <dd>Live-Status, Zuschauer, Follower und VODs über die Twitch-API, Chat und Abos über den Twitch-Chat (siehe <a href="#twitch">Twitch</a>).</dd>
            </dl>
            <p className="how__note">
              Sperrt Cloudflare den Zugriff (Challenge, HTTP 403/429), pausiert der Tracker mindestens fünf Minuten und verlängert die Pause bei wiederholten Sperren
              bis auf sechs Stunden. Er versucht nie, Schutzmaßnahmen zu umgehen.
            </p>
          </section>

          <section className="box how__section" data-tone="white" id="ereignisse" aria-labelledby="ereignisse-h">
            <h2 className="t-3" id="ereignisse-h">
              Ereignisse
            </h2>
            <p>Bei jedem Abruf vergleicht der Tracker den neuen Stand mit dem alten. Jede Änderung wird ein Ereignis mit Zeitstempel.</p>
            <dl className="how__facts">
              <dt>Join, Leave</dt>
              <dd>Aus der Online-Liste, mit Dauer der Session. „Neu“ heißt: der Spieler taucht zum ersten Mal auf, seit der Tracker läuft.</dd>
              <dt>Zähler</dt>
              <dd>Diamanten, Blöcke, Mobs, Strecke, Schaden, Totems, Essen: Anstieg in den Top 10 oder im Spielerprofil. Kleine Schritte bei Essen und Schaden werden ausgeblendet.</dd>
              <dt>Tode</dt>
              <dd>
                Gezählt über den Todeszähler. Nachricht und Mörder kommen aus Feed und Spielerprofil. Ein Tod, den keinem Spieler zugeordnet werden kann, wartet zehn
                Minuten auf die Einzelstatistik; war in der Zeit genau ein Spieler ohne Profil online, bekommt er ihn per Ausschluss.
              </dd>
              <dt>Erfolge</dt>
              <dd>Aus Feed und Spielerprofilen, auch rückwirkend aus der Zeit vor dem Tracker-Start.</dd>
              <dt>Highlights</dt>
              <dd>Meilensteine (z. B. 64 Diamanten, 10.000 Blöcke), Aufstieg in die Top 3 einer Liste und neue Rekorde (Spieler online, Streams live, Zuschauer).</dd>
            </dl>
          </section>

          <section className="box how__section" data-tone="white" id="afk" aria-labelledby="afk-h">
            <h2 className="t-3" id="afk-h">
              AFK und Farmen
            </h2>
            <p>
              AFK-Zeiten kommen vom Server: Er zählt einen Spieler nach 5 Minuten ohne Bewegung als AFK, rechnet diese 5 Minuten rückwirkend dazu und hält
              solange die Spielzeit an. Der Tracker liest diesen Zähler jede Minute und leitet daraus die AFK-Phasen ab. Nur wo er fehlt (Abfrage
              fehlgeschlagen, ältere Daten), schätzt der Tracker selbst: online, aber die gelaufene Strecke steigt 5 Minuten nicht – gegen den Server-Zähler
              abgeglichen trifft das rund 97 % der AFK-Zeit. Sterben während AFK trotzdem mindestens zehn Mobs oder fallen zehn Blöcke pro Minute, ist dieser
              Teil eine AFK-Farm; sinkt die Rate darunter, ist es wieder normales AFK.
            </p>
          </section>

          <section className="box how__section" data-tone="white" id="bestenlisten" aria-labelledby="bestenlisten-h">
            <h2 className="t-3" id="bestenlisten-h">
              Bestenlisten
            </h2>
            <dl className="how__facts">
              <dt>Hauptlisten</dt>
              <dd>
                Die API zeigt nur zehn Namen pro Liste. Der Tracker merkt sich jeden, der dort oder in einem Profil je aufgetaucht ist, mit seinem letzten bekannten Wert –
                der echte Wert kann inzwischen höher sein.
              </dd>
              <dt>Dauerzocker</dt>
              <dd>Außerhalb der Top 10 „geschätzt“ (letzter API-Wert plus seitdem gemessene Online-Zeit) oder „Tracker“ (seit Tracker-Start gemessene Online-Zeit).</dd>
              <dt>Vom Tracker gemessen</dt>
              <dd>„Dauergäste“ (Online-Zeit), „Standbilder“ (AFK) und die AFK-Farmer – für alle Spieler, seit Tracker-Start.</dd>
              <dt>Weitere Werte</dt>
              <dd>Sprünge, platzierte Blöcke, Handel und alles Weitere aus den Spielerprofilen, für jeden Spieler, den der Tracker schon abgefragt hat.</dd>
              <dt>Einzeln</dt>
              <dd>Einzelne Blöcke, Mobs und Tiere aus den eigenen Top 10 der Spieler – wer etwas nicht in seinen Top 10 hat, fehlt in dieser Liste.</dd>
              <dt>Vielfalt</dt>
              <dd>Gesamtwert ohne die eigenen Top 10: wer viel Verschiedenes abbaut, baut oder erledigt.</dd>
              <dt>▲▼</dt>
              <dd>Bewegung gegenüber dem gewählten Zeitpunkt, berechnet aus dem gespeicherten Verlauf. „neu“ heißt: damals noch nicht in der Liste.</dd>
            </dl>
          </section>

          <section className="box how__section" data-tone="white" id="profil" aria-labelledby="profil-h">
            <h2 className="t-3" id="profil-h">
              Spielerprofil
            </h2>
            <dl className="how__facts">
              <dt>Werte und Ränge</dt>
              <dd>
                Aus dem Spielerprofil der API: solange der Spieler online ist, jede Minute neu, sonst höchstens alle 15 Minuten. „Platz“ und #-Zahlen sind der Rang
                laut API unter allen Teilnehmenden (Gold: Top 3); ein Klick öffnet die Bestenliste. Schaden steht in Herzen (Rohwert ÷ 20).
              </dd>
              <dt>Verlauf</dt>
              <dd>Hauptwerte bei jedem Abruf, weitere Werte alle fünf Minuten, die Top-Listen bei jeder Änderung. Der Rang-Verlauf wird alle 30 Minuten neu berechnet.</dd>
              <dt>Pro Online-Stunde</dt>
              <dd>Zuwachs seit Tracker-Start geteilt durch die gemessene Online-Zeit, daneben der Durchschnitt des Servers.</dd>
              <dt>Tageshighlights</dt>
              <dd>
                Die Momente, die der Spieler selbst erzählen würde: schwere Erfolge, andere Spieler erledigt oder von ihnen erledigt, Führung in einer Liste, Rekorde,
                große Diamantenfunde, Raids. Normale Zähler sind nie Highlights, sie stehen in der Tagesbilanz.
              </dd>
            </dl>
          </section>

          <section className="box how__section" data-tone="white" id="twitch" aria-labelledby="twitch-h">
            <h2 className="t-3" id="twitch-h">
              Twitch
            </h2>
            <dl className="how__facts">
              <dt>Live</dt>
              <dd>Live-Status und Zuschauer aller bekannten Kanäle direkt von Twitch. Startet ein Stream neu, während der Tracker nicht hinsieht, erkennt er es am neuen Startzeitpunkt.</dd>
              <dt>Fanmagnet</dt>
              <dd>Neue Follower zählen nur zwischen zwei aufeinanderfolgenden Messungen (jede Minute), bei denen der Streamer auf dem Server war. Mehr als 20 pro Minute werden ein Ereignis.</dd>
              <dt>Subs</dt>
              <dd>Aus dem Twitch-Chat, nur wenn der Streamer beim Eingang auf dem Server online war (AFK zählt mit), seit Beginn der Chat-Erfassung.</dd>
              <dt>Chat</dt>
              <dd>Nachrichten eines Spielers im Chat eines anderen, höchstens die letzten 10.000. Im geteilten Chat (Stream Together) zählt jede Nachricht einmal.</dd>
              <dt>VODs</dt>
              <dd>Tode, Streams und Chat-Nachrichten während eines Streams verlinken die Stelle im VOD – sobald Twitch das VOD kennt.</dd>
            </dl>
          </section>

          <section className="box how__section" data-tone="white" id="zeitstrahl" aria-labelledby="zeitstrahl-h">
            <h2 className="t-3" id="zeitstrahl-h">
              Zeitstrahl und Statistik
            </h2>
            <p>
              Sessions entstehen aus den Join- und Leave-Ereignissen, Streams aus Stream-an und Stream-aus. Hellblau heißt auf dem Server, grau AFK, grün AFK an einer
              Mob-Farm, gelb AFK beim Blöcke-Abbau, lila live auf Twitch. Server-Summen in der Statistik zählen jeden Spieler mit seinem letzten bekannten Stand,
              deshalb kann eine Kurve springen, wenn neue Spieler dazukommen. Fehlen Daten, weil der Tracker nicht lief, bleibt der Graph dort leer. Rekorde
              „am Stück“ heißen: innerhalb eines Abfrage-Intervalls (etwa eine Minute).
            </p>
          </section>

          <section className="box how__section" data-tone="white" id="grenzen" aria-labelledby="grenzen-h">
            <h2 className="t-3" id="grenzen-h">
              Grenzen
            </h2>
            <p>
              Inoffiziell und ohne Gewähr. Koordinaten liefert die API nicht, „wo“ heißt also nur Server oder Twitch. Alles, was zwischen zwei Abrufen passiert und
              sich wieder aufhebt, bleibt unsichtbar. Die Rohdaten gibt es als <Link href="/api/tracker">JSON-API</Link>; der Quellcode liegt auf{" "}
              <a href="https://github.com/CommandD1/Craftattack-Tracker" target="_blank" rel="noopener">
                GitHub
              </a>
              .
            </p>
          </section>
          </div>
        </div>
      </section>
    </>
  );
}
