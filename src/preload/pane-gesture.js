'use strict';

// Injected into every pane (sandboxed). Detects the hidden gestures without
// exposing anything to the page:
//   - swipe down starting at the top edge of the *screen*  -> open the menu
//   - swipe in from the right / left edge of the screen    -> next / previous setup
//   - long press in the top-left corner of the screen      -> open the menu (optional)
// Listeners are passive and in the capture phase on window, so pages that call
// preventDefault / stopPropagation cannot swallow them.

const { ipcRenderer, webFrame, contextBridge } = require('electron');

// ---- low-power video (per-site option) ---------------------------------------
// Electron decodes video on the CPU on the Pi, and VP9/AV1 at 1080p+ is too much
// for a Pi 4. Tell the page that only H.264 up to 720p30 is playable, so sites
// that pick a format (YouTube) send one the Pi can decode smoothly. Like the
// "h264ify" browser extensions. Runs in the page's world before its scripts.
function limitVideo() {
  const MAX_W = 1280;
  const MAX_H = 720;
  const MAX_FPS = 30;
  const heavyCodec = /\b(vp0?9|vp8|av01|av1|hev1|hvc1)/i;
  const num = (re, s) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : 0;
  };
  const tooMuch = (type) => {
    const s = String(type || '');
    return heavyCodec.test(s)
      || num(/width=(\d+)/, s) > MAX_W
      || num(/height=(\d+)/, s) > MAX_H
      || num(/framerate=(\d+)/, s) > MAX_FPS;
  };

  for (const name of ['MediaSource', 'ManagedMediaSource', 'WebKitMediaSource']) {
    const MS = window[name];
    if (!MS || typeof MS.isTypeSupported !== 'function') continue;
    const original = MS.isTypeSupported.bind(MS);
    MS.isTypeSupported = (type) => !tooMuch(type) && original(type);
  }

  const canPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (type) {
    return tooMuch(type) ? '' : canPlayType.call(this, type);
  };

  const caps = navigator.mediaCapabilities;
  if (caps && typeof caps.decodingInfo === 'function') {
    const decodingInfo = caps.decodingInfo.bind(caps);
    caps.decodingInfo = (config) => {
      const v = config && config.video;
      if (v && (heavyCodec.test(v.contentType || '') || v.width > MAX_W || v.height > MAX_H || v.framerate > MAX_FPS)) {
        return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      }
      return decodingInfo(config);
    };
  }
}

try {
  const site = ipcRenderer.sendSync('kiosk:pane-site-sync');
  if (site && site.lowPowerVideo) contextBridge.executeInMainWorld({ func: limitVideo });
} catch {
  // Placeholder pages and errors: nothing to limit.
}

let info = {
  gestureEdgePx: 40,
  gestureDistancePx: 120,
  cornerLongPress: true,
  edgeSwipe: true,
  sideEdgePx: 30,
  hideCursor: false,
  rect: { x: 0, y: 0, width: 0, height: 0 },
  win: { width: 0, height: 0 },
};

const CORNER_PX = 60;
const LONG_PRESS_MS = 1500;
const MOVE_TOLERANCE_PX = 15;

let start = null; // { x, y, edge: 'top' | 'left' | 'right' | null }
let pressTimer = null;

function fire(channel, ...args) {
  cancel();
  ipcRenderer.send(channel, ...args);
}

function cancel() {
  start = null;
  clearTimeout(pressTimer);
  pressTimer = null;
}

// Event coordinates are CSS pixels; with a zoomed site they differ from window
// pixels, so scale by the zoom factor before comparing with window geometry.
function toWindow(x, y) {
  const z = webFrame.getZoomFactor();
  return { x: x * z + info.rect.x, y: y * z + info.rect.y };
}

function begin(clientX, clientY) {
  const p = toWindow(clientX, clientY);
  let edge = null;
  if (p.y <= info.gestureEdgePx) edge = 'top';
  else if (info.edgeSwipe && p.x <= info.sideEdgePx) edge = 'left';
  else if (info.edgeSwipe && info.win.width && p.x >= info.win.width - info.sideEdgePx) edge = 'right';
  const inCorner = info.cornerLongPress && p.x <= CORNER_PX && p.y <= CORNER_PX;
  if (!edge && !inCorner) return;
  start = { ...p, edge };
  if (inCorner) pressTimer = setTimeout(() => fire('kiosk:open-overlay'), LONG_PRESS_MS);
}

function move(clientX, clientY) {
  if (!start) return;
  const p = toWindow(clientX, clientY);
  const dx = p.x - start.x;
  const dy = p.y - start.y;
  if (pressTimer && Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  const dist = info.gestureDistancePx;
  if (start.edge === 'top' && dy >= dist && Math.abs(dx) < dy) fire('kiosk:open-overlay');
  // Like phone home screens: drag in from the right to go to the next setup.
  else if (start.edge === 'right' && -dx >= dist && Math.abs(dy) < -dx) fire('kiosk:swipe', 'next');
  else if (start.edge === 'left' && dx >= dist && Math.abs(dy) < dx) fire('kiosk:swipe', 'prev');
}

const opts = { capture: true, passive: true };

// Touch (the real touchscreen). Single finger only.
window.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return cancel();
  begin(e.touches[0].clientX, e.touches[0].clientY);
}, opts);
window.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 1) return cancel();
  move(e.touches[0].clientX, e.touches[0].clientY);
}, opts);
window.addEventListener('touchend', cancel, opts);
window.addEventListener('touchcancel', cancel, opts);

// Mouse (development on a desktop). Touch input also produces pointer events,
// so only react to real mice here.
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button === 0) begin(e.clientX, e.clientY);
}, opts);
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && e.buttons === 1) move(e.clientX, e.clientY);
}, opts);
window.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') cancel();
}, opts);

// ---- no drag and drop -------------------------------------------------------
// With labwc's touch mouse emulation on (the Raspberry Pi OS default; install.sh
// turns it off) a finger that wobbles on a link, image or selected text starts
// an HTML drag. On the Pi (Wayland) Chromium then fails
// to start the system drag ("Invalid state when trying to start drag") and
// stays stuck in it, ignoring every touch until restarted. A kiosk never needs
// drag and drop, so cancel it before it starts.
window.addEventListener('dragstart', (e) => e.preventDefault(), { capture: true });

// ---- cursor hiding --------------------------------------------------------

const CURSOR_STYLE_ID = '__kiosk_hide_cursor';

function applyCursor() {
  const root = document.documentElement;
  if (!root) return;
  let el = document.getElementById(CURSOR_STYLE_ID);
  if (info.hideCursor && !el) {
    el = document.createElement('style');
    el.id = CURSOR_STYLE_ID;
    el.textContent = '*, *::before, *::after { cursor: none !important; }';
    root.appendChild(el);
  } else if (!info.hideCursor && el) {
    el.remove();
  }
}

function setInfo(next) {
  if (next) info = next;
  applyCursor();
}

ipcRenderer.on('kiosk:pane-info', (_e, next) => setInfo(next));
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.invoke('kiosk:pane-info').then(setInfo).catch(() => {});
});
