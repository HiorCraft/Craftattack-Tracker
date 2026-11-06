import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Datenschutz" };

const SECTIONS = [
  { id: "ueberblick", title: "1. Auf einen Blick" },
  { id: "hosting", title: "2. Hosting" },
  { id: "allgemein", title: "3. Pflichtinformationen" },
  { id: "datenerfassung", title: "4. Datenerfassung" },
  { id: "plugins", title: "5. Plugins und Tools" },
  { id: "tracker", title: "6. Daten im Tracker" },
] as const;

/** Datenschutzerklärung nach Art. 13/14 DSGVO. Bei neuen Diensten oder Datenquellen hier nachziehen. */
export default function Datenschutz() {
  return (
    <>
      <section className="block page-head" data-tone="ender">
        <div className="wrap">
          <p className="eyebrow">Rechtliches</p>
          <h1 className="t-1">Datenschutzerklärung</h1>
          <p>Welche personenbezogenen Daten beim Besuch dieser Website und durch den Tracker verarbeitet werden, wozu und welche Rechte Sie haben.</p>
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

            {/* ------------------------------------------------------------ 1 */}
            <section className="box how__section" data-tone="white" id="ueberblick" aria-labelledby="ueberblick-h">
              <h2 className="t-3" id="ueberblick-h">
                1. Datenschutz auf einen Blick
              </h2>
              <h3>Allgemeine Hinweise</h3>
              <p>
                Die folgenden Hinweise geben einen einfachen Überblick darüber, was mit Ihren personenbezogenen Daten passiert, wenn Sie diese Website besuchen.
                Personenbezogene Daten sind alle Daten, mit denen Sie persönlich identifiziert werden können. Ausführliche Informationen zum Thema Datenschutz
                entnehmen Sie unserer unter diesem Text aufgeführten Datenschutzerklärung.
              </p>
              <h3>Wer ist verantwortlich für die Datenerfassung auf dieser Website?</h3>
              <p>
                Die Datenverarbeitung auf dieser Website erfolgt durch den Websitebetreiber. Dessen Kontaktdaten können Sie dem Abschnitt{" "}
                <a href="#verantwortlich">„Hinweis zur verantwortlichen Stelle“</a> in dieser Datenschutzerklärung entnehmen.
              </p>
              <h3>Wie erfassen wir Ihre Daten?</h3>
              <p>
                Ihre Daten werden zum einen dadurch erhoben, dass Sie uns diese mitteilen, etwa wenn Sie uns eine E-Mail schreiben. Andere Daten werden
                automatisch beim Besuch der Website durch unsere IT-Systeme erfasst. Das sind vor allem technische Daten (z. B. Internetbrowser, Betriebssystem
                oder Uhrzeit des Seitenaufrufs). Die Erfassung dieser Daten erfolgt automatisch, sobald Sie diese Website betreten.
              </p>
              <h3>Wofür nutzen wir Ihre Daten?</h3>
              <p>
                Die Daten werden erhoben, um eine fehlerfreie Bereitstellung der Website zu gewährleisten. Eine Analyse Ihres Nutzerverhaltens findet nicht statt;
                die Website verwendet keine Analyse-, Tracking- oder Werbewerkzeuge.
              </p>
              <h3>Welche Rechte haben Sie bezüglich Ihrer Daten?</h3>
              <p>
                Sie haben jederzeit das Recht, unentgeltlich Auskunft über Herkunft, Empfänger und Zweck Ihrer gespeicherten personenbezogenen Daten zu erhalten.
                Sie haben außerdem ein Recht, die Berichtigung oder Löschung dieser Daten zu verlangen. Wenn Sie eine Einwilligung zur Datenverarbeitung erteilt
                haben, können Sie diese Einwilligung jederzeit für die Zukunft widerrufen. Außerdem haben Sie das Recht, unter bestimmten Umständen die
                Einschränkung der Verarbeitung Ihrer personenbezogenen Daten zu verlangen. Des Weiteren steht Ihnen ein Beschwerderecht bei der zuständigen
                Aufsichtsbehörde zu.
              </p>
              <p>Hierzu sowie zu weiteren Fragen zum Thema Datenschutz können Sie sich jederzeit an uns wenden.</p>
            </section>

            {/* ------------------------------------------------------------ 2 */}
            <section className="box how__section" data-tone="white" id="hosting" aria-labelledby="hosting-h">
              <h2 className="t-3" id="hosting-h">
                2. Hosting
              </h2>
              <p>Wir hosten die Inhalte unserer Website bei folgendem Anbieter:</p>
              <h3>Hetzner</h3>
              <p>
                Anbieter ist die Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen (nachfolgend Hetzner). Details entnehmen Sie der{" "}
                <a href="https://www.hetzner.com/de/legal/privacy-policy/" target="_blank" rel="noopener">
                  Datenschutzerklärung von Hetzner
                </a>
                .
              </p>
              <p>
                Die Verwendung von Hetzner erfolgt auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO. Wir haben ein berechtigtes Interesse an einer möglichst
                zuverlässigen Darstellung unserer Website. Sofern eine entsprechende Einwilligung abgefragt wurde, erfolgt die Verarbeitung ausschließlich auf
                Grundlage von Art. 6 Abs. 1 lit. a DSGVO und § 25 Abs. 1 TDDDG, soweit die Einwilligung die Speicherung von Cookies oder den Zugriff auf
                Informationen im Endgerät des Nutzers (z. B. Device-Fingerprinting) im Sinne des TDDDG umfasst. Die Einwilligung ist jederzeit widerrufbar.
              </p>
              <h3>Cloudflare</h3>
              <p>
                Wir nutzen den Dienst Cloudflare. Anbieter ist die Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107, USA (nachfolgend Cloudflare).
              </p>
              <p>
                Cloudflare bietet ein weltweit verteiltes Content Delivery Network mit DNS an. Dabei wird der Informationstransfer zwischen Ihrem Browser und
                unserer Website technisch über das Netzwerk von Cloudflare geleitet. Das versetzt Cloudflare in die Lage, den Datenverkehr zwischen Ihrem Browser
                und unserer Website zu analysieren und als Filter zwischen unseren Servern und potenziell bösartigem Datenverkehr aus dem Internet zu dienen.
                Hierbei kann Cloudflare auch Cookies oder sonstige Technologien zur Wiedererkennung von Internetnutzern einsetzen, die jedoch allein zum hier
                beschriebenen Zweck verwendet werden. Dabei verarbeitet Cloudflare insbesondere Ihre IP-Adresse, die aufgerufene Adresse, Datum und Uhrzeit sowie
                Angaben zu Browser und Betriebssystem.
              </p>
              <p>
                Der Einsatz von Cloudflare beruht auf unserem berechtigten Interesse an einer möglichst fehlerfreien und sicheren Bereitstellung unseres
                Webangebotes (Art. 6 Abs. 1 lit. f DSGVO). Cookies, die Cloudflare zur Abwehr automatisierter Angriffe setzt, sind für den sicheren Betrieb
                unbedingt erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG).
              </p>
              <p>
                Die Datenübertragung in die USA wird auf die Standardvertragsklauseln der EU-Kommission gestützt. Details finden Sie unter{" "}
                <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">
                  https://www.cloudflare.com/privacypolicy/
                </a>
                . Das Unternehmen verfügt zudem über eine Zertifizierung nach dem „EU-US Data Privacy Framework“ (DPF). Der DPF ist ein Übereinkommen zwischen der
                Europäischen Union und den USA, der die Einhaltung europäischer Datenschutzstandards bei Datenverarbeitungen in den USA gewährleisten soll.
              </p>

              <h3>Auftragsverarbeitung</h3>
              <p>
                Wir haben Verträge über Auftragsverarbeitung (AVV) zur Nutzung der oben genannten Dienste geschlossen. Hierbei handelt es sich um
                datenschutzrechtlich vorgeschriebene Verträge, die gewährleisten, dass die Anbieter die personenbezogenen Daten unserer Websitebesucher nur nach
                unseren Weisungen und unter Einhaltung der DSGVO verarbeiten.
              </p>
            </section>

            {/* ------------------------------------------------------------ 3 */}
            <section className="box how__section" data-tone="white" id="allgemein" aria-labelledby="allgemein-h">
              <h2 className="t-3" id="allgemein-h">
                3. Allgemeine Hinweise und Pflichtinformationen
              </h2>
              <h3>Datenschutz</h3>
              <p>
                Die Betreiber dieser Seiten nehmen den Schutz Ihrer persönlichen Daten sehr ernst. Wir behandeln Ihre personenbezogenen Daten vertraulich und
                entsprechend den gesetzlichen Datenschutzvorschriften sowie dieser Datenschutzerklärung.
              </p>
              <p>
                Wenn Sie diese Website benutzen, werden verschiedene personenbezogene Daten erhoben. Die vorliegende Datenschutzerklärung erläutert, welche Daten
                wir erheben und wofür wir sie nutzen. Sie erläutert auch, wie und zu welchem Zweck das geschieht.
              </p>
              <p>
                Wir weisen darauf hin, dass die Datenübertragung im Internet (z. B. bei der Kommunikation per E-Mail) Sicherheitslücken aufweisen kann. Ein
                lückenloser Schutz der Daten vor dem Zugriff durch Dritte ist nicht möglich.
              </p>

              <h3 id="verantwortlich">Hinweis zur verantwortlichen Stelle</h3>
              <p>Die verantwortliche Stelle für die Datenverarbeitung auf dieser Website ist:</p>
              <address style={{ fontStyle: "normal" }}>
                HXO Development – Liam Fanenbruck
                <br />
                c/o Online-Impressum 12139
                <br />
                Europaring 90
                <br />
                53757 Sankt Augustin
                <br />
                <br />
                E-Mail: <a href="mailto:hello@hxo.dev">hello@hxo.dev</a>
              </address>
              <p>
                Verantwortliche Stelle ist die natürliche oder juristische Person, die allein oder gemeinsam mit anderen über die Zwecke und Mittel der
                Verarbeitung von personenbezogenen Daten (z. B. Namen, E-Mail-Adressen o. Ä.) entscheidet.
              </p>

              <h3>Speicherdauer</h3>
              <p>
                Soweit innerhalb dieser Datenschutzerklärung keine speziellere Speicherdauer genannt wurde, verbleiben Ihre personenbezogenen Daten bei uns, bis
                der Zweck für die Datenverarbeitung entfällt. Wenn Sie ein berechtigtes Löschersuchen geltend machen oder eine Einwilligung zur Datenverarbeitung
                widerrufen, werden Ihre Daten gelöscht, sofern wir keine anderen rechtlich zulässigen Gründe für die Speicherung Ihrer personenbezogenen Daten
                haben (z. B. steuer- oder handelsrechtliche Aufbewahrungsfristen); im letztgenannten Fall erfolgt die Löschung nach Fortfall dieser Gründe.
              </p>

              <h3>Allgemeine Hinweise zu den Rechtsgrundlagen der Datenverarbeitung auf dieser Website</h3>
              <p>
                Sofern Sie in die Datenverarbeitung eingewilligt haben, verarbeiten wir Ihre personenbezogenen Daten auf Grundlage von Art. 6 Abs. 1 lit. a DSGVO
                bzw. Art. 9 Abs. 2 lit. a DSGVO, sofern besondere Datenkategorien nach Art. 9 Abs. 1 DSGVO verarbeitet werden. Im Falle einer ausdrücklichen
                Einwilligung in die Übertragung personenbezogener Daten in Drittstaaten erfolgt die Datenverarbeitung außerdem auf Grundlage von Art. 49 Abs. 1
                lit. a DSGVO. Sofern Sie in die Speicherung von Cookies oder in den Zugriff auf Informationen in Ihr Endgerät (z. B. via Device-Fingerprinting)
                eingewilligt haben, erfolgt die Datenverarbeitung zusätzlich auf Grundlage von § 25 Abs. 1 TDDDG. Die Einwilligung ist jederzeit widerrufbar. Sind
                Ihre Daten zur Vertragserfüllung oder zur Durchführung vorvertraglicher Maßnahmen erforderlich, verarbeiten wir Ihre Daten auf Grundlage des Art.
                6 Abs. 1 lit. b DSGVO. Des Weiteren verarbeiten wir Ihre Daten, sofern diese zur Erfüllung einer rechtlichen Verpflichtung erforderlich sind, auf
                Grundlage von Art. 6 Abs. 1 lit. c DSGVO. Die Datenverarbeitung kann ferner auf Grundlage unseres berechtigten Interesses nach Art. 6 Abs. 1 lit.
                f DSGVO erfolgen. Über die jeweils im Einzelfall einschlägigen Rechtsgrundlagen wird in den folgenden Absätzen dieser Datenschutzerklärung
                informiert.
              </p>

              <h3>Empfänger von personenbezogenen Daten</h3>
              <p>
                Im Rahmen unserer Tätigkeit arbeiten wir mit verschiedenen externen Stellen zusammen. Dabei ist teilweise auch eine Übermittlung von
                personenbezogenen Daten an diese externen Stellen erforderlich. Wir geben personenbezogene Daten nur dann an externe Stellen weiter, wenn dies im
                Rahmen einer Vertragserfüllung erforderlich ist, wenn wir gesetzlich hierzu verpflichtet sind (z. B. Weitergabe von Daten an Steuerbehörden), wenn
                wir ein berechtigtes Interesse nach Art. 6 Abs. 1 lit. f DSGVO an der Weitergabe haben oder wenn eine sonstige Rechtsgrundlage die Datenweitergabe
                erlaubt. Beim Einsatz von Auftragsverarbeitern geben wir personenbezogene Daten nur auf Grundlage eines gültigen Vertrags über
                Auftragsverarbeitung weiter. Im Falle einer gemeinsamen Verarbeitung wird ein Vertrag über gemeinsame Verarbeitung geschlossen.
              </p>

              <h3>Widerruf Ihrer Einwilligung zur Datenverarbeitung</h3>
              <p>
                Viele Datenverarbeitungsvorgänge sind nur mit Ihrer ausdrücklichen Einwilligung möglich. Sie können eine bereits erteilte Einwilligung jederzeit
                widerrufen. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Datenverarbeitung bleibt vom Widerruf unberührt.
              </p>

              <h3>Widerspruchsrecht gegen die Datenerhebung in besonderen Fällen sowie gegen Direktwerbung (Art. 21 DSGVO)</h3>
              <p>
                <strong>
                  WENN DIE DATENVERARBEITUNG AUF GRUNDLAGE VON ART. 6 ABS. 1 LIT. E ODER F DSGVO ERFOLGT, HABEN SIE JEDERZEIT DAS RECHT, AUS GRÜNDEN, DIE SICH AUS
                  IHRER BESONDEREN SITUATION ERGEBEN, GEGEN DIE VERARBEITUNG IHRER PERSONENBEZOGENEN DATEN WIDERSPRUCH EINZULEGEN; DIES GILT AUCH FÜR EIN AUF DIESE
                  BESTIMMUNGEN GESTÜTZTES PROFILING. DIE JEWEILIGE RECHTSGRUNDLAGE, AUF DENEN EINE VERARBEITUNG BERUHT, ENTNEHMEN SIE DIESER
                  DATENSCHUTZERKLÄRUNG. WENN SIE WIDERSPRUCH EINLEGEN, WERDEN WIR IHRE BETROFFENEN PERSONENBEZOGENEN DATEN NICHT MEHR VERARBEITEN, ES SEI DENN,
                  WIR KÖNNEN ZWINGENDE SCHUTZWÜRDIGE GRÜNDE FÜR DIE VERARBEITUNG NACHWEISEN, DIE IHRE INTERESSEN, RECHTE UND FREIHEITEN ÜBERWIEGEN ODER DIE
                  VERARBEITUNG DIENT DER GELTENDMACHUNG, AUSÜBUNG ODER VERTEIDIGUNG VON RECHTSANSPRÜCHEN (WIDERSPRUCH NACH ART. 21 ABS. 1 DSGVO).
                </strong>
              </p>
              <p>
                <strong>
                  WERDEN IHRE PERSONENBEZOGENEN DATEN VERARBEITET, UM DIREKTWERBUNG ZU BETREIBEN, SO HABEN SIE DAS RECHT, JEDERZEIT WIDERSPRUCH GEGEN DIE
                  VERARBEITUNG SIE BETREFFENDER PERSONENBEZOGENER DATEN ZUM ZWECKE DERARTIGER WERBUNG EINZULEGEN; DIES GILT AUCH FÜR DAS PROFILING, SOWEIT ES MIT
                  SOLCHER DIREKTWERBUNG IN VERBINDUNG STEHT. WENN SIE WIDERSPRECHEN, WERDEN IHRE PERSONENBEZOGENEN DATEN ANSCHLIESSEND NICHT MEHR ZUM ZWECKE DER
                  DIREKTWERBUNG VERWENDET (WIDERSPRUCH NACH ART. 21 ABS. 2 DSGVO).
                </strong>
              </p>

              <h3>Beschwerderecht bei der zuständigen Aufsichtsbehörde</h3>
              <p>
                Im Falle von Verstößen gegen die DSGVO steht den Betroffenen ein Beschwerderecht bei einer Aufsichtsbehörde, insbesondere in dem Mitgliedstaat
                ihres gewöhnlichen Aufenthalts, ihres Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes zu. Das Beschwerderecht besteht unbeschadet
                anderweitiger verwaltungsrechtlicher oder gerichtlicher Rechtsbehelfe.
              </p>

              <h3>Recht auf Datenübertragbarkeit</h3>
              <p>
                Sie haben das Recht, Daten, die wir auf Grundlage Ihrer Einwilligung oder in Erfüllung eines Vertrags automatisiert verarbeiten, an sich oder an
                einen Dritten in einem gängigen, maschinenlesbaren Format aushändigen zu lassen. Sofern Sie die direkte Übertragung der Daten an einen anderen
                Verantwortlichen verlangen, erfolgt dies nur, soweit es technisch machbar ist.
              </p>

              <h3>Auskunft, Berichtigung und Löschung</h3>
              <p>
                Sie haben im Rahmen der geltenden gesetzlichen Bestimmungen jederzeit das Recht auf unentgeltliche Auskunft über Ihre gespeicherten
                personenbezogenen Daten, deren Herkunft und Empfänger und den Zweck der Datenverarbeitung und ggf. ein Recht auf Berichtigung oder Löschung dieser
                Daten. Hierzu sowie zu weiteren Fragen zum Thema personenbezogene Daten können Sie sich jederzeit an uns wenden.
              </p>

              <h3>Recht auf Einschränkung der Verarbeitung</h3>
              <p>
                Sie haben das Recht, die Einschränkung der Verarbeitung Ihrer personenbezogenen Daten zu verlangen. Hierzu können Sie sich jederzeit an uns
                wenden. Das Recht auf Einschränkung der Verarbeitung besteht in folgenden Fällen:
              </p>
              <ul>
                <li>
                  Wenn Sie die Richtigkeit Ihrer bei uns gespeicherten personenbezogenen Daten bestreiten, benötigen wir in der Regel Zeit, um dies zu überprüfen.
                  Für die Dauer der Prüfung haben Sie das Recht, die Einschränkung der Verarbeitung Ihrer personenbezogenen Daten zu verlangen.
                </li>
                <li>
                  Wenn die Verarbeitung Ihrer personenbezogenen Daten unrechtmäßig geschah/geschieht, können Sie statt der Löschung die Einschränkung der
                  Datenverarbeitung verlangen.
                </li>
                <li>
                  Wenn wir Ihre personenbezogenen Daten nicht mehr benötigen, Sie sie jedoch zur Ausübung, Verteidigung oder Geltendmachung von Rechtsansprüchen
                  benötigen, haben Sie das Recht, statt der Löschung die Einschränkung der Verarbeitung Ihrer personenbezogenen Daten zu verlangen.
                </li>
                <li>
                  Wenn Sie einen Widerspruch nach Art. 21 Abs. 1 DSGVO eingelegt haben, muss eine Abwägung zwischen Ihren und unseren Interessen vorgenommen
                  werden. Solange noch nicht feststeht, wessen Interessen überwiegen, haben Sie das Recht, die Einschränkung der Verarbeitung Ihrer
                  personenbezogenen Daten zu verlangen.
                </li>
              </ul>
              <p>
                Wenn Sie die Verarbeitung Ihrer personenbezogenen Daten eingeschränkt haben, dürfen diese Daten – von ihrer Speicherung abgesehen – nur mit Ihrer
                Einwilligung oder zur Geltendmachung, Ausübung oder Verteidigung von Rechtsansprüchen oder zum Schutz der Rechte einer anderen natürlichen oder
                juristischen Person oder aus Gründen eines wichtigen öffentlichen Interesses der Europäischen Union oder eines Mitgliedstaats verarbeitet werden.
              </p>

              <h3>SSL- bzw. TLS-Verschlüsselung</h3>
              <p>
                Diese Seite nutzt aus Sicherheitsgründen und zum Schutz der Übertragung vertraulicher Inhalte, wie zum Beispiel Anfragen, die Sie an uns als
                Seitenbetreiber senden, eine SSL- bzw. TLS-Verschlüsselung. Eine verschlüsselte Verbindung erkennen Sie daran, dass die Adresszeile des Browsers
                von „http://“ auf „https://“ wechselt, und an dem Schloss-Symbol in Ihrer Browserzeile. Wenn die SSL- bzw. TLS-Verschlüsselung aktiviert ist,
                können die Daten, die Sie an uns übermitteln, nicht von Dritten mitgelesen werden.
              </p>
            </section>

            {/* ------------------------------------------------------------ 4 */}
            <section className="box how__section" data-tone="white" id="datenerfassung" aria-labelledby="datenerfassung-h">
              <h2 className="t-3" id="datenerfassung-h">
                4. Datenerfassung auf dieser Website
              </h2>
              <h3>Server-Log-Dateien</h3>
              <p>Beim Aufruf jeder Seite erhebt und speichert der Server automatisch Informationen, die Ihr Browser übermittelt. Dies sind:</p>
              <ul>
                <li>Browsertyp und Browserversion</li>
                <li>verwendetes Betriebssystem</li>
                <li>Referrer-URL</li>
                <li>aufgerufene Adresse</li>
                <li>Uhrzeit der Serveranfrage</li>
                <li>IP-Adresse</li>
              </ul>
              <p>
                Eine Zusammenführung dieser Daten mit anderen Datenquellen wird nicht vorgenommen. Die Erfassung erfolgt auf Grundlage von Art. 6 Abs. 1 lit. f
                DSGVO. Wir haben ein berechtigtes Interesse an der technisch fehlerfreien Darstellung und der Absicherung unserer Website; hierzu müssen die
                Server-Log-Files erfasst werden. Die Logs werden nur kurzfristig vorgehalten und anschließend gelöscht.
              </p>

              <h3>Lokaler Speicher statt Cookies</h3>
              <p>
                Diese Website setzt keine eigenen Cookies (zu technisch notwendigen Cookies von Cloudflare siehe Abschnitt 2). Im lokalen Speicher Ihres Browsers (<code>localStorage</code>) werden nur Einstellungen abgelegt, die Sie
                selbst vornehmen: helles oder dunkles Design, auf- und zugeklappte Abschnitte, die Ansichtseinstellungen auf der Seite{" "}
                <Link href="/verbindungen">Verbindungen</Link> und, falls Sie das wählen, Ihre Zustimmung zur Twitch-Einbettung. Diese Werte verlassen Ihren Browser nicht und werden nicht an uns übertragen. Rechtsgrundlage ist §
                25 Abs. 2 Nr. 2 TDDDG, da die Speicherung für den von Ihnen ausdrücklich gewünschten Dienst unbedingt erforderlich ist. Sie können die Einträge
                jederzeit über die Einstellungen Ihres Browsers löschen.
              </p>
              <p>
                Schriften und Bilder werden von unserem eigenen Server ausgeliefert. Spielerköpfe und Skins ruft unser Server selbst bei den jeweiligen Quellen ab;
                Ihr Browser baut dafür keine Verbindung zu Drittanbietern auf.
              </p>

              <h3>Anfrage per E-Mail</h3>
              <p>
                Wenn Sie uns per E-Mail kontaktieren, wird Ihre Anfrage inklusive aller daraus hervorgehenden personenbezogenen Daten (Name, Anfrage) zum Zwecke
                der Bearbeitung Ihres Anliegens bei uns gespeichert und verarbeitet. Diese Daten geben wir nicht ohne Ihre Einwilligung weiter. Die Verarbeitung
                erfolgt auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO; unser berechtigtes Interesse ist die effektive Bearbeitung der an uns gerichteten Anfragen.
                Die Daten verbleiben bei uns, bis Sie uns zur Löschung auffordern oder der Zweck entfällt, sofern keine gesetzlichen Aufbewahrungsfristen
                entgegenstehen.
              </p>
            </section>

            {/* ------------------------------------------------------------ 5 */}
            <section className="box how__section" data-tone="white" id="plugins" aria-labelledby="plugins-h">
              <h2 className="t-3" id="plugins-h">
                5. Plugins und Tools
              </h2>
              <h3>Twitch</h3>
              <p>
                Auf den Profilseiten von Spielern, die gerade live sind, binden wir den Stream und den Chat von Twitch ein. Anbieter ist die Twitch Interactive,
                Inc., 350 Bush Street, 2nd Floor, San Francisco, CA 94104, USA.
              </p>
              <p>
                Wir nutzen dafür eine Zwei-Klick-Lösung: Beim Aufruf der Seite wird zunächst nur ein Platzhalter angezeigt, und es wird keine Verbindung zu
                Twitch aufgebaut. Erst wenn Sie auf „Stream und Chat laden“ klicken, wird eine Verbindung zu den Servern von Twitch hergestellt. Dabei wird Twitch
                mindestens Ihre IP-Adresse und die Information übermittelt, welche unserer Seiten Sie besucht haben. Twitch kann Cookies oder vergleichbare
                Techniken einsetzen. Wenn Sie in Ihrem Twitch-Account eingeloggt sind, ermöglichen Sie Twitch, Ihr Surfverhalten direkt Ihrem persönlichen Profil
                zuzuordnen. Dies können Sie verhindern, indem Sie sich aus Ihrem Twitch-Account ausloggen.
              </p>
              <p>
                Die Verarbeitung erfolgt auf Grundlage Ihrer Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO und § 25 Abs. 1 TDDDG; die Übermittlung in die USA
                stützt sich zusätzlich auf Art. 49 Abs. 1 lit. a DSGVO, soweit kein Angemessenheitsbeschluss greift. Wählen Sie „Twitch künftig immer laden“,
                wird diese Entscheidung im lokalen Speicher Ihres Browsers (<code>ac-twitch-consent</code>) abgelegt und Twitch danach automatisch geladen. Die
                Einwilligung ist jederzeit widerrufbar, über den Link „Zustimmung widerrufen“ unter dem Player oder indem Sie den lokalen Speicher Ihres Browsers
                löschen.
              </p>
              <p>
                Weitere Informationen finden Sie in der{" "}
                <a href="https://www.twitch.tv/p/de-de/legal/privacy-notice/" target="_blank" rel="noopener">
                  Datenschutzerklärung von Twitch
                </a>
                . Twitch ist als Tochter der Amazon.com, Inc. nach dem „EU-US Data Privacy Framework“ (DPF) zertifiziert. Der DPF ist ein Übereinkommen zwischen
                der Europäischen Union und den USA, der die Einhaltung europäischer Datenschutzstandards bei Datenverarbeitungen in den USA gewährleisten soll.
              </p>
            </section>

            {/* ------------------------------------------------------------ 6 */}
            <section className="box how__section" data-tone="white" id="tracker" aria-labelledby="tracker-h">
              <h2 className="t-3" id="tracker-h">
                6. Daten im Tracker
              </h2>
              <p>
                Der Tracker zeigt Statistiken zum Projekt CraftAttack 14. Dafür verarbeitet er öffentlich zugängliche Daten, die nicht bei Ihnen als Besucher
                erhoben werden (Art. 14 DSGVO). Wie die Daten gesammelt werden, ist unter <Link href="/so-funktionierts">So funktioniert’s</Link> ausführlich
                beschrieben.
              </p>
              <dl className="how__facts">
                <dt>Spieldaten</dt>
                <dd>
                  Minecraft-Name, Spieler-ID, Skin, Online-Zeiten und Spielstatistiken der Teilnehmenden aus der öffentlichen API von{" "}
                  <a href="https://craftattack.one/" target="_blank" rel="noopener">
                    craftattack.one
                  </a>
                  .
                </dd>
                <dt>Twitch-Kanäle</dt>
                <dd>Öffentliche Kanaldaten der teilnehmenden Streamer: Kanalname, Live-Status, Titel, Kategorie, Zuschauer- und Followerzahlen, VODs und Clips.</dd>
                <dt>Twitch-Chat</dt>
                <dd>
                  Aus den öffentlichen Chats dieser Kanäle: Abo-, Geschenk-Abo- und Raid-Meldungen mit dem angezeigten Twitch-Namen von Abonnent, Schenker und
                  Empfänger; Chatnachrichten zwischen Teilnehmenden (höchstens 10.000); die Anzahl unterschiedlicher Chatter, gezählt über die numerische
                  Twitch-ID. Andere Chatnachrichten von Zuschauern werden nicht gespeichert.
                </dd>
                <dt>Zweck</dt>
                <dd>Verläufe, Bestenlisten, Ereignisse und Statistiken zum Projekt für die Community bereitstellen.</dd>
                <dt>Rechtsgrundlage</dt>
                <dd>
                  Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist ein nicht kommerzielles Fan-Angebot zu einem öffentlichen Projekt. Die Daten wurden
                  von den Betroffenen selbst oder von den Plattformen öffentlich gemacht.
                </dd>
                <dt>Speicherdauer</dt>
                <dd>Für die Dauer des Projekts CraftAttack 14 und danach als Archiv, solange die Website betrieben wird, oder bis zu einem berechtigten Widerspruch.</dd>
                <dt>Empfänger</dt>
                <dd>Die Datenbank liegt beim Hoster (siehe Abschnitt 2). Die abgeleiteten Daten sind auf dieser Website und über die JSON-API öffentlich abrufbar.</dd>
              </dl>
              <p>
                Möchten Sie, dass Daten zu Ihrer Person aus dem Tracker entfernt werden, etwa Ihr Twitch-Name aus dem Abo-Feed, schreiben Sie an{" "}
                <a href="mailto:hello@hxo.dev">hello@hxo.dev</a>.
              </p>
            </section>

            <p className="how__note">
              Stand: November 2026. Siehe auch das <Link href="/impressum">Impressum</Link>.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
