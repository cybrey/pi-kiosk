'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../src/main/config-store');
const { Display } = require('../src/main/display');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-display-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  // Default config has 'ha-full' (active) and 'ha-split'; add a doorbell screen.
  store.addSetup({ name: 'Doorbell', layout: 'full', panes: ['example'], inRotation: false });
  const display = new Display(store);
  return { store, display };
}

test('temporary activation reverts to the saved setup and is not persisted', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { store, display } = setup();
  const events = [];
  display.on('changed', (s) => events.push(s.activeSetupId));

  const s = display.activate('doorbell', { duration: 30 });
  assert.strictEqual(s.activeSetupId, 'doorbell');
  assert.strictEqual(s.temporary, true);
  assert.strictEqual(s.secondsLeft, 30);
  assert.strictEqual(store.get().settings.activeSetupId, 'ha-full'); // saved config untouched
  assert.strictEqual(new ConfigStore(store.filePath).get().settings.activeSetupId, 'ha-full');

  t.mock.timers.tick(29_000);
  assert.strictEqual(display.activeId(), 'doorbell');
  t.mock.timers.tick(1_000);
  assert.strictEqual(display.activeId(), 'ha-full');
  assert.deepStrictEqual(events, ['doorbell', 'ha-full']);
});

test('repeat temporary call restarts the countdown and keeps the return target', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { display } = setup();
  display.activate('doorbell', { duration: 30 });
  t.mock.timers.tick(20_000);
  display.activate('doorbell', { duration: 30 });
  t.mock.timers.tick(20_000);
  assert.strictEqual(display.activeId(), 'doorbell');
  t.mock.timers.tick(10_000);
  assert.strictEqual(display.activeId(), 'ha-full');
});

test('a permanent switch during a temporary one cancels the revert', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { store, display } = setup();
  display.activate('doorbell', { duration: 30 });
  display.activate('ha-split');
  t.mock.timers.tick(60_000);
  assert.strictEqual(display.activeId(), 'ha-split');
  assert.strictEqual(store.get().settings.activeSetupId, 'ha-split');
});

test('making the temporary setup permanent clears the override', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { store, display } = setup();
  display.activate('doorbell', { duration: 30 });
  display.activate('doorbell');
  t.mock.timers.tick(60_000);
  assert.strictEqual(display.activeId(), 'doorbell');
  assert.strictEqual(store.get().settings.activeSetupId, 'doorbell');
  assert.strictEqual(display.state().temporary, false);
});

test('revert ends a temporary activation early', () => {
  const { display } = setup();
  display.activate('doorbell', { duration: 300 });
  const s = display.revert();
  assert.strictEqual(s.activeSetupId, 'ha-full');
  assert.strictEqual(s.temporary, false);
  display.dispose();
});

test('setups can be addressed by name, case-insensitively', () => {
  const { display } = setup();
  assert.strictEqual(display.activate('DOORBELL').activeSetupId, 'doorbell');
  assert.throws(() => display.activate('nope'), (e) => e.code === 'NOT_FOUND');
});

test('step cycles through rotation setups in configured order and wraps', () => {
  const { store, display } = setup();
  assert.strictEqual(display.step('next').activeSetupId, 'ha-split');
  assert.strictEqual(display.step('next').activeSetupId, 'ha-full'); // doorbell skipped, wraps
  assert.strictEqual(display.step('prev').activeSetupId, 'ha-split');

  store.reorderSetups(['ha-split', 'doorbell', 'ha-full']);
  store.updateSetup('doorbell', { inRotation: true });
  assert.strictEqual(display.step('next').activeSetupId, 'doorbell');
  assert.strictEqual(display.step('next').activeSetupId, 'ha-full');
});

test('stepping away from a temporary setup cancels the revert', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { display } = setup();
  display.activate('doorbell', { duration: 30 });
  // doorbell is not in the rotation, so "next" starts from the first rotation setup.
  display.step('next');
  t.mock.timers.tick(60_000);
  assert.strictEqual(display.state().temporary, false);
  assert.strictEqual(display.activeId(), 'ha-full');
});

test('deleting the temporarily shown setup falls back immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { store, display } = setup();
  display.activate('doorbell', { duration: 30 });
  store.deleteSetup('doorbell');
  assert.strictEqual(display.activeId(), 'ha-full');
  assert.strictEqual(display.state().temporary, false);
});
