import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Über den Tracker-Bot" };

/**
 * Steckbrief des Bots für Betreiber von craftattack.one und für Cloudflares Bot-Verzeichnis: wer fragt, was, wie oft,
 * wie er sich ausweist und wie man ihn erreicht. Die URL steht im User-Agent jeder Anfrage.
 */
export default function BotInfo() {
  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Für Betreiber</p>
          <h1 className="t-1">Über den Tracker-Bot</h1>
          <p>
            <code>actracker</code> ist der Datensammler hinter dieser Seite, einem Fanprojekt zu CraftAttack 14. Er fragt die öffentliche API von craftattack.one ab und
            baut daraus Verläufe, Bestenlisten und Statistiken für die Community.
          </p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <div className="how">
            <section className="box how__section" data-tone="white" aria-labelledby="was-h">
              <h2 className="t-3" id="was-h">
                Was er abfragt und wie oft
              </h2>
              <dl className="how__facts">
                <dt>
                  <code>/api/stats</code>, <code>/api/feed</code>
                </dt>
                <dd>Einmal pro Minute (45 bis 75 Sekunden mit Zufallsabstand).</dd>
                <dt>
                  <code>/api/player/&lt;id&gt;</code>
                </dt>
                <dd>
                  Einmal pro Minute nur für Spieler, die gerade auf dem Server sind, nacheinander mit mindestens einer halben Sekunde Abstand, höchstens 80 pro
                  Durchlauf. Offline-Spieler werden nicht abgefragt, ihre Werte ändern sich nicht.
                </dd>
                <dt>
                  <code>/events/</code>
                </dt>
                <dd>Einmal pro Stunde.</dd>
                <dt>Spielerköpfe</dt>
                <dd>Nur bei Bedarf und zwischengespeichert.</dd>
                <dt>Nicht</dt>
                <dd>Keine Anmeldung, keine Formulare, kein Durchsuchen anderer Seiten.</dd>
              </dl>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="ausweis-h">
              <h2 className="t-3" id="ausweis-h">
                Wie er sich ausweist
              </h2>
              <dl className="how__facts">
                <dt>User-Agent</dt>
                <dd>
                  <code>actracker/1.0 (+https://craftattack.hiorcraft.tv/bot; hello@hxo.dev)</code>
                </dd>
                <dt>Web Bot Auth</dt>
                <dd>
                  Jede Anfrage ist nach RFC 9421 mit einem Ed25519-Schlüssel signiert (<code>Signature-Agent</code>, <code>Signature-Input</code>,{" "}
                  <code>Signature</code>). Der öffentliche Schlüssel steht im{" "}
                  <a href="/.well-known/http-message-signatures-directory">Schlüsselverzeichnis</a>.
                </dd>
                <dt>Bei Sperren</dt>
                <dd>
                  Antwortet die Seite mit 403, 429 oder einer Cloudflare-Prüfung, pausiert der Bot: 5 Minuten, bei Wiederholung doppelt so lange, bis zu 6 Stunden.{" "}
                  <code>Retry-After</code> wird beachtet.
                </dd>
              </dl>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="kontakt-h">
              <h2 className="t-3" id="kontakt-h">
                Kontakt
              </h2>
              <p>
                Zu viele Anfragen, falsche Zeiten, lieber ein anderer Weg? Eine Nachricht an <a href="mailto:hello@hxo.dev">hello@hxo.dev</a> oder ein Issue auf{" "}
                <a href="https://github.com/CommandD1/Craftattack-Tracker" target="_blank" rel="noopener">
                  GitHub
                </a>{" "}
                genügt, die Abfragerate wird gern angepasst. Wie die Seite die Daten verarbeitet, steht unter <Link href="/so-funktionierts">So funktioniert’s</Link>.
              </p>
            </section>
          </div>
        </div>
      </section>
    </>
  );
}
