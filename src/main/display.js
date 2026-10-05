'use strict';

const { EventEmitter } = require('events');
const { ValidationError } = require('./config-store');

/**
 * Decides which setup is on screen.
 *
 * Normally that is the saved `settings.activeSetupId`. A temporary activation
 * (e.g. Home Assistant showing the doorbell camera for 30 s) overrides it
 * without touching the saved config, then reverts automatically. Any
 * permanent switch (menu, swipe, API without duration) cancels the override.
 *
 * Emits 'changed' whenever the on-screen setup (or its temporary state) changes.
 */
class Display extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.override = null; // setup id shown temporarily
    this.until = null; // epoch ms when the override ends
    this.timer = null;

    store.on('changed', (next) => {
      if (this.override && !next.setups.some((s) => s.id === this.override)) this._clearOverride(false);
      this.emit('changed', this.state());
    });
  }

  activeId() {
    return this.override || this.store.get().settings.activeSetupId;
  }

  // Accept a setup id, or a setup name (case-insensitive) for friendlier automations.
  resolve(idOrName) {
    const { setups } = this.store.get();
    const key = String(idOrName || '');
    const hit = setups.find((s) => s.id === key)
      || setups.find((s) => s.name.toLowerCase() === key.toLowerCase());
    if (!hit) throw new ValidationError(`No setup "${key}"`, 'NOT_FOUND');
    return hit.id;
  }

  /**
   * @param {string} idOrName
   * @param {{ duration?: number }} [opts] seconds; > 0 makes it temporary
   */
  activate(idOrName, { duration = 0 } = {}) {
    const id = this.resolve(idOrName);
    const secs = Number(duration);
    if (Number.isFinite(secs) && secs > 0) {
      // A repeat call (doorbell pressed again) just restarts the countdown;
      // the screen to return to is still the saved setup.
      this.override = id === this.store.get().settings.activeSetupId ? null : id;
      clearTimeout(this.timer);
      this.until = this.override ? Date.now() + secs * 1000 : null;
      if (this.override) this.timer = setTimeout(() => this._clearOverride(true), secs * 1000);
      this.emit('changed', this.state());
      return this.state();
    }
    const hadOverride = !!this.override;
    this._clearOverride(false);
    if (this.store.get().settings.activeSetupId !== id) {
      this.store.setActive(id); // emits via the store listener
    } else if (hadOverride) {
      this.emit('changed', this.state());
    }
    return this.state();
  }

  // Move through setups in configured order (only those in the swipe rotation).
  step(direction) {
    const { setups } = this.store.get();
    let ring = setups.filter((s) => s.inRotation !== false);
    if (!ring.length) ring = setups;
    if (!ring.length) return this.state();
    const current = this.activeId();
    const idx = ring.findIndex((s) => s.id === current);
    const delta = direction === 'prev' ? -1 : 1;
    const next = idx === -1 ? ring[0] : ring[(idx + delta + ring.length) % ring.length];
    return this.activate(next.id);
  }

  revert() {
    this._clearOverride(true);
    return this.state();
  }

  _clearOverride(emit) {
    clearTimeout(this.timer);
    this.timer = null;
    const had = !!this.override;
    this.override = null;
    this.until = null;
    if (had && emit) this.emit('changed', this.state());
  }

  state() {
    const cfg = this.store.get();
    const activeSetupId = this.activeId();
    const setup = cfg.setups.find((s) => s.id === activeSetupId);
    return {
      activeSetupId,
      activeSetupName: setup ? setup.name : null,
      savedSetupId: cfg.settings.activeSetupId,
      temporary: !!this.override,
      revertsAt: this.until ? new Date(this.until).toISOString() : null,
      secondsLeft: this.until ? Math.max(0, Math.ceil((this.until - Date.now()) / 1000)) : null,
    };
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

module.exports = { Display };
