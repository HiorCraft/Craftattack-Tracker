#!/usr/bin/env bash
# Neue Version ohne Ausfall ausrollen (auf dem Server, im Live-Klon).
#
#   scripts/deploy.sh            git pull, bauen, umschalten, Tracker neu starten
#   scripts/deploy.sh --no-pull  nur bauen und umschalten
#
# Gebaut wird in den gerade NICHT benutzten Ordner (.next-a / .next-b), während die alte Version weiterläuft.
# Danach steht der neue Ordner in .next-active, `.next` zeigt darauf (für den Tracker), und scripts/cached-server.mjs
# bekommt SIGUSR2: Es startet die neue Version daneben, wärmt sie vor und schaltet erst dann um.
# Schlägt der Build fehl, bleibt alles, wie es war.
set -euo pipefail

LIVE="${ACTRACKER_LIVE:-$HOME/actracker-live}"
ENV_FILE="${ACTRACKER_ENV:-$HOME/.config/actracker/web.env}"
NODE="${NODE:-$HOME/.local/node/bin/node}"
URL="${ACTRACKER_URL:-https://craftattack.hiorcraft.tv}"
cd "$LIVE"

before="$(git rev-parse HEAD)"
if [[ "${1:-}" != "--no-pull" ]]; then git pull --ff-only; fi
# Hat sich der Cache-Server selbst geändert, braucht es einmal einen echten Neustart (kurzer Ausfall)
front_changed=""
if ! git diff --quiet "$before" HEAD -- scripts/cached-server.mjs; then front_changed=1; fi

active="$(cat .next-active 2>/dev/null || true)"
if [[ "$active" == ".next-a" ]]; then target=".next-b"; else target=".next-a"; fi
echo "[deploy] aktiv: ${active:-.next}, baue nach $target"

# Statische Dateien der Version, die gleich überschrieben wird, aufheben: Seiten, die Besucher noch offen haben,
# laden sie womöglich nach. Dateinamen enthalten einen Hash, Zusammenführen ist also gefahrlos. Nach 7 Tagen weg.
if [[ -d "$target/static" ]]; then
  mkdir -p .next-static-archive
  cp -rn "$target/static/." .next-static-archive/
fi
if [[ -d .next-static-archive ]]; then
  find .next-static-archive -type f -mtime +7 -delete
  find .next-static-archive -type d -empty -delete
fi
# Nur der ungenutzte Ordner wird geleert (fester Name, nie leer)
rm -rf -- "./$target"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
start=$(date +%s)
DEPLOY_ID="$(git rev-parse --short HEAD)-$start" NEXT_DIST_DIR="$target" NODE_ENV=production nice -n 10 "$NODE" node_modules/next/dist/bin/next build > "/tmp/actracker-build.log" 2>&1 || {
  tail -30 /tmp/actracker-build.log
  echo "[deploy] Build fehlgeschlagen, alte Version läuft weiter"
  exit 1
}
test -f "$target/BUILD_ID" || { echo "[deploy] kein BUILD_ID, Abbruch"; exit 1; }
echo "[deploy] gebaut in $(( $(date +%s) - start )) s"

echo "$target" > .next-active
# `.next` für den Tracker: Verweis auf die aktive Version (einmalig: alter echter Ordner wird beiseitegelegt)
if [[ -d .next && ! -L .next ]]; then mv .next .next-legacy; fi
ln -sfn "$target" .next.tmp && mv -T .next.tmp .next

pid="$(systemctl show -p MainPID --value actracker-web)"
if [[ "$pid" -gt 1 && -n "$front_changed" ]]; then
  kill "$pid"
  echo "[deploy] Cache-Server geändert: Website startet neu (einmalig kurzer Ausfall)"
elif [[ "$pid" -gt 1 ]]; then
  kill -USR2 "$pid"
  echo "[deploy] Website wechselt auf $target (läuft weiter, bis die neue Version bereit ist)"
fi

if systemctl --user is-enabled actracker-tracker >/dev/null 2>&1; then
  systemctl --user restart actracker-tracker
  echo "[deploy] Tracker neu gestartet"
fi

# Auf das Umschalten warten: die alte Version nutzt nach dem Wechsel keinen der beiden Ports mehr doppelt
for _ in $(seq 1 120); do
  [[ -n "$front_changed" ]] && break
  if journalctl -u actracker-web --since "-5 min" --no-pager 2>/dev/null | grep -q "Umgeschaltet auf $target"; then
    echo "[deploy] umgeschaltet"
    break
  fi
  sleep 3
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$URL/")"
echo "[deploy] $URL → $code"
[[ -d .next-legacy ]] && rm -rf -- ./.next-legacy
exit 0
