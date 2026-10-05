'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore, validate } = require('../src/main/config-store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-test-'));
  return new ConfigStore(path.join(dir, 'config.json'));
}

test('creates default config when missing', () => {
  const store = tmpStore();
  assert.ok(fs.existsSync(store.filePath));
  assert.ok(store.get().sites.length > 0);
  assert.ok(store.getActiveSetup());
});

test('add site, use it in a setup, and block deletion while in use', () => {
  const store = tmpStore();
  const site = store.addSite({ name: 'Cameras', url: 'http://frigate.local:5000' });
  assert.strictEqual(site.id, 'cameras');
  const setup = store.addSetup({ name: 'Cams', layout: 'cols-2', panes: ['home-assistant', site.id] });
  assert.deepStrictEqual(setup.panes, ['home-assistant', 'cameras']);
  assert.deepStrictEqual(setup.ratios, [0.5]);

  assert.throws(() => store.deleteSite(site.id), (e) => e.code === 'IN_USE');
  store.deleteSite(site.id, { force: true });
  assert.deepStrictEqual(store.getSetup(setup.id).panes, ['home-assistant', null]);
});

test('rejects invalid urls', () => {
  const store = tmpStore();
  assert.throws(() => store.addSite({ name: 'Bad', url: 'not a url' }));
  assert.throws(() => store.addSite({ name: 'Bad', url: 'javascript:alert(1)' }));
});

test('changing layout resizes pane list', () => {
  const store = tmpStore();
  const s = store.updateSetup('ha-split', { layout: 'grid-4' });
  assert.strictEqual(s.panes.length, 4);
  const s2 = store.updateSetup('ha-split', { layout: 'full' });
  assert.deepStrictEqual(s2.panes, ['home-assistant']);
});

test('deleting active setup falls back to another', () => {
  const store = tmpStore();
  store.setActive('ha-split');
  store.deleteSetup('ha-split');
  assert.strictEqual(store.get().settings.activeSetupId, 'ha-full');
});

test('emits changed with previous config', () => {
  const store = tmpStore();
  let called = null;
  store.on('changed', (next, prev) => { called = { next, prev }; });
  store.setActive('ha-split');
  assert.strictEqual(called.prev.settings.activeSetupId, 'ha-full');
  assert.strictEqual(called.next.settings.activeSetupId, 'ha-split');
});

test('persists across reloads and backs up corrupt files', () => {
  const store = tmpStore();
  store.addSite({ name: 'Persisted', url: 'https://example.org' });
  const again = new ConfigStore(store.filePath);
  assert.ok(again.getSite('persisted'));

  fs.writeFileSync(store.filePath, '{ broken');
  const recovered = new ConfigStore(store.filePath);
  assert.ok(recovered.get().sites.length > 0);
  const backups = fs.readdirSync(path.dirname(store.filePath)).filter((f) => f.includes('.broken-'));
  assert.strictEqual(backups.length, 1);
});

test('validate drops unknown site references', () => {
  const cfg = validate({
    sites: [{ id: 'a', name: 'A', url: 'https://a.test' }],
    setups: [{ id: 's', name: 'S', layout: 'cols-2', panes: ['a', 'ghost'] }],
  });
  assert.deepStrictEqual(cfg.setups[0].panes, ['a', null]);
  assert.strictEqual(cfg.settings.activeSetupId, 's');
});
