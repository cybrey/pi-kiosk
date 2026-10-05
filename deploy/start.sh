#!/usr/bin/env bash
# Launches the kiosk and restarts it if it crashes.
# Exit codes: 0 = "Exit to desktop" (stop), 75 = restart requested (menu,
# /api/restart, deploy) -> restart immediately, anything else = crash -> retry in 3 s.

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
LOG="$LOG_DIR/pi-kiosk.log"
mkdir -p "$LOG_DIR"

# Keep the log from growing forever.
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5000000 ]; then
  mv "$LOG" "$LOG.1"
fi

cd "$APP_DIR" || exit 1
export ELECTRON_DISABLE_SECURITY_WARNINGS=1
export KIOSK_SUPERVISED=1   # tells the app to exit with 75 to restart

# Screen back on after the monitor loses power (see display-watchdog.sh).
pkill -f deploy/display-watchdog.sh 2>/dev/null
"$APP_DIR/deploy/display-watchdog.sh" &

while true; do
  echo "=== $(date) starting kiosk ===" >> "$LOG"
  ./node_modules/.bin/electron . >> "$LOG" 2>&1
  code=$?
  echo "=== $(date) kiosk exited with code $code ===" >> "$LOG"
  [ "$code" -eq 0 ] && break
  [ "$code" -eq 75 ] && continue
  sleep 3
done
