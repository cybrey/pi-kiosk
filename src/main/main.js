'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, BaseWindow, ipcMain, powerSaveBlocker, dialog, session, screen } = require('electron');
const { ConfigStore, DEFAULT_PATH } = require('./config-store');

const CONFIG_PATH = process.env.KIOSK_CONFIG || DEFAULT_PATH;
const { PaneManager, PARTITION } = require('./pane-manager');
const { Overlay } = require('./overlay');
const { Keyboard } = require('./keyboard');
const { Display } = require('./display');
const { Toast } = require('./toast');
const { startServer } = require('./server');

// ---- Chromium switches (must be set before 'ready') ------------------------
if (process.platform === 'linux') {
  // Run natively on Wayland (labwc/wayfire on Raspberry Pi OS), fall back to X11.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Lets the on-screen keyboard (squeekboard/wvkbd) type into fields under Wayland.
  app.commandLine.appendSwitch('enable-wayland-ime');
  // Use the Pi's GPU even though Chromium's blocklist distrusts it, and draw
  // pages on the GPU, leaving the CPU free for video decoding (Electron decodes
  // video in software on the Pi).
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
}
app.commandLine.appendSwitch('touch-events', 'enabled');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Vulkan: ignore-gpu-blocklist (below) would turn it on, but it does not work with Wayland.
app.commandLine.appendSwitch('disable-features', 'Translate,HardwareMediaKeyHandling,Vulkan');
app.commandLine.appendSwitch('disable-pinch'); // stop accidental zooming on the touchscreen
app.commandLine.appendSwitch('overscroll-history-navigation', '0');

// Remote debugging for troubleshooting a pane, off by default. Enable with the
// KIOSK_DEBUG_PORT env var, or by writing a port number to debug-port next to the
// config file (then restart). It listens on 127.0.0.1 only; reach it over SSH:
//   ssh -L 9222:127.0.0.1:9222 <pi>   then open http://localhost:9222 in Chrome.
const DEBUG_PORT = process.env.KIOSK_DEBUG_PORT || (() => {
  try {
    return fs.readFileSync(path.join(path.dirname(CONFIG_PATH), 'debug-port'), 'utf8').trim();
  } catch {
    return '';
  }
})();
if (/^\d+$/.test(DEBUG_PORT)) {
  app.commandLine.appendSwitch('remote-debugging-port', DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  // The main process too (Node inspector), on the next port up.
  require('inspector').open(Number(DEBUG_PORT) + 1, '127.0.0.1');
}

// Fullscreen kiosk by default on the Pi; windowed on dev machines unless asked.
const FULLSCREEN = process.env.KIOSK_FULLSCREEN
  ? process.env.KIOSK_FULLSCREEN === '1'
  : process.platform === 'linux';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Under deploy/start.sh, exit code 75 makes the wrapper restart us immediately,
// keeping its crash-restart loop in charge. Otherwise relaunch ourselves.
const RESTART_EXIT_CODE = 75;
function restartApp() {
  if (process.env.KIOSK_SUPERVISED) {
    app.exit(RESTART_EXIT_CODE);
  } else {
    app.relaunch();
    app.exit(0);
  }
}

// Power off the Pi. Saves logins and cookies first. The desktop user may power
// off without a password (polkit allows it for the active local session). Only
// once systemd has accepted the request does the app exit, with code 0 so
// start.sh does not relaunch it. If it is refused, the kiosk keeps running.
async function shutdownSystem() {
  if (process.platform !== 'linux') return { error: 'only available on the Pi' };
  for (const ses of [session.defaultSession, session.fromPartition(PARTITION)]) {
    ses.flushStorageData();
    await ses.cookies.flushStore().catch(() => {});
  }
  return new Promise((resolve) => {
    execFile('systemctl', ['poweroff'], { timeout: 15_000 }, (err, _stdout, stderr) => {
      if (err) {
        console.error('[kiosk] poweroff failed', err.message, stderr);
        resolve({ error: String(stderr || err.message).trim() });
        return;
      }
      console.log('[kiosk] powering off');
      resolve({ ok: true });
      setTimeout(() => app.exit(0), 500); // let the reply reach the page first
    });
  });
}

// Next / previous setup from a swipe or Ctrl+Shift+←/→: the panes slide across.
// (Switches from the menu or the API change instantly.)
let pendingSlide;
function slideStep(direction) {
  pendingSlide = direction;
  try {
    display.step(direction);
  } finally {
    pendingSlide = undefined;
  }
}

let win;
let store;
let display;
let panes;
let overlay;
let toast;
let keyboard;

function createWindow() {
  // Start at the screen's size in kiosk mode: under Wayland (labwc) the switch to
  // fullscreen happens after creation, and the window may not report a resize.
  const { width, height } = FULLSCREEN ? screen.getPrimaryDisplay().size : { width: 1280, height: 800 };
  win = new BaseWindow({
    width,
    height,
    backgroundColor: '#000000',
    frame: !FULLSCREEN,
    fullscreen: FULLSCREEN,
    kiosk: FULLSCREEN,
    autoHideMenuBar: true,
    title: 'Kiosk',
  });
  win.setMenu?.(null);

  let laidOut = '';
  const relayout = () => {
    const size = win.getContentSize().join('x');
    if (!panes || size === laidOut) return; // panes not created yet: they lay out on creation
    laidOut = size;
    keyboard.resize();
    panes.apply();
    overlay.resize();
    toast.hide();
  };
  for (const event of ['resize', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'restore']) {
    win.on(event, relayout);
  }
  // Belt and braces: the compositor can settle the final size a moment after
  // startup without any of the events above.
  for (const ms of [500, 1500, 3000, 6000]) setTimeout(relayout, ms);
  win.on('closed', () => app.quit());
}

function registerIpc() {
  ipcMain.handle('kiosk:pane-info', (e) => panes.infoFor(e.sender));
  // Synchronous: the pane preload needs this before the page's own scripts run.
  ipcMain.on('kiosk:pane-site-sync', (e) => {
    const site = panes.siteFor(e.sender);
    e.returnValue = { lowPowerVideo: !!site?.lowPowerVideo };
  });
  ipcMain.on('kiosk:open-overlay', () => overlay.show());
  ipcMain.on('kiosk:swipe', (_e, dir) => {
    if (!overlay.visible) slideStep(dir === 'prev' ? 'prev' : 'next');
  });

  // On-screen keyboard: edit box focus from any page, key presses from the keyboard view.
  ipcMain.on('kiosk:kb-show', (e, kind) => keyboard.show(e.sender, kind));
  ipcMain.on('kiosk:kb-hide', (e) => keyboard.hideFor(e.sender));
  ipcMain.on('kiosk:kb-key', (e, key) => {
    if (keyboard.isKeyboard(e.sender)) keyboard.press(key);
  });

  // Overlay-only actions: ignore anything not sent by the overlay view.
  const fromOverlay = (fn) => (e, ...args) => {
    if (overlay.isOverlay(e.sender)) fn(...args);
  };
  ipcMain.on('kiosk:overlay-close', fromOverlay(() => overlay.hide()));
  ipcMain.on('kiosk:reload-panes', fromOverlay(() => panes.reloadAll()));
  ipcMain.on('kiosk:restart', fromOverlay(restartApp));
  ipcMain.on('kiosk:exit', fromOverlay(() => app.exit(0)));
  ipcMain.handle('kiosk:shutdown', (e) =>
    overlay.isOverlay(e.sender) ? shutdownSystem() : { error: 'not allowed' });
}

// Keyboard fallbacks, active in every pane and the overlay:
//   Ctrl+Shift+K  toggle the menu
//   Ctrl+Shift+R  reload all panes
//   Ctrl+Shift+←/→ previous / next setup
//   Escape        close the menu
//   Ctrl+Shift+I  devtools for the focused view (debugging)
function registerShortcuts() {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('focus', () => keyboard?.onFocus(wc));
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      const combo = input.control && input.shift;
      if (combo && key === 'k') {
        overlay.toggle();
      } else if (combo && key === 'r') {
        panes.reloadAll();
      } else if (combo && (key === 'arrowleft' || key === 'arrowright')) {
        slideStep(key === 'arrowleft' ? 'prev' : 'next');
      } else if (combo && key === 'i') {
        wc.openDevTools({ mode: 'detach' });
      } else if (key === 'escape' && overlay.visible && overlay.isOverlay(wc)) {
        overlay.hide();
      } else {
        return;
      }
      event.preventDefault();
    });
  });
}

async function main() {
  store = new ConfigStore();
  display = new Display(store);
  console.log(`[kiosk] config: ${store.filePath}`);

  let port;
  try {
    ({ port } = await startServer(store, display, {
      reloadPanes: () => panes?.reloadAll(),
      restart: () => {
        setTimeout(restartApp, 300); // let the HTTP response go out first
      },
      screenSize: () => {
        const [width, height] = win ? win.getContentSize() : [1280, 800];
        return { width, height };
      },
    }));
    console.log(`[kiosk] config UI: http://localhost:${port}/`);
  } catch (err) {
    dialog.showErrorBox('Kiosk', `Could not start the config server: ${err.message}`);
    app.exit(1);
    return;
  }

  createWindow();
  // Before any page loads: it registers the edit-box focus preload on both sessions.
  keyboard = new Keyboard(
    win,
    [session.defaultSession, session.fromPartition(PARTITION)],
    () => store.get().settings.onScreenKeyboard,
  );
  panes = new PaneManager(win, store, () => display.activeId());
  overlay = new Overlay(win, `http://127.0.0.1:${port}`);
  toast = new Toast(win);
  overlay.onHide = () => keyboard.hideFor(overlay.view.webContents);
  registerIpc();

  // Make room for the keyboard in whatever it is typing into (the menu or the panes).
  keyboard.on('change', () => {
    const inset = keyboard.visible ? keyboard.height : 0;
    const forOverlay = keyboard.visible && overlay.isOverlay(keyboard.target);
    overlay.setBottomInset(forOverlay ? inset : 0);
    panes.setBottomInset(forOverlay ? 0 : inset);
  });

  store.on('changed', (next, prev) => {
    if (!next.settings.onScreenKeyboard) keyboard.hide();
    panes.onConfigChanged(next, prev);
  });

  // Re-layout whenever the on-screen setup changes (menu, swipe, API, revert),
  // and briefly show its name.
  let shownId = display.activeId();
  display.on('changed', (state) => {
    panes.apply({ slide: state.activeSetupId !== shownId ? pendingSlide : undefined });
    if (state.activeSetupId === shownId) return;
    shownId = state.activeSetupId;
    if (!overlay.isOverlay(keyboard.target)) keyboard.hide(); // its pane may be gone
    if (overlay.visible || !store.get().settings.showSwitchToast || !state.activeSetupName) return;
    const note = state.temporary && state.secondsLeft ? `${state.secondsLeft}s` : '';
    toast.show(state.activeSetupName, note);
  });
  panes.apply();

  // What the GPU is doing for us (shows up in ~/.cache/pi-kiosk.log).
  app.once('gpu-info-update', () => {
    const s = app.getGPUFeatureStatus();
    console.log(`[kiosk] gpu: compositing=${s.gpu_compositing} rasterization=${s.rasterization} video_decode=${s.video_decode} webgl=${s.webgl} vulkan=${s.vulkan}`);
  });

  // Keep the display awake while the kiosk runs.
  powerSaveBlocker.start('prevent-display-sleep');

  // No setups yet (fresh install with an emptied config): go straight to the menu.
  if (!store.getActiveSetup()) overlay.show();
}

registerShortcuts();

app.on('second-instance', () => {
  if (win) win.focus();
});

app.on('child-process-gone', (_e, details) => {
  console.warn(`[kiosk] child process gone: ${details.type} (${details.reason})`);
});

process.on('uncaughtException', (err) => {
  console.error('[kiosk] uncaught exception', err);
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(main);
