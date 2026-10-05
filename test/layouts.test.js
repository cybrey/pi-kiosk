'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { LAYOUTS, computeRects, normalizeRatios } = require('../src/main/layouts');

const AREA = { width: 1280, height: 800 };

function area(r) {
  return r.width * r.height;
}

for (const [id, def] of Object.entries(LAYOUTS)) {
  test(`${id}: pane count matches and rects tile the screen`, () => {
    const rects = computeRects(id, def.ratios, AREA);
    assert.strictEqual(rects.length, def.panes);
    const total = rects.reduce((sum, r) => sum + area(r), 0);
    assert.strictEqual(total, AREA.width * AREA.height);
    for (const r of rects) {
      assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y));
      assert.ok(r.width > 0 && r.height > 0);
      assert.ok(r.x + r.width <= AREA.width && r.y + r.height <= AREA.height);
    }
  });

  test(`${id}: gap leaves space between panes`, () => {
    const gap = 6;
    const rects = computeRects(id, def.ratios, AREA, gap);
    const total = rects.reduce((sum, r) => sum + area(r), 0);
    if (def.panes > 1) assert.ok(total < AREA.width * AREA.height);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.ok(!overlap, `panes ${i} and ${j} overlap`);
      }
    }
  });
}

test('cols-2 honours ratio', () => {
  const [l, r] = computeRects('cols-2', [0.75], AREA);
  assert.deepStrictEqual(l, { x: 0, y: 0, width: 960, height: 800 });
  assert.deepStrictEqual(r, { x: 960, y: 0, width: 320, height: 800 });
});

test('left-1-right-2 layout geometry', () => {
  const [big, top, bottom] = computeRects('left-1-right-2', [0.5, 0.25], AREA);
  assert.deepStrictEqual(big, { x: 0, y: 0, width: 640, height: 800 });
  assert.deepStrictEqual(top, { x: 640, y: 0, width: 640, height: 200 });
  assert.deepStrictEqual(bottom, { x: 640, y: 200, width: 640, height: 600 });
});

test('area offset is respected', () => {
  const [r] = computeRects('full', [], { x: 10, y: 20, width: 100, height: 50 });
  assert.deepStrictEqual(r, { x: 10, y: 20, width: 100, height: 50 });
});

test('ratios are clamped and defaulted', () => {
  assert.deepStrictEqual(normalizeRatios('cols-2', [5]), [0.9]);
  assert.deepStrictEqual(normalizeRatios('grid-4', []), [0.5, 0.5]);
  const [a, b] = normalizeRatios('cols-3', [0.5, 0.52]);
  assert.ok(b - a >= 0.1 - 1e-9);
});

test('unknown layout throws', () => {
  assert.throws(() => computeRects('nope', [], AREA));
});
