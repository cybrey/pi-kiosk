'use strict';

// API for the on-screen keyboard page (src/renderer/keyboard).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskKeyboard', {
  // { text: 'a' } types text; { action: 'backspace' | 'enter' | 'left' | 'right' | 'hide' } presses a key.
  press: (key) => ipcRenderer.send('kiosk:kb-key', key),
  // Called with 'text' | 'email' | 'url' | 'number' | 'tel' each time the keyboard opens for a field.
  onLayout: (cb) => {
    ipcRenderer.on('kiosk:kb-layout', (_e, kind) => cb(kind));
  },
});
