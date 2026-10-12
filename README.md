# CraftAttack 14 Tracker

Live unter **https://craftattack.hiorcraft.tv**

> **Hinweis:** Dieses Repo ist der Quellcode des Trackers, der auf craftattack.hiorcraft.tv läuft.
> Es ist nicht als Self-Hosting-Paket gedacht und es gibt dafür keinen Support. Nutz einfach die Live-Seite.
> Für neue Features, Bugfixes oder Ideen sind Pull Requests und Issues aber sehr willkommen.

## Mitmachen

1. Repo forken und klonen, `npm install`
2. `npm run dev` startet die App lokal auf http://localhost:3000. Ohne `DATABASE_URL` nutzt sie eine eingebettete Datenbank (PGlite) unter `data/`, du brauchst also kein PostgreSQL.
3. Änderung machen, `npm run lint` und `npx tsc --noEmit` müssen sauber sein.
4. Pull Request gegen `main` mit kurzer Beschreibung, was und warum.

Ideen, die noch offen sind: Twitch-API-Anbindung (Clips, Kategorie), Discord-Benachrichtigungen bei Highlights, Tages- und Wochenstatistiken, Vergleich zweier Spieler.

Inoffizieller Tracker für CraftAttack 14. Fragt alle 30 Sekunden `https://craftattack.one/api/stats` ab und dazu
für jeden bekannten Spieler `https://craftattack.one/api/ext/<id>` (alle Zähler plus Rang, auch außerhalb der Top 10),
vergleicht den Stand mit dem vorherigen und schreibt jede Änderung als Ereignis mit Zeitstempel auf.

## Starten

```bash
npm install
npm run dev      # http://localhost:3000
```

Der Poller startet automatisch mit dem Server (`instrumentation.ts`).

## Datenbank (PostgreSQL)

- `DATABASE_URL` gesetzt (siehe `.env.example`) → echtes PostgreSQL über `pg`. Tabellen werden beim Start angelegt.
- Nicht gesetzt → eingebettetes PostgreSQL (PGlite) unter `data/pglite`, ohne Installation.

Tabellen: `tracker_meta` (Status, Rekorde, letzter API-Snapshot), `players`, `events` (Chronik), `history` (Zeitreihe gesamt), `player_history` (Zeitreihe pro Spieler).

Alle Seiten werden komplett serverseitig gerendert (SSR, `instant = false`), kein Lade-Skeleton.

## Was erfasst wird

| Ereignis | Quelle | Wo |
| --- | --- | --- |
| Join / Leave (inkl. Session-Dauer) | `online[]` | Server |
| Tod, Diamanten, Blöcke, Mobs, Strecke | Anstieg in `/api/ext/<id>` bzw. den Top-10-Boards | Server |
| Tode, die keinem bekannten Spieler zuzuordnen sind | `totals.deaths` | Server (ohne Spieler) |
| Stream an / aus / Titel geändert, Peak-Zuschauer | `live[]` | Twitch |
| Twitch-Abos (inkl. Resubs und Geschenk-Abos; normale Summen ab 10 Subs, Geschenke von bekannten Streamern als Einzelevent; nur wenn der Kanal-Streamer auf dem Spielserver online ist) | Twitch IRC `USERNOTICE` | Twitch |
| Twitch-Subs gesamt, Tagesverlauf und aktuelle Streamsumme | gespeicherte IRC-Abo-Ereignisse | Twitch |
| Server online / offline | `serverOnline` | Server |
| Erster Auftritt eines Spielers (seit Tracker-Start) | `online[]` | Server |
| Rang-Aufstieg in die Top 3 einer Bestenliste | Boards | Server |
| Meilensteine (z. B. 24 h Spielzeit, 1.000 Diamanten, 10. Tod) | Boards | Server |
| Rekorde: meiste gleichzeitig online / live / Zuschauer | Snapshot | Server |
| Pro Spieler: Zeitreihe aller Werte, längste Session, Online-Zeit | abgeleitet | – |

Koordinaten liefert die API nicht. „Wo“ bedeutet daher: auf dem Server oder auf Twitch.

## Seiten

- `/` Übersicht im Look der offiziellen Stats-Seite plus Ereignis-Feed und Verlaufskurven
- `/ereignisse` komplette Chronik mit Filtern (Kategorie, Ort, Spieler) und Seiten
- `/spieler` und `/spieler/<id>` alle erfassten Spieler mit Verlauf, Sessions, Graphen und bei Live-Streamern Twitch-Player plus Chat
- `/events` offizielle Termine von craftattack.one (stündlich abgeglichen)
- `/live` Twitch-Übersicht, Zuschauerkurve und Stream-Chronik
- `/bestenlisten?liste=twitchSubs` Twitch-Abo-Bestenliste; Profile zeigen Gesamtzahl, Tagesgraph und – wenn live – Subs im aktuellen Stream
- `/api/tracker?limit=200&player=<id>&type=<typ>` JSON-Export, `/api/tracker/poll` löst eine Abfrage manuell aus

## Konfiguration

- `DATABASE_URL` PostgreSQL-Verbindung, z. B. `postgres://user:pass@localhost:5432/actracker`
- `CA_STATS_URL` andere API-Adresse
- `CA_EXT_URL` Basis-Adresse der Einzelstatistik (Standard `https://craftattack.one/api/ext`)
- `CA_EXT_CONCURRENCY` gleichzeitige ext-Anfragen pro Poll (Standard 8)
- `CA_POLL_INTERVAL_MS` Abfrageintervall (Standard 30000)
- `TWITCH_IRC_NICK` und `TWITCH_IRC_TOKEN` optional für Twitch-IRC mit `chat:read`; alle bekannten Kanäle werden mit höchstens 20 JOINs in 10 Sekunden (einer alle 500 ms) abonniert. Es werden nur bekannte Sub-`USERNOTICE`s gespeichert.
- Twitch-Subzahlen werden ab Beginn der IRC-Erfassung gezählt und nur erfasst, wenn der Kanal-Streamer bei Eingang der Meldung auf dem Spielserver online ist (AFK zählt als online). Geschenk-USERNOTICEs von bekannten Spielern an einen anderen Streamer werden einzeln mit Geberbild und Anzahl angezeigt; bereits gespeicherte Minutensummen lassen sich mangels Geberdaten nicht rückwirkend in solche Einzelevents aufteilen.
- `NEXT_PUBLIC_TWITCH_URL`, `NEXT_PUBLIC_DISCORD_URL`, `NEXT_PUBLIC_GITHUB_URL` optionale Footer-Links (werden beim Build eingebettet)
