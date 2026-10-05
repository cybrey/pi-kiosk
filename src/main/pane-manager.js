'use strict';

const path = require('path');
const { WebContentsView, session } = require('electron');
const { computeRects } = require('./layouts');

const PARTITION = 'persist:kiosk';
const PRELOAD = path.join(__dirname, '..', 'preload', 'pane-gesture.js');
const ERROR_PAGE = path.join(__dirname, '..', 'renderer', 'pane-error', 'index.html');
const EMPTY_PAGE = path.join(__dirname, '..', 'renderer', 'pane-empty', 'index.html');
const MAX_BACKOFF_MS = 60_000;
// Pause / resume every <video> and <audio> in a frame, including inside shadow
// roots (web components). Only media we paused gets resumed.
const MEDIA_WALK = `const media = [];
  const walk = (root) => {
    root.querySelectorAll('video, audio').forEach((m) => media.push(m));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);`;
const PAUSE_MEDIA = `(() => { ${MEDIA_WALK}
  for (const m of media) if (!m.paused) { m.__kioskPaused = true; m.pause(); } })()`;
const RESUME_MEDIA = `(() => { ${MEDIA_WALK}
  for (const m of media) if (m.__kioskPaused) { m.__kioskPaused = false; m.play().catch(() => {}); } })()`;
const SLIDE_MS = 300; // swipe animation between setups
const SLIDE_FRAME_MS = 16;
// Scrollbars swallow touches, which would block the right-edge swipe; on a touch
// kiosk pages scroll by dragging, so they are hidden (user-origin CSS beats page CSS).
const HIDE_SCROLLBARS_CSS =
  '* { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }';

/**
 * Owns the WebContentsViews that render site panes.
 *
 * Views are keyed by site id, so a site shown in two setups reuses one live view
 * (keeps logins, video streams and scroll position when switching). Views that
 * are not used by the active setup are detached and kept in an LRU cache of
 * `keepAliveViews` entries; older ones are destroyed to save memory.
 */
class PaneManager {
  /** @param {() => string|null} getActiveId which setup to show (saved or temporary) */
  constructor(win, store, getActiveId) {
    this.win = win;
    this.store = store;
    this.getActiveId = getActiveId;
    this.views = new Map(); // siteId -> entry
    this.emptyViews = []; // placeholder views for unassigned panes
    this.attached = new Set(); // views currently in the window
    this.lru = []; // detached siteIds, most recent last
    this.bottomInset = 0; // room left for the on-screen keyboard
    this.session = session.fromPartition(PARTITION);
  }

  // ---- public -------------------------------------------------------------

  setBottomInset(px) {
    if (px === this.bottomInset) return;
    this.bottomInset = px;
    this.apply();
  }

  /**
   * Lay out the active setup.
   * @param {{ slide?: 'next' | 'prev' }} [opts] animate the change like
   *   flipping between home screens: 'next' slides the new panes in from the
   *   right and the old ones out to the left, 'prev' the other way.
   */
  apply({ slide } = {}) {
    const cfg = this.store.get();
    const activeId = this.getActiveId();
    const setup = cfg.setups.find((s) => s.id === activeId);
    const [width, fullHeight] = this.win.getContentSize();
    const height = Math.max(100, fullHeight - this.bottomInset);
    const wanted = []; // [view, rect]

    if (setup) {
      const rects = computeRects(setup.layout, setup.ratios, { width, height }, cfg.settings.gapPx);
      let emptyIdx = 0;
      setup.panes.forEach((siteId, i) => {
        const site = siteId && cfg.sites.find((s) => s.id === siteId);
        // The same site twice in one setup gets one view; later duplicates show a placeholder.
        if (site && !wanted.some(([, , id]) => id === site.id)) {
          wanted.push([this._ensureView(site, cfg.settings).view, rects[i], site.id]);
        } else {
          wanted.push([this._emptyView(emptyIdx++), rects[i], null]);
        }
      });
    }

    const wantedViews = new Set(wanted.map(([v]) => v));
    const leaving = [...this.attached].filter((v) => !wantedViews.has(v));

    if (this.anim) {
      // A re-layout of the same setup mid-slide (the config save that follows a
      // switch) just retargets it; anything else finishes the slide first.
      const same = !slide && wanted.length === this.anim.entering.length
        && wanted.every(([v]) => this.anim.entering.some(([e]) => e === v));
      if (same) {
        this.anim.entering = wanted.map(([v, rect]) => [v, rect]);
        return;
      }
      this._finishSlide();
    }

    if (slide && cfg.settings.swipeAnimation && leaving.length) {
      this._startSlide(slide, wanted, leaving, width);
      this._trimCache(cfg.settings.keepAliveViews);
      return;
    }

    for (const view of leaving) this._detach(view);
    for (const [view, rect, siteId] of wanted) {
      const old = view.getBounds();
      const moved = old.x !== rect.x || old.y !== rect.y || old.width !== rect.width || old.height !== rect.height;
      view.setBounds(rect);
      if (!this.attached.has(view)) {
        this._attach(view);
        this._repaint(view);
      } else if (moved) {
        this._repaint(view);
      }
      this._sendInfo(view);
      if (siteId) this.lru = this.lru.filter((id) => id !== siteId);
    }
    this._trimCache(cfg.settings.keepAliveViews);
  }

  // Called when config changes: refresh changed sites, then re-layout.
  onConfigChanged(next, prev) {
    const prevSites = new Map(prev.sites.map((s) => [s.id, s]));
    for (const [id, entry] of this.views) {
      const site = next.sites.find((s) => s.id === id);
      if (!site) {
        this._destroy(id);
        continue;
      }
      const old = prevSites.get(id);
      if (old && (old.url !== site.url || old.lowPowerVideo !== site.lowPowerVideo)) {
        entry.site = site;
        this._load(entry);
      } else if (old) {
        entry.site = site;
        entry.view.webContents.setZoomFactor(site.zoom);
        this._scheduleAutoReload(entry);
      }
      if (next.settings.hideScrollbars !== prev.settings.hideScrollbars) this._applyScrollbars(entry);
    }
    this.apply(); // also pushes fresh pane info (settings + rects) to attached panes
  }

  reloadAll() {
    for (const view of this.attached) {
      const entry = [...this.views.values()].find((e) => e.view === view);
      if (entry) this._load(entry);
    }
  }

  destroyAll() {
    for (const id of [...this.views.keys()]) this._destroy(id);
  }

  // ---- internals ------------------------------------------------------------

  _ensureView(site, settings) {
    let entry = this.views.get(site.id);
    if (entry) return entry;

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    view.setBackgroundColor('#000000');
    entry = { site, view, retries: 0, retryTimer: null, reloadTimer: null, failed: false };
    this.views.set(site.id, entry);

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      // Kiosk: open popups in the same pane instead of new windows.
      wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.on('did-finish-load', () => {
      if (!entry.failed) entry.retries = 0;
      wc.setZoomFactor(entry.site.zoom);
      this._repaint(view);
    });
    wc.on('dom-ready', () => {
      entry.scrollbarCss = null; // a new document drops previously inserted CSS
      this._applyScrollbars(entry);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      // -3 = ERR_ABORTED (navigation replaced); not a real failure.
      if (!isMainFrame || code === -3) return;
      this._fail(entry, `${desc} (${code})`, url);
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this._fail(entry, `Page crashed: ${details.reason}`, entry.site.url);
    });
    // A hidden page that starts playing on its own (autoplay, a player that resumes) is paused again.
    wc.on('media-started-playing', () => {
      if (!this.attached.has(view)) this._inAllFrames(wc, PAUSE_MEDIA);
    });
    wc.on('unresponsive', () => {
      console.warn(`[pane ${site.id}] unresponsive`);
    });
    // Self-signed certificates are common on LAN devices (HA, NVRs, routers).
    wc.on('certificate-error', (event, _url, _err, _cert, callback) => {
      const allow = this.store.get().settings.ignoreCertErrors;
      if (allow) event.preventDefault();
      callback(allow);
    });

    this._load(entry);
    this._scheduleAutoReload(entry);
    return entry;
  }

  _load(entry) {
    clearTimeout(entry.retryTimer);
    entry.failed = false;
    entry.view.webContents.loadURL(entry.site.url).catch(() => { /* handled by did-fail-load */ });
  }

  _fail(entry, reason, url) {
    if (entry.view.webContents.isDestroyed()) return;
    entry.failed = true;
    entry.retries += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (entry.retries - 1));
    console.warn(`[pane ${entry.site.id}] ${reason}; retry in ${delay / 1000}s`);
    entry.view.webContents
      .loadFile(ERROR_PAGE, {
        query: { name: entry.site.name, url: url || entry.site.url, reason, retry: String(Math.round(delay / 1000)) },
      })
      .catch(() => {});
    clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => this._load(entry), delay);
  }

  async _applyScrollbars(entry) {
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    const hide = this.store.get().settings.hideScrollbars;
    if (hide && !entry.scrollbarCss) {
      entry.scrollbarCss = 'pending';
      entry.scrollbarCss = await wc.insertCSS(HIDE_SCROLLBARS_CSS, { cssOrigin: 'user' }).catch(() => null);
    } else if (!hide && entry.scrollbarCss && entry.scrollbarCss !== 'pending') {
      const key = entry.scrollbarCss;
      entry.scrollbarCss = null;
      await wc.removeInsertedCSS(key).catch(() => {});
    }
  }

  // ---- slide animation --------------------------------------------------------

  _startSlide(direction, wanted, leaving, width) {
    const dir = direction === 'prev' ? 1 : -1; // which way everything moves along x
    const offset = (rect, dx) => ({ ...rect, x: Math.round(rect.x + dx) });
    this.anim = {
      dir,
      width,
      start: Date.now(),
      entering: wanted.map(([v, rect]) => [v, rect]),
      leaving: leaving.map((v) => [v, v.getBounds()]),
      siteIds: wanted.map(([, , id]) => id).filter(Boolean),
    };
    for (const [view, rect] of this.anim.entering) {
      view.setBounds(offset(rect, -dir * width)); // start one screen away
      if (!this.attached.has(view)) this._attach(view);
    }
    this.lru = this.lru.filter((id) => !this.anim.siteIds.includes(id));
    this.anim.timer = setInterval(() => this._slideFrame(), SLIDE_FRAME_MS);
  }

  _slideFrame() {
    const a = this.anim;
    const t = Math.min(1, (Date.now() - a.start) / SLIDE_MS);
    if (t >= 1) return this._finishSlide();
    const eased = 1 - (1 - t) ** 3; // ease-out cubic
    const dx = a.dir * a.width * eased;
    for (const [view, rect] of a.leaving) view.setBounds({ ...rect, x: Math.round(rect.x + dx) });
    for (const [view, rect] of a.entering) view.setBounds({ ...rect, x: Math.round(rect.x + dx - a.dir * a.width) });
  }

  _finishSlide() {
    const a = this.anim;
    if (!a) return;
    clearInterval(a.timer);
    this.anim = null;
    for (const [view] of a.leaving) {
      if (this.attached.has(view)) this._detach(view);
    }
    for (const [view, rect] of a.entering) {
      if (view.webContents.isDestroyed()) continue;
      view.setBounds(rect);
      this._repaint(view);
      this._sendInfo(view);
    }
    this._trimCache(this.store.get().settings.keepAliveViews);
  }

  // On the Pi (Wayland) a pane's first frame can fail to reach the screen. Pages
  // that keep updating (Home Assistant) recover by themselves, but a static page
  // stays black until something redraws it. So ask for a few repaints after the
  // page loads or the pane is placed or resized.
  _repaint(view) {
    for (const ms of [0, 300, 1000, 3000]) {
      setTimeout(() => {
        if (!view.webContents.isDestroyed() && this.attached.has(view)) view.webContents.invalidate();
      }, ms);
    }
  }

  _scheduleAutoReload(entry) {
    clearInterval(entry.reloadTimer);
    entry.reloadTimer = null;
    const minutes = entry.site.autoReloadMin;
    if (minutes > 0) {
      entry.reloadTimer = setInterval(() => {
        if (entry.failed) return;
        // Off screen: reload when it comes back instead (see _wake).
        if (this.attached.has(entry.view)) entry.view.webContents.reloadIgnoringCache();
        else entry.reloadDue = true;
      }, minutes * 60_000);
    }
  }

  // What the pane preload needs: gesture settings plus where the pane sits in the
  // window, so "top edge of the screen" works for panes that are not at the top.
  _info(view) {
    const s = this.store.get().settings;
    const [width, height] = this.win.getContentSize();
    return {
      gestureEdgePx: s.gestureEdgePx,
      gestureDistancePx: s.gestureDistancePx,
      cornerLongPress: s.cornerLongPress,
      edgeSwipe: s.edgeSwipe,
      sideEdgePx: s.sideEdgePx,
      hideCursor: s.hideCursor,
      rect: view.getBounds(),
      win: { width, height },
    };
  }

  // The site a pane shows (null for placeholders), for the preload at page start.
  siteFor(webContents) {
    for (const e of this.views.values()) if (e.view.webContents === webContents) return e.site;
    return null;
  }

  infoFor(webContents) {
    const view = this._viewFor(webContents);
    return view ? this._info(view) : null;
  }

  _sendInfo(view) {
    if (view.webContents.isDestroyed()) return;
    view.webContents.send('kiosk:pane-info', this._info(view));
  }

  _viewFor(webContents) {
    for (const e of this.views.values()) if (e.view.webContents === webContents) return e.view;
    return this.emptyViews.find((v) => v.webContents === webContents) || null;
  }

  _emptyView(i) {
    if (!this.emptyViews[i]) {
      const view = new WebContentsView({
        webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
      });
      view.setBackgroundColor('#111111');
      view.webContents.loadFile(EMPTY_PAGE);
      this.emptyViews[i] = view;
    }
    return this.emptyViews[i];
  }

  _attach(view) {
    this.win.contentView.addChildView(view, 0); // index 0 keeps panes below the overlay
    this.attached.add(view);
    this._wake(view);
  }

  _detach(view) {
    this.win.contentView.removeChildView(view);
    this.attached.delete(view);
    this._sleep(view);
    for (const [id, e] of this.views) {
      if (e.view === view) {
        this.lru = this.lru.filter((x) => x !== id);
        this.lru.push(id);
      }
    }
  }

  // Sites kept loaded off screen (the cache) must not keep playing: mute them and
  // pause their media. Hidden pages are also throttled by Chromium (timers slowed).
  _sleep(view) {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    wc.setAudioMuted(true);
    this._inAllFrames(wc, PAUSE_MEDIA);
  }

  // Back on screen: unmute, resume what _sleep paused, catch up on a missed auto-reload.
  _wake(view) {
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    wc.setAudioMuted(false);
    const entry = [...this.views.values()].find((e) => e.view === view);
    if (entry?.reloadDue) {
      entry.reloadDue = false;
      if (!entry.failed) {
        wc.reloadIgnoringCache();
        return;
      }
    }
    this._inAllFrames(wc, RESUME_MEDIA);
  }

  // Includes iframes (e.g. a YouTube embed inside a dashboard).
  _inAllFrames(wc, code) {
    let frames = [];
    try {
      frames = wc.mainFrame.framesInSubtree;
    } catch {
      return;
    }
    for (const frame of frames) frame.executeJavaScript(code).catch(() => {});
  }

  _trimCache(keep) {
    while (this.lru.length > keep) this._destroy(this.lru.shift());
  }

  _destroy(id) {
    const entry = this.views.get(id);
    if (!entry) return;
    clearTimeout(entry.retryTimer);
    clearInterval(entry.reloadTimer);
    if (this.attached.has(entry.view)) {
      this.win.contentView.removeChildView(entry.view);
      this.attached.delete(entry.view);
    }
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.views.delete(id);
    this.lru = this.lru.filter((x) => x !== id);
  }
}

module.exports = { PaneManager, PARTITION };
