#!/usr/bin/env bash
# Runs on the Pi after deploy.ps1 has uploaded new code:
#   - reinstalls dependencies only if package-lock.json changed
#   - restarts the running kiosk app
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
chmod +x deploy/*.sh

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed. Run the first-time install:  .\\deploy.ps1 -Install" >&2
  exit 1
fi

STAMP="node_modules/.kiosk-lock-hash"
LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  echo "Dependencies changed - running npm ci (this can take a few minutes)..."
  npm ci --omit=dev --no-audit --no-fund
  echo "$LOCK_HASH" > "$STAMP"
else
  echo "Dependencies unchanged."
fi

CONFIG="${KIOSK_CONFIG:-$HOME/.config/pi-kiosk/config.json}"
PORT="$(node -p "require('$CONFIG').settings.port" 2>/dev/null || echo 8080)"

# Loopback requests never need the PIN.
if curl -fsS -m 5 -X POST "http://127.0.0.1:$PORT/api/restart" >/dev/null 2>&1; then
  echo "Kiosk restarted with the new code."
else
  echo "Kiosk app is not running, so nothing was restarted."
  echo "It will start with the new code at the next login/reboot (sudo reboot)."
fi
