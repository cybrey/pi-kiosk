'use strict';

const path = require('path');
const { WebContentsView } = require('electron');

const PAGE = path.join(__dirname, '..', 'renderer', 'toast', 'index.html');
const WIDTH = 420;
const HEIGHT = 64;
const SHOW_MS = 1400;

/**
 * Brief "now showing: <setup>" pill near the bottom of the screen after a
 * switch, so swiping between setups that share a layout is not ambiguous.
 * It is only attached while visible, so it never blocks touches for long.
 */
class Toast {
  constructor(win) {
    this.win = win;
    this.visible = false;
    this.timer = null;
    this.view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    this.view.setBackgroundColor('#00000000');
    this.ready = this.view.webContents.loadFile(PAGE).catch(() => {});
  }

  async show(text, note = '') {
    await this.ready;
    const [width, height] = this.win.getContentSize();
    const w = Math.min(WIDTH, width - 32);
    this.view.setBounds({ x: Math.round((width - w) / 2), y: height - HEIGHT - 32, width: w, height: HEIGHT });
    if (!this.visible) {
      this.win.contentView.addChildView(this.view); // on top of panes
      this.visible = true;
    }
    this.view.webContents
      .executeJavaScript(`showToast(${JSON.stringify(text)}, ${JSON.stringify(note)})`)
      .catch(() => {});
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), SHOW_MS);
  }

  hide() {
    clearTimeout(this.timer);
    if (!this.visible) return;
    this.view.webContents.executeJavaScript('hideToast()').catch(() => {});
    setTimeout(() => {
      if (this.timer) return; // re-shown meanwhile
      this.win.contentView.removeChildView(this.view);
      this.visible = false;
    }, 200);
    this.timer = null;
  }
}

module.exports = { Toast };
