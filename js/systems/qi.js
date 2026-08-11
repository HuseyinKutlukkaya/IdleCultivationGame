/**
 * systems/qi.js — QiSystem (single owner of the qi resource).
 *
 * The Phase-2 qi resource system. Every fixed simulation tick ('loop:update')
 * the system reads the current rate of each configured per-second qi source
 * (config.qi.sources[].ratePath — a state path into that source's own rate
 * slot, e.g. MeditationSystem writes cultivation.qiSources.meditation),
 * aggregates them into the canonical per-second rate (cultivation.qiPerSecond),
 * applies the gains to the cultivator's qi (cultivation.qi) clamped to the
 * derived cap (cultivation.qiMax), accrues statistics.qiGenerated and emits
 * 'qi:gained' for every tick that actually added qi. Sources declare
 * themselves in JSON and write a scalar rate contribution into their own
 * state slot; this system owns the resource itself, so future qi producers
 * (herbs, sect income, pills, ...) plug in via config with no code changes.
 *
 * Data-driven tuning: the qi cap comes from config.qi.baseMaxQi (derived
 * tuning — see _computeQiMax for where realm/root multipliers stack) and
 * every income source from config.qi.sources. A MISSING config.qi block
 * is silent (the cap stays at the state value and the source list is empty);
 * a present but invalid baseMaxQi warns once in the constructor and leaves
 * the cap untouched (mirroring the _readNonNegativeNumber pattern in
 * save-manager, offline-progress and meditation).
 *
 * Realm multipliers (Phase 3): the current realm's effect slots stack here.
 * The cap (managed path) multiplies by cultivation.realmEffects.
 * qiMaxMultiplier and the aggregate per-second rate multiplies by
 * cultivation.realmEffects.cultivationSpeedMultiplier (both the
 * constructor's immediate sync and every tick) — see _realmMultiplier for
 * the neutral coercion (a missing/malformed/<=0 factor reads as 1, so a
 * hostile save can never zero out a cap or rate) and _safeFinite for the
 * overflow clamp (an absurd restored multiplier can never put Infinity into
 * qiMax/qiPerSecond). Future spirit-root/technique multipliers stack the
 * same way: each writes a factor slot into cultivation.realmEffects (or a
 * future config multiplier block) and nothing else changes.
 *
 * State owned (writes): cultivation.qiMax (derived cap),
 * cultivation.qiPerSecond (aggregate rate), cultivation.qi (current),
 * statistics.qiGenerated. Reads: every config.qi.sources[].ratePath value
 * from state, cultivation.qiMax. All paths are part of the canonical
 * GameState (see core/game-state.js), so they always exist; every numeric
 * read is still coerced with a fail-safe _asNumber so a malformed or legacy
 * value can never poison the math.
 *
 * Restore-trust (attacker-shaped saves): before ANY read or write the
 * cultivation/statistics top-level slices are repaired to the canonical fresh
 * shapes when they are unusable (null, a primitive or an array) — a broken
 * slice must never abort boot or throw per-tick, while a healthy restored
 * slice keeps its own fields. The per-tick gain is also dropped entirely when
 * qi + added or qiGenerated + added would not be finite: a restored value at
 * the double limit (or a rate that overflows) must never put Infinity into
 * state (see _onUpdate's finite-write guard).
 *
 * Event contract (all emitted on the shared EventBus; consumed: 'loop:update'):
 *   loop:update  { deltaMs, elapsedMs, tick } — subscribed in the
 *                 constructor; the fixed-timestep simulation pulse
 *                 (deltaMs === tickRateMs from the GameLoop) that drives
 *                 production.
 *   qi:gained    { amount, total, sources } — fired per tick whenever qi
 *                 actually increased (never on zero gains, to avoid noise);
 *                 sources lists the ids of every source that contributed a
 *                 positive rate this tick.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. Systems communicate through the EventBus only; this
 * module depends solely on the shared GameState and EventBus singletons
 * (both injectable for deterministic tests).
 *
 * Future expansion (see DESIGN.md/PLANS.md): spirit-root, technique, pill
 * and formation multipliers stack in _computeQiMax (cap) and in the rate
 * aggregation (per-source rate factors) without touching the resource math —
 * the realm multipliers are already wired through cultivation.realmEffects;
 * additional qi sources (herbs, sect income, ...) are declared in
 * config.qi.sources with their own state rate slot.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** Keys that alias the prototype chain and must never be traversed. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class QiSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `qi` block is read for baseMaxQi and sources. A missing block
   *        is silent (cap untouched, no sources); an invalid baseMaxQi warns
   *        once and leaves the cap untouched.
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as MeditationSystem, OfflineProgress,
   *        DataManager, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   */
  constructor(options = {}) {
    const qi = (options.config && options.config.qi) || {};

    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;

    /** @type {number|null} configured qi cap; null = unmanaged (state value). */
    this._baseMaxQi = _readNonNegativeNumber(qi.baseMaxQi, null, 'baseMaxQi');
    /** @type {Array<{id: string, label: string, ratePath: string}>} */
    this._sources = _readSources(qi.sources);

    // Bound once so subscribe/unsubscribe always see the same function
    // identity (same pattern as MeditationSystem._onUpdate and GameLoop).
    this._onUpdate = this._onUpdate.bind(this);
    // Ordering assumption (main.js boot): the MeditationSystem is constructed
    // first, so its slot write runs before this system's aggregate on the
    // same tick; the aggregate reads slots that only change synchronously
    // (start/stop), so the order is stable — a future reordering must keep
    // meditation's write ahead of this system's read.
    this._eventBus.subscribe('loop:update', this._onUpdate);

    // Restore-trust: a malformed cultivation slice (null, a primitive or an
    // array) restored from an attacker-shaped save must never abort boot —
    // repair it to the canonical fresh slice before the cap/rate sync below.
    this._ensureSlice('cultivation', _freshCultivationSlice);

    // Reflect the derived cap and the current aggregate source rate
    // immediately — a restored session shows the right cap/rate before the
    // first tick (same reasoning as MeditationSystem's constructor sync).
    this._syncQiMax();
    this._syncPerSecondRate(this._currentRateSum());
  }

  /**
   * @returns {number|null} the configured qi cap (baseMaxQi), or null when
   *          no cap is configured (the state value governs instead).
   */
  get baseMaxQi() {
    return this._baseMaxQi;
  }

  /**
   * @returns {Array<object>} shallow copies of the configured qi sources.
   */
  get sources() {
    return this._sources.map((source) => ({ ...source }));
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
   * Aggregates the current rate of every configured source (safe dot-path
   * read; a missing, malformed or unsafe path contributes 0), syncs
   * cultivation.qiPerSecond to the sum ONLY when it differs (keeps renderer
   * partial-refresh comparisons and offline-progress reads stable), then
   * computes the raw gain from the payload's deltaMs (the tick interval,
   * never hardcoded), clamps it to the room left below the qi cap and, when
   * anything was actually gained, applies it to state, accrues
   * statistics.qiGenerated and emits 'qi:gained' (zero-gain ticks stay
   * silent). Before any read/write the malformed top-level slices
   * (cultivation/statistics) are repaired to the canonical fresh shapes
   * (restore-trust), and a finite-write guard drops the whole gain when
   * qi + added or qiGenerated + added would not be finite — a restored value
   * at the double limit must never put Infinity into state.
   *
   * @param {object} [payload] — the 'loop:update' payload
   *        ({ deltaMs, elapsedMs, tick }).
   * @returns {void}
   */
  _onUpdate(payload) {
    // Restore-trust before ANY read/write: repair a malformed restored slice
    // (null, a primitive or an array) to the canonical fresh shape. A healthy
    // slice keeps its own fields — extra/missing ones are the deep-merge's job.
    this._ensureSlice('cultivation', _freshCultivationSlice);
    this._ensureSlice('statistics', _freshStatisticsSlice);

    // Aggregate the RAW source rates first — the active-sources list must
    // reflect which sources contributed (the realm speed multiplier does NOT
    // change which sources are active), then stack the realm's
    // cultivationSpeedMultiplier on the aggregate (clamped finite so an
    // absurd restored multiplier can never put Infinity into the rate).
    let rateSum = 0;
    const activeSources = [];
    for (const source of this._sources) {
      const rate = _asNumber(this._readPath(source.ratePath));
      rateSum += rate;
      if (rate > 0) activeSources.push(source.id);
    }
    const rate = _safeFinite(
      rateSum * _realmMultiplier(this._state, 'cultivationSpeedMultiplier')
    );
    this._syncPerSecondRate(rate);

    // Use the payload's deltaMs (=== tickRateMs from the GameLoop); a
    // missing or non-finite delta coerces to 0 via _asNumber, so a malformed
    // payload can never produce a bogus gain.
    const deltaMs = _asNumber(payload && payload.deltaMs);
    const gain = (rate * deltaMs) / 1000;
    if (gain <= 0) return;

    const qi = _asNumber(this._state.cultivation.qi);
    const room = Math.max(this._computeQiMax() - qi, 0);
    const added = Math.min(gain, room);

    if (added > 0) {
      const total = qi + added;
      const nextGenerated = _asNumber(this._state.statistics.qiGenerated) + added;

      // Finite-write guard (mirrors the offline-progress _applyProducer write
      // guard): a restored value at the double limit (qi or qiGenerated near
      // Number.MAX_VALUE) or a rate overflow across two sources must never put
      // Infinity into state — when either sum is not finite, skip the gain
      // entirely (no qi write, no statistics write, no 'qi:gained' event).
      if (Number.isFinite(total) && Number.isFinite(nextGenerated)) {
        this._state.cultivation.qi = total;
        this._state.statistics.qiGenerated = nextGenerated;

        this._eventBus.emit('qi:gained', {
          amount: added,
          total,
          sources: activeSources,
        });
      }
    }
  }

  /**
   * The current qi cap. Managed (a baseMaxQi is configured) → the configured
   * number × the current realm's qiMaxMultiplier (clamped finite); unmanaged
   * (missing/invalid baseMaxQi) → the state value unchanged. THE hook where
   * realm/spirit-root/technique multipliers stack: each factor multiplies in
   * here and the whole game (tick clamp, renderer progress bars,
   * offline-progress capPath) reads the synced cultivation.qiMax, so adding
   * a multiplier never touches the production math.
   *
   * @returns {number} the derived qi cap.
   */
  _computeQiMax() {
    if (this._baseMaxQi !== null) {
      return _safeFinite(
        this._baseMaxQi * _realmMultiplier(this._state, 'qiMaxMultiplier')
      );
    }
    return _asNumber(this._state.cultivation.qiMax);
  }

  /**
   * Write the derived cap into cultivation.qiMax, but ONLY when it differs
   * from the current value — a steady cap leaves the field untouched (keeps
   * renderer partial-refresh comparisons and offline-progress reads stable).
   * When the cap shrinks below the current pool, qi is clamped down with it:
   * the cap is derived tuning and the pool must never sit above it (otherwise
   * room = 0 forever and the renderer progress bar overflows). A growing cap
   * never touches qi.
   *
   * @returns {void}
   */
  _syncQiMax() {
    const cap = this._computeQiMax();
    if (this._state.cultivation.qiMax !== cap) {
      this._state.cultivation.qiMax = cap;
      // Defensive clamp: only when qi actually exceeds the new cap — a
      // shrinking cap brings the pool down with it; a growing cap never
      // touches qi.
      if (this._state.cultivation.qi > cap) {
        this._state.cultivation.qi = cap;
      }
    }
  }

  /**
   * Write the aggregate per-second rate into cultivation.qiPerSecond, but
   * ONLY when it differs from the current value — a steady rate leaves the
   * field untouched (keeps renderer partial-refresh comparisons and
   * offline-progress reads stable).
   *
   * @param {number} rate — the aggregate rate to expose in
   *        cultivation.qiPerSecond.
   * @returns {void}
   */
  _syncPerSecondRate(rate) {
    if (this._state.cultivation.qiPerSecond !== rate) {
      this._state.cultivation.qiPerSecond = rate;
    }
  }

  /**
   * Make sure a top-level state slice is a plain object before ANY read or
   * write against it. A malformed slice restored from an attacker-shaped save
   * (null, a primitive or an array) is replaced with the canonical fresh
   * slice from the fallback factory — restore-trust: a broken top-level slice
   * must never abort boot or throw per-tick. A healthy restored slice (even
   * one with extra or missing fields) is never clobbered — the deep-merge in
   * save-manager already reconciles missing fields.
   *
   * @param {string} name — top-level slice name in state (e.g. 'cultivation').
   * @param {() => object} fallback — factory returning the canonical fresh slice.
   * @returns {object} the (possibly repaired) slice.
   */
  _ensureSlice(name, fallback) {
    const current = this._state[name];
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      this._state[name] = fallback();
    }
    return this._state[name];
  }

  /**
   * Sum the current rate contribution of every configured source, stacked
   * with the current realm's cultivationSpeedMultiplier (clamped finite). A
   * source whose ratePath is missing, malformed or unsafe contributes 0
   * (never throws, never reaches the prototype chain).
   *
   * @returns {number} the aggregate per-second qi rate right now.
   */
  _currentRateSum() {
    let sum = 0;
    for (const source of this._sources) {
      sum += _asNumber(this._readPath(source.ratePath));
    }
    return _safeFinite(
      sum * _realmMultiplier(this._state, 'cultivationSpeedMultiplier')
    );
  }

  /**
   * Resolve a dot path (e.g. "cultivation.qiSources.meditation") through the
   * game state. Missing intermediate segments short-circuit to undefined,
   * and segments that alias the prototype chain (`__proto__`, `constructor`,
   * `prototype`) are treated as missing — a source path can never reach
   * Object.prototype (defense in depth; paths are dev-authored config, not
   * user input).
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
}

/**
 * The canonical fresh cultivation slice (mirrors core/game-state.js). Used as
 * the restore-trust fallback when a restored cultivation slice is unusable
 * (null, a primitive or an array) — a broken top-level slice must never abort
 * boot or throw per-tick.
 *
 * @returns {object} the canonical cultivation slice.
 */
function _freshCultivationSlice() {
  return {
    realm: 'Mortal',
    realmTier: 0,
    realmStage: 1,
    nextRealm: 'Qi Gathering',
    breakthroughCost: null,
    realmProgress: 0,
    realmProgressMax: 1000,
    realmEffects: {
      qiMaxMultiplier: 1,
      cultivationSpeedMultiplier: 1,
      powerMultiplier: 1,
      lifespanYears: 100,
    },
    qi: 0,
    qiMax: 100,
    qiPerSecond: 0,
    qiSources: { meditation: 0 },
    breakthroughs: 0,
  };
}

/**
 * The canonical fresh statistics slice (mirrors core/game-state.js). Used as
 * the restore-trust fallback when a restored statistics slice is unusable
 * (null, a primitive or an array).
 *
 * @returns {object} the canonical statistics slice.
 */
function _freshStatisticsSlice() {
  return {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  };
}

/**
 * Read and validate the qi source list from config. Entries without a
 * non-empty id and ratePath are skipped with a warning; the rest are
 * normalized (label falls back to id). A missing "sources" key is silent —
 * it simply means no per-second income exists yet (qiPerSecond stays 0).
 *
 * @param {*} raw — raw value of config.qi.sources.
 * @returns {Array<{id: string, label: string, ratePath: string}>}
 *          the validated sources.
 */
function _readSources(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn('QiSystem: "sources" must be an array — ignoring sources.');
    return [];
  }

  const sources = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn('QiSystem: skipping a source that is not an object.');
      continue;
    }
    if (
      typeof entry.id !== 'string' ||
      entry.id === '' ||
      typeof entry.ratePath !== 'string' ||
      entry.ratePath === ''
    ) {
      console.warn(
        'QiSystem: skipping a source without non-empty id and ratePath.'
      );
      continue;
    }
    sources.push({
      id: entry.id,
      label:
        typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
      ratePath: entry.ratePath,
    });
  }
  return sources;
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
 * Read a realm effect multiplier (e.g. 'qiMaxMultiplier' or
 * 'cultivationSpeedMultiplier') off state.cultivation.realmEffects —
 * the slot the RealmSystem (js/systems/realms.js) writes. A missing,
 * malformed or non-positive value returns the neutral factor 1 (never 0, so
 * a hostile save or a missing realmEffects object can never zero out a cap
 * or rate). Guards against a null/non-object realmEffects and against a null
 * cultivation slice.
 *
 * @param {object|null} state — game state object.
 * @param {string} key — the realm effect key to read.
 * @returns {number} the effective multiplier (>= 1).
 */
function _realmMultiplier(state, key) {
  const effects =
    state && state.cultivation ? state.cultivation.realmEffects : null;
  if (effects === null || typeof effects !== 'object' || Array.isArray(effects)) {
    return 1;
  }
  const parsed = Number(effects[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Drop overflow into a finite upper bound so an absurd restored multiplier
 * (e.g. 1e308 — a hostile save) can never put Infinity into qiMax or
 * qiPerSecond. Positive overflow (an overflowed product, or a value past
 * Number.MAX_SAFE_INTEGER) clamps to Number.MAX_SAFE_INTEGER — NEVER 0, so a
 * huge-but-valid multiplier can never zero out the cap/rate (the
 * neutral-factor discipline lives in _realmMultiplier). Negative values
 * (a hostile negative source rate) clamp to the neutral 0 — a rate/cap can
 * never flip sign, so an overflowed negative product (-Infinity) becomes the
 * no-production value instead of a silent +MAX_SAFE_INTEGER sign-flip.
 *
 * @param {number} value — raw value.
 * @returns {number} the finite value (0 for negatives), or
 *          Number.MAX_SAFE_INTEGER when the raw value is not finite or
 *          overflowed past it.
 */
function _safeFinite(value) {
  if (value < 0) return 0;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return value;
}

/**
 * Read a non-negative finite number tuning option, falling back to a default.
 * A missing value falls back silently (a partial config is not an error); a
 * present but invalid value warns once.
 *
 * @param {*} value — raw option value.
 * @param {number|null} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number|null} the validated value, or the fallback.
 */
function _readNonNegativeNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  if (value !== undefined) {
    console.warn(`QiSystem: invalid "${name}" (${String(value)}) — leaving the cap untouched.`);
  }
  return fallback;
}
