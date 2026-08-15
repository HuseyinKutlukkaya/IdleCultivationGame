/**
 * systems/milestones.js — MilestoneSystem (single owner of one-shot threshold rewards).
 *
 * The Phase-3 threshold-reward system. Milestones grant a ONE-SHOT gift when a
 * lifetime statistics counter crosses a configured threshold (first 100 qi,
 * first breakthrough, first meditation, one hour of playtime, ...). The
 * catalog (data/milestones/milestones.json via the DataManager) declares
 * every milestone as { id, name, description, stat, threshold, reward }:
 *   - `stat` MUST be one of the four lifetime counter keys
 *     (STATISTICS_KEYS in js/systems/statistics.js: playtimeMs,
 *     meditationsCompleted, breakthroughsTotal, qiGenerated);
 *   - `threshold` is a finite positive number;
 *   - `reward` maps resourceId → amount; every id resolves in
 *     config.resources.items (data/game-config.json) — grants go through
 *     ResourceSystem.add() (the wallet), never through a direct
 *     state.resources write.
 *
 * LORE DISCIPLINE: milestone rewards are ONE-SHOT gifts — the canonical
 * "breakthrough gifts" on the DESIGN.md "Spirit Stone Acquisition" ladder
 * (personal cultivation produces qi, not stones; a gift is earned once, it is
 * NEVER a per-second producer and NEVER repeatable). The reached map
 * (state.milestones.reached[id] → epoch-ms timestamp) persists in state, so a
 * reached milestone is never re-evaluated, never re-granted, never re-emitted.
 *
 * Event contract (all emitted on the injected eventBus; consumed:
 * 'statistics:changed'):
 *   statistics:changed { snapshot: { playtimeMs, meditationsCompleted,
 *                        breakthroughsTotal, qiGenerated } } — subscribed in
 *                        the constructor; the snapshot is the four lifetime
 *                        counters as finite numbers (StatisticsSystem emits it
 *                        whenever ANY counter changes). The system has NO
 *                        'loop:update' subscription — thresholds only change
 *                        through the counters.
 *   milestone:reached   { id, name, stat, threshold, reward, reachedAt } —
 *                        fired once per milestone, ever, when the threshold
 *                        first crosses. reachedAt is the epoch-ms timestamp of
 *                        the grant (injected `now()` clock, defaults to
 *                        Date.now — the same injectable-clock pattern as
 *                        NotificationManager). The bootstrap translates this
 *                        into a popup + log entry; the reward payload is a
 *                        defensive shallow copy of the catalog's reward map.
 *
 * Restore-trust (attacker-shaped saves): the `milestones` slice is repaired
 * to the canonical fresh shape (object with a `reached` object) BEFORE any
 * read or write — in the constructor AND before every evaluation/list/reached
 * read. A healthy restored slice keeps its own reached map (a restored save
 * whose counters already crossed thresholds grants retroactively in the
 * constructor's single evaluation pass; the reached map guards the first
 * 'statistics:changed' from double-granting). Malformed catalog definitions
 * (missing/unsafe id/name/stat/threshold/reward, a stat outside the four
 * counters, a non-finite/non-positive threshold, a non-plain-object reward)
 * are skipped with one console.warn each; a missing/empty catalog must never
 * abort boot — the system simply has nothing to evaluate.
 *
 * Pure gameplay — no DOM access, no storage I/O, no loop subscription and a
 * destroy() that unsubscribes 'statistics:changed' (idempotent shutdown
 * future-proofing). Depends solely on the shared GameState singleton, the
 * injected EventBus, the injected DataManager (which resolves milestone
 * definitions — nothing is hardcoded) and the injected resourceSystem (the
 * wallet — grants never write state.resources directly).
 *
 * Future expansion: multi-resource rewards, reward tiers, milestone
 * categories (realm-based, cultivation-based) land in the catalog + the
 * _grantReward layer without touching the evaluation pipeline; per-milestone
 * UI render data (icon, lore) extends the cached definition.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, freshMilestonesSlice } from '../core/game-state.js';
import { STATISTICS_KEYS } from './statistics.js';

/** Keys that alias the prototype chain and must never appear in state.milestones.reached. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class MilestoneSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as UpgradeSystem, ResourceSystem,
   *        StatisticsSystem, OfflineProgress, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {object|null} [options.dataManager=null] — DataManager
   *        (or a lookalike with `getAll(collection)`) resolving milestone
   *        definitions from the `milestones` collection. When absent the
   *        system reads nothing — an empty catalog simply means no thresholds
   *        to evaluate. Metadata is never hardcoded.
   * @param {object|null} [options.resourceSystem=null] — ResourceSystem
   *        (or a lookalike with `add(id, amount)`); grants are paid through
   *        it. When absent the milestone is still marked reached and emitted —
   *        the reward is simply not granted (the reached map guards against a
   *        later double-grant). The system NEVER writes state.resources
   *        directly — the wallet is owned by ResourceSystem.
   * @param {() => number} [options.now] — wall-clock source for the reachedAt
   *        stamp; defaults to Date.now (injectable for deterministic tests,
   *        same pattern as NotificationManager's `now` option).
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver (`milestones` collection). */
    this._dataManager = options.dataManager || null;
    /** @type {object|null} wallet (`add()` consumer for reward grants). */
    this._resourceSystem = options.resourceSystem || null;
    /** @type {() => number} wall-clock source for reachedAt stamps. */
    this._now = typeof options.now === 'function' ? options.now : Date.now;

    // Bound once so subscribe/unsubscribe always see the same function
    // identity (same pattern as StatisticsSystem._onUpdate).
    this._onStatisticsChanged = this._onStatisticsChanged.bind(this);

    // Restore-trust: a malformed milestones slice (null, a primitive or an
    // array) restored from an attacker-shaped save must never abort boot —
    // repair it to the canonical fresh slice before any API call can run.
    this._ensureSlice();

    // Snapshot a defensive reference to the catalog at construction time
    // (mirrors UpgradeSystem._readDefinitions). Malformed definitions are
    // skipped with a warning; an empty/missing catalog is a silent no-op.
    this._definitions = this._readDefinitions();

    // Subscribe to the lifetime-counter stream — the ONLY event this system
    // listens to (no loop:update: thresholds never tick, they only move when
    // a counter moves).
    this._eventBus.subscribe('statistics:changed', this._onStatisticsChanged);

    // ONE retroactive evaluation pass: a restored save whose counters already
    // crossed thresholds grants its milestones here (reached-map guarded), so
    // the very first 'statistics:changed' can never double-grant.
    this._evaluate(this._captureSnapshot());
  }

  /**
   * Every catalog milestone in file order, each annotated with its reached
   * status. Returns shallow copies — mutating a returned entry never leaks
   * into the cached catalog.
   *
   * @returns {Array<object>} the catalog entries ({ id, name, description,
   *          stat, threshold, reward, reached }).
   */
  list() {
    this._ensureSlice();
    return this._definitions.map((definition) => ({
      ...definition,
      reached: this._isReached(definition.id),
    }));
  }

  /**
   * Whether a milestone has been granted (and will never be again).
   * Unknown / malformed ids return false silently — reads never warn.
   *
   * @param {string} id — the milestone id.
   * @returns {boolean} true when the milestone is in the reached map.
   */
  isReached(id) {
    if (typeof id !== 'string' || id === '' || UNSAFE_KEYS.has(id)) return false;
    return this._isReached(id);
  }

  /**
   * The reached map (milestone id → epoch-ms grant timestamp). Defensive
   * shallow copy — mutating the returned object never leaks into state.
   *
   * @returns {Object<string, number>} the reached milestones.
   */
  reached() {
    this._ensureSlice();
    return { ...this._state.milestones.reached };
  }

  /**
   * Tear down the system: unsubscribe the 'statistics:changed' handler so
   * counter changes no longer grant milestones (shutdown-sequence
   * future-proofing; the system must not be reused after this call).
   * Idempotent: a second call is a no-op because EventBus.unsubscribe
   * tolerates unknown pairs.
   *
   * @returns {void}
   */
  destroy() {
    this._eventBus.unsubscribe('statistics:changed', this._onStatisticsChanged);
  }

  /**
   * 'statistics:changed' handler (bound; invoked via the EventBus). Restore-
   * trust the slice, then evaluate every not-yet-reached milestone against
   * the payload's snapshot. A missing/malformed payload falls back to the
   * current state snapshot (coerced to finite numbers) — the handler never
   * throws and never grants from garbage.
   *
   * @param {object} [payload] — the 'statistics:changed' payload
   *        ({ snapshot: { playtimeMs, meditationsCompleted,
   *        breakthroughsTotal, qiGenerated } }).
   * @returns {void}
   */
  _onStatisticsChanged(payload) {
    // Restore-trust before ANY read/write — same pattern as
    // StatisticsSystem._onUpdate.
    this._ensureSlice();
    const snapshot =
      payload !== null && typeof payload === 'object' && payload.snapshot !== null &&
      typeof payload.snapshot === 'object'
        ? payload.snapshot
        : this._captureSnapshot();
    this._evaluate(snapshot);
  }

  /**
   * Evaluate every catalog milestone not yet in the reached map against a
   * snapshot. Each crossing grants once (writes the reached stamp, pays the
   * reward through the wallet, emits 'milestone:reached'). A milestone
   * already in `reached` is never re-evaluated, never re-granted, never
   * re-emitted — the reached map is the one-shot guard.
   *
   * @param {object} snapshot — counter values keyed by STATISTICS_KEYS
   *        (read defensively: unreadable counters coerce to 0).
   * @returns {void}
   */
  _evaluate(snapshot) {
    this._ensureSlice();
    for (const definition of this._definitions) {
      if (this._isReached(definition.id)) continue;
      // The catalog guarantees a finite positive threshold; the counter read
      // is coerced to a finite number, so the comparison is always safe.
      const value = _asNumber(snapshot ? snapshot[definition.stat] : 0);
      if (value >= definition.threshold) {
        this._grant(definition);
      }
    }
  }

  /**
   * Grant a milestone: stamp the reached map, pay the reward through the
   * wallet and emit 'milestone:reached'. Runs exactly once per milestone
   * because _evaluate never re-enters a reached id.
   *
   * @param {object} definition — the validated catalog definition.
   * @returns {void}
   */
  _grant(definition) {
    const reachedAt = this._now();
    this._state.milestones.reached[definition.id] = reachedAt;
    this._grantReward(definition.reward);
    this._eventBus.emit('milestone:reached', {
      id: definition.id,
      name: definition.name,
      stat: definition.stat,
      threshold: definition.threshold,
      reward: { ...definition.reward },
      reachedAt,
    });
  }

  /**
   * Pay a milestone reward through the injected wallet. Each [resourceId,
   * amount] entry is a single ResourceSystem.add() call — unknown ids and
   * unusable amounts degrade safely (the wallet warns and returns 0; the
   * system ignores the return value and never throws). Prototype-alias keys
   * are skipped defensively; non-positive amounts are skipped.
   *
   * @param {object} reward — the catalog reward map (resourceId → amount).
   * @returns {void}
   */
  _grantReward(reward) {
    if (!this._resourceSystem) return;
    for (const [resourceId, amount] of Object.entries(reward)) {
      if (UNSAFE_KEYS.has(resourceId)) continue;
      const parsed = _asNumber(amount);
      if (parsed <= 0) continue;
      this._resourceSystem.add(resourceId, parsed);
    }
  }

  /**
   * Read the milestone catalog from the injected DataManager, skipping every
   * malformed definition with one console.warn. Returns an empty array when
   * no DataManager was injected or the collection is missing/empty — the
   * system then simply has nothing to evaluate (no throw, no hardcoded
   * fallback; the data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the validated catalog (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') return [];
    const raw = this._dataManager.getAll('milestones');
    if (!Array.isArray(raw)) return [];

    const definitions = [];
    for (const entry of raw) {
      const problem = this._definitionProblem(entry);
      if (problem === null) {
        definitions.push(entry);
      } else {
        console.warn(`MilestoneSystem: skipping malformed milestone definition — ${problem}.`);
      }
    }
    return definitions;
  }

  /**
   * Structural validation of a single catalog definition. Returns a
   * human-readable problem description, or null when the definition is
   * usable (non-empty string id/name/stat, stat in the four counters, finite
   * positive threshold, plain-object reward).
   *
   * @param {*} entry — a raw catalog entry.
   * @returns {string|null} the problem description, or null when valid.
   */
  _definitionProblem(entry) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'not a plain object';
    }
    if (typeof entry.id !== 'string' || entry.id === '' || UNSAFE_KEYS.has(entry.id)) {
      return 'missing/unsafe "id"';
    }
    if (typeof entry.name !== 'string' || entry.name === '') {
      return `"${entry.id}": missing "name"`;
    }
    if (typeof entry.stat !== 'string' || !STATISTICS_KEYS.includes(entry.stat)) {
      return `"${entry.id}": "stat" must be one of ${STATISTICS_KEYS.join(', ')}`;
    }
    if (!Number.isFinite(entry.threshold) || entry.threshold <= 0) {
      return `"${entry.id}": "threshold" must be a finite number > 0`;
    }
    if (entry.reward === null || typeof entry.reward !== 'object' || Array.isArray(entry.reward)) {
      return `"${entry.id}": "reward" must be a plain object`;
    }
    return null;
  }

  /**
   * Build a counter snapshot from the current state. Centralized so the
   * constructor's retroactive pass and the fallback path in
   * _onStatisticsChanged never drift; every counter is coerced to a finite
   * number (a malformed statistics slice reads as all-zero — restoring the
   * statistics slice is StatisticsSystem's job, this system only reads).
   *
   * @returns {{playtimeMs: number, meditationsCompleted: number,
   *          breakthroughsTotal: number, qiGenerated: number}} the four
   *          canonical counters.
   */
  _captureSnapshot() {
    const statistics = this._state.statistics;
    const snapshot = {};
    for (const key of STATISTICS_KEYS) {
      snapshot[key] =
        statistics !== null && typeof statistics === 'object' && !Array.isArray(statistics)
          ? _asNumber(statistics[key])
          : 0;
    }
    return snapshot;
  }

  /**
   * Whether a milestone id is already in the reached map (the one-shot guard
   * every evaluation consults). Restore-trusts the slice first.
   *
   * @param {string} id — the milestone id.
   * @returns {boolean} true when the id is an own key of the reached map.
   */
  _isReached(id) {
    this._ensureSlice();
    return Object.prototype.hasOwnProperty.call(this._state.milestones.reached, id);
  }

  /**
   * Make sure the top-level `milestones` slice is canonical before ANY read
   * or write. A malformed slice restored from an attacker-shaped save (null,
   * a primitive, an array, or one whose `reached` is not an object) is
   * replaced with the canonical fresh slice — restore-trust: a broken
   * top-level slice must never abort boot or throw per call. A healthy
   * restored slice (even one with extra keys) is never clobbered, so the
   * player's already-reached milestones survive a restore.
   *
   * @returns {object} the (possibly repaired) milestones slice.
   */
  _ensureSlice() {
    const current = this._state.milestones;
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      current.reached === null ||
      typeof current.reached !== 'object' ||
      Array.isArray(current.reached)
    ) {
      this._state.milestones = freshMilestonesSlice();
    }
    return this._state.milestones;
  }
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no progress" value — never a tuning number).
 *
 * @param {*} value — raw value (counter or reward amount).
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}