# CraftAttack 14 Tracker

Live unter **https://craftattack.hiorcraft.tv**

> **Hinweis:** Dieses Repo ist der Quellcode des Trackers, der auf craftattack.hiorcraft.tv läuft.
> Es ist nicht als Self-Hosting-Paket gedacht und es gibt dafür keinen Support. Nutz einfach die Live-Seite.
> Für neue Features, Bugfixes oder Ideen sind Pull Requests und Issues aber sehr willkommen.

## Mitmachen

1. Repo forken und klonen, `npm install`
2. `DATABASE_URL` in `.env.local` setzen (siehe `.env.example`), dann startet `npm run dev` lokal auf http://localhost:3000.
3. Änderung machen, `npm run lint` und `npx tsc --noEmit` müssen sauber sein.
4. Pull Request gegen `main` mit kurzer Beschreibung, was und warum.

Ideen, die noch offen sind: Twitch-API-Anbindung (Clips, Kategorie), Discord-Benachrichtigungen bei Highlights, Tages- und Wochenstatistiken, Vergleich zweier Spieler.

Inoffizieller Tracker für CraftAttack 14. Fragt `https://craftattack.one/api/stats` standardmäßig in zufälligen Abständen
von 45 bis 75 Sekunden ab (Mittelwert: eine Minute).
Einzelstatistiken (`/api/player/<spieler-id>`) werden nur für Spieler angefragt, die online sind oder es beim vorigen
Poll waren, dann aber bei jedem Poll. Offline ändern sich die Werte nicht, der gespeicherte Stand bleibt gültig.
Pro Poll gehen höchstens 80 solcher Anfragen raus, mit mindestens 500 ms Abstand;
kann eine Antwort nicht rechtzeitig erneuert werden, bleibt sie 15 Minuten gültig. Bei Cloudflare-Challenges, HTTP 403/429 oder Cloudflare-5xx-
Antworten pausiert der Tracker Anfragen an den betroffenen Origin mindestens fünf Minuten. Wiederholte Sperren
verlängern die Pause exponentiell bis höchstens sechs Stunden; `Retry-After` wird zusätzlich als Mindestwartezeit
beachtet. Während der Pause werden keine automatischen Probe-Anfragen gesendet, danach wird automatisch vorsichtig
fortgesetzt. Nach 24 Stunden ohne erneute Sperre beginnt die Eskalation wieder bei fünf Minuten. Bild-Proxys liefern
während einer solchen Pause ebenfalls `503` mit `Retry-After`, statt auf eine alternative Quelle auszuweichen.
Diese Rücksichtnahme kann eine Sperre nicht garantieren zu verhindern; beachte die Nutzungsbedingungen und wende
dich bei einer Sperre an den Betreiber, statt Schutzmaßnahmen zu umgehen.
Der Tracker vergleicht den Stand mit dem vorherigen und schreibt jede Änderung als Ereignis mit Zeitstempel auf.

## Starten

```bash
npm install
npm run dev      # http://localhost:3000
```

Der Poller startet automatisch mit dem Server (`instrumentation.ts`).

### Nur Website oder nur Tracker

`TRACKER_MODE` legt fest, was ein Prozess übernimmt:

| Modus | Befehl | Verhalten |
| --- | --- | --- |
| `all` (Standard) | `npm run dev` / `npm start` | Website und Tracker im selben Prozess |
| `web` | `npm run dev:web` / `npm run start:web` | Nur die Website. Poller, Twitch-IRC und Nachträge starten nicht. `/api/tracker/poll` und `/api/cron/poll` bleiben für einen externen Cron nutzbar. |
| `tracker` | `npm run dev:tracker` / `npm run start:tracker` | Nur der Tracker. Alle Seiten antworten mit HTTP 503; erreichbar bleiben `/api/tracker` (Status) sowie die Poll-Endpunkte. |

Beide Modi gleichzeitig auf einem Rechner brauchen verschiedene Ports, z. B. `PORT=3001 npm run start:tracker`.
Im Modus `web` lädt die Website den Stand beim Start aus der DB und gleicht ihn danach bei Anfragen höchstens alle
30 Sekunden ab (Tracker-Stand, Spieler, neue und kürzlich geänderte Ereignisse), alle 6 Stunden vollständig. Die
Poll-Endpunkte antworten dort mit HTTP 409: Cron-Aufrufe gehören an den Tracker-Dienst, sonst schreiben zwei Poller.
Sie teilen sich dieselbe Datenbank (`DATABASE_URL`); der Tracker schreibt, die Website liest.
Auf Render lässt sich der Tracker so als eigener Worker-Service mit `npm run start:tracker` betreiben.

## Render (512 MB)

`render.yaml` richtet einen Render-Starter-Web-Service ein. Der Produktionsserver
begrenzt V8s Heap auf 280 MB Old Space plus 16 MB Semi Space (`--max-semi-space-size`), zusammen
gut 340 MB. Ohne die Semi-Space-Grenze darf Node 24 den Heap auf über 530 MB wachsen lassen, mehr als die
Instanz hat; dann beendet Render den Prozess samt Tracker. Teure Abfragen (Rang-Verlauf, Raten, Sessions,
Bestenlisten) werden zwischengespeichert, gleichzeitige Anfragen teilen sich eine Berechnung, abgelaufene
Einträge werden sofort ausgeliefert und im Hintergrund erneuert (`lib/swrCache.ts`); `/api/warm` füllt sie
kurz nach dem Start. Für noch mehr Sicherheit lässt sich der Tracker als eigener Dienst betreiben
(siehe „Nur Website oder nur Tracker“). Next.js hält höchstens 16 MB Cache im Speicher und
verwendet beim Build einen Worker. Die verbleibende Speichermarge ist für Node.js,
native Module und den Tracker vorgesehen.

Beim Erstellen des Blueprints die abgefragten Variablen eintragen:
`DATABASE_URL` und `CRON_SECRET`. Twitch-Zugangsdaten sind
optional und können nach dem Erstellen im Render-Dashboard gesetzt werden.

Für `DATABASE_URL` die **Internal Database URL** der Render-PostgreSQL-Datenbank
verwenden. Damit kommunizieren Web-Service und Datenbank intern über dasselbe
Render-Netzwerk. Die Hostname-, Port-, Datenbank-, Username- und Password-Felder
müssen nicht einzeln eingetragen werden; die Internal Database URL enthält sie
bereits. Die **External Database URL** ist für Verbindungen von außerhalb Render,
zum Beispiel für lokale Entwicklung. Die PSQL Command ist für manuelle
`psql`-Verbindungen und wird von der App nicht benötigt. Die App verschlüsselt
die PostgreSQL-Verbindung mit TLS; da Render intern selbstsignierte Zertifikate
verwendet, wird das Zertifikat dabei nicht verifiziert.

## Datenbanken zusammenführen

`scripts/merge-eras.mjs` führt die Datenbanken mehrerer Tracker-Epochen (PGlite, Neon, Render) in eine zusammen:

```bash
# Ziel einmal mit dem aktuellen Schema anlegen: App mit dieser DATABASE_URL im Modus web starten und wieder stoppen
npm i --no-save @electric-sql/pglite@0.5   # nur für eine PGlite-Quelle
node scripts/merge-eras.mjs --target <ziel-url> \
  --source pglite:/pfad/zu/data/pglite --source <neon-url> --source <render-url> --dry-run
```

Quellen älteste zuerst. `--dry-run` rollt am Ende zurück und zeigt nur die Zahlen. Das Ziel muss leer sein.
Verlauf, Chat und Feed werden vereinigt, Ereignisse mit kollidierender ID bekommen ein Epochen-Präfix, an
Epochengrenzen werden fehlende Leave/Join-Ereignisse ergänzt. Spieler-Summen (Online-Zeit, Sessions, AFK,
Stream-Zeit, Follower) werden addiert, Spitzenwerte als Maximum übernommen, aktuelle Felder aus der neuesten Epoche.

## Schätzung (`/schaetzung`)

Dieselbe Website noch einmal unter `/schaetzung`, aber mit gefüllten Datenlücken: Zeiten, in denen der Tracker aus
war, und Werte, die erst später erfasst wurden, sind aus dem Verhalten der Spieler hochgerechnet (Sessions nach
Tagesprofil, Zähler schubweise auf die Online-Minuten verteilt, Streams, Zuschauer, Abos, Follower). Geschätzte
Bereiche sind in den Diagrammen schattiert und nennen ihre Konfidenz; Details unter „So funktioniert’s“.

- `node scripts/estimate.mjs` rechnet die Schätzung und legt sie in die Schemas `approx_fill` (Daten) und `approx`
  (Sichten mit den Namen der echten Tabellen) derselben Datenbank. Die echten Tabellen bleiben unangetastet.
  `--if-changed` rechnet nur bei neuen Lücken (spätestens alle 12 Stunden), `--dry-run` schaltet nicht um.
  Exit-Code 3 = Lücken haben sich geändert, die Schätzungs-Website sollte neu starten.
- `npm run build:schaetzung` baut die Ausgabe mit `basePath` `/schaetzung` nach `.next-schaetzung/`,
  `npm run start:schaetzung -- -p 3030` startet sie. Sie liest mit `search_path=approx,public`, schreibt nichts und
  betreibt nie den Tracker.
- `scripts/cached-server.mjs` leitet `/schaetzung/…` an `ESTIMATE_PORT` (Standard 3030) weiter.
- Feste Annahmen stehen oben in `scripts/estimate.mjs`: Start am 10.10.2026 um 12 Uhr, Offtag Montag 26.10.

## Twitch-Verlauf nachtragen

- Der Tracker holt alle 3 Stunden Archiv-VODs und Clips über die Helix-API (`lib/twitchHistory.ts`): Stream-Zeiten
  in Tracker-Lücken werden daraus echte Ereignisse, beliebte Clips werden zum Ereignis „Clip“.
- `node scripts/vod-chat.mjs` (Dauerdienst) liest langsam die Chat-Wiedergabe der VODs, ältestes zuerst, und trägt
  Abos, Geschenk-Abos, Cheers, Raids (mit Zuschauerzahl) und Nachrichten zwischen Spielern nach, wo der Live-Chat
  nichts hat (vor dem 19.10. alles, danach Zeitfenster ohne Live-Aufzeichnung). Tempo nach Frist
  (`--deadline`, Standard 30.11.2026), mindestens 2,5 s zwischen Anfragen. Fortschritt in `vod_chat_progress`.

## Datenbank (PostgreSQL)

- `DATABASE_URL` muss gesetzt sein (siehe `.env.example`), damit die App über `pg` direkt auf PostgreSQL zugreift. Für Render den Internal Database URL verwenden; bei lokaler Entwicklung mit einer Render-Datenbank den External Database URL. Tabellen werden beim Start angelegt.

Tabellen: `tracker_meta` (Status, Rekorde, letzter API-Snapshot), `players`, `events` (Chronik), `history` (Zeitreihe gesamt, einschließlich Spielerzahl), `player_history` (Spielerwerte, Follower-Gesamtstand und Twitch-Kategorie je Messpunkt; Zusatzwerte aus `/api/player` höchstens alle 5 Minuten als kompaktes `extra_stats integer[]`, Reihenfolge in `lib/playerStats.ts`), `player_top_history` (Top-Listen je Spieler: jede Minute nur die geänderten Einträge, stündlich ein vollständiger Stand als Anker), `twitch_chat_messages` (höchstens 10.000 Nachrichten zwischen Spielern; im geteilten Chat einmal je Nachricht, weitere Kanäle in `shared_with`) und `shared_chat_sessions` (geteilte Chats mit Beteiligten, Beginn und Ende). Neue Verlaufsfelder werden mit additiven `IF NOT EXISTS`-Spalten ergänzt; bestehende Daten bleiben erhalten.

Die Datenseiten öffnen sofort mit Überschrift und Platzhaltern (Partial Prerender) und streamen die Daten nach; die Spielerseite lädt dabei jeden Abschnitt einzeln.
Geöffnete Seiten aktualisieren ihre Daten höchstens einmal pro Minute und nur solange der Tab sichtbar ist.

## Was erfasst wird

| Ereignis | Quelle | Wo |
| --- | --- | --- |
| Join / Leave (inkl. Session-Dauer) | `online[]` | Server |
| Tod, Diamanten, Blöcke, Mobs, Strecke, Spielzeit, Herzen, Totems, Essen | Anstieg in `/api/player/<id>` bzw. den Top-10-Boards | Server |
| Weitere Werte (platzierte Blöcke, Sprünge, Truhen, Handel, …), Top-Blöcke und -Mobs, erster Join | `/api/player/<id>`, nur der letzte Stand | Spielerprofil |
| Geteilter Chat (Stream Together): Beginn, Ende, beteiligte Kanäle | Twitch-API `shared_chat/session` (mit `TWITCH_CLIENT_ID`/`SECRET`), sonst aus geteilten Chat-Nachrichten | Twitch, Profil, Live |
| Tode, die keinem bekannten Spieler zuzuordnen sind | `totals.deaths` | Server (ohne Spieler) |
| Stream an / aus / Titel geändert, Peak-Zuschauer | `live[]` | Twitch |
| Twitch-Abos (inkl. Resubs und Geschenk-Abos; normale Summen ab 10 Subs, Geschenke von bekannten Streamern im Feed je Geber und Minute zusammengefasst; nur wenn der Kanal-Streamer auf dem Spielserver online ist) | Twitch IRC `USERNOTICE` | Twitch |
| Raids zwischen bekannten Spielern (mit Zuschauerzahl, falls Twitch sie mitsendet) | Twitch IRC `USERNOTICE` | Twitch |
| Twitch-Subs gesamt, Tagesverlauf und aktuelle Streamsumme | gespeicherte IRC-Abo-Ereignisse | Twitch |
| Follower-Zuwachs während des Serveraufenthalts und Verlauf | Differenz öffentlicher Twitch-GQL-Followerstände zwischen Messungen, bei denen der Spieler online ist | Twitch + Server |
| Follower-Schub (mehr als 20 neue Follower pro Minute auf dem Server) | Differenz der Twitch-GQL-Follower-Messungen während aufeinanderfolgender Server-Messungen | Twitch + Server |
| Server online / offline | `serverOnline` | Server |
| Erster Auftritt eines Spielers (seit Tracker-Start) | `online[]` | Server |
| Rang-Aufstieg in die Top 3 einer Bestenliste | Boards | Server |
| Meilensteine (z. B. 24 h Spielzeit, 1.000 Diamanten, 10. Tod) | Boards | Server |
| Rekorde: meiste gleichzeitig online / live / Zuschauer | Snapshot | Server |
| Pro Spieler: Zeitreihe aller Werte, Follower-Gesamtstand, Rang-Snapshot und Twitch-Kategorie, längste Session, Online-Zeit | abgeleitet | – |

Koordinaten liefert die API nicht. „Wo“ bedeutet daher: auf dem Server oder auf Twitch.

## Seiten

- `/` Übersicht im Look der offiziellen Stats-Seite plus Ereignis-Feed und Verlaufskurven
- `/ereignisse` komplette Chronik mit Filtern (Kategorie, Ort, Spieler) und Seiten
- `/spieler` und `/spieler/<id>` alle erfassten Spieler mit Verlauf, Sessions, Graphen und bei Live-Streamern Twitch-Player plus Chat
- `/events` offizielle Termine von craftattack.one (stündlich abgeglichen)
- `/live` Twitch-Übersicht, Zuschauerkurve und Stream-Chronik
- `/bestenlisten?liste=twitchSubs` Twitch-Abo-Bestenliste; Profile zeigen Gesamtzahl, Tagesgraph und – wenn live – Subs im aktuellen Stream
- `/bestenlisten?liste=followers` Bestenliste des Follower-Zuwachses während der Serverzeit; Profile und eigener Graph zeigen den erfassten Verlauf, keine globalen Twitch-Gesamtstände
- `/api/tracker?limit=200&player=<id>&type=<typ>` JSON-Export, `/api/cron/poll` löst eine authentifizierte Abfrage aus

## Konfiguration

- `DATABASE_URL` PostgreSQL-Verbindung, z. B. `postgres://user:pass@localhost:5432/actracker`
- `CA_STATS_URL` andere API-Adresse
- `CA_PLAYER_URL` Basis-Adresse der Einzelstatistik je Spieler-ID (Standard `https://craftattack.one/api/player`; ersetzt das frühere `CA_EXT_URL`)
- `CA_PLAYER_MAX_PER_POLL` höchstens so viele Einzelstatistik-Anfragen pro Poll (Standard 80); `CA_PLAYER_REQUEST_INTERVAL_MS` Abstand zwischen ihnen (Standard 500, mindestens 250).
- `CA_POLL_INTERVAL_MS` mittleres Abfrageintervall in Millisekunden (Standard 60000, mit ±25 % Jitter; nicht unter die Vorgaben des API-Betreibers setzen)
- `TRACKER_MODE` `all` (Standard), `web` oder `tracker`; siehe [Nur Website oder nur Tracker](#nur-website-oder-nur-tracker).
- `CA_AFK_MINUTES` Minuten ohne Streckenzuwachs, bevor ein Online-Spieler als AFK gilt (Standard 20); historische AFK-Zeiten und Ereignisse werden beim Start neu bewertet.
- `CRON_SECRET` zufälliges Geheimnis für cron-job.org, mit `openssl rand -hex 32` erzeugen. In cron-job.org einen GET-Aufruf an `https://<deine-domain>/api/cron/poll` mit dem Header `Authorization: Bearer <CRON_SECRET>` einrichten. Bereits laufende oder wegen Poll-Abstand pausierte Abfragen antworten mit HTTP 200 und `status: "skipped"`; echte Fehler liefern HTTP 502.
- `WEB_BOT_AUTH_KEY_FILE` (oder `WEB_BOT_AUTH_KEY` mit dem PEM-Inhalt) Ed25519-Schlüssel, mit dem der Tracker Anfragen an craftattack.one signiert (Web Bot Auth, Cloudflare Verified Bots). Erzeugen mit `openssl genpkey -algorithm ed25519 -out web-bot-auth.pem`. Die Website braucht ihn auch, sie liefert das Schlüsselverzeichnis unter `/.well-known/http-message-signatures-directory` aus.
- `CA_PROXY` optional, z. B. `socks5://127.0.0.1:1080`: Anfragen an craftattack.one laufen über diesen Proxy, alles andere (Twitch, Datenbank) direkt. Gedacht für die eigene Internetleitung als Rückkanal: Der Heimrechner verbindet sich per SSH zum Server und öffnet dort einen SOCKS-Proxy, der über die Heimleitung ins Netz geht:
  `ssh -N -R 127.0.0.1:1080 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes <user>@<server>`. Ist er nicht erreichbar, schlagen die Abfragen fehl, es gibt keinen direkten Ersatzweg.
- `TWITCH_IRC_NICK` und `TWITCH_IRC_TOKEN` optional für Twitch-IRC mit `chat:read`; alle bekannten Kanäle werden mit höchstens 20 JOINs in 10 Sekunden (einer alle 500 ms) abonniert. Erfasst werden bekannte Sub-`USERNOTICE`s sowie Raids, wenn sowohl der raidende Spieler als auch der Zielkanal einem Spieler zugeordnet sind.
- Twitch-Subzahlen werden ab Beginn der IRC-Erfassung gezählt und nur erfasst, wenn der Kanal-Streamer bei Eingang der Meldung auf dem Spielserver online ist (AFK zählt als online). Geschenk-USERNOTICEs von bekannten Spielern an einen anderen Streamer werden im Feed pro Geber, Stream und Minute mit Geberbild und aufsummierter Anzahl angezeigt; die einzelnen IRC-Meldungen bleiben für die Statistiken gespeichert. Bereits gespeicherte Minutensummen lassen sich mangels Geberdaten nicht rückwirkend solchen Gebern zuordnen.
- `NEXT_PUBLIC_TWITCH_URL`, `NEXT_PUBLIC_DISCORD_URL`, `NEXT_PUBLIC_GITHUB_URL` optionale Footer-Links (werden beim Build eingebettet)
