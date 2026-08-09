/**
 * systems/meditation.js — MeditationSystem (first gameplay system, produces Qi).
 *
 * The first Phase-2 gameplay system. While the cultivator is meditating
 * (state.meditation.active), every fixed simulation tick ('loop:update')
 * produces qi into state.cultivation.qi, clamped to the qi cap
 * (cultivation.qiMax), and reports each gain as a fact on the EventBus so
 * downstream consumers (renderer, statistics, notifications, audio) can react
 * without this system referencing them. A start/stop/toggle session API is
 * provided for the future UI; the system itself never touches the DOM.
 *
 * Data-driven tuning: the per-second rate comes from
 * config.meditation.baseQiPerSecond (see data/game-config.json) — nothing is
 * hardcoded. A MISSING meditation config block is silent (rate 0); a present
 * but invalid value warns once in the constructor and falls back to 0
 * (mirroring the _readNonNegativeNumber pattern in save-manager and
 * offline-progress).
 *
 * State owned (writes): meditation.active, meditation.startedAt,
 * cultivation.qi, cultivation.qiPerSecond, statistics.qiGenerated,
 * statistics.meditationsCompleted. The `meditation` slice and every other
 * path are part of the canonical GameState (see core/game-state.js), so they
 * always exist; reads of qi/qiMax/statistics are still coerced with a
 * fail-safe _asNumber so a malformed or legacy value can never poison the
 * math.
 *
 * Event contract (all emitted on the shared EventBus; consumed: 'loop:update'):
 *   loop:update          { deltaMs, elapsedMs, tick } — subscribed in the
 *                         constructor; the fixed-timestep simulation pulse
 *                         (deltaMs === tickRateMs) that drives production.
 *   qi:gained            { amount, source: 'meditation', total } — fired per
 *                         tick whenever qi actually increased (never on zero
 *                         gains, to avoid noise).
 *   meditation:started   { startedAt, mode } — a session began.
 *   meditation:stopped   { durationMs, qiGained, meditationsCompleted } —
 *                         a session ended; qiGained is that session's total.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. Systems communicate through the EventBus only; this
 * module depends solely on the shared GameState and EventBus singletons
 * (both injectable for deterministic tests).
 *
 * Future expansion (see DESIGN.md): Focused/Deep/Dual/Guided/Automatic
 * meditation modes (mode key already lives in state), per-mode and per-
 * multiplier rate stacking (spirit root, realm, technique, ...) — the tick
 * handler multiplies through _effectiveRate(), so extra factors plug in
 * without touching the production math.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

export class MeditationSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `meditation` block is read for baseQiPerSecond. A missing block
   *        is silent (rate 0); an invalid value warns once and falls back to 0.
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as DataManager, GameLoop, Renderer
   *        and OfflineProgress).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {() => number} [options.now] — clock returning the current epoch ms;
   *        defaults to Date.now (injectable for deterministic session
   *        durations in tests).
   */
  constructor(options = {}) {
    const meditation = (options.config && options.config.meditation) || {};

    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {() => number} wall-clock source (epoch ms). */
    this._now = typeof options.now === 'function' ? options.now : Date.now;

    /** @type {number} base qi produced per second of active meditation. */
    this._baseRate = _readNonNegativeNumber(
      meditation.baseQiPerSecond,
      0,
      'baseQiPerSecond'
    );

    /** @type {number} qi accumulated during the current session (reset on start/stop). */
    this._sessionQi = 0;

    // Bound once so subscribe/unsubscribe always see the same function
    // identity (same pattern as GameLoop._frame and Renderer's handlers).
    this._onUpdate = this._onUpdate.bind(this);
    this._eventBus.subscribe('loop:update', this._onUpdate);

    // Reflect the (possibly restored) active flag in the per-second rate
    // immediately — this is what the renderer bindings and the
    // offline-progress qi producer read.
    this._syncPerSecondRate(this.isActive ? this._effectiveRate() : 0);
  }

  /**
   * @returns {boolean} true while the cultivator is meditating (an active
   *          session is producing qi every tick).
   */
  get isActive() {
    return Boolean(this._state.meditation && this._state.meditation.active);
  }

  /**
   * Begin a meditation session. No-op (returns false) when a session is
   * already active; otherwise marks state active, records the session start
   * from the injected clock, resets the session-qi accumulator, syncs the
   * per-second rate into state and emits 'meditation:started'.
   *
   * @returns {boolean} true when a session was started, false when one was
   *          already running.
   */
  start() {
    if (this.isActive) return false;

    this._ensureMeditationSlice();
    this._state.meditation.active = true;
    this._state.meditation.startedAt = this._now();
    this._sessionQi = 0;
    this._syncPerSecondRate(this._effectiveRate());

    this._eventBus.emit('meditation:started', {
      startedAt: this._state.meditation.startedAt,
      mode: this._state.meditation.mode,
    });
    return true;
  }

  /**
   * End the current meditation session. No-op (returns false) when no
   * session is active; otherwise computes the session duration from the
   * injected clock (0 when no start was recorded, e.g. the fresh-default
   * session), marks state inactive, resets the session accumulator, counts
   * one completed meditation in statistics, zeroes the per-second rate and
   * emits 'meditation:stopped' with the session totals.
   *
   * @returns {boolean} true when a session was stopped, false when none was
   *          running.
   */
  stop() {
    if (!this.isActive) return false;

    const startedAt = _asNumber(this._state.meditation.startedAt);
    // startedAt === 0 means "no real session start" (fresh default or a
    // restored flag without a timestamp) — report zero duration instead of a
    // nonsense `now - 0` gap.
    const durationMs = startedAt > 0 ? Math.max(this._now() - startedAt, 0) : 0;

    this._state.meditation.active = false;
    this._state.meditation.startedAt = 0;

    const qiGained = this._sessionQi;
    this._sessionQi = 0;
    this._state.statistics.meditationsCompleted =
      _asNumber(this._state.statistics.meditationsCompleted) + 1;
    this._syncPerSecondRate(0);

    this._eventBus.emit('meditation:stopped', {
      durationMs,
      qiGained,
      meditationsCompleted: this._state.statistics.meditationsCompleted,
    });
    return true;
  }

  /**
   * Flip the meditation session: start when inactive, stop when active.
   *
   * @returns {boolean} the result of the underlying start()/stop() call.
   */
  toggle() {
    return this.isActive ? this.stop() : this.start();
  }

  /**
   * Tear down the system: unsubscribe the tick handler so 'loop:update'
   * events no longer mutate state (shutdown-sequence future-proofing; the
   * system must not be reused after this call).
   *
   * @returns {void}
   */
  destroy() {
    this._eventBus.unsubscribe('loop:update', this._onUpdate);
  }

  /**
   * Fixed-timestep tick handler (bound; invoked via 'loop:update').
   *
   * While inactive: guarantee cultivation.qiPerSecond is 0 (only writing
   * when it differs) and return — no qi, no event. While active: sync the
   * per-second rate, compute the raw gain from the payload's deltaMs (the
   * tick interval, never hardcoded), clamp it to the room left below the qi
   * cap and, when anything was actually gained, apply it to state, add it to
   * the session accumulator and emit 'qi:gained' (zero-gain ticks stay
   * silent).
   *
   * @param {object} [payload] — the 'loop:update' payload
   *        ({ deltaMs, elapsedMs, tick }).
   * @returns {void}
   */
  _onUpdate(payload) {
    if (!this.isActive) {
      this._syncPerSecondRate(0);
      return;
    }

    const rate = this._effectiveRate();
    this._syncPerSecondRate(rate);

    // Use the payload's deltaMs (=== tickRateMs from the GameLoop); a
    // missing or non-finite delta coerces to 0 via _asNumber, so a malformed
    // payload can never produce a bogus gain.
    const deltaMs = _asNumber(payload && payload.deltaMs);
    const gain = (rate * deltaMs) / 1000;

    const qi = _asNumber(this._state.cultivation.qi);
    const qiMax = _asNumber(this._state.cultivation.qiMax);
    const room = Math.max(qiMax - qi, 0);
    const added = Math.min(gain, room);

    if (added > 0) {
      const total = qi + added;
      this._state.cultivation.qi = total;
      this._state.statistics.qiGenerated =
        _asNumber(this._state.statistics.qiGenerated) + added;
      this._sessionQi += added;

      this._eventBus.emit('qi:gained', {
        amount: added,
        source: 'meditation',
        total,
      });
    }
  }

  /**
   * The effective qi-per-second rate for an active session. Placeholder: the
   * base rate from config. Future multipliers (spirit root, realm,
   * technique, meditation mode, ...) multiply in here — the tick handler
   * already applies the result, so stacking factors never touches the
   * production math.
   *
   * @returns {number} qi produced per second while meditating.
   */
  _effectiveRate() {
    return this._baseRate;
  }

  /**
   * Write the per-second rate into state, but ONLY when it differs from the
   * current value — a steady rate leaves the field untouched (keeps renderer
   * partial-refresh comparisons and offline-progress reads stable).
   *
   * @param {number} rate — the rate to expose in cultivation.qiPerSecond.
   * @returns {void}
   */
  _syncPerSecondRate(rate) {
    if (this._state.cultivation.qiPerSecond !== rate) {
      this._state.cultivation.qiPerSecond = rate;
    }
  }

  /**
   * Make sure the meditation slice exists before a session starts. A state
   * predating the slice (an old save shape restored without it) gets the
   * neutral defaults: no active session, basic mode, no start time.
   *
   * @returns {void}
   */
  _ensureMeditationSlice() {
    if (this._state.meditation === null || typeof this._state.meditation !== 'object') {
      this._state.meditation = {
        active: false,
        mode: 'basic',
        startedAt: 0,
      };
    }
  }
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no production" value — never a tuning number).
 *
 * @param {*} value — raw value (rate, qi, cap or statistic).
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read a non-negative finite number tuning option, falling back to a default.
 * A missing value falls back silently (a partial config is not an error); a
 * present but invalid value warns once.
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
    console.warn(`MeditationSystem: invalid "${name}" (${String(value)}) — using ${fallback}.`);
  }
  return fallback;
}
