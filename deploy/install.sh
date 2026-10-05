#!/usr/bin/env bash
# One-time setup on the Raspberry Pi. Run from the project folder:
#   bash deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "Installing pi-kiosk from $APP_DIR"

# ---- system info -------------------------------------------------------------
. /etc/os-release
echo "OS: $PRETTY_NAME ($(uname -m))"
SESSION="${XDG_SESSION_TYPE:-unknown}"
echo "Session type: $SESSION   Desktop: ${XDG_CURRENT_DESKTOP:-unknown}"
if [ "$(uname -m)" != "aarch64" ]; then
  echo "WARNING: this is not a 64-bit OS. Electron works best on Raspberry Pi OS 64-bit."
fi

# ---- Node.js -----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js and npm..."
  sudo apt-get update
  sudo apt-get install -y nodejs npm
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "Node $(node --version)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node 18 or newer is required. Install a newer Node (e.g. from NodeSource) and re-run." >&2
  exit 1
fi

# ---- app dependencies (downloads the ARM64 Electron build) -----------------
cd "$APP_DIR"
rm -rf node_modules   # never reuse node_modules copied from another OS
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
# Lets deploy/update.sh skip reinstalling until package-lock.json changes.
[ -f package-lock.json ] && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.kiosk-lock-hash
chmod +x deploy/*.sh

# ---- autostart at login (works with labwc, wayfire and X11/LXDE) -------------
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/pi-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pi Kiosk
Exec=$APP_DIR/deploy/start.sh
X-GNOME-Autostart-enabled=true
EOF
echo "Autostart entry: $HOME/.config/autostart/pi-kiosk.desktop"

# ---- real touch input (labwc) -------------------------------------------------
# Raspberry Pi OS sets touchscreens to mouse emulation, which turns a finger
# drag into a mouse drag: pages cannot be scrolled and links/images get dragged.
# The kiosk handles real touch, so switch emulation off for configured screens.
LABWC_RC="$HOME/.config/labwc/rc.xml"
if [ -f "$LABWC_RC" ] && grep -q 'mouseEmulation="yes"' "$LABWC_RC"; then
  cp "$LABWC_RC" "$LABWC_RC.bak-kiosk"
  sed -i '/<touch /s/mouseEmulation="yes"/mouseEmulation="no"/' "$LABWC_RC"
  echo "Touchscreen: mouse emulation off in $LABWC_RC (backup: $LABWC_RC.bak-kiosk)"
fi
# The touch entry names the screen with its USB port, e.g. "ILITEK-TP (USB 1-1.1.3)",
# so it stops applying when the cable moves to another port. An empty name
# applies the entry to any touchscreen.
if [ -f "$LABWC_RC" ] && grep -q '<touch deviceName="[^"]*(USB [^)]*)"' "$LABWC_RC"; then
  sed -i 's/<touch deviceName="[^"]*(USB [^)]*)"/<touch deviceName=""/' "$LABWC_RC"
  echo "Touchscreen: settings apply on any USB port"
fi

# ---- audio: prefer HDMI over the 3.5mm jack ---------------------------------
# HDMI and the headphone jack have equal priority, and WirePlumber remembers the
# default sink by HDMI port. If the screen ends up on the other port, the saved
# sink is missing and audio silently falls back to the jack. Ranking every HDMI
# output higher makes it follow whichever port is connected.
WP_CONF="$HOME/.config/wireplumber/wireplumber.conf.d/50-kiosk-prefer-hdmi.conf"
mkdir -p "$(dirname "$WP_CONF")"
cat > "$WP_CONF" <<'EOF'
# pi-kiosk: prefer whichever HDMI output exists over the 3.5mm jack.
monitor.alsa.rules = [
  {
    matches = [ { node.name = "~alsa_output.*hdmi.*" } ]
    actions = { update-props = { priority.session = 2000, priority.driver = 2000 } }
  }
]
EOF
echo "Audio: HDMI preferred over the headphone jack ($WP_CONF)"

# ---- desktop autologin and no screen blanking ------------------------------
if command -v raspi-config >/dev/null 2>&1; then
  echo "Enabling desktop autologin and disabling screen blanking..."
  sudo raspi-config nonint do_boot_behaviour B4 || echo "  (could not set autologin; use raspi-config > System > Boot / Auto Login)"
  sudo raspi-config nonint do_blanking 1 || echo "  (could not disable blanking; use raspi-config > Display > Screen Blanking)"
fi

IP="$(hostname -I | awk '{print $1}')"
cat <<EOF

Done. Reboot to start the kiosk:  sudo reboot

  Config from another device:  http://$IP:8080/
  Remote setup switcher:       http://$IP:8080/overlay/
  On the touchscreen:          swipe down from the top edge (or long press the top-left corner)
  Log file:                    ~/.cache/pi-kiosk.log
  Test without rebooting:      $APP_DIR/deploy/start.sh
EOF
