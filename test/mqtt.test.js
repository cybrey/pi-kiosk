'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('../src/main/mqtt');
const { ConfigStore } = require('../src/main/config-store');

const cfg = { topicPrefix: 'doorbell', clientId: 'kiosk', durationSeconds: 30, maxAgeSeconds: 30 };
const msg = (topic, payload = '', extra = {}) => decide({ topic, payload: Buffer.from(payload), retain: false, ...extra }, cfg);

test('broadcast and targeted show/hide', () => {
  assert.deepStrictEqual(msg('doorbell/show'), { action: 'show', duration: 30 });
  assert.deepStrictEqual(msg('doorbell/kiosk/show'), { action: 'show', duration: 30 });
  assert.deepStrictEqual(msg('doorbell/hide'), { action: 'hide' });
  assert.deepStrictEqual(msg('doorbell/kiosk/hide'), { action: 'hide' });
  assert.ok(msg('doorbell/macbook/show').ignore);
  assert.ok(msg('doorbell/clients/kiosk').ignore);
});

test('timeoutSeconds overrides the configured duration', () => {
  assert.strictEqual(msg('doorbell/show', '{"timeoutSeconds": 45}').duration, 45);
  // 0 means "until closed" on the desktop popup; the kiosk keeps its own duration.
  assert.strictEqual(msg('doorbell/show', '{"timeoutSeconds": 0}').duration, 30);
});

test('ignores retained, stale and malformed messages', () => {
  assert.match(msg('doorbell/show', '', { retain: true }).ignore, /retained/);
  const now = Date.now();
  assert.match(msg('doorbell/show', JSON.stringify({ ts: now / 1000 - 120 }), { now }).ignore, /old/);
  assert.deepStrictEqual(msg('doorbell/show', JSON.stringify({ ts: now / 1000 - 5 }), { now }).action, 'show');
  assert.match(msg('doorbell/show', 'not json').ignore, /JSON/);
  assert.match(msg('doorbell/show', '[1]').ignore, /object/);
});

test('mqtt settings are validated and defaulted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const m = store.get().settings.mqtt;
  assert.strictEqual(m.enabled, false);
  assert.strictEqual(m.topicPrefix, 'doorbell');
  assert.ok(m.clientId);

  const next = store.updateSettings({
    mqtt: { ...m, enabled: true, url: 'mqtt://192.168.1.220:1883', clientId: 'Hall Kiosk', setupId: 'ha-full', durationSeconds: 1 },
  }).mqtt;
  assert.strictEqual(next.clientId, 'hall-kiosk');
  assert.strictEqual(next.setupId, 'ha-full');
  assert.strictEqual(next.durationSeconds, 5); // clamped

  assert.throws(() => store.updateSettings({ mqtt: { ...next, url: 'homeassistant.local' } }), /broker/);
  // A deleted setup is cleared from the doorbell choice.
  store.deleteSetup('ha-full');
  assert.strictEqual(store.get().settings.mqtt.setupId, '');
});
