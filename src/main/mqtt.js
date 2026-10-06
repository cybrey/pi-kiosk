'use strict';

const { EventEmitter } = require('events');
const mqtt = require('mqtt');

/**
 * Shows setups when MQTT messages arrive, e.g. the doorbell camera when Home
 * Assistant publishes a ring. The broker connection is in Settings; each setup
 * can have a trigger topic (setup.mqtt.topic) and how long to show it.
 *
 * A trigger topic ending in "/show" follows the Doorbell Popup desktop app's
 * convention, so one message from HA reaches every screen:
 *
 *   doorbell/show               show the setup (every screen)
 *   doorbell/hide               go back now, if that setup is showing
 *   doorbell/<clientId>/show    just this kiosk
 *   doorbell/<clientId>/hide
 *
 * Any other topic only shows. The kiosk also publishes a retained
 * "online"/"offline" (last will) to <topicPrefix>/clients/<clientId>.
 *
 * Payloads are empty or a JSON object. Optional fields: "ts" (unix seconds;
 * messages older than maxAgeSeconds are ignored) and "timeoutSeconds" (how
 * long to show, overriding the setup's own duration).
 */

// Topic -> { action, setup } for every setup with a trigger.
function routes(setups, clientId) {
  const map = new Map();
  for (const setup of setups) {
    const topic = setup.mqtt?.topic;
    if (!topic) continue;
    map.set(topic, { action: 'show', setup });
    if (!topic.endsWith('/show')) continue;
    const base = topic.slice(0, -'/show'.length);
    map.set(`${base}/${clientId}/show`, { action: 'show', setup });
    map.set(`${base}/hide`, { action: 'hide', setup });
    map.set(`${base}/${clientId}/hide`, { action: 'hide', setup });
  }
  return map;
}

// Decides what a message means. Pure, so it can be unit tested.
// Returns { action: 'show', setupId, duration } | { action: 'hide', setupId } | { ignore: reason }.
function decide({ topic, payload, retain, now = Date.now() }, cfg) {
  const route = routes(cfg.setups, cfg.mqtt.clientId).get(topic);
  if (!route) return { ignore: 'unknown topic' };
  // A retained message would replay on every reconnect.
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
  if (body.ts != null && cfg.mqtt.maxAgeSeconds > 0) {
    const age = now / 1000 - Number(body.ts);
    if (age > cfg.mqtt.maxAgeSeconds) return { ignore: `message is ${Math.round(age)}s old` };
  }
  const setupId = route.setup.id;
  if (route.action === 'hide') return { action: 'hide', setupId };
  const t = Number(body.timeoutSeconds);
  return { action: 'show', setupId, duration: Number.isFinite(t) && t > 0 ? t : route.setup.mqtt.durationSeconds };
}

class TriggerSubscriber extends EventEmitter {
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
    this.connection = '';
    this.topics = [];

    store.on('changed', () => this.sync());
    this.sync();
  }

  // Reconnect when the connection settings change; otherwise just update
  // the subscriptions to match the setups' triggers.
  sync() {
    const cfg = this.store.get();
    const connection = JSON.stringify(cfg.settings.mqtt);
    if (connection !== this.connection) {
      this.connection = connection;
      this._disconnect();
      this.topics = [];
      if (cfg.settings.mqtt.enabled) this._connect(cfg.settings.mqtt);
      else this._setStatus('off');
      return;
    }
    if (this.client?.connected) this._subscribe();
  }

  _wantedTopics() {
    const cfg = this.store.get();
    return [...routes(cfg.setups, cfg.settings.mqtt.clientId).keys()];
  }

  _subscribe() {
    const client = this.client;
    const wanted = this._wantedTopics();
    const gone = this.topics.filter((t) => !wanted.includes(t));
    const added = wanted.filter((t) => !this.topics.includes(t));
    this.topics = wanted;
    if (gone.length) client.unsubscribe(gone);
    if (added.length) {
      client.subscribe(added, { qos: 1 }, (err) => {
        if (err) console.error('[mqtt] subscribe failed', err.message);
      });
    }
    if (!wanted.length) console.log('[mqtt] connected, but no setup has an MQTT trigger yet');
  }

  _setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    console.log(`[mqtt] ${status}`);
    this.emit('status', status);
  }

  _connect(cfg) {
    const presence = `${cfg.topicPrefix}/clients/${cfg.clientId}`;
    const client = mqtt.connect(cfg.url, {
      clientId: `pi-kiosk-${cfg.clientId}`,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clean: true, // messages missed while offline are not replayed later
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: { topic: presence, payload: 'offline', qos: 1, retain: true },
    });
    this.client = client;
    this.presence = presence;
    this._setStatus('connecting');

    client.on('connect', () => {
      this._setStatus('connected');
      this.topics = []; // a clean session starts with no subscriptions
      this._subscribe();
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
    const cfg = this.store.get();
    const result = decide({ topic, payload, retain: packet.retain }, { setups: cfg.setups, mqtt: cfg.settings.mqtt });
    if (result.ignore) {
      if (result.ignore !== 'unknown topic') console.warn(`[mqtt] ignoring ${topic}: ${result.ignore}`);
      return;
    }
    try {
      if (result.action === 'hide') {
        // Only end the temporary display this trigger started.
        const state = this.display.state();
        if (state.temporary && state.activeSetupId === result.setupId) this.display.revert();
      } else {
        this.display.activate(result.setupId, { duration: result.duration });
        console.log(`[mqtt] ${topic}: showing "${result.setupId}" for ${result.duration}s`);
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
    this.connection = '';
    this._disconnect();
  }
}

module.exports = { TriggerSubscriber, decide, routes };
