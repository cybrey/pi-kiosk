'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, routes } = require('../src/main/mqtt');
const { ConfigStore, validate, defaultConfig } = require('../src/main/config-store');

const cfg = {
  mqtt: { clientId: 'kiosk', maxAgeSeconds: 30 },
  setups: [
    { id: 'front-door', mqtt: { topic: 'doorbell/show', durationSeconds: 30 } },
    { id: 'garden', mqtt: { topic: 'garden/motion', durationSeconds: 10 } },
    { id: 'plain', mqtt: { topic: '', durationSeconds: 30 } },
  ],
};
const msg = (topic, payload = '', extra = {}) => decide({ topic, payload: Buffer.from(payload), retain: false, ...extra }, cfg);

function tmpStore(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  const file = path.join(dir, 'config.json');
  if (contents) fs.writeFileSync(file, JSON.stringify(contents));
  return new ConfigStore(file);
}

test('a /show trigger also gets targeted and hide topics', () => {
  assert.deepStrictEqual([...routes(cfg.setups, 'kiosk').keys()].sort(), [
    'doorbell/hide', 'doorbell/kiosk/hide', 'doorbell/kiosk/show', 'doorbell/show', 'garden/motion',
  ]);
});

test('messages map to their setup', () => {
  assert.deepStrictEqual(msg('doorbell/show'), { action: 'show', setupId: 'front-door', duration: 30 });
  assert.deepStrictEqual(msg('doorbell/kiosk/show'), { action: 'show', setupId: 'front-door', duration: 30 });
  assert.deepStrictEqual(msg('doorbell/hide'), { action: 'hide', setupId: 'front-door' });
  assert.deepStrictEqual(msg('garden/motion'), { action: 'show', setupId: 'garden', duration: 10 });
  assert.ok(msg('doorbell/macbook/show').ignore);
  assert.ok(msg('doorbell/clients/kiosk').ignore);
});

test('timeoutSeconds overrides the setup duration', () => {
  assert.strictEqual(msg('doorbell/show', '{"timeoutSeconds": 45}').duration, 45);
  // 0 means "until closed" on the desktop popup; the kiosk keeps the setup's duration.
  assert.strictEqual(msg('doorbell/show', '{"timeoutSeconds": 0}').duration, 30);
});

test('ignores retained, stale and malformed messages', () => {
  assert.match(msg('doorbell/show', '', { retain: true }).ignore, /retained/);
  const now = Date.now();
  assert.match(msg('doorbell/show', JSON.stringify({ ts: now / 1000 - 120 }), { now }).ignore, /old/);
  assert.strictEqual(msg('doorbell/show', JSON.stringify({ ts: now / 1000 - 5 }), { now }).action, 'show');
  assert.match(msg('doorbell/show', 'not json').ignore, /JSON/);
  assert.match(msg('doorbell/show', '[1]').ignore, /object/);
});

test('broker settings are validated and defaulted', () => {
  const store = tmpStore();
  const m = store.get().settings.mqtt;
  assert.strictEqual(m.enabled, false);
  assert.strictEqual(m.topicPrefix, 'doorbell');
  assert.ok(m.clientId);

  const next = store.updateSettings({ mqtt: { ...m, enabled: true, url: 'mqtt://192.168.1.220:1883', clientId: 'Hall Kiosk' } }).mqtt;
  assert.strictEqual(next.clientId, 'hall-kiosk');
  assert.throws(() => store.updateSettings({ mqtt: { ...next, url: 'homeassistant.local' } }), /broker/);
});

test('setup triggers are validated', () => {
  const store = tmpStore();
  const s = store.updateSetup('ha-full', { mqtt: { topic: '/doorbell/show/', durationSeconds: 1 } });
  assert.deepStrictEqual(s.mqtt, { topic: 'doorbell/show', durationSeconds: 5 });
  assert.deepStrictEqual(store.getSetup('ha-split').mqtt, { topic: '', durationSeconds: 30 });
  assert.throws(() => store.updateSetup('ha-split', { mqtt: { topic: 'doorbell/show' } }), /can't both use/);
  assert.throws(() => store.updateSetup('ha-split', { mqtt: { topic: 'doorbell/#' } }), /\+ or #/);
});

test('the old single doorbell setting moves onto the setup', () => {
  const old = defaultConfig();
  old.settings.mqtt = { enabled: true, url: 'mqtt://192.168.1.220:1883', username: 'u', password: 'p', topicPrefix: 'doorbell', clientId: 'kiosk', setupId: 'ha-split', durationSeconds: 45 };
  const store = tmpStore(old);
  const cfgNow = store.get();
  assert.deepStrictEqual(cfgNow.setups.find((s) => s.id === 'ha-split').mqtt, { topic: 'doorbell/show', durationSeconds: 45 });
  assert.strictEqual(cfgNow.settings.mqtt.setupId, undefined);
  assert.strictEqual(cfgNow.settings.mqtt.password, 'p');
  // Validating again (every later save) doesn't change anything.
  assert.deepStrictEqual(validate(cfgNow), cfgNow);
});
