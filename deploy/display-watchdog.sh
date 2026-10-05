#!/usr/bin/env bash
# Turns the screen back on after it loses power (e.g. a smart plug on the
# monitor). labwc disables the output when the monitor goes away and leaves it
# off when it returns, so the kiosk keeps running on a black screen. Started by
# start.sh; checks every few seconds for a connected but disabled HDMI output.

LOG="${XDG_CACHE_HOME:-$HOME/.cache}/pi-kiosk.log"

command -v wlr-randr >/dev/null 2>&1 || exit 0

while true; do
  for c in /sys/class/drm/card*-HDMI-A-*; do
    [ -e "$c/status" ] || continue
    if [ "$(cat "$c/status")" = connected ] && [ "$(cat "$c/enabled")" = disabled ]; then
      out="${c##*/card[0-9]-}"   # card1-HDMI-A-2 -> HDMI-A-2
      sleep 2                    # let the monitor finish waking up
      # A disabled output has no mode, so a plain --on fails; ask for the preferred one.
      if wlr-randr --output "$out" --on --preferred >/dev/null 2>&1; then
        echo "=== $(date) display watchdog: turned $out back on ===" >> "$LOG"
      fi
    fi
  done
  sleep 5
done
