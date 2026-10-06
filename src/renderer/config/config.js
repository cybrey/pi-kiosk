'use strict';

(function () {
  const api = window.KioskApi;
  const kiosk = window.kiosk; // present only inside the kiosk overlay
  const { LAYOUTS } = window.KioskLayouts;
  const $ = (sel, root = document) => root.querySelector(sel);

  let state = null; // { config, layouts, screen }
  let editing = false; // suppress live re-render while a sheet is open

  if (kiosk) document.body.classList.add('embedded');

  // Tiny DOM helper: h('button.primary', { onclick }, 'Text', child...)
  function h(tag, props, ...children) {
    const [name, ...classes] = tag.split('.');
    const el = document.createElement(name || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  function field(label, input, hint) {
    return h('label.field', null, h('span', null, label), input, hint ? h('div.hint', null, hint) : null);
  }

  const aspect = () => (state.screen ? state.screen.width / state.screen.height : 1.6);
  const siteName = (id) => state.config.sites.find((s) => s.id === id)?.name || '';

  async function load() {
    state = await api.get('/config');
    if (!editing) render();
  }

  async function run(fn, okMessage) {
    try {
      const out = await fn();
      if (okMessage) api.toast(okMessage);
      await load();
      return out ?? true;
    } catch (err) {
      api.toast(err.message, true);
      return false;
    }
  }

  // ---- tabs -----------------------------------------------------------------

  function showTab(name) {
    if (!['setups', 'sites', 'settings'].includes(name)) name = 'setups';
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function render() {
    renderSetups();
    renderSites();
    renderSettings();
  }

  // ---- setups ---------------------------------------------------------------

  function renderSetups() {
    const { setups } = state.config;
    const display = state.state;
    const list = $('#setup-list');
    list.replaceChildren();
    if (!setups.length) {
      list.append(h('div.empty', null, 'No setups yet. Tap “New setup” to create one.'));
      return;
    }
    setups.forEach((s, i) => {
      const active = s.id === display.activeSetupId;
      const preview = h('div');
      api.renderLayout(preview, s.layout, s.ratios, s.panes.map(siteName), aspect());
      list.append(
        h(`div.card${active ? '.active' : ''}`, null,
          preview,
          h('div.title', null, s.name,
            active ? h('span.badge', null, display.temporary ? 'Showing (temporary)' : 'Active') : null),
          h('div.meta', null, LAYOUTS[s.layout].name, s.inRotation ? '' : ' · not in swipe rotation'),
          s.mqtt?.topic ? h('div.meta', null, 'MQTT: ', h('code.id', null, s.mqtt.topic), ` · ${s.mqtt.durationSeconds}s`) : null,
          h('div.meta', null, 'ID: ', h('code.id', { title: 'Use this in API calls, e.g. /api/activate/<id>' }, s.id)),
          h('div.row', null,
            h('button.small.primary', { disabled: active && !display.temporary, onclick: () => run(() => api.post(`/activate/${s.id}`), 'Activated') }, 'Activate'),
            h('button.small', { onclick: () => editSetup(s) }, 'Edit'),
            h('span.spacer'),
            h('button.small', { title: 'Move up', disabled: i === 0, onclick: () => moveSetup(i, -1) }, '↑'),
            h('button.small', { title: 'Move down', disabled: i === setups.length - 1, onclick: () => moveSetup(i, 1) }, '↓'),
            h('button.small.danger', { onclick: () => deleteSetup(s) }, 'Delete'),
          ),
        ),
      );
    });
  }

  function moveSetup(i, dir) {
    const ids = state.config.setups.map((s) => s.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    run(() => api.post('/setups-order', { ids }));
  }

  function deleteSetup(s) {
    if (confirm(`Delete setup “${s.name}”?`)) run(() => api.del(`/setups/${s.id}`), 'Deleted');
  }

  function editSetup(existing) {
    const draft = existing
      ? structuredClone(existing)
      : { name: '', layout: 'cols-2', ratios: [...LAYOUTS['cols-2'].ratios], panes: [], inRotation: true };

    const nameInput = h('input', { type: 'text', value: draft.name, placeholder: 'e.g. HA + Cameras' });
    const rotationInput = h('input', { type: 'checkbox', checked: draft.inRotation !== false });

    // MQTT trigger: show this setup for a while when a message arrives.
    const trigger = draft.mqtt || { topic: '', durationSeconds: 30 };
    const broker = state.config.settings.mqtt;
    const triggerOn = h('input', { type: 'checkbox', checked: !!trigger.topic });
    const topicInput = h('input', { type: 'text', value: trigger.topic, placeholder: 'e.g. doorbell/show' });
    const secondsInput = h('input', { type: 'number', value: String(trigger.durationSeconds), min: 5, max: 3600 });
    const topicHint = h('div.hint');
    const triggerFields = h('div', null,
      h('label.field', null, h('span', null, 'Topic'), topicInput, topicHint),
      field('Show for (seconds)', secondsInput, 'Then the kiosk goes back. Another message restarts the countdown.'),
    );
    const updateTrigger = () => {
      triggerFields.hidden = !triggerOn.checked;
      const t = topicInput.value.trim().replace(/^\/+|\/+$/g, '');
      topicHint.textContent = t.endsWith('/show')
        ? `Also: ${t.slice(0, -5)}/${broker.clientId}/show (this kiosk only) and ${t.slice(0, -5)}/hide (go back now).`
        : 'Use a topic ending in /show to share it with the Doorbell Popup app on your computers.';
    };
    triggerOn.addEventListener('change', () => {
      updateTrigger();
      if (triggerOn.checked) topicInput.focus();
    });
    topicInput.addEventListener('input', updateTrigger);
    updateTrigger();
    const triggerSection = h('div', null,
      h('label.check', null, triggerOn, 'Show this setup when an MQTT message arrives'),
      broker.enabled ? null : h('div.hint', { style: 'margin:-8px 0 12px' },
        'The MQTT broker is not connected yet: set it up under Settings → MQTT broker.'),
      triggerFields,
    );
    const picker = h('div.layout-picker');
    const sliders = h('div');
    const preview = h('div.big-preview');

    function renderPicker() {
      picker.replaceChildren();
      for (const [id, def] of Object.entries(LAYOUTS)) {
        const thumb = h('div');
        api.renderLayout(thumb, id, def.ratios, null, aspect());
        picker.append(
          h(`button${id === draft.layout ? '.active' : ''}`, {
            type: 'button',
            title: def.name,
            onclick: () => {
              draft.layout = id;
              draft.ratios = [...def.ratios];
              renderAll();
            },
          }, thumb, h('div.lbl', null, def.name)),
        );
      }
    }

    function renderSliders() {
      sliders.replaceChildren();
      const def = LAYOUTS[draft.layout];
      def.ratioLabels.forEach((label, i) => {
        const out = h('span', null, `${Math.round(draft.ratios[i] * 100)}%`);
        const input = h('input', {
          type: 'range', min: '10', max: '90', step: '1', value: String(Math.round(draft.ratios[i] * 100)),
          oninput: (e) => {
            draft.ratios[i] = Number(e.target.value) / 100;
            out.textContent = `${e.target.value}%`;
            renderPreview();
          },
        });
        sliders.append(h('label.field', null, h('span', null, `${label}: `, out), input));
      });
    }

    function siteSelect(i) {
      const select = h('select', {
        onchange: (e) => {
          if (e.target.value === '__new') {
            e.target.value = draft.panes[i] || '';
            editSite(null, (site) => {
              draft.panes[i] = site.id;
              renderPreview();
            });
          } else {
            draft.panes[i] = e.target.value || null;
            renderPreview();
          }
        },
      },
      h('option', { value: '' }, '— empty —'),
      state.config.sites.map((s) => h('option', { value: s.id, selected: s.id === draft.panes[i] }, s.name)),
      h('option', { value: '__new' }, '+ New site…'));
      return select;
    }

    function renderPreview() {
      const def = LAYOUTS[draft.layout];
      draft.panes = Array.from({ length: def.panes }, (_, i) => draft.panes[i] || null);
      const cells = api.renderLayout(preview, draft.layout, draft.ratios, draft.panes.map(siteName), aspect());
      cells.forEach((cell, i) => {
        cell.replaceChildren(h('div.num', null, `Pane ${i + 1}`), siteSelect(i));
      });
    }

    function renderAll() {
      renderPicker();
      renderSliders();
      renderPreview();
    }

    const body = h('div.editor-grid', null,
      h('div', null,
        field('Name', nameInput, existing
          ? h('span', null, 'ID for API calls: ', h('code.id', null, existing.id), ' (stays the same if you rename)')
          : 'The ID for API calls is created from this name when you save.'),
        h('label.check', null, rotationInput, 'Include when swiping left/right between setups'),
        triggerSection,
        h('label.field', null, h('span', null, 'Layout')),
        picker,
        sliders,
      ),
      h('div', null,
        h('label.field', null, h('span', null, 'Panes: pick a site for each')),
        preview,
        h('div.hint', null, 'The preview matches the kiosk screen’s shape.'),
      ),
    );
    renderAll();

    openSheet(existing ? 'Edit setup' : 'New setup', body, async () => {
      const data = {
        name: nameInput.value,
        layout: draft.layout,
        ratios: draft.ratios,
        panes: draft.panes,
        inRotation: rotationInput.checked,
        mqtt: {
          topic: triggerOn.checked ? topicInput.value.trim() : '',
          durationSeconds: Number(secondsInput.value),
        },
      };
      if (triggerOn.checked && !data.mqtt.topic) {
        api.toast('Enter an MQTT topic, or untick “Show this setup when an MQTT message arrives”', true);
        return false;
      }
      return run(() => (existing ? api.put(`/setups/${existing.id}`, data) : api.post('/setups', data)), 'Saved');
    });
    if (!existing) nameInput.focus();
  }

  // ---- sites ----------------------------------------------------------------

  function renderSites() {
    const { sites, setups } = state.config;
    const list = $('#site-list');
    list.replaceChildren();
    if (!sites.length) {
      list.append(h('div.empty', null, 'No sites yet. Tap “New site” to add one.'));
      return;
    }
    for (const s of sites) {
      const usedIn = setups.filter((x) => x.panes.includes(s.id)).map((x) => x.name);
      const extras = [
        s.zoom !== 1 ? `zoom ${Math.round(s.zoom * 100)}%` : null,
        s.autoReloadMin ? `reloads every ${s.autoReloadMin} min` : null,
        s.lowPowerVideo ? 'low-power video' : null,
        usedIn.length ? `used in: ${usedIn.join(', ')}` : 'not used',
      ].filter(Boolean).join(' · ');
      list.append(
        h('div.card.site-card', null,
          h('div.info', null,
            h('div.title', null, s.name),
            h('div.meta', null, s.url),
            h('div.meta', null, extras),
          ),
          h('div.row', null,
            !kiosk ? h('a.btn.small', { href: s.url, target: '_blank', rel: 'noopener' }, 'Open') : null,
            h('button.small', { onclick: () => editSite(s) }, 'Edit'),
            h('button.small.danger', { onclick: () => deleteSite(s) }, 'Delete'),
          ),
        ),
      );
    }
  }

  async function deleteSite(s) {
    if (!confirm(`Delete site “${s.name}”?`)) return;
    try {
      await api.del(`/sites/${s.id}`);
      api.toast('Deleted');
    } catch (err) {
      if (err.code !== 'IN_USE') return api.toast(err.message, true);
      const used = err.details.usedBy.join(', ');
      if (!confirm(`“${s.name}” is used in: ${used}.\nDelete anyway and leave those panes empty?`)) return;
      await run(() => api.del(`/sites/${s.id}?force=1`), 'Deleted');
    }
    load();
  }

  // `onCreated(site)` is called after a new site is saved (used by the setup editor).
  function editSite(existing, onCreated) {
    const s = existing || { name: '', url: 'http://', zoom: 1, autoReloadMin: 0 };
    const name = h('input', { type: 'text', value: s.name, placeholder: 'e.g. Home Assistant' });
    const url = h('input', { type: 'url', value: s.url, placeholder: 'http://homeassistant.local:8123', autocapitalize: 'off', spellcheck: false });
    const zoom = h('select', null,
      [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((z) =>
        h('option', { value: String(z), selected: Math.abs(z - s.zoom) < 0.001 }, `${Math.round(z * 100)}%`)));
    if (![...zoom.options].some((o) => o.selected)) {
      zoom.prepend(h('option', { value: String(s.zoom), selected: true }, `${Math.round(s.zoom * 100)}%`));
    }
    const reload = h('input', { type: 'number', min: '0', step: '1', value: String(s.autoReloadMin) });
    const lowPower = h('input', { type: 'checkbox', checked: !!s.lowPowerVideo });

    const body = h('div', { style: 'max-width:640px;margin:0 auto' },
      field('Name', name),
      field('URL', url, 'Use the full address including http:// or https://. Sites that block embedding (Home Assistant, camera NVRs) work fine here.'),
      field('Zoom', zoom, 'Scale the page to fit small panes.'),
      field('Auto-reload (minutes)', reload, '0 = never. Useful for dashboards or camera pages that go stale.'),
      h('label.check', null, lowPower, 'Low-power video'),
      h('div.hint', { style: 'margin:-8px 0 18px' },
        'Asks sites like YouTube for H.264 video at up to 720p, which the Pi plays smoothly. Turn on if video stutters.'),
    );

    openSheet(existing ? 'Edit site' : 'New site', body, async () => {
      const data = {
        name: name.value,
        url: url.value,
        zoom: Number(zoom.value),
        autoReloadMin: Number(reload.value) || 0,
        lowPowerVideo: lowPower.checked,
      };
      const saved = await run(() => (existing ? api.put(`/sites/${existing.id}`, data) : api.post('/sites', data)), 'Saved');
      if (saved && !existing && onCreated) onCreated(saved);
      return !!saved;
    });
    if (!existing) name.focus();
  }

  // ---- settings -------------------------------------------------------------

  // "● Connected" style line, updated live from the server's mqtt events.
  function mqttStatusLine(status) {
    const s = status || 'off';
    const color = s === 'connected' ? '#22c55e' : s.startsWith('error') ? '#ef4444' : s === 'off' ? '#6b7280' : '#f59e0b';
    return h('div', { id: 'mqtt-status', style: 'display:flex;align-items:center;gap:8px;margin:0 0 10px;font-weight:600' },
      h('span', { style: `width:10px;height:10px;border-radius:50%;flex:none;background:${color}` }),
      `Status: ${s}`);
  }

  function renderSettings() {
    const s = state.config.settings;
    const m = s.mqtt;
    const form = $('#settings-form');
    const num = (key, attrs) => h('input', { type: 'number', name: key, value: String(s[key]), ...attrs });
    const check = (key, label) =>
      h('label.check', null, h('input', { type: 'checkbox', name: key, checked: !!s[key] }), label);

    form.replaceChildren(
      h('fieldset', null, h('legend', null, 'Hidden menu gesture'),
        field('Top edge size (px)', num('gestureEdgePx', { min: 5, max: 200 }), 'How close to the top of the screen the swipe must start.'),
        field('Swipe distance (px)', num('gestureDistancePx', { min: 30, max: 600 }), 'How far down you must drag.'),
        check('cornerLongPress', 'Also open with a long press (1.5 s) in the top-left corner'),
        h('div.hint', { style: 'margin:-8px 0 18px' }, 'Keyboard: Ctrl+Shift+K toggles the menu, Ctrl+Shift+R reloads all panes.'),
      ),
      h('fieldset', null, h('legend', null, 'Swipe between setups'),
        check('edgeSwipe', 'Swipe in from the right edge for the next setup, from the left for the previous'),
        field('Side edge size (px)', num('sideEdgePx', { min: 5, max: 200 }),
          'How close to the left/right edge the swipe must start. Order follows the Setups tab; Ctrl+Shift+←/→ also works.'),
        check('swipeAnimation', 'Slide the panes across when swiping between setups'),
        check('showSwitchToast', 'Briefly show the setup name after switching'),
      ),
      h('fieldset', null, h('legend', null, 'Display'),
        field('Gap between panes (px)', num('gapPx', { min: 0, max: 40 })),
        check('hideCursor', 'Hide the mouse cursor in panes'),
        check('hideScrollbars', 'Hide scrollbars in panes (pages still scroll by dragging; keeps the right-edge swipe working)'),
        check('onScreenKeyboard', 'Show an on-screen keyboard when an edit box is tapped (turn off if a real keyboard is attached)'),
        field('Cached hidden sites', num('keepAliveViews', { min: 0, max: 12 }),
          'Sites not on screen stay loaded (paused and muted) so switching back is instant. Lower this if the Pi runs low on memory.'),
        check('ignoreCertErrors', 'Accept self-signed HTTPS certificates (common on LAN devices)'),
      ),
      h('fieldset', null, h('legend', null, 'MQTT broker'),
        mqttStatusLine(state.mqttStatus),
        h('div.hint', { style: 'margin:0 0 14px' },
          'Lets Home Assistant show a setup on demand, e.g. the doorbell camera when someone rings. ',
          'Choose which message shows which setup in each setup’s editor (Setups tab → Edit).'),
        h('label.check', null, h('input', { type: 'checkbox', name: 'mqttEnabled', checked: m.enabled }), 'Connect to the MQTT broker'),
        field('Broker', h('input', { type: 'text', name: 'mqttUrl', value: m.url, placeholder: 'mqtt://homeassistant.local:1883' }),
          'With the Mosquitto add-on: mqtt://<Home Assistant IP>:1883'),
        field('Username', h('input', { type: 'text', name: 'mqttUsername', value: m.username, autocomplete: 'off' }),
          'A Home Assistant user works with the Mosquitto add-on.'),
        field('Password', h('input', { type: 'password', name: 'mqttPassword', value: m.password, autocomplete: 'new-password' })),
        field('Subscriber id', h('input', { type: 'text', name: 'mqttClientId', value: m.clientId }),
          'Names this kiosk, e.g. doorbell/' + m.clientId + '/show reaches only this kiosk.'),
        field('Status topic prefix', h('input', { type: 'text', name: 'mqttTopicPrefix', value: m.topicPrefix }),
          `The kiosk publishes online/offline to ${m.topicPrefix}/clients/${m.clientId}.`),
      ),
      h('fieldset', null, h('legend', null, 'Remote access'),
        field('PIN for editing from other devices', h('input', { type: 'password', name: 'configPin', value: s.configPin, autocomplete: 'new-password' }),
          'Leave empty to allow anyone on your network. The touchscreen itself never needs the PIN.'),
        field('Port', num('port', { min: 1, max: 65535 }), `Current: ${location.port || 80}. A restart is needed after changing it.`),
      ),
      h('div.button-row', null, h('button.primary', { type: 'submit' }, 'Save settings')),
      h('fieldset', null, h('legend', null, 'Backup'),
        h('div.button-row', null,
          h('a.btn', { href: '/api/export', download: 'kiosk-config.json' }, 'Export config'),
          h('button', { type: 'button', onclick: importConfig }, 'Import config…'),
        ),
      ),
      kiosk ? h('fieldset', null, h('legend', null, 'Kiosk app'),
        h('div.button-row', null,
          h('button', { type: 'button', onclick: () => confirm('Restart the kiosk app?') && kiosk.restart() }, 'Restart app'),
          h('button.danger', { type: 'button', onclick: () => confirm('Exit the kiosk to the desktop?') && kiosk.exit() }, 'Exit to desktop'),
          kiosk.canShutdown ? h('button.danger', { type: 'button', onclick: shutdown }, 'Shut down') : null,
        ),
        kiosk.canShutdown ? h('div.hint', null, 'Shut down before unplugging the power. Wait until the green light stops flashing.') : null,
      ) : '', // replaceChildren would print null as text
    );
  }

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const data = {
      gestureEdgePx: Number(f.gestureEdgePx.value),
      gestureDistancePx: Number(f.gestureDistancePx.value),
      cornerLongPress: f.cornerLongPress.checked,
      edgeSwipe: f.edgeSwipe.checked,
      sideEdgePx: Number(f.sideEdgePx.value),
      showSwitchToast: f.showSwitchToast.checked,
      swipeAnimation: f.swipeAnimation.checked,
      gapPx: Number(f.gapPx.value),
      hideCursor: f.hideCursor.checked,
      hideScrollbars: f.hideScrollbars.checked,
      onScreenKeyboard: f.onScreenKeyboard.checked,
      keepAliveViews: Number(f.keepAliveViews.value),
      ignoreCertErrors: f.ignoreCertErrors.checked,
      configPin: f.configPin.value,
      port: Number(f.port.value),
      mqtt: {
        ...state.config.settings.mqtt,
        enabled: f.mqttEnabled.checked,
        url: f.mqttUrl.value.trim(),
        username: f.mqttUsername.value.trim(),
        password: f.mqttPassword.value,
        clientId: f.mqttClientId.value.trim(),
        topicPrefix: f.mqttTopicPrefix.value.trim(),
      },
    };
    run(() => api.put('/settings', data), 'Settings saved').then(() => {
      if (data.configPin) api.setPin(data.configPin);
    });
  });

  async function shutdown() {
    if (!confirm('Shut down the Pi?\n\nTo turn it back on, unplug the power and plug it in again.')) return;
    const result = await kiosk.shutdown();
    if (result.error) api.toast(`Could not shut down: ${result.error}`, true);
    else api.toast('Shutting down…');
  }

  function importConfig() {
    const input = h('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const cfg = JSON.parse(await file.text());
        if (confirm('Replace the whole configuration with this file?')) run(() => api.put('/config', cfg), 'Imported');
      } catch (err) {
        api.toast(`Invalid file: ${err.message}`, true);
      }
    });
    input.click();
  }

  // ---- sheet (stackable, so "New site" can open from inside the setup editor) ---

  const sheetStack = [];

  function showTopSheet() {
    const top = sheetStack[sheetStack.length - 1];
    $('#sheet').hidden = !top;
    editing = !!top;
    if (!top) return render();
    $('#sheet-title').textContent = top.title;
    $('#sheet-body').replaceChildren(top.body);
  }

  function openSheet(title, body, onSave) {
    sheetStack.push({ title, body, onSave });
    showTopSheet();
  }

  function closeSheet() {
    sheetStack.pop();
    showTopSheet();
  }

  $('#sheet-cancel').addEventListener('click', closeSheet);
  $('#sheet-save').addEventListener('click', async (e) => {
    const top = sheetStack[sheetStack.length - 1];
    e.target.disabled = true;
    try {
      if (await top.onSave()) closeSheet();
    } finally {
      e.target.disabled = false;
    }
  });

  // ---- boot -----------------------------------------------------------------

  $('#add-setup').addEventListener('click', () => editSetup(null));
  $('#add-site').addEventListener('click', () => editSite(null));
  $('#done').addEventListener('click', () => kiosk && kiosk.close());
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  showTab(location.hash.slice(1));
  load().catch((err) => api.toast(err.message, true));
  const events = api.subscribe(() => load().catch(() => {}));
  events.addEventListener('mqtt', (e) => {
    const { status } = JSON.parse(e.data);
    if (state) state.mqttStatus = status;
    $('#mqtt-status')?.replaceWith(mqttStatusLine(status));
  });
})();
