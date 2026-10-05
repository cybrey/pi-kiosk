'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { WebContentsView } = require('electron');

const PAGE = path.join(__dirname, '..', 'renderer', 'keyboard', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'keyboard-bridge.js');
const FOCUS_PRELOAD = path.join(__dirname, '..', 'preload', 'keyboard-focus.js');
const KINDS = new Set(['text', 'email', 'url', 'number', 'tel']);
// Accelerator key names for the non-text keys.
const KEY_CODES = { backspace: 'Backspace', enter: 'Enter', left: 'Left', right: 'Right' };
// When another view takes focus, wait this long before hiding: if it was a tap
// on an edit box in another pane, that pane asks for the keyboard right away.
const HIDE_DELAY_MS = 150;

/**
 * Built-in on-screen keyboard. The kiosk has only a touchscreen, and the OS
 * keyboard (squeekboard) is not reliably there or on top of a fullscreen app.
 *
 * keyboard-focus.js runs in every page (registered on the given sessions) and
 * reports when an edit box gains or loses focus. The keyboard is a
 * WebContentsView docked at the bottom of the window. Keys are typed into the
 * page that asked for it with insertText / sendInputEvent.
 *
 * Emits 'change' when it appears, disappears or resizes, so the caller can
 * shrink the panes or the overlay to keep the field visible.
 */
class Keyboard extends EventEmitter {
  constructor(win, sessions, isEnabled) {
    super();
    this.win = win;
    this.isEnabled = isEnabled;
    this.visible = false;
    this.target = null; // webContents the keys go to
    this.hideTimer = null;
    this.watched = new WeakSet();

    for (const ses of sessions) ses.registerPreloadScript({ type: 'frame', filePath: FOCUS_PRELOAD });

    this.view = new WebContentsView({
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view.setBackgroundColor('#14161b');
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    // A tap on the keyboard focuses its view; give focus straight back to the
    // page so the edit box keeps its caret and receives the keys.
    wc.on('focus', () => this._focusTarget());
    wc.loadFile(PAGE).catch((err) => console.error('[keyboard] failed to load', err.message));

    // The view stays in the window for good, parked below the bottom edge while
    // hidden. On the Pi (Wayland), a view that is removed and added back can stay
    // "hidden" inside Chromium: it is drawn but ignores every tap. Moving it is
    // reliable.
    this._setBounds();
    this.win.contentView.addChildView(this.view);
  }

  isKeyboard(webContents) {
    return webContents === this.view.webContents;
  }

  get height() {
    const [, height] = this.win.getContentSize();
    return Math.round(Math.min(380, Math.max(180, height * 0.42)));
  }

  show(webContents, kind) {
    clearTimeout(this.hideTimer);
    if (!this.isEnabled() || !KINDS.has(kind)) {
      this._notify(webContents, false);
      return;
    }
    if (this.target && this.target !== webContents) this._notify(this.target, false);
    const changed = !this.visible || this.target !== webContents;
    this.target = webContents;
    this._watch(webContents);
    this.view.webContents.send('kiosk:kb-layout', kind);
    if (!this.visible) {
      this.visible = true;
      this.win.contentView.addChildView(this.view); // already a child: just raises it above the menu
      this._setBounds();
    }
    this._notify(webContents, true);
    if (changed) this.emit('change');
  }

  hide() {
    clearTimeout(this.hideTimer);
    if (!this.visible) return;
    this.visible = false;
    this._setBounds();
    const target = this.target;
    this.target = null;
    this._notify(target, false);
    this.emit('change');
  }

  // The page's edit box lost focus.
  hideFor(webContents) {
    if (webContents === this.target) this.hide();
  }

  // Some view gained focus; anything other than the keyboard or its target means
  // the user tapped elsewhere.
  onFocus(webContents) {
    if (!this.visible || webContents === this.target || this.isKeyboard(webContents)) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  press(key) {
    if (!key || typeof key !== 'object') return;
    if (key.action === 'hide') return this.hide();
    const wc = this.target;
    if (!wc || wc.isDestroyed()) return this.hide();
    this._focusTarget();
    if (typeof key.text === 'string' && key.text) {
      wc.insertText(key.text.slice(0, 16)).catch(() => {});
      return;
    }
    const keyCode = KEY_CODES[key.action];
    if (!keyCode) return;
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    // Enter's keypress is what submits forms and adds a newline in a textarea.
    if (key.action === 'enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
  }

  resize() {
    this._setBounds();
    if (this.visible) this.emit('change');
  }

  // Docked at the bottom while visible, parked just below the window otherwise.
  _setBounds() {
    const [width, height] = this.win.getContentSize();
    const h = this.height;
    this.view.setBounds({ x: 0, y: this.visible ? height - h : height, width, height: h });
  }

  _focusTarget() {
    const wc = this.target;
    if (wc && !wc.isDestroyed() && !wc.isFocused()) wc.focus();
  }

  _notify(webContents, up) {
    if (webContents && !webContents.isDestroyed()) webContents.send('kiosk:kb-state', up);
  }

  // Close the keyboard when its page goes away or loads another document.
  _watch(webContents) {
    if (this.watched.has(webContents)) return;
    this.watched.add(webContents);
    webContents.on('destroyed', () => this.hideFor(webContents));
    webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.hideFor(webContents);
    });
  }
}

module.exports = { Keyboard };
