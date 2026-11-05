-- FOMO-Offday: Server zu vom 26.10.2026 02:00 bis 27.10.2026 09:00 deutscher Zeit
-- (Winterzeit: 2026-10-26 01:00Z bis 2026-10-27 08:00Z). Der Tracker war vom 25.10. 17:33Z bis 27.10. 08:11Z aus.
-- Die Lücke VOR dem Offday (25.10. 17:33Z bis 26.10. 01:00Z) bleibt für die Lückenanalyse; hier geht es nur darum,
-- dass im Offday nichts auf dem Server passiert ist und Sessions/Streams dazu passen.
--
--   psql "$DATABASE_URL" -v commit=0 -f scripts/fixes/2026-10-26-offday.sql   Probelauf (ROLLBACK)
--   psql "$DATABASE_URL" -v commit=1 -f scripts/fixes/2026-10-26-offday.sql   ausführen (Tracker vorher stoppen!)
--
-- Vorher gesicherte Zeilen: offday_backup_events, offday_backup_players. Eingefügte Verlaufspunkte liegen alle im
-- Fenster (dort gab es vorher keine): DELETE FROM history/player_history WHERE at im Fenster macht sie rückgängig.
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE w AS SELECT timestamptz '2026-10-26 01:00Z' AS a, timestamptz '2026-10-27 08:00Z' AS b,
  timestamptz '2026-10-27 08:11:29.326Z' AS restart;

-- Sicherung
CREATE TABLE IF NOT EXISTS offday_backup_events AS SELECT * FROM events WHERE false;
CREATE TABLE IF NOT EXISTS offday_backup_players AS SELECT id, tracked_seconds, longest_session FROM players WHERE false;

/* ---------- 1. Server-Verlauf: alle 5 Min, niemand online, Zähler stehen ---------- */
INSERT INTO history (at, online_count, player_count, live_count, viewers, playtime_seconds, deaths)
SELECT t, 0, f.player_count, 0, 0, f.playtime_seconds, f.deaths
  FROM generate_series((SELECT a FROM w), (SELECT b FROM w), interval '5 min') t,
       (SELECT * FROM history WHERE at >= (SELECT b FROM w) ORDER BY at LIMIT 1) f
ON CONFLICT (at) DO NOTHING;

/* ---------- 2. Spieler-Verlauf: stündlich offline, Zähler = erster Stand danach (sonst letzter davor) ---------- */
INSERT INTO player_history (player, at, online, viewers, playtime_seconds, deaths, diamonds, blocks_broken, mobs_killed,
  distance, damage_dealt, totems_used, food_eaten, followers_on_server, followers_total, ranks, stream_game_id, stream_game_name, extra_stats)
SELECT p.player, t, false, NULL,
  coalesce(af.playtime_seconds, bf.playtime_seconds), coalesce(af.deaths, bf.deaths), coalesce(af.diamonds, bf.diamonds),
  coalesce(af.blocks_broken, bf.blocks_broken), coalesce(af.mobs_killed, bf.mobs_killed), coalesce(af.distance, bf.distance),
  coalesce(af.damage_dealt, bf.damage_dealt), coalesce(af.totems_used, bf.totems_used), coalesce(af.food_eaten, bf.food_eaten),
  NULL, NULL, NULL, NULL, NULL, coalesce(af.extra_stats, bf.extra_stats)
FROM (SELECT DISTINCT player FROM player_history WHERE at < (SELECT a FROM w)) p
CROSS JOIN generate_series((SELECT a FROM w), (SELECT b FROM w), interval '1 hour') t
LEFT JOIN LATERAL (
  SELECT
    (SELECT playtime_seconds FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND playtime_seconds IS NOT NULL ORDER BY at LIMIT 1) AS playtime_seconds,
    (SELECT deaths FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND deaths IS NOT NULL ORDER BY at LIMIT 1) AS deaths,
    (SELECT diamonds FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND diamonds IS NOT NULL ORDER BY at LIMIT 1) AS diamonds,
    (SELECT blocks_broken FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND blocks_broken IS NOT NULL ORDER BY at LIMIT 1) AS blocks_broken,
    (SELECT mobs_killed FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND mobs_killed IS NOT NULL ORDER BY at LIMIT 1) AS mobs_killed,
    (SELECT distance FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND distance IS NOT NULL ORDER BY at LIMIT 1) AS distance,
    (SELECT damage_dealt FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND damage_dealt IS NOT NULL ORDER BY at LIMIT 1) AS damage_dealt,
    (SELECT totems_used FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND totems_used IS NOT NULL ORDER BY at LIMIT 1) AS totems_used,
    (SELECT food_eaten FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND food_eaten IS NOT NULL ORDER BY at LIMIT 1) AS food_eaten,
    (SELECT extra_stats FROM player_history h WHERE h.player = p.player AND h.at >= (SELECT b FROM w) AND extra_stats IS NOT NULL ORDER BY at LIMIT 1) AS extra_stats
) af ON true
LEFT JOIN LATERAL (
  SELECT
    (SELECT playtime_seconds FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND playtime_seconds IS NOT NULL ORDER BY at DESC LIMIT 1) AS playtime_seconds,
    (SELECT deaths FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND deaths IS NOT NULL ORDER BY at DESC LIMIT 1) AS deaths,
    (SELECT diamonds FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND diamonds IS NOT NULL ORDER BY at DESC LIMIT 1) AS diamonds,
    (SELECT blocks_broken FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND blocks_broken IS NOT NULL ORDER BY at DESC LIMIT 1) AS blocks_broken,
    (SELECT mobs_killed FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND mobs_killed IS NOT NULL ORDER BY at DESC LIMIT 1) AS mobs_killed,
    (SELECT distance FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND distance IS NOT NULL ORDER BY at DESC LIMIT 1) AS distance,
    (SELECT damage_dealt FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND damage_dealt IS NOT NULL ORDER BY at DESC LIMIT 1) AS damage_dealt,
    (SELECT totems_used FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND totems_used IS NOT NULL ORDER BY at DESC LIMIT 1) AS totems_used,
    (SELECT food_eaten FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND food_eaten IS NOT NULL ORDER BY at DESC LIMIT 1) AS food_eaten,
    (SELECT extra_stats FROM player_history h WHERE h.player = p.player AND h.at < (SELECT a FROM w) AND extra_stats IS NOT NULL ORDER BY at DESC LIMIT 1) AS extra_stats
) bf ON true
ON CONFLICT (player, at) DO NOTHING;

/* ---------- 3. Subs/Cheers im Offday: niemand war auf dem Server ---------- */
INSERT INTO offday_backup_events SELECT * FROM events
 WHERE at >= (SELECT a FROM w) AND at < (SELECT b FROM w) AND (meta->>'serverOnline' = 'true' OR meta->>'onServer' = 'true');
UPDATE events SET meta = meta || '{"serverOnline": false}'
 WHERE at >= (SELECT a FROM w) AND at < (SELECT b FROM w) AND meta->>'serverOnline' = 'true';
UPDATE events SET meta = meta || '{"onServer": false}'
 WHERE at >= (SELECT a FROM w) AND at < (SELECT b FROM w) AND meta->>'onServer' = 'true';
UPDATE twitch_cheers SET on_server = false WHERE at >= (SELECT a FROM w) AND at < (SELECT b FROM w) AND on_server;
UPDATE twitch_subs SET on_server = false WHERE at >= (SELECT a FROM w) AND at < (SELECT b FROM w) AND on_server;

/* ---------- 4. Server-Sessions: niemand war im Offday online ---------- */
-- Offene Sessions von vor dem Ausfall (letztes Join/Leave vor 25.10. 17:34Z ist ein Join)
CREATE TEMP TABLE open_s AS
SELECT DISTINCT ON (player) player, type, at AS joined FROM events
 WHERE type IN ('join', 'first_join', 'leave') AND at <= '2026-10-25 17:34Z' ORDER BY player, at DESC;
DELETE FROM open_s WHERE type = 'leave';
ALTER TABLE open_s ADD COLUMN next_id text, ADD COLUMN next_type text, ADD COLUMN next_at timestamptz;
UPDATE open_s o SET next_id = (SELECT id FROM events e WHERE e.player = o.player AND e.type IN ('join', 'first_join', 'leave') AND e.at > '2026-10-25 17:34Z' ORDER BY at, id LIMIT 1);
UPDATE open_s o SET next_type = e.type, next_at = e.at FROM events e WHERE e.id = o.next_id;

INSERT INTO offday_backup_players SELECT id, tracked_seconds, longest_session FROM players WHERE id IN (SELECT player FROM open_s);
INSERT INTO offday_backup_events SELECT * FROM events WHERE id IN (SELECT next_id FROM open_s WHERE next_type = 'leave')
  OR id IN (SELECT e.id FROM events e JOIN open_s o ON e.player = o.player WHERE e.type = 'leave' AND o.next_type = 'leave' AND o.next_at > (SELECT restart FROM w)
            AND e.at = o.next_at);

-- 4a. Leave beim Neustart → Leave zu Beginn des Offdays; die 31 Std. 11 Min. auch von der Online-Zeit abziehen
CREATE TEMP TABLE cut AS SELECT round(extract(epoch FROM (SELECT restart - a FROM w)))::int AS s;
UPDATE players p SET tracked_seconds = greatest(0, p.tracked_seconds - (SELECT s FROM cut))
  FROM open_s o WHERE o.player = p.id AND o.next_type = 'leave';
UPDATE events e SET at = (SELECT a FROM w),
  meta = coalesce(e.meta, '{}') || jsonb_build_object('sessionSeconds', round(extract(epoch FROM ((SELECT a FROM w) - o.joined)))::int,
                                                      'offdayFix', true, 'originalAt', to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM open_s o WHERE e.id = o.next_id AND o.next_type = 'leave' AND o.next_at = (SELECT restart FROM w);
-- 4b. Beim Neustart wieder online, Session lief weiter: Leave zum Offday-Beginn, Join beim Neustart, späteres Leave kürzen
INSERT INTO events (id, at, type, player, player_name, uuid, "where", meta)
SELECT 'offday-leave-' || o.player, (SELECT a FROM w), 'leave', o.player, p.name, p.uuid, 'server',
       jsonb_build_object('sessionSeconds', round(extract(epoch FROM ((SELECT a FROM w) - o.joined)))::int, 'offdayFix', true)
  FROM open_s o JOIN players p ON p.id = o.player WHERE o.next_type = 'leave' AND o.next_at > (SELECT restart FROM w);
INSERT INTO events (id, at, type, player, player_name, uuid, "where", meta)
SELECT 'offday-join-' || o.player, (SELECT restart FROM w), 'join', o.player, p.name, p.uuid, 'server', '{"offdayFix": true}'
  FROM open_s o JOIN players p ON p.id = o.player WHERE o.next_type = 'leave' AND o.next_at > (SELECT restart FROM w);
UPDATE events e SET meta = coalesce(e.meta, '{}') || jsonb_build_object('sessionSeconds', round(extract(epoch FROM (e.at - (SELECT restart FROM w))))::int, 'offdayFix', true)
  FROM open_s o WHERE e.id = o.next_id AND o.next_type = 'leave' AND o.next_at > (SELECT restart FROM w);
-- 4c. Join ohne jedes Leave seit dem 24.10.: Leave beim letzten Online-Punkt (die Lücke selbst klärt die Lückenanalyse)
INSERT INTO events (id, at, type, player, player_name, uuid, "where", meta)
SELECT 'offday-leave-' || o.player, l.at, 'leave', o.player, p.name, p.uuid, 'server',
       jsonb_build_object('sessionSeconds', round(extract(epoch FROM (l.at - o.joined)))::int, 'offdayFix', true, 'basis', 'zuletzt online gesehen')
  FROM open_s o JOIN players p ON p.id = o.player
  CROSS JOIN LATERAL (SELECT max(at) AS at FROM player_history h WHERE h.player = o.player AND h.online AND h.at < '2026-10-25 17:34Z') l
 WHERE o.next_type <> 'leave' AND l.at > o.joined;
-- 4d. AFK-Ende, das der Neustart-Leave auslöste: mit an den Offday-Beginn
INSERT INTO offday_backup_events SELECT * FROM events WHERE at = (SELECT restart FROM w) AND type IN ('afk_end', 'afk_mobs_end', 'afk_blocks_end') AND meta->>'byLeave' = 'true'
  AND player IN (SELECT player FROM open_s WHERE next_type = 'leave' AND next_at = (SELECT restart FROM w));
UPDATE events SET at = (SELECT a FROM w),
  meta = meta || jsonb_build_object('afkSeconds', greatest(0, (meta->>'afkSeconds')::int - (SELECT s FROM cut)), 'offdayFix', true)
 WHERE at = (SELECT restart FROM w) AND type IN ('afk_end', 'afk_mobs_end', 'afk_blocks_end') AND meta->>'byLeave' = 'true'
   AND player IN (SELECT player FROM open_s WHERE next_type = 'leave' AND next_at = (SELECT restart FROM w));
-- Längste Session neu, wenn die aufgeblähte Session der Rekord war
UPDATE players p SET longest_session = m.mx
  FROM (SELECT e.player, max((e.meta->>'sessionSeconds')::int) AS mx FROM events e WHERE e.type = 'leave' AND e.player IN (SELECT player FROM open_s) GROUP BY 1) m,
       offday_backup_events b
 WHERE m.player = p.id AND b.player = p.id AND b.type = 'leave' AND (b.meta->>'sessionSeconds')::int = p.longest_session AND m.mx < p.longest_session;

/* ---------- 5. Streams: Start-/Endzeiten nach VODs und Twitch-Startzeit ---------- */
-- Starts beim Neustart: echte Startzeit steht in meta.startedAt (von Twitch)
CREATE TEMP TABLE rs AS SELECT id, player, (meta->>'startedAt')::timestamptz AS started FROM events
 WHERE type = 'stream_start' AND at = (SELECT restart FROM w) AND meta ? 'startedAt';
INSERT INTO offday_backup_events SELECT * FROM events WHERE id IN (SELECT id FROM rs);
-- 5a. Doppelt: ein VOD-Start derselben Sendung (±60 s) gibt es schon → Neustart-Start löschen
DELETE FROM events e USING rs WHERE e.id = rs.id AND EXISTS (
  SELECT 1 FROM events v WHERE v.player = rs.player AND v.type = 'stream_start' AND v.id LIKE 'vod-start-%' AND abs(extract(epoch FROM (v.at - rs.started))) <= 60);
-- 5b. Sonst: auf die echte Startzeit legen (1 s nach einem Ende zur selben Zeit, z. B. 48-Std.-Grenze von Twitch)
UPDATE events e SET at = rs.started + CASE WHEN EXISTS (SELECT 1 FROM events x WHERE x.player = rs.player AND x.type = 'stream_end' AND x.at = rs.started) THEN interval '1 s' ELSE interval '0' END,
  meta = e.meta || jsonb_build_object('offdayFix', true, 'originalAt', '2026-10-27T08:11:29.326Z')
         || CASE WHEN rs.started < (SELECT b FROM w) THEN '{"onServer": false}'::jsonb ELSE '{}'::jsonb END
  FROM rs WHERE e.id = rs.id;
-- 5c. nooreax: 20-s-VOD um 08:39 mitten im laufenden Stream (Ende der alten Sendung laut Twitch 08:41:43) → weg
INSERT INTO offday_backup_events SELECT * FROM events WHERE id = 'vod-start-2911171874';
DELETE FROM events WHERE id = 'vod-start-2911171874';
-- 5d. Zweites Ende einer Sendung, die laut VOD schon beendet war (veralteter Stand beim Neustart) → löschen
CREATE TEMP TABLE dup_end AS SELECT e.id FROM events e WHERE e.type = 'stream_end' AND e.id NOT LIKE 'vod-end-%'
   AND e.at >= '2026-10-26 01:00Z' AND e.at <= (SELECT restart FROM w) AND e.meta ? 'vodId'
   AND EXISTS (SELECT 1 FROM events v WHERE v.id = 'vod-end-' || (e.meta->>'vodId') AND v.at <= e.at);
INSERT INTO offday_backup_events SELECT * FROM events WHERE id IN (SELECT id FROM dup_end);
DELETE FROM events WHERE id IN (SELECT id FROM dup_end);
-- 5e. Ende beim Neustart, obwohl der Kanal vorher ausgeraidet hat → Ende beim Raid
CREATE TEMP TABLE raid_end AS SELECT e.id, r.at AS raided FROM events e
  CROSS JOIN LATERAL (SELECT max(at) AS at FROM events r WHERE r.player = e.player AND r.type = 'raid' AND r.meta ? 'raidTargetLogin' AND (r.meta->>'raidTargetPlayerId') IS DISTINCT FROM r.player
                        AND r.at > '2026-10-25 17:00Z' AND r.at < e.at) r
 WHERE e.type = 'stream_end' AND e.at = (SELECT restart FROM w) AND r.at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM events s WHERE s.player = e.player AND s.type = 'stream_start' AND s.at > r.at AND s.at < e.at);
INSERT INTO offday_backup_events SELECT * FROM events WHERE id IN (SELECT id FROM raid_end);
UPDATE events e SET at = raid_end.raided + interval '1 s',
  meta = e.meta || jsonb_build_object('streamSeconds', greatest(0, (e.meta->>'streamSeconds')::int - round(extract(epoch FROM ((SELECT restart FROM w) - raid_end.raided)))::int),
                                      'offdayFix', true, 'basis', 'Raid', 'originalAt', '2026-10-27T08:11:29.326Z')
  FROM raid_end WHERE e.id = raid_end.id;

/* ---------- Bericht ---------- */
SELECT 'history im Fenster' AS was, count(*) FROM history WHERE at >= (SELECT a FROM w) AND at <= (SELECT b FROM w)
UNION ALL SELECT 'player_history im Fenster', count(*) FROM player_history WHERE at >= (SELECT a FROM w) AND at <= (SELECT b FROM w)
UNION ALL SELECT 'Subs/Cheers noch auf Server', count(*) FROM events WHERE at >= (SELECT a FROM w) AND at < (SELECT b FROM w) AND (meta->>'serverOnline' = 'true' OR meta->>'onServer' = 'true')
UNION ALL SELECT 'Sessions über den Offday', count(*) FROM (SELECT DISTINCT ON (player) player, type FROM events WHERE type IN ('join','first_join','leave') AND at <= (SELECT a FROM w) ORDER BY player, at DESC, id DESC) x WHERE type <> 'leave'
UNION ALL SELECT 'gesicherte Ereignisse', count(*) FROM offday_backup_events
UNION ALL SELECT 'gesicherte Spieler', count(*) FROM offday_backup_players;
SELECT b.player, b.type, b.at AS vorher, e.at AS nachher, b.id FROM offday_backup_events b LEFT JOIN events e ON e.id = b.id
 WHERE b.type IN ('stream_start', 'stream_end') ORDER BY b.player, b.at;
SELECT b.id, b.longest_session AS vorher, p.longest_session AS nachher, b.tracked_seconds - p.tracked_seconds AS weniger_s
  FROM offday_backup_players b JOIN players p ON p.id = b.id WHERE b.longest_session <> p.longest_session OR b.tracked_seconds <> p.tracked_seconds ORDER BY 1 LIMIT 60;

\if :commit
COMMIT;
\else
ROLLBACK;
\endif
