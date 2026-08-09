/**
 * core/offline-progress.js — offline progress simulation (core engine).
 *
 * Simulates the production that happened while the player was away. On boot,
 * after a save is restored, the game measures the wall-clock gap since the
 * last active session (the timestamp this system stamps into
 * `state.meta.lastSeenAt` on every save), caps it, runs every configured
 * producer forward and applies the gains to GameState. The whole pipeline
 * from PLANS.md — store last timestamp → calculate elapsed → simulate
 * production → apply caps → emit summary — lives here so the gameplay
 * phases (meditation, herbs, sect income, ...) only need to declare their
 * producers in JSON and the engine keeps working unchanged.
 *
 * Data-driven producers: each entry in `config.offline.producers` describes
 * one resource that accrues while away:
 *   {
 *     "id":       "qi",                       unique producer id,
 *     "label":    "Qi",                       optional display name (falls back to id),
 *     "path":     "cultivation.qi",           state path the gains are added to,
 *     "ratePath": "cultivation.qiPerSecond",  state path of the per-second rate,
 *     "capPath":  "cultivation.qiMax"         optional state path of the resource cap
 *   }
 * Rates and caps are read from GameState at apply time, so a producer with a
 * zero rate (e.g. qi before the meditation system exists) simply yields zero.
 * Nothing is hardcoded: tuning lives in data/game-config.json.
 *
 * Event contract (emitted on the shared EventBus):
 *   offline:progress { summary } — fired once per apply() that simulated a
 *     real gap (previous session + enabled + elapsed time). The payload is
 *     the same summary object apply() returns, so future consumers
 *     (notifications, history) can announce the gains without touching this
 *     system.
 *
 * Pure core-engine infrastructure — no DOM access, no storage I/O (the
 * timestamp lives in GameState and is persisted by SaveManager through the
 * normal serialize path), framework-free and GitHub Pages compatible.
 *
 * Future expansion (see PLANS.md): per-producer multipliers (spirit roots,
 * formations, sect bonuses), per-resource caps with growth, and a richer
 * summary for the notification system.
 */

import { EventBus } from './event-bus.js';
import { GameState } from './game-state.js';

/** Keys that alias the prototype chain and must never be traversed or written. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class OfflineProgress {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `offline` block is read (enabled, maxOfflineMs, producers).
   *        A missing block disables offline progress silently.
   * @param {object} [options.state] — game state object to read rates, caps,
   *        resources and the last-seen timestamp from and apply gains to;
   *        defaults to the shared GameState singleton (same dependency-
   *        injection pattern as DataManager, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {() => number} [options.now] — clock returning the current epoch ms;
   *        defaults to Date.now (injectable for deterministic tests).
   */
  constructor(options = {}) {
    const offline = (options.config && options.config.offline) || {};

    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {() => number} wall-clock source (epoch ms). */
    this._now = typeof options.now === 'function' ? options.now : Date.now;

    /** @type {boolean} master switch from config (per-player toggle is read from state). */
    this._enabled = _readBoolean(offline.enabled, false, 'enabled');
    /** @type {number} cap on simulated time away in ms (0 disables gains). */
    this._maxOfflineMs = _readNonNegativeNumber(offline.maxOfflineMs, 0, 'maxOfflineMs');
    /** @type {Array<{id: string, label: string, path: string, ratePath: string, capPath: string|null}>} */
    this._producers = _readProducers(offline.producers);
  }

  /**
   * @returns {boolean} true when offline progress is enabled in config.
   */
  get isEnabled() {
    return this._enabled;
  }

  /**
   * @returns {number} configured cap on simulated away-time in ms.
   */
  get maxOfflineMs() {
    return this._maxOfflineMs;
  }

  /**
   * @returns {Array<object>} shallow copies of the configured producers.
   */
  get producers() {
    return this._producers.map((producer) => ({ ...producer }));
  }

  /**
   * Simulate the time spent away since the last active session and apply the
   * resulting gains to the game state. The reference point is read from
   * `state.meta.lastSeenAt` (written by stamp() on every save) or passed in
   * explicitly via the `lastActiveAt` option.
   *
   * Pipeline: compute the raw wall-clock gap (0 for a fresh game or a clock
   * that moved backwards) → skip entirely when offline progress is disabled
   * (config or the player's settings.offlineProgress) or there is nothing to
   * simulate → cap the gap at maxOfflineMs → run each producer forward
   * (amount = floor(rate × seconds), clamped to the resource cap if any) →
   * apply the gains to state → emit 'offline:progress' → return the summary.
   *
   * @param {object} [options] — apply options.
   * @param {number} [options.lastActiveAt] — epoch ms of the previous
   *        session's end; defaults to state.meta.lastSeenAt (0 = fresh game).
   * @param {number} [options.now] — current epoch ms; defaults to this._now()
   *        (Date.now). Overrides the injected clock for explicit callers.
   * @returns {object} the summary:
   *          {
   *            applied:      boolean — true when production was simulated,
   *            enabled:      boolean — config && player setting both on,
   *            elapsedMs:    number  — raw wall-clock gap (0 when none),
   *            timeCapped:   boolean — elapsedMs exceeded maxOfflineMs,
   *            effectiveMs:  number  — simulated duration after the cap,
   *            producers:    Array   — per-producer gains
   *              { id, label, amount, rate, cap, capped }
   *          }
   */
  apply({ lastActiveAt, now } = {}) {
    const nowMs = Number.isFinite(Number(now)) ? Number(now) : this._now();
    const lastMs = Number(lastActiveAt);
    const lastSeen = Number.isFinite(lastMs) ? lastMs : this._readLastSeenAt();

    // A gap only exists after a previous session and only forward in time.
    const elapsedMs = lastSeen > 0 ? Math.max(nowMs - lastSeen, 0) : 0;

    const summary = {
      applied: false,
      enabled: this._enabled && this._playerEnabled(),
      elapsedMs,
      timeCapped: false,
      effectiveMs: 0,
      producers: [],
    };

    if (!summary.enabled || elapsedMs <= 0) {
      return summary;
    }

    const effectiveMs = Math.min(elapsedMs, this._maxOfflineMs);
    summary.timeCapped = effectiveMs < elapsedMs;
    summary.effectiveMs = effectiveMs;

    const seconds = effectiveMs / 1000;
    for (const producer of this._producers) {
      summary.producers.push(this._applyProducer(producer, seconds));
    }

    summary.applied = true;
    this._eventBus.emit('offline:progress', summary);
    return summary;
  }

  /**
   * Record the current wall-clock time as the end of the active session.
   * Called by the bootstrap right before every serialize, so each save
   * carries the timestamp the next boot measures offline time from. Safe to
   * call at any time — it only writes `state.meta.lastSeenAt`.
   *
   * @returns {void}
   */
  stamp() {
    if (this._state.meta === null || typeof this._state.meta !== 'object') {
      this._state.meta = {};
    }
    this._state.meta.lastSeenAt = this._now();
  }

  /**
   * Read the last-seen timestamp from state (the default reference point for
   * apply()). Tolerates a state that predates the meta slice (old saves).
   *
   * @returns {number} the stored epoch ms, or 0 when absent/invalid.
   */
  _readLastSeenAt() {
    const meta = this._state.meta;
    if (meta === null || typeof meta !== 'object') return 0;
    const value = Number(meta.lastSeenAt);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * Run one producer forward and apply its gains to the game state. The
   * amount is the floored per-second rate over the simulated seconds, clamped
   * to the space left below the resource cap (capPath), so a resource can
   * never exceed its cap while away. Missing or non-numeric rates/caps are
   * treated as zero (fail-safe: a broken producer yields no gains).
   *
   * @param {{id: string, label: string, path: string, ratePath: string, capPath: string|null}} producer — validated producer.
   * @param {number} seconds — simulated duration in seconds.
   * @returns {{id: string, label: string, amount: number, rate: number, cap: number|null, capped: boolean}}
   *          the producer's gains.
   */
  _applyProducer(producer, seconds) {
    const current = _asNumber(this._readPath(producer.path));
    const rate = _asNumber(this._readPath(producer.ratePath));
    const cap = producer.capPath ? _asNumber(this._readPath(producer.capPath)) : null;

    // The produced amount is bounded by the free room below the cap; a
    // missing cap means unbounded. Never negative, never fractional, and
    // never non-finite: a rate so large that rate × seconds overflows (an
    // uncapped producer) yields zero gains instead of Infinity in state.
    const room = cap === null ? Infinity : Math.max(cap - current, 0);
    const rawAmount = Math.floor(Math.min(rate * seconds, room));
    let amount = Number.isFinite(rawAmount) && rawAmount > 0 ? rawAmount : 0;

    if (amount > 0) {
      const next = current + amount;
      if (Number.isFinite(next) && this._writePath(producer.path, next)) {
        // Gain applied.
      } else {
        // current + amount overflowed, or the write was skipped (unsafe or
        // malformed path) — report zero so the summary never claims
        // resources that were not actually added.
        amount = 0;
      }
    }

    return {
      id: producer.id,
      label: producer.label,
      amount,
      rate,
      cap,
      capped: cap !== null && amount > 0 && current + amount >= cap,
    };
  }

  /**
   * @returns {boolean} true when the player's own setting (settings.offlineProgress)
   *          has not been turned off; missing settings default to enabled.
   */
  _playerEnabled() {
    return !(this._state.settings && this._state.settings.offlineProgress === false);
  }

  /**
   * Resolve a dot path (e.g. "cultivation.qi") through the game state.
   * Missing intermediate segments short-circuit to undefined, and segments
   * that alias the prototype chain (`__proto__`, `constructor`, `prototype`)
   * are treated as missing — a producer path can never reach Object.prototype
   * (defense in depth; paths are dev-authored config, not user input).
   *
   * @param {string} path — dot-separated path into the state object.
   * @returns {*} the value at the path, or undefined when a segment is missing.
   */
  _readPath(path) {
    let current = this._state;
    for (const segment of String(path).split('.')) {
      if (current === null || current === undefined || UNSAFE_KEYS.has(segment)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }

  /**
   * Write a value at a dot path. Missing intermediate segments are created as
   * plain objects (a producer pointing at a not-yet-existing slice simply
   * creates it), but an intermediate segment that already holds a non-object
   * (a scalar or an array), or any segment that aliases the prototype chain
   * (`__proto__`, `constructor`, `prototype`), aborts with a warning instead
   * of clobbering — a misconfigured producer path must never destroy an
   * existing state field or pollute Object.prototype.
   *
   * @param {string} path — dot-separated path into the state object.
   * @param {*} value — value to write.
   * @returns {boolean} true when the value was written, false when the path
   *          was unsafe and the write was skipped.
   */
  _writePath(path, value) {
    const segments = String(path).split('.');
    let current = this._state;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (UNSAFE_KEYS.has(segment)) {
        console.warn(
          `OfflineProgress: producer path "${path}" uses an unsafe key ` +
            `"${segment}" — skipping this gain.`
        );
        return false;
      }
      const next = current[segment];
      if (next === undefined || next === null) {
        current[segment] = {};
        current = current[segment];
      } else if (typeof next === 'object' && !Array.isArray(next)) {
        current = next;
      } else {
        console.warn(
          `OfflineProgress: producer path "${path}" crosses a non-object at ` +
            `"${segments.slice(0, i + 1).join('.')}" — skipping this gain.`
        );
        return false;
      }
    }
    const last = segments[segments.length - 1];
    if (UNSAFE_KEYS.has(last)) {
      console.warn(
        `OfflineProgress: producer path "${path}" uses an unsafe key ` +
          `"${last}" — skipping this gain.`
      );
      return false;
    }
    current[last] = value;
    return true;
  }
}

/**
 * Read and validate a producer list from config. Entries without a non-empty
 * id, path and ratePath are skipped with a warning; the rest are normalized
 * (label falls back to id, capPath to null). A missing "producers" key is
 * silent — it simply means nothing is simulated.
 *
 * @param {*} raw — raw value of config.offline.producers.
 * @returns {Array<{id: string, label: string, path: string, ratePath: string, capPath: string|null}>}
 *          the validated producers.
 */
function _readProducers(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn('OfflineProgress: "producers" must be an array — ignoring producers.');
    return [];
  }

  const producers = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn('OfflineProgress: skipping a producer that is not an object.');
      continue;
    }
    if (
      typeof entry.id !== 'string' ||
      entry.id === '' ||
      typeof entry.path !== 'string' ||
      entry.path === '' ||
      typeof entry.ratePath !== 'string' ||
      entry.ratePath === ''
    ) {
      console.warn(
        'OfflineProgress: skipping a producer without non-empty id, path and ratePath.'
      );
      continue;
    }
    producers.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
      path: entry.path,
      ratePath: entry.ratePath,
      capPath:
        typeof entry.capPath === 'string' && entry.capPath !== '' ? entry.capPath : null,
    });
  }
  return producers;
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no production" value — never a tuning number).
 *
 * @param {*} value — raw value (rate, cap or resource count).
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read a boolean tuning option, falling back to a default. A missing value
 * falls back silently (a broken/partial config is not an error); a present
 * but invalid value warns once.
 *
 * @param {*} value — raw option value.
 * @param {boolean} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {boolean} the validated value, or the fallback.
 */
function _readBoolean(value, fallback, name) {
  if (typeof value === 'boolean') return value;
  if (value !== undefined) {
    console.warn(`OfflineProgress: invalid "${name}" (${String(value)}) — using ${fallback}.`);
  }
  return fallback;
}

/**
 * Read a non-negative finite number tuning option, falling back to a default.
 * A missing value falls back silently; a present but invalid value warns once.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _readNonNegativeNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  if (value !== undefined) {
    console.warn(`OfflineProgress: invalid "${name}" (${String(value)}) — using ${fallback}.`);
  }
  return fallback;
}
