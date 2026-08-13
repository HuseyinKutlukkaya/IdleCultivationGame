/**
 * systems/statistics.js — StatisticsSystem (single owner of playtimeMs).
 *
 * The lifetime-counter system for Phase 2. The StatisticsSystem owns ONLY
 * `state.statistics.playtimeMs` — it accrues it through the same fixed-
 * timestep 'loop:update' pulse as MeditationSystem and QiSystem and
 * exposes a read-only query API for all four lifetime counters (playtimeMs,
 * meditationsCompleted, breakthroughsTotal, qiGenerated). The other three
 * counters are owned by the systems that already write them:
 *   - meditationsCompleted → MeditationSystem.stop() (Phase 2)
 *   - qiGenerated         → QiSystem._onUpdate()      (Phase 2)
 *   - breakthroughsTotal  → future BreakthroughSystem  (Phase 3)
 * StatisticsSystem only READS the other three to assemble the snapshot it
 * announces via 'statistics:changed', so adding a new writer to any of
 * those counters does not require touching this system.
 *
 * Restore-trust: BEFORE any read or write in the constructor AND every
 * tick, a malformed `state.statistics` slice (null, a primitive or an
 * array) is repaired to the canonical fresh shape. This mirrors the
 * `_ensureSlice` / `_ensureMeditationSlice` defensive pattern in QiSystem
 * and MeditationSystem — an attacker-shaped save that lands, e.g.,
 * `state.statistics = 5` or `null` must never abort boot or per-tick,
 * while a healthy restored slice keeps its own fields.
 *
 * Finite-write guard: when `currentPlaytimeMs + deltaMs` would not be
 * finite (e.g. the counter sits at the double limit), the write is
 * dropped entirely — no event, no mutation. This mirrors the finite-
 * write guard in QiSystem._onUpdate and OfflineProgress._applyProducer:
 * a runaway tick must never put Infinity into state.
 *
 * Event contract (all emitted on the shared EventBus; consumed:
 * 'loop:update'):
 *   loop:update        { deltaMs, elapsedMs, tick } — subscribed in the
 *                       constructor; the fixed-timestep simulation pulse
 *                       (deltaMs === tickRateMs from the GameLoop) whose
 *                       deltaMs the system accumulates as playtime.
 *   statistics:changed { snapshot: { playtimeMs, meditationsCompleted,
 *                       breakthroughsTotal, qiGenerated } } — fired
 *                       whenever ANY of the four counters changes
 *                       (compare-before-emit, same pattern as
 *                       MeditationSystem._syncQiSource /
 *                       QiSystem._syncPerSecondRate).
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and
 * GitHub Pages compatible. Communicates with sibling systems only
 * through the EventBus; this module depends solely on the shared
 * GameState and EventBus singletons (both injectable for deterministic
 * tests).
 *
 * Future expansion (see DESIGN.md / PLANS.md): spirit-stone acquisition
 * counters (Phase 5), per-realm playtime, per-technique durations ...
 * land here by adding new state fields plus a writer in the matching
 * system — the read-only getAll()/get() API picks them up automatically.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, freshStatisticsSlice } from '../core/game-state.js';

/** Keys the snapshot rolls up and `get(...)` accepts. The system WRITES
 * only `playtimeMs`; the other three are read-only mirrors of the
 * counter writers (MeditationSystem, future BreakthroughSystem, QiSystem).
 * Adding a new counter = extend this list + extend the canonical slice in
 * core/game-state.js; the writer can live anywhere. */
const SNAPSHOT_KEYS = [
  'playtimeMs',
  'meditationsCompleted',
  'breakthroughsTotal',
  'qiGenerated',
];

export class StatisticsSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads
   *        from and writes to; defaults to the shared GameState singleton
   *        (same dependency-injection pattern as MeditationSystem,
   *        QiSystem, Renderer, OfflineProgress, DataManager and GameLoop).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;

    // Bound once so subscribe/unsubscribe always see the same function
    // identity (same pattern as MeditationSystem._onUpdate,
    // QiSystem._onUpdate and GameLoop._frame).
    this._onUpdate = this._onUpdate.bind(this);
    this._eventBus.subscribe('loop:update', this._onUpdate);

    // Restore-trust on construction: a malformed restored slice (null, a
    // primitive or an array) is repaired BEFORE any read or write. A healthy
    // slice keeps its own fields (the deep-merge in save-manager already
    // reconciles missing keys).
    this._ensureSlice();

    // Seed the last-emitted snapshot from the current state so the very
    // first tick that does NOT change any counter (e.g. a tick with
    // deltaMs=0, or a tick where the finite-write guard drops the playtime
    // write) emits no event — the compare-before-emit pattern shared with
    // MeditationSystem._syncQiSource and QiSystem._syncPerSecondRate.
    /** @type {?object} last-emitted snapshot, null only before construction
     *                   seeded it. */
    this._lastSnapshot = this._captureSnapshot();
  }

  /**
   * Read every lifetime counter in one shot. Returns a fresh, plain-object
   * snapshot — mutating the returned object never leaks back into state
   * (the system builds it with a defensive shallow copy of every field).
   *
   * @returns {{playtimeMs: number, meditationsCompleted: number,
   *          breakthroughsTotal: number, qiGenerated: number}} the four
   *          canonical counters, all coerced to finite numbers (0 on
   *          unreadable values, fail-safe).
   */
  getAll() {
    // Restore-trust before reading — keeps the contract sound even when
    // a hostile external actor corrupted the slice mid-session. The
    // shared _captureSnapshot keeps the constructor seed, this getter
    // and _onUpdate always in lockstep on shape + coercion rules.
    this._ensureSlice();
    return this._captureSnapshot();
  }

  /**
   * Read a single lifetime counter by key. Unknown / malformed keys
   * return 0 silently — reads never throw and never warn (the call sites
   * that guard with `get(...) > 0` must never blow up on a future counter
   * that does not exist yet).
   *
   * @param {string} key — one of 'playtimeMs', 'meditationsCompleted',
   *        'breakthroughsTotal', 'qiGenerated'.
   * @returns {number} the counter value (coerced to a finite number), or 0
   *          for unknown / unreadable keys.
   */
  get(key) {
    if (typeof key !== 'string') return 0;
    // Only the four canonical counters are exposed by this API; any other
    // key (typo, future counter not yet wired, attacker-supplied input) is
    // a no-op. We still restore-trust so a future counter reads at 0 when
    // the slice is corrupted instead of crashing the caller.
    this._ensureSlice();
    if (!SNAPSHOT_KEYS.includes(key)) return 0;
    return _asNumber(this._state.statistics[key]);
  }

  /**
   * Tear down the system: unsubscribe the tick handler so 'loop:update'
   * events no longer mutate state (shutdown-sequence future-proofing;
   * the system must not be reused after this call). Idempotent: a second
   * call is a no-op because EventBus.unsubscribe tolerates unknown pairs.
   *
   * @returns {void}
   */
  destroy() {
    this._eventBus.unsubscribe('loop:update', this._onUpdate);
  }

  /**
   * Fixed-timestep tick handler (bound; invoked via 'loop:update').
   *
   * Restore-trust the top-level slice before any read or write, then
   * accumulate the payload's deltaMs into playtimeMs (using the same
   * finite-write guard as QiSystem._onUpdate: a value that would push
   * the counter past Number.MAX_VALUE is dropped, never written, never
   * announced — a restored value near the double limit must never put
   * Infinity into state). When ANY of the four counters changed this
   * tick (including a non-owned counter advanced by MeditationSystem
   * or QiSystem on the same tick) emit 'statistics:changed' with the
   * new snapshot.
   *
   * The compare-before-emit pattern keeps the event rate at most one
   * per tick (the meditation / qi systems may emit at most one each),
   * matching the same partial-refresh-friendly cadence shared with the
   * rest of the gameplay layer.
   *
   * @param {object} [payload] — the 'loop:update' payload
   *        ({ deltaMs, elapsedMs, tick }).
   * @returns {void}
   */
  _onUpdate(payload) {
    // Restore-trust before ANY read/write — same pattern as
    // QiSystem._onUpdate.
    this._ensureSlice();

    // Use the payload's deltaMs (=== tickRateMs from the GameLoop); a
    // missing, non-finite or negative delta coerces to 0 via _asNumber
    // (clamped at 0), so a malformed payload can never produce a bogus
    // accrual. A deltaMs of 0 is a no-op (no write, no emit) — but we
    // still fall through to the snapshot check below so a sibling system
    // advancing e.g. qiGenerated on the same tick still emits.
    const currentPlaytimeMs = _asNumber(this._state.statistics.playtimeMs);
    const rawDelta = _asNumber(payload && payload.deltaMs);
    const deltaMs = rawDelta > 0 ? rawDelta : 0;

    if (deltaMs > 0) {
      const next = currentPlaytimeMs + deltaMs;
      // Finite-write guard (mirrors QiSystem._onUpdate): when the
      // accumulator would overflow to Infinity (a restored counter at
      // Number.MAX_VALUE plus even the smallest delta) skip the write
      // entirely — no playtimeMs mutation, no event.
      if (Number.isFinite(next)) {
        this._state.statistics.playtimeMs = next;
      }
    }

    // Snapshot comparison decides whether to emit. This is how the system
    // notices sibling counters (meditationsCompleted, qiGenerated,
    // breakthroughsTotal) advancing without having to subscribe to their
    // dedicated events — the snapshot rolls up the canonical shape every
    // tick and only fires when something actually changed. The
    // _lastSnapshot is seeded in the constructor so a first tick with no
    // effect (malformed deltaMs, finite-write drop) stays silent.
    const snapshot = this._captureSnapshot();
    if (!_snapshotEqual(this._lastSnapshot, snapshot)) {
      this._lastSnapshot = snapshot;
      this._eventBus.emit('statistics:changed', { snapshot });
    }
  }

  /**
   * Build the current counters snapshot in canonical order. Centralized
   * so the constructor's seed, getAll() and _onUpdate never drift.
   *
   * @returns {{playtimeMs: number, meditationsCompleted: number,
   *          breakthroughsTotal: number, qiGenerated: number}} the four
   *          canonical counters, each coerced to a finite number.
   */
  _captureSnapshot() {
    return {
      playtimeMs: _asNumber(this._state.statistics.playtimeMs),
      meditationsCompleted: _asNumber(this._state.statistics.meditationsCompleted),
      breakthroughsTotal: _asNumber(this._state.statistics.breakthroughsTotal),
      qiGenerated: _asNumber(this._state.statistics.qiGenerated),
    };
  }

  /**
   * Make sure the top-level `statistics` slice is a plain object before
   * ANY read or write against it. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced
   * with the canonical fresh statistics slice — restore-trust: a broken
   * top-level slice must never abort boot or throw per-tick. A healthy
   * restored slice (even one with extra or missing fields) is never
   * clobbered, so user-progress / restoration counters survive.
   *
   * @returns {object} the (possibly repaired) statistics slice.
   */
  _ensureSlice() {
    const current = this._state.statistics;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      this._state.statistics = freshStatisticsSlice();
    }
    return this._state.statistics;
  }
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0
 * (the neutral "no progress" value — never a tuning number).
 *
 * @param {*} value — raw value (counter).
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Compare two snapshots for shallow structural equality. Each field must
 * be the same finite number; a difference in any field means the
 * snapshot changed and the listener needs to be notified.
 *
 * @param {object} a — previous snapshot.
 * @param {object} b — next snapshot.
 * @returns {boolean} true when every counter is identical.
 */
function _snapshotEqual(a, b) {
  for (const key of SNAPSHOT_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Re-exported so tests / sibling systems can refer to the canonical
 * snapshot shape without re-declaring it. The list is the API surface:
 * `getAll()` always returns these four keys and `get()` accepts only
 * these strings.
 */
export const STATISTICS_KEYS = SNAPSHOT_KEYS;

/**
 * Expose the single owned key (the one this system writes); the snapshot
 * is the canonical read API, but `STATISTICS_OWNED_KEY` documents the
 * write-side contract so future tests / metadata can refer to it
 * without re-declaring the magic string.
 */
export const STATISTICS_OWNED_KEY = 'playtimeMs';
