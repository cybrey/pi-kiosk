'use strict';

// Small client for the kiosk REST API, shared by the overlay and config pages.
// Handles the optional PIN for LAN access (stored per browser).
(function () {
  const PIN_KEY = 'kiosk-pin';

  function getPin() {
    try { return localStorage.getItem(PIN_KEY) || ''; } catch { return ''; }
  }
  function setPin(pin) {
    try { localStorage.setItem(PIN_KEY, pin); } catch { /* ignore */ }
  }

  async function request(method, url, body) {
    const headers = { 'x-kiosk-pin': getPin() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`/api${url}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.code === 'PIN_REQUIRED') {
      const pin = window.prompt('Enter the kiosk PIN');
      if (pin !== null) {
        setPin(pin);
        return request(method, url, body);
      }
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.code = data.code;
      err.details = data.details;
      throw err;
    }
    return data;
  }

  // Calls `onChange` whenever the config changes anywhere (other browser, overlay, ...).
  function subscribe(onChange) {
    const pin = encodeURIComponent(getPin());
    const es = new EventSource(`/api/events?pin=${pin}`);
    es.addEventListener('config', () => onChange());
    return es;
  }

  function toast(message, isError) {
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 4000 : 2000);
  }

  // Render a layout preview into `el`. `labels[i]` is the text for pane i
  // (falsy = empty pane). Returns the pane elements so callers can add controls.
  function renderLayout(el, layoutId, ratios, labels, aspect) {
    const W = 1000;
    const H = Math.round(W / (aspect || 1.6));
    const rects = window.KioskLayouts.computeRects(layoutId, ratios, { width: W, height: H });
    el.classList.add('layout-preview');
    el.style.setProperty('--aspect', `${W} / ${H}`);
    el.replaceChildren();
    return rects.map((r, i) => {
      const pane = document.createElement('div');
      pane.className = `pane${labels && labels[i] ? ' filled' : ''}`;
      Object.assign(pane.style, {
        left: `${(r.x / W) * 100}%`,
        top: `${(r.y / H) * 100}%`,
        width: `${(r.width / W) * 100}%`,
        height: `${(r.height / H) * 100}%`,
      });
      const inner = document.createElement('div');
      inner.textContent = (labels && labels[i]) || '';
      pane.appendChild(inner);
      el.appendChild(pane);
      return inner;
    });
  }

  window.KioskApi = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    put: (url, body) => request('PUT', url, body),
    del: (url) => request('DELETE', url),
    subscribe,
    toast,
    renderLayout,
    setPin,
  };
})();
