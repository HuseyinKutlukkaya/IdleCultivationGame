/**
 * core/game-loop.js — fixed-timestep simulation ticker driven by rAF.
 *
 * Drives the entire idle game: a requestAnimationFrame loop computes per-frame
 * deltas, converts them into fixed-rate simulation updates and throttled
 * UI-refresh pulses, and publishes everything on the EventBus so systems can
 * react without referencing the loop (or each other) directly.
 *
 * Why rAF + a fixed timestep:
 *   - rAF is the browser's vsync-aligned frame callback (the only browser API
 *     used here), so the loop runs at display refresh rate with no polling.
 *   - Background tabs throttle/pause rAF automatically; maxFrameDeltaMs clamps
 *     the resulting giant deltas so a single tab switch cannot cause a huge
 *     time jump. Offline progress is a separate system and out of scope here.
 *   - Fixed updates always carry deltaMs === tickRateMs, so simulation code
 *     never has to reason about variable time steps.
 *
 * Event contract (all events emitted on the shared EventBus; payloads are
 * plain data and describe facts, not commands):
 *   loop:started   { startedAt }                — loop began (performance.now()).
 *   loop:stopped   { elapsedMs, ticks }         — loop halted.
 *   loop:paused    { elapsedMs }                — rAF keeps running, simulation frozen.
 *   loop:resumed   { elapsedMs }                — simulation continues.
 *   loop:frame     { deltaMs, elapsedMs }       — every frame (opt-in raw feed,
 *                                                 useful for future animations).
 *   loop:update    { deltaMs, elapsedMs, tick } — fixed-timestep simulation
 *                                                 step (deltaMs === tickRateMs).
 *   loop:uiRefresh { elapsedMs }                — throttled UI-refresh pulse.
 *
 * Pure infrastructure — no DOM access, no storage I/O, no gameplay logic,
 * framework-free, ES module and GitHub Pages compatible. Systems subscribe to
 * the events above via EventBus; they never register direct callbacks here.
 *
 * Future expansion (see PLANS.md): pause/speed multipliers, background
 * throttling, offline accumulation and an event-processing phase slot.
 */

import { EventBus } from './event-bus.js';

export class GameLoop {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.eventBus] — pub/sub bus for loop events;
   *        defaults to the shared EventBus singleton (same pattern as
   *        DataManager). The bus must provide subscribe, unsubscribe,
   *        hasListeners and emit (see core/event-bus.js) — hasListeners
   *        is used in the frame hot path to skip building payloads when
   *        nobody is listening.
   * @param {number} [options.tickRateMs] — fixed simulation step interval
   *        in milliseconds (default 1000).
   * @param {number} [options.uiRefreshRateMs] — interval between
   *        'loop:uiRefresh' emissions in milliseconds (default 100).
   * @param {number} [options.maxFrameDeltaMs] — clamp for per-frame deltas
   *        in milliseconds; prevents huge jumps after tab switches /
   *        background throttling (default 250).
   */
  constructor(options = {}) {
    /** @type {object} pub/sub bus every loop event is emitted on. */
    this._eventBus = options.eventBus || EventBus;

    /** @type {number} fixed simulation step interval in ms. */
    this._tickRateMs = _positiveNumber(options.tickRateMs, 1000, 'tickRateMs');
    /** @type {number} UI-refresh emission interval in ms. */
    this._uiRefreshRateMs = _positiveNumber(options.uiRefreshRateMs, 100, 'uiRefreshRateMs');
    /** @type {number} per-frame delta clamp in ms. */
    this._maxFrameDeltaMs = _positiveNumber(options.maxFrameDeltaMs, 250, 'maxFrameDeltaMs');

    /** @type {boolean} true while the rAF loop is live. */
    this._running = false;
    /** @type {boolean} true while simulation is paused. */
    this._paused = false;
    /** @type {number|null} current requestAnimationFrame handle. */
    this._rafId = null;
    /** @type {number} timestamp of the last processed frame. */
    this._lastFrameAt = 0;
    /** @type {number} total active (non-paused) elapsed time in ms. */
    this._elapsedMs = 0;
    /** @type {number} count of fixed 'loop:update' steps emitted. */
    this._ticks = 0;
    /** @type {number} leftover ms toward the next fixed update. */
    this._accumulator = 0;
    /** @type {number} leftover ms toward the next UI refresh. */
    this._uiAccumulator = 0;
    /** @type {number} performance.now() at the last start(). */
    this._startedAt = 0;

    // Bound once so start()/stop() can hand the same function to rAF.
    this._frame = this._frame.bind(this);
  }

  /**
   * Begin the loop. Idempotent: no-op when already running. Resets the
   * frame accumulators and the last-frame timestamp so a fresh run starts
   * clean (no stale partial ticks and no phantom delta on the first frame),
   * records startedAt, emits 'loop:started' and schedules the first frame.
   *
   * @returns {void}
   */
  start() {
    if (this._running) return;

    this._running = true;
    this._paused = false;
    this._accumulator = 0;
    this._uiAccumulator = 0;
    this._lastFrameAt = performance.now();
    this._startedAt = this._lastFrameAt;

    this._eventBus.emit('loop:started', { startedAt: this._startedAt });

    this._rafId = requestAnimationFrame(this._frame);
  }

  /**
   * Halt the loop. Idempotent: no-op when not running. Cancels the pending
   * rAF, marks the loop stopped and emits 'loop:stopped' with the session
   * totals so callers (e.g. a future SaveManager) can capture them.
   *
   * @returns {void}
   */
  stop() {
    if (!this._running) return;

    this._running = false;
    this._paused = false;

    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    this._eventBus.emit('loop:stopped', {
      elapsedMs: this._elapsedMs,
      ticks: this._ticks,
    });
  }

  /**
   * Pause the simulation. The rAF loop keeps running (and keeps refreshing
   * lastFrameAt) but time stops accumulating and no updates are emitted, so
   * resuming causes no delta jump. Emits 'loop:paused'. No-op when not
   * running or already paused.
   *
   * @returns {void}
   */
  pause() {
    if (!this._running || this._paused) return;

    this._paused = true;
    this._eventBus.emit('loop:paused', { elapsedMs: this._elapsedMs });
  }

  /**
   * Resume a paused simulation. Emits 'loop:resumed'. The last-frame
   * timestamp is reset to now so the pause duration never leaks into the
   * first post-pause delta. No-op when not running or not paused.
   *
   * @returns {void}
   */
  resume() {
    if (!this._running || !this._paused) return;

    this._paused = false;
    this._lastFrameAt = performance.now();
    this._eventBus.emit('loop:resumed', { elapsedMs: this._elapsedMs });
  }

  /**
   * @returns {boolean} true while the rAF loop is live.
   */
  get isRunning() {
    return this._running;
  }

  /**
   * @returns {boolean} true while the simulation is paused.
   */
  get isPaused() {
    return this._paused;
  }

  /**
   * @returns {number} total active (non-paused) time in milliseconds.
   */
  get elapsedMs() {
    return this._elapsedMs;
  }

  /**
   * @returns {number} count of fixed 'loop:update' steps emitted.
   */
  get ticks() {
    return this._ticks;
  }

  /**
   * @returns {number} fixed simulation step interval in milliseconds.
   */
  get tickRateMs() {
    return this._tickRateMs;
  }

  /**
   * @returns {number} UI-refresh emission interval in milliseconds.
   */
  get uiRefreshRateMs() {
    return this._uiRefreshRateMs;
  }

  /**
   * Per-frame callback (bound). Do not call directly — scheduled via rAF.
   *
   * Frame flow: guard → compute+clamp delta → track elapsed → emit raw
   * frame feed → drain fixed updates → maybe emit UI refresh → request next
   * frame.
   *
   * @param {number} now — DOMHighResTimeStamp from requestAnimationFrame.
   * @returns {void}
   */
  _frame(now) {
    if (!this._running) return;

    let deltaMs = now - this._lastFrameAt;
    this._lastFrameAt = now;

    // Paused: keep rAF alive and lastFrameAt fresh, but do not accumulate —
    // simulation time stands still without a delta jump on resume.
    if (this._paused) {
      this._rafId = requestAnimationFrame(this._frame);
      return;
    }

    // Clamp: negative deltas are clock noise; huge deltas come from tab
    // switches / background throttling and must not warp the simulation.
    deltaMs = deltaMs < 0 ? 0 : Math.min(deltaMs, this._maxFrameDeltaMs);

    this._elapsedMs += deltaMs;
    if (this._eventBus.hasListeners('loop:frame')) {
      this._eventBus.emit('loop:frame', { deltaMs, elapsedMs: this._elapsedMs });
    }

    // Fixed timestep: simulation code always sees deltaMs === tickRateMs.
    // Multiple updates may be drained in one frame to catch up after a
    // frame whose delta was clamped down.
    this._accumulator += deltaMs;
    while (this._accumulator >= this._tickRateMs) {
      this._accumulator -= this._tickRateMs;
      this._ticks += 1;
      if (this._eventBus.hasListeners('loop:update')) {
        this._eventBus.emit('loop:update', {
          deltaMs: this._tickRateMs,
          elapsedMs: this._elapsedMs,
          tick: this._ticks,
        });
      }
    }

    // Throttled UI-refresh pulse (at most one per frame).
    this._uiAccumulator += deltaMs;
    if (this._uiAccumulator >= this._uiRefreshRateMs) {
      this._uiAccumulator -= this._uiRefreshRateMs;
      if (this._eventBus.hasListeners('loop:uiRefresh')) {
        this._eventBus.emit('loop:uiRefresh', { elapsedMs: this._elapsedMs });
      }
    }

    this._rafId = requestAnimationFrame(this._frame);
  }
}

/**
 * Coerce a tuning option to a positive finite number, falling back to a
 * default when missing or invalid. Guardrails the fixed-step math: a
 * non-positive tickRateMs would otherwise make the drain loop infinite and
 * freeze the tab.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _positiveNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (value !== undefined) {
    console.warn(`GameLoop: invalid ${name} (${String(value)}) — using default ${fallback}.`);
  }
  return fallback;
}
