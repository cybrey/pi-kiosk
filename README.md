# Pi Kiosk

A multi-pane touchscreen kiosk browser for the Raspberry Pi 4, built with Electron.

- Show 1–4 borderless browser panes, e.g. Home Assistant on the left and cameras on the right.
- Keep a **site library** (name + URL + zoom + auto-reload) and reuse sites across **setups** (a layout plus a site per pane).
- **Hidden menu:** swipe down from the top edge of the screen, or long-press the top-left corner. The menu switches setups instantly and leads into the full configuration.
- Configure on the touchscreen, or from any browser on your network at `http://<pi-ip>:8080/`.
- Each pane is a real browser view, not an iframe, so sites that refuse to be embedded (Home Assistant, Frigate, UniFi Protect, Blue Iris, …) work. Logins persist across reboots.

## What you need

- **Raspberry Pi 4** (2 GB works; 4 GB is better for several camera streams). A Pi 5 should also work.
- **A good power supply:** the official 5.1 V 3 A USB-C supply, or a USB-C PD charger (45 W or more). A 2 A phone charger causes freezes and under-voltage warnings.
- **A microSD card**, 16 GB or larger (A1/A2 rated).
- **A touchscreen monitor** connected by HDMI (use the port next to the USB-C power socket, HDMI 0) plus its USB cable for touch.
- **A PC** on the same network for the setup and for editing the configuration. The steps below use Windows; macOS and Linux work the same way.

## Install

### 1. Flash Raspberry Pi OS

1. Install [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your PC and insert the SD card.
2. Choose **Device:** Raspberry Pi 4. **OS:** Raspberry Pi OS (64-bit), the one *with desktop*, not Lite. **Storage:** your SD card. Bookworm and Trixie both work.
3. When it asks about OS customisation, choose **Edit settings** and set:
   - **Hostname:** e.g. `kiosk`, so the Pi is reachable at `kiosk.local`.
   - **Username and password:** e.g. `admin`. You will need these for SSH and `sudo`.
   - **Wi-Fi** name, password and country (skip this if you use Ethernet, which is recommended for camera streams).
   - **Locale:** your time zone and keyboard layout.
   - On the **Services** tab: tick **Enable SSH** (password authentication).
4. Write the card, put it in the Pi, connect the screen and the touch USB cable, then power it on. The first boot takes a few minutes and ends at the desktop.

### 2. Find the Pi on your network

From the PC:

```powershell
ping kiosk.local
```

If the name doesn't resolve, find the Pi's IP address in your router's device list, or open a terminal on the Pi and run `hostname -I`. Give the Pi a **fixed IP address** (a DHCP reservation in your router) so the address you use for the configuration and for Home Assistant never changes.

### 3. Install the kiosk

Pick **one** of these two methods.

#### Option A: from your PC with `deploy.ps1` (recommended if you will change the code)

Clone the repo on your PC, then from the project folder in PowerShell:

```powershell
git clone https://github.com/cybrey/pi-kiosk.git
cd pi-kiosk
.\deploy.ps1 -Target admin@kiosk.local -SetupKey   # enter the Pi password one last time
.\deploy.ps1 -Install                              # asks for your sudo password on the Pi
```

`-SetupKey` saves the Pi's address in `.deploy-target`, which is not committed, and copies your SSH key so you aren't asked for a password again. `-Install` uploads the code to `~/pi-kiosk` on the Pi and runs `deploy/install.sh` there. If PowerShell refuses to run the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

#### Option B: directly on the Pi with git

SSH in (`ssh admin@kiosk.local`), or open a terminal on the Pi, and run:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/cybrey/pi-kiosk.git ~/pi-kiosk
cd ~/pi-kiosk
bash deploy/install.sh
```

If the repo is private, `git clone` asks for a username and password. Use your GitHub username and a [personal access token](https://github.com/settings/tokens) (read-only "Contents" access to this repo) as the password, or install the GitHub CLI (`sudo apt install gh`) and run `gh auth login` first.

#### What `install.sh` does

- Installs Node.js and npm from the Raspberry Pi OS repositories (Node 18 or newer is required).
- Runs `npm ci`, which downloads the ARM64 Electron build. This takes a few minutes.
- Adds an autostart entry (`~/.config/autostart/pi-kiosk.desktop`) that runs `deploy/start.sh` at login. `start.sh` restarts the app if it crashes, and also starts the display watchdog that turns the screen back on after the monitor loses power.
- Turns off touchscreen mouse emulation in labwc, so a finger drag scrolls pages instead of dragging links. Your original `rc.xml` is backed up.
- Makes audio prefer HDMI over the 3.5 mm headphone jack.
- Enables desktop autologin and turns off screen blanking (via `raspi-config`).

It is safe to run again.

### 4. Reboot

```bash
sudo reboot
```

The Pi boots straight into the kiosk, full screen. The first start shows two example setups (Home Assistant and example.com). To check the app without rebooting, run `~/pi-kiosk/deploy/start.sh` from a terminal on the Pi.

### 5. Configure your sites

From a PC or phone on the same network, open **`http://kiosk.local:8080/`** (or `http://<pi-ip>:8080/`):

1. **Sites tab:** add each page you want to show (name, URL, zoom, optional auto-reload). Delete the examples.
2. **Setups tab:** create a setup, pick a layout, and choose a site for each pane.
3. **Settings tab:** set a **PIN** if other people on your network shouldn't be able to change the kiosk, and adjust gestures, keyboard and cursor to taste.
4. On the touchscreen, log in to each site once (e.g. Home Assistant). Logins are saved and survive reboots.

Your settings live **only on the Pi**, in `~/.config/pi-kiosk/config.json`. They are never part of the repo and are not touched by updates. To keep a copy, use Settings → **Export config** and keep the file somewhere outside this repo folder. Export files are git-ignored anyway, in case you forget.

## Updating

**From the PC** (if you used Option A):

```powershell
git pull              # if you are updating from GitHub
npm run deploy        # or .\deploy.ps1
```

It uploads `src/`, `deploy/` and the package files (about 40 KB, never `node_modules`), replaces the old `src/` and `deploy/` folders, and runs `npm ci` only if `package-lock.json` changed. Then it restarts the kiosk through `POST /api/restart`, which comes back within a couple of seconds. Your config and logins on the Pi are untouched. `deploy.ps1` needs nothing extra installed: Windows already has `ssh`, `scp` and `tar`.

**On the Pi** (if you used Option B):

```bash
cd ~/pi-kiosk
git pull
bash deploy/update.sh   # reinstalls dependencies only if needed, then restarts the kiosk
```

## Running the Pi day to day

- **Turning it off:** Menu → Configure → Settings → Kiosk app → **Shut down**. Wait until the green light stops flashing before you unplug it. Pulling the power on a running Pi can corrupt the SD card.
- **Turning it on:** plug the power back in. A Pi 4 has no power button and boots whenever it gets power.
- **Exit to the desktop / restart the app:** Configure → Settings → Kiosk app. After "Exit to desktop", run `~/pi-kiosk/deploy/start.sh` or reboot to bring the kiosk back.
- **Screen off at night:** switching the monitor off with a smart plug on a schedule is fine. The display watchdog turns the screen back on when the power returns, and the touchscreen USB comes back with the monitor.
- **SSH in:** `ssh admin@kiosk.local`

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Kiosk doesn't start after a reboot | `tail -50 ~/.cache/pi-kiosk.log`. Check that autologin is on: `sudo raspi-config` → System Options → Boot / Auto Login → Desktop Autologin. |
| Black screen after the monitor was switched off and on | The display watchdog should fix it within a few seconds. Check that it is running: `pgrep -af display-watchdog`. |
| Touch doesn't respond, or drags links instead of scrolling | `grep "\[overlay\]" ~/.cache/pi-kiosk.log`. Check that `~/.config/labwc/rc.xml` has `<touch deviceName="" mouseEmulation="no"/>`, then reboot. |
| No sound | Audio may have fallen back to the headphone jack. Re-run `bash deploy/install.sh` (it adds the HDMI preference), and use the HDMI port next to the power socket. |
| Random freezes, lightning-bolt icon | The power supply is too weak. See [What you need](#what-you-need). |
| Can't reach `http://<pi-ip>:8080/` | Is the kiosk running? Is the PC on the same network? Try the IP address instead of `kiosk.local`. |
| A site won't load (certificate error) | Settings → "Accept self-signed HTTPS certificates" (on by default, for local devices like Frigate or UniFi). |

## Using it

| Action | How |
| --- | --- |
| Open the menu | Swipe down from the top edge · long-press the top-left corner (1.5 s) · `Ctrl+Shift+K` |
| Switch setup | Tap a setup card in the menu |
| Next / previous setup | Swipe in from the right / left edge · `Ctrl+Shift+→` / `Ctrl+Shift+←` |
| Configure | Menu → **Configure**, or `http://<pi-ip>:8080/` from a PC or phone |
| Switch setups from a phone | `http://<pi-ip>:8080/overlay/` |
| Reload all panes | Menu → **Reload**, or `Ctrl+Shift+R` |
| Close the menu | Tap outside it · swipe it up · ✕ · `Esc` |
| Exit / restart the app | Configure → Settings → Kiosk app |
| Type into an edit box | Tap it: the on-screen keyboard slides up and the panes (or menu) shrink to make room. ⌨ ▾ closes it; tap the field again to reopen. Number fields get a keypad |

**Setups** let you pick a layout (single, two columns, two rows, left + 2 stacked, top + 2 below, three columns, grid of 4). Drag the sliders to set the split sizes, then choose a site for each pane. You can create a new site straight from a pane's dropdown.

**Swiping between setups** works like virtual desktops: swipe in from the right edge for the next setup, or from the left edge for the previous one. It wraps around, in the order on the Setups tab (use ↑/↓ to reorder). To keep a setup out of the swipe rotation (e.g. a doorbell screen only used by automations), untick "Include when swiping" in its editor. After each switch, the setup's name shows briefly at the bottom of the screen.

**Settings** cover: gesture sensitivity, gap between panes, cursor hiding, the on-screen keyboard (turn it off if a real keyboard is attached), how many hidden sites stay loaded (instant switching versus memory; hidden sites are muted, their video and audio paused, and auto-reload waits until they are back on screen), self-signed certificate handling, an optional **PIN** for editing from other devices, and backup (export/import).

Typing long URLs on the touchscreen is painful, so do most editing from a PC.

## Remote control (Home Assistant, scripts)

| Call | Effect |
| --- | --- |
| `POST /api/activate/<id or name>` | Switch to a setup (saved; survives reboot) |
| `POST /api/activate/<id or name>?duration=30` | Show a setup for 30 s, then return to the previous one (not saved) |
| `POST /api/next` · `POST /api/prev` | Next / previous setup in the swipe rotation |
| `POST /api/revert` | End a temporary display now |
| `GET /api/state` | What is on screen, whether it is temporary, seconds left |
| `POST /api/restart` | Restart the kiosk app (used by `deploy.ps1`) |

The setup can be given by id or by name (case-insensitive, URL-encoded). Each setup's ID is shown on its card in the Setups tab and in its editor. The ID is created from the name when the setup is first saved, and stays the same if you rename the setup. Calling the same temporary activation again (the doorbell is pressed twice) restarts the countdown. Changing setup by hand during a temporary display cancels the return. If a PIN is set, send it as the `x-kiosk-pin` header.

Home Assistant example (`configuration.yaml`):

```yaml
rest_command:
  kiosk_show:
    url: "http://<pi-ip>:8080/api/activate/{{ setup }}?duration={{ seconds | default(0) }}"
    method: POST
    headers:
      x-kiosk-pin: "1234"   # only if a PIN is set
```

Automation action, triggered by the doorbell:

```yaml
action: rest_command.kiosk_show
data:
  setup: doorbell
  seconds: 30
```

## Files

- Config: `~/.config/pi-kiosk/config.json` (override the path with the `KIOSK_CONFIG` env var)
- Log: `~/.cache/pi-kiosk.log`
- Browser profile (cookies/logins): Electron's userData folder, `~/.config/pi-kiosk/` (partition `persist:kiosk`)

## Development (Windows/macOS/Linux)

```bash
npm install
npm start                 # windowed; drag down from the top with the mouse to open the menu
KIOSK_FULLSCREEN=1 npm start
npm test                  # layout + config store unit tests
```

Structure:

```
src/main/        Electron main process: window, pane views, overlay, config store, HTTP API
src/preload/     pane-gesture.js (hidden swipe detection in every pane), overlay-bridge.js,
                 keyboard-focus.js (edit-box focus detection in every page), keyboard-bridge.js
src/renderer/    overlay (setup switcher), config (settings UI), keyboard, pane error/empty pages, shared CSS/JS
deploy/          install.sh (first-time setup), start.sh (launcher, restarts on crash),
                 update.sh (after deploy/git pull), display-watchdog.sh
test/            node:test unit tests
```

## Notes

- Home Assistant: log in once in its pane. The session is stored and survives reboots. HA has a "kiosk mode" add-on (HACS) if you also want to hide its sidebar.
- If a site misses the swipe (rare), use the corner long-press instead, or increase "Top edge size" in Settings.
- On a 2 GB Pi with 4 camera streams, lower "Cached hidden sites" to 0–2.
