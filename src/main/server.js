'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { LAYOUTS } = require('./layouts');

const RENDERER = path.join(__dirname, '..', 'renderer');
const LAYOUTS_SRC = path.join(__dirname, 'layouts.js');

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Local HTTP server: REST API + static config UI + overlay page.
 * Requests from other machines need the PIN (when one is set); the kiosk
 * itself (loopback) never does.
 *
 * @param {import('./config-store').ConfigStore} store
 * @param {import('./display').Display} display
 * @param {{ reloadPanes: () => void, restart: () => void, screenSize: () => {width:number,height:number}, mqtt?: import('./mqtt').TriggerSubscriber }} actions
 */
function createServer(store, display, actions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // ---- live updates (Server-Sent Events) ----------------------------------
  // Display 'changed' also fires for every config change, so one source covers both.
  const clients = new Set();
  display.on('changed', (state) => {
    const msg = `event: config\ndata: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) res.write(msg);
  });
  // MQTT connection status, as its own event so the Settings form isn't
  // re-rendered (losing unsaved edits) every time it changes.
  actions.mqtt?.on('status', (status) => {
    const msg = `event: mqtt\ndata: ${JSON.stringify({ status })}\n\n`;
    for (const res of clients) res.write(msg);
  });

  // ---- auth -----------------------------------------------------------------
  const requirePin = (req, res, next) => {
    const pin = store.get().settings.configPin;
    if (!pin || isLoopback(req)) return next();
    if (req.get('x-kiosk-pin') === pin || req.query.pin === pin) return next();
    res.status(401).json({ error: 'PIN required', code: 'PIN_REQUIRED' });
  };

  const api = express.Router();
  api.use(requirePin);

  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'IN_USE' ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code || 'ERROR', details: err.details });
    }
  };

  api.get('/config', wrap(() => ({
    config: store.get(),
    layouts: LAYOUTS,
    screen: actions.screenSize(),
    state: display.state(),
    mqttStatus: actions.mqtt?.status || 'off',
  })));
  api.put('/config', wrap((req) => store.replace(req.body)));

  api.post('/sites', wrap((req) => store.addSite(req.body)));
  api.put('/sites/:id', wrap((req) => store.updateSite(req.params.id, req.body)));
  api.delete('/sites/:id', wrap((req) => store.deleteSite(req.params.id, { force: req.query.force === '1' })));

  api.post('/setups', wrap((req) => store.addSetup(req.body)));
  api.put('/setups/:id', wrap((req) => store.updateSetup(req.params.id, req.body)));
  api.delete('/setups/:id', wrap((req) => store.deleteSetup(req.params.id)));
  api.post('/setups-order', wrap((req) => store.reorderSetups(req.body.ids || [])));

  // ---- remote control (menu, phone, Home Assistant) -------------------------
  // POST /api/activate/<id or name>            switch permanently
  // POST /api/activate/<id or name>?duration=30 show for 30 s, then return
  // (duration can also be sent as JSON body: {"duration": 30})
  const duration = (req) => Number(req.query.duration ?? req.body?.duration ?? 0) || 0;
  api.post('/activate/:id', wrap((req) => display.activate(req.params.id, { duration: duration(req) })));
  api.post('/next', wrap(() => display.step('next')));
  api.post('/prev', wrap(() => display.step('prev')));
  api.post('/revert', wrap(() => display.revert()));
  api.get('/state', wrap(() => display.state()));
  api.put('/settings', wrap((req) => store.updateSettings(req.body)));
  api.post('/reload', wrap(() => actions.reloadPanes()));
  api.post('/restart', wrap(() => actions.restart()));

  api.get('/export', (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="kiosk-config.json"');
    res.json(store.get());
  });

  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  app.use('/api', api);

  // Share the layout math with the browser (it is plain JS with no requires).
  app.get('/shared/layouts.js', (req, res) => {
    const src = fs.readFileSync(LAYOUTS_SRC, 'utf8');
    res.type('application/javascript').send(
      `(function(){var module={exports:{}};\n${src}\nwindow.KioskLayouts=module.exports;})();`,
    );
  });

  app.use('/shared', express.static(path.join(RENDERER, 'shared')));
  app.use('/overlay', express.static(path.join(RENDERER, 'overlay')));
  app.use('/', express.static(path.join(RENDERER, 'config')));

  return app;
}

function startServer(store, display, actions) {
  const { port } = store.get().settings;
  const app = createServer(store, display, actions);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => resolve({ server, port }));
    server.on('error', reject);
  });
}

module.exports = { createServer, startServer };
