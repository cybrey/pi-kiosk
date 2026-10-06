'use strict';

const { EventEmitter } = require('events');
const mqtt = require('mqtt');

/**
 * Doorbell over MQTT. Shares its topics with the Doorbell Popup desktop app, so
 * Home Assistant publishes one message per ring and every screen reacts:
 *
 *   <prefix>/show               all subscribers: show the doorbell setup
 *   <prefix>/hide               all subscribers: go back now
 *   <prefix>/<clientId>/show    just this kiosk
 *   <prefix>/<clientId>/hide
 *   <prefix>/clients/<clientId> retained "online"/"offline" (last will), published here
 *
 * Payloads are empty or a JSON object. Optional fields: "ts" (unix seconds;
 * messages older than maxAgeSeconds are ignored) and "timeoutSeconds" (how
 * long to show the doorbell setup, overriding durationSeconds).
 */

// Decides what a message means. Pure, so it can be unit tested.
// Returns { action: 'show', duration } | { action: 'hide' } | { ignore: reason }.
function decide({ topic, payload, retain, now = Date.now() }, cfg) {
  const prefix = cfg.topicPrefix;
  const action = {
    [`${prefix}/show`]: 'show',
    [`${prefix}/hide`]: 'hide',
    [`${prefix}/${cfg.clientId}/show`]: 'show',
    [`${prefix}/${cfg.clientId}/hide`]: 'hide',
  }[topic];
  if (!action) return { ignore: 'unknown topic' };
  // A retained ring would replay on every reconnect.
  if (retain) return { ignore: 'retained message' };

  let body = {};
  const text = Buffer.from(payload || '').toString('utf8').trim();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return { ignore: 'payload is not JSON' };
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { ignore: 'payload must be a JSON object' };
    }
  }
  if (body.ts != null && cfg.maxAgeSeconds > 0) {
    const age = now / 1000 - Number(body.ts);
    if (age > cfg.maxAgeSeconds) return { ignore: `message is ${Math.round(age)}s old` };
  }
  if (action === 'hide') return { action };
  const t = Number(body.timeoutSeconds);
  return { action, duration: Number.isFinite(t) && t > 0 ? t : cfg.durationSeconds };
}

class DoorbellSubscriber extends EventEmitter {
  /**
   * @param {import('./config-store').ConfigStore} store
   * @param {import('./display').Display} display
   */
  constructor(store, display) {
    super();
    this.store = store;
    this.display = display;
    this.client = null;
    this.status = 'off';
    this.current = '';

    store.on('changed', () => this.sync());
    this.sync();
  }

  // (Re)connect when the MQTT settings change.
  sync() {
    const cfg = this.store.get().settings.mqtt;
    const key = JSON.stringify(cfg);
    if (key === this.current) return;
    this.current = key;
    this._disconnect();
    if (cfg.enabled) this._connect(cfg);
    else this._setStatus('off');
  }

  _setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    console.log(`[mqtt] ${status}`);
    this.emit('status', status);
  }

  _connect(cfg) {
    const presence = `${cfg.topicPrefix}/clients/${cfg.clientId}`;
    const topics = ['show', 'hide'].flatMap((a) => [`${cfg.topicPrefix}/${a}`, `${cfg.topicPrefix}/${cfg.clientId}/${a}`]);
    const client = mqtt.connect(cfg.url, {
      clientId: `pi-kiosk-${cfg.clientId}`,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clean: true, // rings missed while offline are not replayed later
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: { topic: presence, payload: 'offline', qos: 1, retain: true },
    });
    this.client = client;
    this.presence = presence;
    this._setStatus('connecting');

    client.on('connect', () => {
      this._setStatus('connected');
      client.subscribe(topics, { qos: 1 }, (err) => {
        if (err) console.error('[mqtt] subscribe failed', err.message);
      });
      client.publish(presence, 'online', { qos: 1, retain: true });
    });
    // Keep an error on show while retrying, rather than flicking to "connecting".
    const unlessError = (s) => () => {
      if (!this.status.startsWith('error')) this._setStatus(s);
    };
    client.on('reconnect', unlessError('connecting'));
    client.on('offline', unlessError('offline'));
    client.on('error', (err) => this._setStatus(`error: ${err.message}`));
    client.on('message', (topic, payload, packet) => this._onMessage(topic, payload, packet));
  }

  _onMessage(topic, payload, packet) {
    const cfg = this.store.get().settings.mqtt;
    const result = decide({ topic, payload, retain: packet.retain }, cfg);
    if (result.ignore) {
      if (result.ignore !== 'unknown topic') console.warn(`[mqtt] ignoring ${topic}: ${result.ignore}`);
      return;
    }
    try {
      if (result.action === 'hide') {
        this.display.revert();
      } else if (!cfg.setupId) {
        console.warn('[mqtt] doorbell rang, but no doorbell setup is chosen in Settings');
      } else {
        this.display.activate(cfg.setupId, { duration: result.duration });
        console.log(`[mqtt] doorbell: showing "${cfg.setupId}" for ${result.duration}s`);
      }
    } catch (err) {
      console.error(`[mqtt] ${topic} failed`, err.message);
    }
  }

  _disconnect() {
    const client = this.client;
    if (!client) return;
    this.client = null;
    client.removeAllListeners();
    client.on('error', () => {});
    if (client.connected) {
      client.publish(this.presence, 'offline', { qos: 1, retain: true }, () => client.end());
      setTimeout(() => client.end(true), 1500); // don't hang on a dead connection
    } else {
      client.end(true);
    }
  }

  dispose() {
    this.current = '';
    this._disconnect();
  }
}

module.exports = { DoorbellSubscriber, decide };
