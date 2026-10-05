'use strict';

const path = require('path');
const { WebContentsView } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'preload', 'overlay-bridge.js');

/**
 * The quick switcher / config overlay. It is a transparent WebContentsView that
 * covers the whole window and is attached on top of the panes only while open.
 * It loads pages from the local config server, so the switcher and the config UI
 * share one origin and one REST API.
 */
class Overlay {
  constructor(win, baseUrl) {
    this.win = win;
    this.baseUrl = baseUrl;
    this.home = `${baseUrl}/overlay/`;
    this.visible = false;
    this.bottomInset = 0; // room left for the on-screen keyboard
    this.onHide = null;
    this._checkTimer = null;
    this._createView();
  }

  _createView() {
    this.view = new WebContentsView({
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    this.view.setBackgroundColor('#00000000');
    const wc = this.view.webContents;

    // Only allow the overlay to show the local config server's pages.
    const allowed = (url) => url.startsWith(`${this.baseUrl}/`);
    wc.on('will-navigate', (e, url) => {
      if (!allowed(url)) e.preventDefault();
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', () => {
      this.loaded = false;
    });

    this.loaded = false;
    this._load();
  }

  // On the Pi the overlay view can get stuck "hidden" in Chromium: attached on
  // top but never drawn and never given input. It is then an invisible layer
  // swallowing every touch. A fresh view does not inherit that state, so after
  // each show check the page really is visible, replace the view once if not,
  // and detach it if even that fails.
  _verifyShown(retried = false) {
    clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(async () => {
      if (!this.visible) return;
      const wc = this.view.webContents;
      const state = await Promise.race([
        wc.executeJavaScript('document.visibilityState').catch(() => 'error'),
        new Promise((r) => setTimeout(() => r('timeout'), 3000)), // a busy Pi can be slow to answer
      ]);
      if (!this.visible || wc !== this.view.webContents || state === 'visible') return;
      if (retried) {
        console.error(`[overlay] still not shown (${state}); closing it so touches reach the panes`);
        this.hide();
        return;
      }
      console.error(`[overlay] view stuck (${state}); replacing it`);
      this.win.contentView.removeChildView(this.view);
      this.visible = false;
      this.onHide?.();
      this.destroy();
      this._createView();
      this.show(true);
    }, 1000);
  }

  _load() {
    this.loaded = true;
    this.view.webContents.loadURL(this.home).catch((err) => {
      this.loaded = false;
      console.error('[overlay] failed to load', err.message);
    });
  }

  isOverlay(webContents) {
    return webContents === this.view.webContents;
  }

  show(retried = false) {
    const wc = this.view.webContents;
    // Always open on the switcher, even if it was last closed on the config page.
    // (A view still loading the switcher, e.g. a fresh one from _verifyShown, is left alone.)
    if (!this.loaded || (!wc.isLoading() && !wc.getURL().startsWith(this.home))) this._load();
    this.resize();
    if (!this.visible) {
      this.win.contentView.addChildView(this.view); // appended last = on top
      this.visible = true;
    }
    wc.focus();
    wc.send('kiosk:overlay-shown');
    this._verifyShown(retried);
  }

  hide() {
    clearTimeout(this._checkTimer);
    if (!this.visible) return;
    this.win.contentView.removeChildView(this.view);
    this.visible = false;
    this.onHide?.();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  setBottomInset(px) {
    if (px === this.bottomInset) return;
    this.bottomInset = px;
    this.resize();
  }

  resize() {
    const [width, height] = this.win.getContentSize();
    this.view.setBounds({ x: 0, y: 0, width, height: Math.max(100, height - this.bottomInset) });
  }

  destroy() {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}

module.exports = { Overlay };
