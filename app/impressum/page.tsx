import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Impressum" };

/** Anbieterkennzeichnung nach § 5 DDG und § 18 Abs. 2 MStV. */
export default function Impressum() {
  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Rechtliches</p>
          <h1 className="t-1">Impressum</h1>
          <p>Angaben gemäß § 5 Digitale-Dienste-Gesetz (DDG).</p>
        </div>
      </section>

      <section className="block block--tight" data-tone="paper">
        <div className="wrap">
          <div className="how">
            <section className="box how__section" data-tone="white" aria-labelledby="anbieter-h">
              <h2 className="t-3" id="anbieter-h">
                Anbieter
              </h2>
              <address style={{ fontStyle: "normal" }}>
                HXO Development
                <br />
                Inhaber: Liam Fanenbruck
                <br />
                c/o Online-Impressum 12139
                <br />
                Europaring 90
                <br />
                53757 Sankt Augustin
                <br />
                Deutschland
              </address>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="kontakt-h">
              <h2 className="t-3" id="kontakt-h">
                Kontakt
              </h2>
              <dl className="how__facts">
                <dt>E-Mail</dt>
                <dd>
                  <a href="mailto:hello@hxo.dev">hello@hxo.dev</a>
                </dd>
              </dl>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="mstv-h">
              <h2 className="t-3" id="mstv-h">
                Verantwortlich für den Inhalt
              </h2>
              <p>Verantwortlich im Sinne von § 18 Abs. 2 MStV: Liam Fanenbruck, Anschrift wie oben.</p>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="hinweis-h">
              <h2 className="t-3" id="hinweis-h">
                Hinweis zum Projekt
              </h2>
              <p>
                Der CraftAttack Tracker ist ein inoffizielles, nicht kommerzielles Fan-Projekt. Er steht in keiner Verbindung zu CraftAttack, craftattack.one, den
                teilnehmenden Creatorn, Mojang Studios, Microsoft oder Twitch. Alle Marken gehören ihren jeweiligen Inhabern.
              </p>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="haftung-h">
              <h2 className="t-3" id="haftung-h">
                Haftung für Inhalte und Links
              </h2>
              <p>
                Die Zahlen werden automatisch aus öffentlichen Quellen abgeleitet und können unvollständig, verzögert oder falsch sein. Für Richtigkeit,
                Vollständigkeit und Aktualität wird keine Gewähr übernommen. Als Diensteanbieter sind wir nach den allgemeinen Gesetzen für eigene Inhalte
                verantwortlich, aber nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen. Bei Bekanntwerden von
                Rechtsverletzungen entfernen wir die betreffenden Inhalte umgehend.
              </p>
              <p>
                Für Inhalte verlinkter externer Seiten sind ausschließlich deren Betreiber verantwortlich. Zum Zeitpunkt der Verlinkung waren keine
                Rechtsverstöße erkennbar. Bei Bekanntwerden von Rechtsverletzungen entfernen wir solche Links umgehend.
              </p>
            </section>

            <section className="box how__section" data-tone="white" aria-labelledby="streit-h">
              <h2 className="t-3" id="streit-h">
                Verbraucherstreitbeilegung
              </h2>
              <p>Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
            </section>

            <p className="how__note">
              Wie wir mit Daten umgehen, steht in der <Link href="/datenschutz">Datenschutzerklärung</Link>.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
