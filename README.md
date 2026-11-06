# CraftAttack 14 Tracker

Inoffizieller Tracker für CraftAttack 14, live unter **https://craftattack.hiorcraft.tv**.

Er fragt regelmäßig die öffentliche API von craftattack.one und Twitch ab, vergleicht jeden Stand mit dem vorigen
und schreibt jede Änderung als Ereignis mit Zeitstempel auf: Joins, Tode, Diamanten, Streams, Abos, Raids und mehr.

> Dieses Repo ist der Quellcode der Live-Seite, kein Self-Hosting-Paket; dafür gibt es keinen Support.
> Issues und Pull Requests für Fehler, Features und Ideen sind sehr willkommen.

## Inhalt

- [Mitmachen](#mitmachen)
- [Seiten](#seiten)
- [Was erfasst wird](#was-erfasst-wird)
- [Rücksicht auf craftattack.one](#rücksicht-auf-craftattackone)
- [Betrieb](#betrieb)
- [Konfiguration](#konfiguration)
- [Datenbank](#datenbank)
- [Werkzeuge](#werkzeuge)

## Mitmachen

1. Repo forken und klonen, `npm install`.
2. `DATABASE_URL` in `.env.local` setzen (siehe `.env.example`). Tabellen legt die App beim Start selbst an.
3. `npm run dev` startet Website und Tracker auf http://localhost:3000.
4. Vor dem Pull Request müssen `npm run lint` und `npx tsc --noEmit` sauber sein.
5. Pull Request gegen `main` mit kurzer Beschreibung, was und warum.

Offene Ideen: Discord-Benachrichtigungen bei Highlights, Vergleich zweier Spieler.

## Seiten

| Bereich | Seiten |
| --- | --- |
| Jetzt | `/` Übersicht und Ereignis-Feed · `/live` Streams, Zuschauerkurve · `/events` offizielle Termine |
| Spieler | `/spieler`, `/spieler/<id>` Profil mit Verlauf, Sessions, Graphen, Stream und Chat |
| Bestenlisten | `/bestenlisten?liste=<wert>`, z. B. `twitchSubs` oder `followers` |
| Verlauf | `/ereignisse` Chronik mit Filtern · `/zeitstrahl` · `/graph` eigene Graphen · `/statistik` |
| Community | `/verbindungen` Netz, Distanz und Gruppen der Spieler · `/zuschauer` |

Dazu `/so-funktionierts` (Erklärungen) und die JSON-API `/api/tracker?limit=200&player=<id>&type=<typ>`.

Seiten öffnen sofort mit Platzhaltern und streamen die Daten nach (Partial Prerender). Offene Seiten aktualisieren
sich höchstens einmal pro Minute, solange der Tab sichtbar ist.

## Was erfasst wird

| Ereignis | Quelle |
| --- | --- |
| Join / Leave mit Session-Dauer, erster Auftritt, AFK | `online[]` der Stats-API |
| Tode, Diamanten, Blöcke, Mobs, Strecke, Spielzeit, Herzen, Totems, Essen | Anstieg in `/api/player/<id>` bzw. den Top-10-Boards |
| Weitere Werte (Sprünge, Truhen, Handel …), Top-Blöcke und -Mobs | `/api/player/<id>`, nur der letzte Stand |
| Tode ohne bekannten Spieler | `totals.deaths` |
| Rang-Aufstiege in die Top 3, Meilensteine, Rekorde (online, live, Zuschauer) | abgeleitet aus Boards und Snapshots |
| Server online / offline | `serverOnline` |
| Stream an / aus, Titel, Peak-Zuschauer | `live[]`, Twitch-API |
| Abos, Resubs, Geschenk-Abos (nur, während der Streamer auf dem Server ist) | Twitch-IRC `USERNOTICE` |
| Raids zwischen Spielern, Nachrichten im Chat eines anderen Spielers | Twitch-IRC |
| Geteilter Chat (Stream Together) mit Beteiligten, Beginn und Ende | Twitch-API `shared_chat/session` |
| Follower-Zuwachs während der Serverzeit, Follower-Schübe | öffentliche Twitch-Followerstände je Messung |
| Stream-Zeiten in Tracker-Lücken, beliebte Clips | Twitch-VODs und Clips (alle 3 Stunden) |

Koordinaten liefert die API nicht; „wo“ heißt immer: auf dem Server oder auf Twitch.

## Rücksicht auf craftattack.one

- `/api/stats` wird in zufälligen Abständen von 45 bis 75 Sekunden abgefragt (im Mittel einmal pro Minute).
- `/api/player/<id>` nur für Spieler, die online sind oder es beim vorigen Poll waren; höchstens 80 Anfragen pro
  Poll, mindestens 500 ms Abstand. Kommt keine frische Antwort, bleibt die alte 15 Minuten gültig.
- Bei Cloudflare-Challenges, HTTP 403/429 oder Cloudflare-5xx pausiert der Tracker mindestens fünf Minuten, bei
  wiederholten Sperren exponentiell länger bis höchstens sechs Stunden. `Retry-After` gilt als Mindestwartezeit.
  Während der Pause gibt es keine Probe-Anfragen; Bild-Proxys antworten mit `503` statt auszuweichen.
  Nach 24 Stunden ohne Sperre beginnt die Eskalation wieder bei fünf Minuten.
- Anfragen werden mit Web Bot Auth signiert (siehe `WEB_BOT_AUTH_KEY_FILE`).

Das garantiert nicht, dass es keine Sperre gibt. Bei einer Sperre an den Betreiber wenden, statt Schutzmaßnahmen
zu umgehen.

## Betrieb

### Website und Tracker trennen

`TRACKER_MODE` legt fest, was ein Prozess übernimmt. Beide teilen sich dieselbe Datenbank; der Tracker schreibt,
die Website liest.

| Modus | Befehl | Verhalten |
| --- | --- | --- |
| `all` (Standard) | `npm run dev` / `npm start` | Website und Tracker im selben Prozess |
| `web` | `npm run dev:web` / `npm run start:web` | Nur die Website. Gleicht sich höchstens alle 30 s mit der DB ab, alle 6 Stunden vollständig. Poll-Endpunkte antworten mit 409. |
| `tracker` | `npm run dev:tracker` / `npm run start:tracker` | Nur Poller, Twitch-IRC und Nachträge. Seiten antworten mit 503, erreichbar bleiben `/api/tracker` und die Poll-Endpunkte. |

Auf einem Rechner brauchen beide verschiedene Ports, z. B. `PORT=3001 npm run start:tracker`.

### Live-Server

- `npm run start:cached` (`scripts/cached-server.mjs`) steht vor der Website: Kurzzeit-Cache für viele Besucher,
  höchstens zwei gleichzeitige Renderings, Wechsel auf neue Versionen ohne Ausfall.
- `scripts/deploy.sh` rollt aus: `git pull`, Build in den freien Ordner `.next-a` / `.next-b`, vorwärmen,
  umschalten, danach den Tracker-Dienst neu starten. Schlägt der Build fehl, bleibt alles, wie es war.
- `scripts/watchdog.mjs` prüft alle paar Minuten Tunnel, Tracker, Website, Dienste und Speicherplatz und meldet
  anhaltende Probleme per ntfy (`NTFY_URL`).

### Render

`render.yaml` richtet einen Starter-Web-Service (512 MB) ein. Der Heap ist auf 280 MB Old Space plus 16 MB
Semi Space begrenzt, teure Abfragen werden zwischengespeichert (`lib/swrCache.ts`) und `/api/warm` füllt sie nach
dem Start. Beim Blueprint `DATABASE_URL` (die **Internal Database URL**) und `CRON_SECRET` eintragen; Twitch-Daten
sind optional. Mehr Luft gibt es, wenn der Tracker als eigener Worker mit `npm run start:tracker` läuft.

## Konfiguration

Alle Variablen mit Beispielen stehen in `.env.example`.

| Variable | Bedeutung |
| --- | --- |
| `DATABASE_URL` | PostgreSQL, z. B. `postgres://user:pass@localhost:5432/actracker`. Verbindungen nutzen TLS; selbstsignierte Zertifikate (Render) werden akzeptiert. |
| `TRACKER_MODE` | `all`, `web` oder `tracker`, siehe [oben](#website-und-tracker-trennen) |
| `CRON_SECRET` | Geheimnis für `GET /api/cron/poll` mit `Authorization: Bearer <CRON_SECRET>` (nur an den Tracker richten). Erzeugen mit `openssl rand -hex 32`. |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Twitch-App: Live-Status, Zuschauer, geteilter Chat, VOD-Links, Clips |
| `TWITCH_IRC_NICK`, `TWITCH_IRC_TOKEN` | Twitch-IRC mit `chat:read` für Abos, Raids und Chat-Nachrichten (höchstens 20 JOINs je 10 s) |
| `WEB_BOT_AUTH_KEY_FILE` / `WEB_BOT_AUTH_KEY` | Ed25519-Schlüssel zum Signieren der Anfragen; die Website veröffentlicht das Verzeichnis unter `/.well-known/http-message-signatures-directory`. Erzeugen mit `openssl genpkey -algorithm ed25519 -out web-bot-auth.pem`. |
| `CA_PROXY` | Optional, z. B. `socks5://127.0.0.1:1080`: nur Anfragen an craftattack.one laufen darüber, z. B. über die eigene Heimleitung per `ssh -N -R 127.0.0.1:1080 <user>@<server>`. Ohne Proxy schlagen sie fehl, es gibt keinen Ersatzweg. |
| `CA_STATS_URL`, `CA_PLAYER_URL` | Andere API-Adressen |
| `CA_POLL_INTERVAL_MS` | Mittleres Abfrageintervall (Standard 60000, ±25 %); nicht unter die Vorgaben des Betreibers setzen |
| `CA_PLAYER_MAX_PER_POLL`, `CA_PLAYER_REQUEST_INTERVAL_MS` | Einzelstatistiken je Poll (Standard 80) und Abstand (Standard 500 ms, mindestens 250) |
| `CA_AFK_MINUTES` | Minuten ohne Bewegung, bevor ein Spieler als AFK gilt (Standard 5) |
| `NEXT_PUBLIC_TWITCH_URL`, `NEXT_PUBLIC_DISCORD_URL`, `NEXT_PUBLIC_GITHUB_URL` | Footer-Links (beim Build eingebettet) |

## Datenbank

PostgreSQL über `pg`. Tabellen werden beim Start angelegt; neue Felder kommen als `ADD COLUMN IF NOT EXISTS` dazu,
bestehende Daten bleiben.

| Tabelle | Inhalt |
| --- | --- |
| `tracker_meta` | Status, Rekorde, letzter API-Snapshot |
| `players` | Spieler mit Summen (Online-Zeit, Sessions, AFK, Stream-Zeit, Follower) |
| `events` | Chronik aller Ereignisse |
| `history` | Zeitreihe gesamt, einschließlich Spielerzahl |
| `player_history` | Werte je Spieler und Messpunkt; Zusatzwerte höchstens alle 5 Minuten als `extra_stats integer[]` (Reihenfolge in `lib/playerStats.ts`) |
| `player_top_history` | Top-Listen je Spieler: geänderte Einträge jede Minute, stündlich ein vollständiger Anker |
| `twitch_chat_messages` | Nachrichten zwischen Spielern (im geteilten Chat einmal je Nachricht) |
| `shared_chat_sessions` | Geteilte Chats mit Beteiligten, Beginn und Ende |

## Werkzeuge

### Twitch-Chat aus VODs nachtragen

`node scripts/vod-chat.mjs` (Dauerdienst) liest langsam die Chat-Wiedergabe der VODs, ältestes zuerst, und trägt
Abos, Cheers, Raids und Nachrichten zwischen Spielern nach, wo der Live-Chat fehlt. Das Tempo richtet sich nach der
Frist (`--deadline`, Standard 30.11.2026), mindestens 2,5 s zwischen Anfragen. Fortschritt in `vod_chat_progress`.

### Schätzung (`/schaetzung`)

Dieselbe Website mit gefüllten Datenlücken: Zeiten ohne Tracker und spät erfasste Werte sind aus dem Verhalten
der Spieler hochgerechnet und in Diagrammen schattiert.

- `node scripts/estimate.mjs` schreibt in die Schemas `approx_fill` und `approx` derselben DB, die echten Tabellen
  bleiben unberührt. `--if-changed` rechnet nur bei neuen Lücken, `--dry-run` schaltet nicht um. Exit-Code 3 heißt,
  die Schätzungs-Website sollte neu starten.
- `npm run build:schaetzung` und `npm run start:schaetzung -- -p 3030` bauen und starten sie (nur lesend, nie mit
  Tracker). `scripts/cached-server.mjs` leitet `/schaetzung/…` an `ESTIMATE_PORT` (Standard 3030) weiter.
- Feste Annahmen stehen oben in `scripts/estimate.mjs` (Start 10.10.2026, 12 Uhr; Offtag Montag 26.10.).

### Datenbanken zusammenführen

`scripts/merge-eras.mjs` führt die Datenbanken mehrerer Tracker-Epochen (PGlite, Neon, Render) in eine leere,
schon angelegte Ziel-DB zusammen, Quellen älteste zuerst:

```bash
npm i --no-save @electric-sql/pglite@0.5   # nur für eine PGlite-Quelle
node scripts/merge-eras.mjs --target <ziel-url> \
  --source pglite:/pfad/zu/data/pglite --source <neon-url> --source <render-url> --dry-run
```

Verläufe werden vereinigt, kollidierende Ereignis-IDs bekommen ein Epochen-Präfix, an den Grenzen fehlende
Leave/Join-Ereignisse werden ergänzt. Spieler-Summen werden addiert, Spitzenwerte als Maximum übernommen.
`--dry-run` rollt am Ende zurück und zeigt nur die Zahlen.

### Einmalige Korrekturen

`scripts/fixes/` enthält SQL für einmalige Datenkorrekturen, z. B. den Offtag am 26.10.
