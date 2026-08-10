/**
 * systems/upgrades.js — UpgradeSystem (single owner of the purchasable boosts).
 *
 * The Phase-2 basic-upgrade system. Players spend a configured resource
 * (data/upgrades/upgrades.json declares the costResource id per upgrade)
 * to BUY LEVELS of an upgrade, and each level contributes an effect.
 * v1 supports a single category, `qiRateAdd`, whose levels write their
 * aggregate into cultivation.qiSources.upgrades — a slot the QiSystem
 * reads via config.qi.sources (no code change to QiSystem was needed; the
 * existing per-source aggregation picked it up the moment the new entry
 * was added to config.qi.sources). Future categories (qiMaxAdd,
 * resourceBoost, ...) arrive by extending the effect-application layer
 * here without touching the qi pipeline: each category owns one writer.
 *
 * Data-driven content: the upgrade catalog (id, name, description,
 * category, costResource, baseCost, costGrowth, effectPerLevel, optional
 * maxLevel) is resolved through the DataManager's `upgrades` collection
 * (data/upgrades/upgrades.json via data/manifest.json). Nothing is
 * hardcoded: a Data Author can add or retire upgrades, retune their costs
 * or change the effect tier purely in JSON, with no code change.
 *
 * State owned (writes): state.upgrades.purchased[id] (the per-upgrade
 * level, an integer >= 0) and state.cultivation.qiSources.upgrades (the
 * aggregate qiRateAdd contribution, in qi/s). The system calls
 * ResourceSystem.spend() to deduct cost — never touches state.resources
 * directly. Both target slices are part of the canonical GameState (see
 * core/game-state.js), so they always exist; every numeric read is still
 * coerced with a fail-safe _asNumber so a malformed or legacy value can
 * never poison the cost math.
 *
 * Restore-trust (attacker-shaped saves): the `upgrades` slice is repaired
 * to the canonical fresh shape (object with a `purchased` object) before
 * ANY read or write; a purchased value that is non-numeric, negative, or
 * non-finite is clamped to 0 (a hostile save cannot pre-bought a level
 * for free); an unknown id in the purchased map is dropped (a removed
 * upgrade cannot keep its old level forever — the next recompute drops
 * it from the aggregate). All of this keeps the qi aggregate bounded
 * even if the save is crafted.
 *
 * Event contract (all emitted on the injected eventBus):
 *   upgrades:purchased { id, level, cost, effectPerLevel } — emitted on
 *     EVERY successful purchase (never on a rejected buy). The
 *     upgrades-panel subscriber listens to this and re-renders so the
 *     player sees the new level + cost instantly. The full level /
 *     cost / effectPerLevel trio lets the UI keep its counters in sync
 *     without a second state read.
 *
 * Pure gameplay — no DOM access, no storage I/O, no loop subscription
 * and no destroy() (there are no listeners to tear down). Per-second
 * downstream effects arrive via the existing QiSystem tick aggregation
 * from the qiSources slot, so this module depends solely on the shared
 * GameState singleton, the injected EventBus, the injected DataManager
 * (which resolves upgrade definitions) and the injected resourceSystem
 * (which owns the wallet — never the wallet data itself).
 *
 * Future expansion: new effect categories (qiMaxAdd, resourceBoost,
 * pilProduction, ...) land inside _applyEffects without touching the
 * purchase pipeline; prerequisites and unlock tiers land as additional
 * purchasability checks before _attemptSpend. Per-upgrade render data
 * (icon, lore) extends the cached definition; the system itself never
 * grows presentation knowledge.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** Keys that alias the prototype chain and must never appear in state.upgrades.purchased. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The state path the aggregate qiRateAdd contribution is exposed at. */
const QI_SOURCE_SLOT = 'cultivation.qiSources.upgrades';

/** Default state slice shape (mirrors core/game-state.js). */
function _freshUpgradesSlice() {
  return { purchased: {} };
}

export class UpgradeSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as ResourceSystem, InventorySystem,
   *        QiSystem, OfflineProgress, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {object|null} [options.dataManager=null] — DataManager
   *        (or a lookalike with `getAll(collection)` / `get(collection, id)`)
   *        resolving upgrade definitions from the `upgrades` collection.
   *        When absent the system reads nothing — purchase() rejects every
   *        id because no catalog can resolve a definition. Metadata is
   *        never hardcoded.
   * @param {object|null} [options.resourceSystem=null] — ResourceSystem
   *        (or a lookalike with `spend(id, amount)`); when absent the
   *        system cannot deduct cost and purchase() rejects every id.
   *        The system NEVER writes state.resources directly — the wallet
   *        is owned by ResourceSystem so future caps and tools have a single
   *        write primitive.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver (`upgrades` collection). */
    this._dataManager = options.dataManager || null;
    /** @type {object|null} wallet (`spend()` consumer). */
    this._resourceSystem = options.resourceSystem || null;

    // Restore-trust: a malformed upgrades slice (null, a primitive or an array)
    // restored from an attacker-shaped save must never abort boot — repair
    // it to the canonical fresh slice before any API call can run.
    this._ensureSlice();

    // Snapshot a defensive deep copy of the catalog at construction time so
    // a concurrent reload of the DataManager (or a hostile one) cannot
    // mutate the levels math mid-game. Cached definitions are deep-frozen
    // by the DataManager; the array itself stays a reference snapshot for
    // lookup performance.
    this._definitions = this._readDefinitions();
    /** @type {Map<string, object>} id → definition, built once for O(1) lookup. */
    this._byId = new Map(this._definitions.map((definition) => [definition.id, definition]));

    // Seed the qi aggregate from any purchased levels in a restored save
    // so a loaded game shows the right qiPerSecond before the first tick
    // (same reasoning as MeditationSystem's constructor sync).
    this._writeQiAggregate(this._computeQiAggregate());
  }

  /**
   * @returns {Array<object>} shallow copies of the cached upgrade
   *          definitions (file order preserved). Mutating a returned copy
   *          never leaks into the catalog.
   */
  list() {
    return this._definitions.map((definition) => ({ ...definition }));
  }

  /**
   * Look up a single definition by id.
   *
   * @param {string} id — the upgrade id.
   * @returns {object|null} the cached definition, or null when unknown.
   */
  get(id) {
    const definition = this._byId.get(id);
    return definition ? { ...definition } : null;
  }

  /**
   * @returns {number} the current owned level of an upgrade (>= 0). Unknown
   *          ids and prototype-alias ids return 0 (silent fail-safe — reads
   *          never warn).
   * @param {string} id — the upgrade id.
   */
  level(id) {
    if (typeof id !== 'string' || id === '' || UNSAFE_KEYS.has(id)) return 0;
    if (!this._byId.has(id)) return 0;
    return Math.max(Math.trunc(_asNumber(this._state.upgrades.purchased[id])), 0);
  }

  /**
   * Compute the cost of the NEXT level (the level the player would buy
   * when they click). Cost formula: cost(N) = floor(baseCost × costGrowth^(N-1)),
   * where N is the current level + 1 (level-1 cost = baseCost). Unknown
   * ids and maxed-out upgrades return 0.
   *
   * @param {string} id — the upgrade id.
   * @returns {number} the next-level cost, 0 when unknown or maxed.
   */
  cost(id) {
    const definition = this._byId.get(id);
    if (!definition) return 0;
    const currentLevel = this.level(id);
    const maxLevel = definition.maxLevel;
    if (typeof maxLevel === 'number' && currentLevel >= maxLevel) return 0;
    const base = _asNumber(definition.baseCost);
    const growth = _asNumber(definition.costGrowth);
    if (base <= 0 || growth < 1) return 0;
    const next = currentLevel + 1;
    const raw = base * Math.pow(growth, next - 1);
    return Math.floor(_safeFinite(raw));
  }

  /**
   * Whether the player can afford the next level RIGHT NOW. Combines the
   * cost() ceiling, the maxLevel ceiling, and the wallet balance.
   *
   * @param {string} id — the upgrade id.
   * @returns {boolean} true when the next-level click would succeed.
   */
  canPurchase(id) {
    if (!this._byId.has(id)) return false;
    if (!this._resourceSystem) return false;
    const definition = this._byId.get(id);
    const currentLevel = this.level(id);
    const maxLevel = definition.maxLevel;
    if (typeof maxLevel === 'number' && currentLevel >= maxLevel) return false;
    const nextCost = this.cost(id);
    if (nextCost <= 0) return false;
    return this._resourceSystem.canAfford(definition.costResource, nextCost);
  }

  /**
   * Attempt to buy one level of an upgrade. Deducts cost via the wallet,
   * increments state.upgrades.purchased[id], recomputes the qi aggregate
   * and emits `upgrades:purchased`. Every failure mode returns false
   * with no mutation, no event:
   *
   *   - non-string / empty / prototype-alias id;
   *   - unknown id (no definition in the catalog);
   *   - resourceSystem missing or the spend returning false (insufficient
   *     funds, maxed upgrade, unknown cost resource);
   *   - the post-spend level would push an unknown upgrade id past a
   *     restored maxLevel (defense in depth — the catalog-driven check
   *     already covers this, but a hostile save must not bypass it).
   *
   * @param {string} id — the upgrade id.
   * @returns {boolean} true on a successful purchase.
   */
  purchase(id) {
    if (typeof id !== 'string' || id === '') {
      console.warn(`UpgradeSystem: purchase('${String(id)}') — id must be a non-empty string.`);
      return false;
    }
    if (UNSAFE_KEYS.has(id)) {
      console.warn(`UpgradeSystem: purchase('${id}') — unsafe prototype-alias id.`);
      return false;
    }
    const definition = this._byId.get(id);
    if (!definition) {
      console.warn(`UpgradeSystem: unknown upgrade id "${id}" — nothing purchased.`);
      return false;
    }
    if (!this._resourceSystem) {
      console.warn(
        `UpgradeSystem: no resource system available — cannot purchase "${id}".`
      );
      return false;
    }
    const currentLevel = this.level(id);
    const maxLevel = definition.maxLevel;
    if (typeof maxLevel === 'number' && currentLevel >= maxLevel) {
      console.warn(
        `UpgradeSystem: "${id}" is maxed (${currentLevel}/${maxLevel}) — nothing purchased.`
      );
      return false;
    }
    const cost = this.cost(id);
    if (cost <= 0) {
      console.warn(`UpgradeSystem: "${id}" has no positive next-level cost — nothing purchased.`);
      return false;
    }

    const spent = this._resourceSystem.spend(definition.costResource, cost);
    if (!spent) {
      // The wallet emits its own warning on a failed spend (unknown id / cap).
      return false;
    }

    // Commit the level. The post-spend state must be a positive integer —
    // anything non-finite (a hostile save restoring a string value) is
    // coerced back to 1 (the just-bought level, no carry-over).
    const nextLevel = currentLevel + 1;
    this._state.upgrades.purchased[id] = nextLevel;
    this._writeQiAggregate(this._computeQiAggregate());

    this._eventBus.emit('upgrades:purchased', {
      id,
      level: nextLevel,
      cost,
      effectPerLevel: _asNumber(definition.effectPerLevel),
    });
    return true;
  }

  /**
   * Aggregate the qi contribution of every qiRateAdd upgrade. Each
   * contribution is `effectPerLevel × level`; the sum lands in
   * cultivation.qiSources.upgrades (read by QiSystem through
   * config.qi.sources).
   *
   * @returns {number} the sum of every qiRateAdd upgrade's contribution.
   */
  _computeQiAggregate() {
    let sum = 0;
    for (const definition of this._definitions) {
      if (definition.category !== 'qiRateAdd') continue;
      const effect = _asNumber(definition.effectPerLevel);
      if (effect <= 0) continue;
      sum += effect * this.level(definition.id);
    }
    return sum;
  }

  /**
   * Write the aggregate to cultivation.qiSources.upgrades, but ONLY when
   * it differs from the current value — a steady rate leaves the field
   * untouched (keeps renderer partial-refresh comparisons and the
   * offline-progress read stable).
   *
   * @param {number} aggregate — the qi/s aggregate to expose.
   * @returns {void}
   */
  _writeQiAggregate(aggregate) {
    const value = _safeFinite(aggregate);
    if (this._state.cultivation?.qiSources?.upgrades !== value) {
      this._state.cultivation.qiSources.upgrades = value;
    }
  }

  /**
   * Read the upgrade catalog from the injected DataManager. Returns an
   * empty array when no DataManager was injected — purchase() then
   * rejects every id with a warning. No throw, no fallback to hardcoded
   * defaults (the data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the catalog (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager) return [];
    if (typeof this._dataManager.getAll !== 'function') return [];
    return this._dataManager.getAll('upgrades');
  }

  /**
   * Make sure the upgrades slice is canonical before any read or write.
   * A malformed slice restored from an attacker-shaped save (null, a
   * primitive or an array, or one whose `purchased` is not an object) is
   * replaced with the canonical fresh slice. A healthy slice whose
   * `purchased` map carries unknown ids (a removed upgrade) keeps them
   * but they contribute zero to the aggregate; a value that is non-finite
   * or negative is clamped to 0 on the next level() / cost() read.
   *
   * @returns {object} the (possibly repaired) slice.
   */
  _ensureSlice() {
    const current = this._state.upgrades;
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      typeof current.purchased !== 'object' ||
      current.purchased === null ||
      Array.isArray(current.purchased)
    ) {
      this._state.upgrades = _freshUpgradesSlice();
      return this._state.upgrades;
    }
    // Clamp every known-purchased value to a non-negative integer in place,
    // and silently drop prototype-alias keys (defense). Mirror the pattern
    // used by ResourceSystem when reading a hostile state.resources.
    const purchased = current.purchased;
    for (const key of Object.keys(purchased)) {
      if (UNSAFE_KEYS.has(key)) {
        delete purchased[key];
        continue;
      }
      const parsed = _asNumber(purchased[key]);
      const clamped = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
      if (clamped !== purchased[key]) purchased[key] = clamped;
    }
    return current;
  }
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no effect / no cost" value).
 *
 * @param {*} value — raw number-ish value.
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Drop overflow into a finite upper bound so an absurd (costGrowth, level)
 * pair can never put Infinity into the qi aggregate (a hostile catalog
 * with costGrowth 1e3 and a large level would otherwise overflow).
 *
 * @param {number} value — raw value.
 * @returns {number} the finite value, or Number.MAX_SAFE_INTEGER when the
 *          raw value overflowed past it.
 */
function _safeFinite(value) {
  if (!Number.isFinite(value)) return 0;
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return value;
}
