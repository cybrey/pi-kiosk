'use strict';

// Layout templates. `ratios` are split positions in the range (0, 1):
// each one marks where a divider sits, as a fraction of the available width or height.
// Kept free of Electron imports so the config UI and the tests can use it.
const LAYOUTS = {
  'full': {
    name: 'Single',
    panes: 1,
    ratios: [],
    ratioLabels: [],
  },
  'cols-2': {
    name: 'Two columns',
    panes: 2,
    ratios: [0.5],
    ratioLabels: ['Left width'],
  },
  'rows-2': {
    name: 'Two rows',
    panes: 2,
    ratios: [0.5],
    ratioLabels: ['Top height'],
  },
  'left-1-right-2': {
    name: 'Left + 2 stacked',
    panes: 3,
    ratios: [0.6, 0.5],
    ratioLabels: ['Left width', 'Right split'],
  },
  'top-1-bottom-2': {
    name: 'Top + 2 below',
    panes: 3,
    ratios: [0.6, 0.5],
    ratioLabels: ['Top height', 'Bottom split'],
  },
  'cols-3': {
    name: 'Three columns',
    panes: 3,
    ratios: [1 / 3, 2 / 3],
    ratioLabels: ['First divider', 'Second divider'],
  },
  'grid-4': {
    name: 'Grid of 4',
    panes: 4,
    ratios: [0.5, 0.5],
    ratioLabels: ['Vertical divider', 'Horizontal divider'],
  },
};

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Fill in missing ratios from the defaults and clamp them to a usable range.
function normalizeRatios(layoutId, ratios) {
  const def = LAYOUTS[layoutId];
  if (!def) throw new Error(`Unknown layout: ${layoutId}`);
  const out = def.ratios.map((d, i) => {
    const v = Array.isArray(ratios) ? Number(ratios[i]) : NaN;
    return clamp(Number.isFinite(v) ? v : d, MIN_RATIO, MAX_RATIO);
  });
  if (layoutId === 'cols-3' && out[1] - out[0] < MIN_RATIO) {
    out[1] = clamp(out[0] + MIN_RATIO, MIN_RATIO * 2, MAX_RATIO);
    out[0] = Math.min(out[0], out[1] - MIN_RATIO);
  }
  return out;
}

// Split `length` at the fractions in `cuts`. Returns [start, size] segments
// that tile exactly (integer pixels, with `gap` between segments).
function split(start, length, cuts, gap) {
  const usable = length - gap * cuts.length;
  const edges = [0, ...cuts.map((c) => Math.round(usable * c)), usable];
  const segs = [];
  for (let i = 0; i < edges.length - 1; i++) {
    segs.push([start + edges[i] + gap * i, edges[i + 1] - edges[i]]);
  }
  return segs;
}

/**
 * Compute pane rectangles for a layout.
 * @param {string} layoutId
 * @param {number[]} ratios
 * @param {{x?:number,y?:number,width:number,height:number}} area
 * @param {number} [gap=0] pixels between panes
 * @returns {{x:number,y:number,width:number,height:number}[]} one rect per pane, in pane order
 */
function computeRects(layoutId, ratios, area, gap = 0) {
  const r = normalizeRatios(layoutId, ratios);
  const x0 = area.x || 0;
  const y0 = area.y || 0;
  const W = area.width;
  const H = area.height;
  const rect = ([x, w], [y, h]) => ({ x, y, width: w, height: h });
  const fullX = [x0, W];
  const fullY = [y0, H];

  switch (layoutId) {
    case 'full':
      return [rect(fullX, fullY)];
    case 'cols-2':
      return split(x0, W, r, gap).map((sx) => rect(sx, fullY));
    case 'rows-2':
      return split(y0, H, r, gap).map((sy) => rect(fullX, sy));
    case 'cols-3':
      return split(x0, W, r, gap).map((sx) => rect(sx, fullY));
    case 'left-1-right-2': {
      const [left, right] = split(x0, W, [r[0]], gap);
      const [top, bottom] = split(y0, H, [r[1]], gap);
      return [rect(left, fullY), rect(right, top), rect(right, bottom)];
    }
    case 'top-1-bottom-2': {
      const [top, bottom] = split(y0, H, [r[0]], gap);
      const [left, right] = split(x0, W, [r[1]], gap);
      return [rect(fullX, top), rect(left, bottom), rect(right, bottom)];
    }
    case 'grid-4': {
      const [left, right] = split(x0, W, [r[0]], gap);
      const [top, bottom] = split(y0, H, [r[1]], gap);
      return [rect(left, top), rect(right, top), rect(left, bottom), rect(right, bottom)];
    }
    default:
      throw new Error(`Unknown layout: ${layoutId}`);
  }
}

module.exports = { LAYOUTS, computeRects, normalizeRatios };
