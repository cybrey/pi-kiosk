'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { LAYOUTS, normalizeRatios } = require('./layouts');

const DEFAULT_PATH = path.join(os.homedir(), '.config', 'pi-kiosk', 'config.json');

// Doorbell over MQTT (see src/main/mqtt.js). Off until a broker is filled in.
const DEFAULT_MQTT = {
  enabled: false,
  url: 'mqtt://homeassistant.local:1883',
  username: '',
  password: '',
  topicPrefix: 'doorbell',
  clientId: '',
  setupId: '',
  durationSeconds: 30,
  maxAgeSeconds: 30,
};

const DEFAULT_SETTINGS = {
  activeSetupId: null,
  gestureEdgePx: 40,
  gestureDistancePx: 120,
  cornerLongPress: true,
  edgeSwipe: true,
  sideEdgePx: 30,
  showSwitchToast: true,
  swipeAnimation: true,
  hideCursor: false,
  hideScrollbars: true,
  onScreenKeyboard: true,
  keepAliveViews: 4,
  gapPx: 0,
  ignoreCertErrors: true,
  configPin: '',
  port: 8080,
  mqtt: DEFAULT_MQTT,
};

function defaultConfig() {
  return {
    sites: [
      { id: 'home-assistant', name: 'Home Assistant', url: 'http://homeassistant.local:8123', zoom: 1, autoReloadMin: 0 },
      { id: 'example', name: 'Example', url: 'https://example.com', zoom: 1, autoReloadMin: 0 },
    ],
    setups: [
      { id: 'ha-full', name: 'Home Assistant', layout: 'full', ratios: [], panes: ['home-assistant'] },
      { id: 'ha-split', name: 'HA + Example', layout: 'cols-2', ratios: [0.6], panes: ['home-assistant', 'example'] },
    ],
    settings: { ...DEFAULT_SETTINGS, activeSetupId: 'ha-full' },
  };
}

class ValidationError extends Error {
  constructor(message, code = 'INVALID', details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function makeId(name, existing) {
  const base = String(name || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'item';
  let id = base;
  while (existing.has(id)) id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  return id;
}

function num(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function cleanSite(s) {
  const name = String(s.name || '').trim();
  const url = String(s.url || '').trim();
  if (!name) throw new ValidationError('Site name is required');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Invalid URL for "${name}": ${url}`);
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    throw new ValidationError(`URL for "${name}" must be http, https or file`);
  }
  return {
    id: String(s.id),
    name,
    url,
    zoom: num(s.zoom, 1, 0.25, 5),
    autoReloadMin: num(s.autoReloadMin, 0, 0, 24 * 60),
    lowPowerVideo: !!s.lowPowerVideo,
  };
}

function cleanSetup(s, siteIds) {
  const name = String(s.name || '').trim();
  if (!name) throw new ValidationError('Setup name is required');
  const layout = String(s.layout || 'full');
  const def = LAYOUTS[layout];
  if (!def) throw new ValidationError(`Unknown layout "${layout}"`);
  const panes = [];
  for (let i = 0; i < def.panes; i++) {
    const p = Array.isArray(s.panes) ? s.panes[i] : null;
    panes.push(p && siteIds.has(p) ? p : null);
  }
  return {
    id: String(s.id),
    name,
    layout,
    ratios: normalizeRatios(layout, s.ratios),
    panes,
    inRotation: s.inRotation !== false,
  };
}

function cleanSettings(s, setupIds) {
  const out = { ...DEFAULT_SETTINGS };
  const src = s || {};
  out.gestureEdgePx = num(src.gestureEdgePx, out.gestureEdgePx, 5, 200);
  out.gestureDistancePx = num(src.gestureDistancePx, out.gestureDistancePx, 30, 600);
  const bool = (key) => (src[key] !== undefined ? !!src[key] : out[key]);
  out.cornerLongPress = bool('cornerLongPress');
  out.edgeSwipe = bool('edgeSwipe');
  out.sideEdgePx = num(src.sideEdgePx, out.sideEdgePx, 5, 200);
  out.showSwitchToast = bool('showSwitchToast');
  out.swipeAnimation = bool('swipeAnimation');
  out.hideCursor = !!src.hideCursor;
  out.hideScrollbars = bool('hideScrollbars');
  out.onScreenKeyboard = bool('onScreenKeyboard');
  out.ignoreCertErrors = bool('ignoreCertErrors');
  out.keepAliveViews = Math.round(num(src.keepAliveViews, out.keepAliveViews, 0, 12));
  out.gapPx = Math.round(num(src.gapPx, out.gapPx, 0, 40));
  out.configPin = String(src.configPin || '').trim();
  out.port = Math.round(num(src.port, out.port, 1, 65535));
  out.activeSetupId = setupIds.has(src.activeSetupId) ? src.activeSetupId : [...setupIds][0] || null;
  out.mqtt = cleanMqtt(src.mqtt, setupIds);
  return out;
}

// MQTT topic levels can't contain "/", "+" or "#"; keep ids simple.
function topicId(v, def) {
  const id = String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || def;
}

function cleanMqtt(m, setupIds) {
  const src = m || {};
  const url = String(src.url ?? DEFAULT_MQTT.url).trim();
  if (src.enabled && !/^(mqtts?|wss?):\/\/[^/]+/.test(url)) {
    throw new ValidationError('MQTT broker must look like mqtt://host:1883');
  }
  return {
    enabled: !!src.enabled,
    url,
    username: String(src.username || ''),
    password: String(src.password || ''),
    topicPrefix: String(src.topicPrefix || DEFAULT_MQTT.topicPrefix).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_MQTT.topicPrefix,
    clientId: topicId(src.clientId, topicId(os.hostname().split('.')[0], 'kiosk')),
    setupId: setupIds.has(src.setupId) ? src.setupId : '',
    durationSeconds: Math.round(num(src.durationSeconds, DEFAULT_MQTT.durationSeconds, 5, 3600)),
    maxAgeSeconds: Math.round(num(src.maxAgeSeconds, DEFAULT_MQTT.maxAgeSeconds, 0, 3600)),
  };
}

// Validate and normalise a whole config object. Throws ValidationError.
function validate(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new ValidationError('Config must be an object');
  const sites = [];
  const siteIds = new Set();
  for (const raw of cfg.sites || []) {
    const site = cleanSite(raw);
    if (!site.id || siteIds.has(site.id)) throw new ValidationError(`Duplicate or missing site id "${site.id}"`);
    siteIds.add(site.id);
    sites.push(site);
  }
  const setups = [];
  const setupIds = new Set();
  for (const raw of cfg.setups || []) {
    const setup = cleanSetup(raw, siteIds);
    if (!setup.id || setupIds.has(setup.id)) throw new ValidationError(`Duplicate or missing setup id "${setup.id}"`);
    setupIds.add(setup.id);
    setups.push(setup);
  }
  return { sites, setups, settings: cleanSettings(cfg.settings, setupIds) };
}

class ConfigStore extends EventEmitter {
  constructor(filePath = process.env.KIOSK_CONFIG || DEFAULT_PATH) {
    super();
    this.filePath = filePath;
    this.config = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return validate(JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the broken file for inspection rather than silently overwriting it.
        const backup = `${this.filePath}.broken-${Date.now()}`;
        try { fs.copyFileSync(this.filePath, backup); } catch { /* ignore */ }
        console.error(`[config] Failed to load ${this.filePath} (${err.message}); backup at ${backup}`);
      }
      const cfg = validate(defaultConfig());
      this._write(cfg);
      return cfg;
    }
  }

  _write(cfg) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  get() {
    return structuredClone(this.config);
  }

  getSite(id) {
    return this.config.sites.find((s) => s.id === id) || null;
  }

  getSetup(id) {
    return this.config.setups.find((s) => s.id === id) || null;
  }

  getActiveSetup() {
    return this.getSetup(this.config.settings.activeSetupId);
  }

  // Apply a mutation to a copy, validate, persist, then emit 'changed'.
  _commit(mutate) {
    const draft = this.get();
    mutate(draft);
    const next = validate(draft);
    const prev = this.config;
    this._write(next);
    this.config = next;
    this.emit('changed', this.get(), prev);
    return this.get();
  }

  replace(cfg) {
    return this._commit((draft) => {
      draft.sites = cfg.sites;
      draft.setups = cfg.setups;
      draft.settings = cfg.settings;
    });
  }

  addSite(data) {
    let id;
    this._commit((d) => {
      id = makeId(data.name, new Set(d.sites.map((s) => s.id)));
      d.sites.push({ ...data, id });
    });
    return this.getSite(id);
  }

  updateSite(id, data) {
    if (!this.getSite(id)) throw new ValidationError(`No site "${id}"`, 'NOT_FOUND');
    this._commit((d) => {
      const i = d.sites.findIndex((s) => s.id === id);
      d.sites[i] = { ...d.sites[i], ...data, id };
    });
    return this.getSite(id);
  }

  // Refuses to delete a site that a setup still uses unless `force` is set;
  // forcing clears it from those panes.
  deleteSite(id, { force = false } = {}) {
    if (!this.getSite(id)) throw new ValidationError(`No site "${id}"`, 'NOT_FOUND');
    const usedBy = this.config.setups.filter((s) => s.panes.includes(id)).map((s) => s.name);
    if (usedBy.length && !force) {
      throw new ValidationError(`Site is used by: ${usedBy.join(', ')}`, 'IN_USE', { usedBy });
    }
    this._commit((d) => {
      d.sites = d.sites.filter((s) => s.id !== id);
    });
  }

  addSetup(data) {
    let id;
    this._commit((d) => {
      id = makeId(data.name, new Set(d.setups.map((s) => s.id)));
      d.setups.push({ ...data, id });
      if (!d.settings.activeSetupId) d.settings.activeSetupId = id;
    });
    return this.getSetup(id);
  }

  updateSetup(id, data) {
    if (!this.getSetup(id)) throw new ValidationError(`No setup "${id}"`, 'NOT_FOUND');
    this._commit((d) => {
      const i = d.setups.findIndex((s) => s.id === id);
      d.setups[i] = { ...d.setups[i], ...data, id };
    });
    return this.getSetup(id);
  }

  deleteSetup(id) {
    if (!this.getSetup(id)) throw new ValidationError(`No setup "${id}"`, 'NOT_FOUND');
    this._commit((d) => {
      d.setups = d.setups.filter((s) => s.id !== id);
    });
  }

  reorderSetups(ids) {
    this._commit((d) => {
      const order = new Map(ids.map((id, i) => [id, i]));
      d.setups.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    });
  }

  setActive(id) {
    if (!this.getSetup(id)) throw new ValidationError(`No setup "${id}"`, 'NOT_FOUND');
    this._commit((d) => {
      d.settings.activeSetupId = id;
    });
  }

  updateSettings(data) {
    this._commit((d) => {
      d.settings = { ...d.settings, ...data };
    });
    return this.get().settings;
  }
}

module.exports = { ConfigStore, ValidationError, validate, defaultConfig, DEFAULT_PATH };
