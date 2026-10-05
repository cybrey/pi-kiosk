'use strict';

(function () {
  const api = window.KioskApi;
  const kiosk = window.kiosk; // only present inside the kiosk overlay view
  const $ = (sel) => document.querySelector(sel);

  let state = null;

  if (!kiosk) document.body.classList.add('remote');

  function tickClock() {
    $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function load() {
    try {
      state = await api.get('/config');
      render();
    } catch (err) {
      api.toast(err.message, true);
    }
  }

  function render() {
    const { config, screen, state: display } = state;
    const sites = new Map(config.sites.map((s) => [s.id, s]));
    const aspect = screen ? screen.width / screen.height : 1.6;
    const list = $('#setups');
    list.replaceChildren();
    $('#empty').hidden = config.setups.length > 0;
    $('.sub').textContent = display.temporary
      ? `Showing ${display.activeSetupName} temporarily · tap a setup to stay`
      : 'Choose a setup';

    for (const setup of config.setups) {
      const btn = document.createElement('button');
      btn.className = `setup${setup.id === display.activeSetupId ? ' active' : ''}`;
      const preview = document.createElement('div');
      const labels = setup.panes.map((id) => (id && sites.get(id) ? sites.get(id).name : ''));
      api.renderLayout(preview, setup.layout, setup.ratios, labels, aspect);
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = setup.name;
      btn.append(preview, name);
      btn.addEventListener('click', () => activate(setup.id));
      list.appendChild(btn);
    }
  }

  async function activate(id) {
    try {
      await api.post(`/activate/${encodeURIComponent(id)}`);
      if (kiosk) close();
      else load();
    } catch (err) {
      api.toast(err.message, true);
    }
  }

  function open() {
    document.body.classList.remove('open');
    tickClock();
    load();
    // Next frame so the transition runs from the closed position.
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('open')));
  }

  let closing = false;
  function close() {
    if (!kiosk || closing) return;
    closing = true;
    document.body.classList.remove('open');
    setTimeout(() => {
      closing = false;
      kiosk.close();
    }, 220);
  }

  // ---- interactions ---------------------------------------------------------

  $('#backdrop').addEventListener('click', close);
  $('#close').addEventListener('click', close);
  $('#reload').addEventListener('click', async () => {
    if (kiosk) {
      kiosk.reloadPanes();
      close();
    } else {
      await api.post('/reload');
      api.toast('Reloading panes');
    }
  });

  // Swipe up on the panel to dismiss.
  let startY = null;
  const panel = $('#panel');
  panel.addEventListener('touchstart', (e) => {
    startY = panel.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (startY !== null && startY - e.touches[0].clientY > 80) {
      startY = null;
      close();
    }
  }, { passive: true });

  setInterval(tickClock, 10_000);
  api.subscribe(load);

  if (kiosk) {
    kiosk.onShown(open);
    open();
  } else {
    tickClock();
    load();
  }
})();
