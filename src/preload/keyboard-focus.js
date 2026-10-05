'use strict';

// Registered for every page in the kiosk (panes and the menu/config overlay) by
// src/main/keyboard.js. Tells the main process when an edit box gains or loses
// focus, so it can show the built-in on-screen keyboard.
//
// Tapping a key moves focus to the keyboard's own view for a moment, and the
// main process hands it straight back. The page would see that as the edit box
// losing and regaining focus (which closes autocomplete dropdowns and the like),
// so those focus events are hidden from the page while the keyboard is up.

const { ipcRenderer } = require('electron');

// <input> types that take typed text (input.type normalises unknown types to 'text').
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

let shown = false; // the keyboard is up for this page
let swallowed = null; // element whose blur was hidden from the page while focus was on the keyboard
let reportTimer = null;

// document.activeElement stops at shadow hosts (Home Assistant is all web components).
function deepActive() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

// Which keyboard layout an element wants, or null if it does not take typed text.
function kindOf(el) {
  if (!el || !el.getAttribute || el.disabled || el.readOnly) return null;
  const mode = (el.getAttribute('inputmode') || '').toLowerCase();
  if (mode === 'none') return null; // the page brings its own keypad
  let type = '';
  if (el.tagName === 'INPUT') {
    type = el.type;
    if (!TEXT_INPUTS.has(type)) return null;
  } else if (el.tagName !== 'TEXTAREA' && !el.isContentEditable) {
    return null;
  }
  if (type === 'number' || mode === 'numeric' || mode === 'decimal') return 'number';
  if (type === 'tel' || mode === 'tel') return 'tel';
  if (type === 'email' || mode === 'email') return 'email';
  if (type === 'url' || mode === 'url') return 'url';
  return 'text';
}

// Runs once focus has settled (blur fires before focus reaches the next field).
function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    const kind = document.hasFocus() ? kindOf(deepActive()) : null;
    if (kind) {
      shown = true;
      ipcRenderer.send('kiosk:kb-show', kind);
    } else if (shown) {
      shown = false;
      ipcRenderer.send('kiosk:kb-hide');
    }
  }, 0);
}

function onFocusLost(e) {
  // The whole page lost focus (to the keyboard, or elsewhere): keep it quiet for
  // now. If it was not the keyboard, the main process says so and we replay it.
  if (shown && !document.hasFocus()) {
    if (e.target !== window) swallowed = e.composedPath()[0];
    e.stopImmediatePropagation();
    return;
  }
  if (e.type === 'focusout') scheduleReport();
}

function onFocusGained(e) {
  const el = e.composedPath()[0];
  const returning = swallowed && (el === window || el === swallowed);
  if (e.type === 'focusin') swallowed = null; // window focus, focus, focusin: focusin comes last
  if (returning) {
    e.stopImmediatePropagation();
    return;
  }
  if (e.type === 'focusin') scheduleReport();
}

// Capture on window runs before any page listener, so stopImmediatePropagation hides the event.
window.addEventListener('blur', onFocusLost, true);
window.addEventListener('focusout', onFocusLost, true);
window.addEventListener('focus', onFocusGained, true);
window.addEventListener('focusin', onFocusGained, true);

// Tapping a field that already has focus (after closing the keyboard) brings it back.
window.addEventListener('pointerup', (e) => {
  if (shown) return;
  const el = deepActive();
  if (!kindOf(el)) return;
  const r = el.getBoundingClientRect();
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) scheduleReport();
}, { capture: true, passive: true });

// The page shrinks to make room for the keyboard; keep the field in sight.
window.addEventListener('resize', () => {
  if (!shown) return;
  const el = deepActive();
  if (kindOf(el)) el.scrollIntoView({ block: 'nearest' });
});

ipcRenderer.on('kiosk:kb-state', (_e, up) => {
  shown = up;
  if (up) return;
  const el = swallowed;
  swallowed = null;
  // Focus went somewhere other than the keyboard: deliver the blur we held back.
  if (el && !document.hasFocus()) {
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    window.dispatchEvent(new FocusEvent('blur'));
  }
});
