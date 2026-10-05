'use strict';

// Exposes a tiny API to the overlay pages (switcher + embedded config UI).
// Everything else (listing/activating setups, editing config) goes through
// the local REST API so the same pages work from a LAN browser.

const { contextBridge, ipcRenderer } = require('electron');

// No drag and drop: on the Pi a touch-started drag leaves Chromium stuck,
// ignoring every touch (see pane-gesture.js).
window.addEventListener('dragstart', (e) => e.preventDefault(), { capture: true });

contextBridge.exposeInMainWorld('kiosk', {
  embedded: true,
  close: () => ipcRenderer.send('kiosk:overlay-close'),
  reloadPanes: () => ipcRenderer.send('kiosk:reload-panes'),
  restart: () => ipcRenderer.send('kiosk:restart'),
  exit: () => ipcRenderer.send('kiosk:exit'),
  // Power off the Pi. Resolves to { ok: true } or { error }.
  canShutdown: process.platform === 'linux',
  shutdown: () => ipcRenderer.invoke('kiosk:shutdown'),
  onShown: (cb) => {
    ipcRenderer.on('kiosk:overlay-shown', () => cb());
  },
});
