/**
 * systems/techniques.js — TechniqueSystem (single owner of the technique generators).
 *
 * The P5 idle-style technique shop with classic idle logic: cooldown per
 * producer, levels with geometric price rise, milestone bonuses at 5/10/25/
 * 50/100/150/200 (cooldown reduction OR revenue bonus), and a proficiency
 * ladder: Beginner → Minor → Greater → Complete → Mastered → Assimilated →
 * Transcendence. Techniques produce QI only (lore-safe — NEVER spirit stones;
 * stones are world-salary per AGENTS.md).
 *
 * Data-driven content: technique definitions resolve through the DataManager's
 * `techniques` collection (data/techniques/techniques.json via data/manifest.json).
 * Nothing is hardcoded: a Data Author can add, retire or retune techniques,
 * change costs, cooldowns, milestone tables and proficiency ladders purely in
 * JSON, with no code changes.
 *
 * State owned (writes): state.techniques.owned[id] (level, proficiencyXp,
 * lastActivationMs) and state.cultivation.qiSources.techniques (the aggregate
 * qi/s rate across all techniques). The system uses ResourceSystem.spend() to
 * deduct cost (never touches state.resources directly).
 *
 * Restore-trust: the techniques slice is repaired to the canonical fresh shape
 * before any read/write; prototype-alias ids are rejected; non-finite values
 * are clamped to safe defaults.
 *
 * Event contract (all emitted on the injected eventBus):
 *   technique:purchased { id, level } — first buy (level 1).
 *   technique:upgraded { id, level, cost } — every upgrade.
 *   technique:activated { id, qiGenerated } — per-technique activation.
 *
 * Pure gameplay — no DOM access, no storage I/O. Subscribes to 'loop:update'
 * for the cooldown tick and the qi aggregate write.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** Keys that alias the prototype chain and must never appear in state.techniques.owned. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The state path where the aggregate qi/s rate from techniques is exposed. */
const QI_SOURCE_SLOT = 'cultivation.qiSources.techniques';

/** Default state slice shape (mirrors core/game-state.js). */
function _freshTechniquesSlice() {
  return { owned: {} };
}

export class TechniqueSystem {
  /**
   * @param {object} [options] — constructor options.
   * @param {object} [options.state] — game state object; defaults to the shared
   *        GameState singleton.
   * @param {object} [options.eventBus] — pub/sub bus; defaults to EventBus singleton.
   * @param {object|null} [options.dataManager=null] — DataManager
   *        (or lookalike with `getAll('techniques')` / `get('techniques', id)`).
   *        When absent the system reads nothing — every buy/upgrade rejects.
   * @param {object|null} [options.resourceSystem=null] — ResourceSystem
   *        (or lookalike with `spend(id, amount)`) for stone deduction.
   * @param {Function|null} [options.nowFn] — function returning epoch ms
   *        (default Date.now). Injectable for deterministic tests.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver. */
    this._dataManager = options.dataManager || null;
    /** @type {object|null} wallet (`spend()` consumer). */
    this._resourceSystem = options.resourceSystem || null;
    /** @type {Function} clock for deterministic tests. */
    this._nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;

    // Restore-trust: repair a malformed techniques slice before any API call.
    this._ensureSlice();

    // Snapshot the catalog from the DataManager.
    this._definitions = this._readDefinitions();
    /** @type {Map<string, object>} id → definition for O(1) lookup. */
    this._byId = new Map(this._definitions.map((d) => [d.id, d]));

    // Bound once so subscribe/unsubscribe see the same function identity.
    this._onUpdate = this._onUpdate.bind(this);

    // Subscribe to the game loop for cooldown ticks and qi aggregate writes.
    this._eventBus.subscribe('loop:update', this._onUpdate);

    // Seed the qi aggregate from restored owned entries.
    this._writeQiAggregate(this._computeQiAggregate());
  }

  /**
   * Tear down: unsubscribe from loop:update.
   */
  destroy() {
    this._eventBus.unsubscribe('loop:update', this._onUpdate);
  }

  /**
   * @returns {Array<object>} shallow copies of cached technique definitions.
   */
  list() {
    return this._definitions.map((d) => ({ ...d }));
  }

  /**
   * Look up a single definition by id.
   *
   * @param {string} id — technique id.
   * @returns {object|null} the cached definition, or null.
   */
  get(id) {
    const d = this._byId.get(id);
    return d ? { ...d } : null;
  }

  /**
   * @returns {number} the current owned level of a technique (>= 0).
   * @param {string} id — technique id.
   */
  level(id) {
    if (typeof id !== 'string' || id === '' || UNSAFE_KEYS.has(id)) return 0;
    const owned = this._state.techniques.owned[id];
    if (!owned || typeof owned !== 'object') return 0;
    return Math.max(Math.trunc(_asNumber(owned.level)), 0);
  }

  /**
   * Whether a technique is owned (level >= 1).
   *
   * @param {string} id — technique id.
   * @returns {boolean} true when owned.
   */
  isOwned(id) {
    return this.level(id) >= 1;
  }

  /**
   * Compute the cost of the NEXT level (buy = level-1 cost, upgrade = level-N+1 cost).
   * Cost = floor(baseCost × costMultiplier^(currentLevel)).
   * For buy: currentLevel = 0 → cost = baseCost.
   * For upgrade: currentLevel = N → cost = floor(baseCost × costMultiplier^N).
   * Returns 0 for unknown ids.
   *
   * @param {string} id — technique id.
   * @returns {number} the next-level cost.
   */
  cost(id) {
    const definition = this._byId.get(id);
    if (!definition) return 0;
    const base = _asNumber(definition.baseCost);
    const multiplier = _asNumber(definition.costMultiplier);
    if (base <= 0 || multiplier < 1) return 0;
    const current = this.level(id);
    const raw = base * Math.pow(multiplier, current);
    const result = Math.floor(_safeFinite(raw));
    return result <= 0 ? 0 : result;
  }

  /**
   * Get the qi revenue per activation, including milestone revenue bonuses.
   * Formula: (baseRevenue + revenuePerLevel × level) × revenueMultiplier.
   *
   * @param {string} id — technique id.
   * @returns {number} qi per activation.
   */
  getRevenue(id) {
    const definition = this._byId.get(id);
    if (!definition) return 0;
    const base = _asNumber(definition.baseRevenue);
    const perLevel = _asNumber(definition.revenuePerLevel);
    const level = this.level(id);
    const raw = base + perLevel * level;
    if (raw <= 0) return 0;
    const multiplier = this._computeMultiplier(id, 'revenue');
    return _safeFinite(raw * multiplier);
  }

  /**
   * Get the cooldown between activations in ms, including milestone bonuses.
   * Formula: cooldownMs × cooldownMultiplier.
   *
   * @param {string} id — technique id.
   * @returns {number} cooldown in ms.
   */
  getCooldown(id) {
    const definition = this._byId.get(id);
    if (!definition) return 0;
    const cooldown = _asNumber(definition.cooldownMs);
    if (cooldown <= 0) return 0;
    const multiplier = this._computeMultiplier(id, 'cooldown');
    return Math.max(_safeFinite(cooldown * multiplier), 1);
  }

  /**
   * The current proficiency tier name from the ladder.
   *
   * @param {string} id — technique id.
   * @returns {string} proficiency tier name.
   */
  getProficiencyName(id) {
    const definition = this._byId.get(id);
    if (!definition) return 'Unknown';
    const proficiency = definition.proficiency;
    if (!proficiency || !Array.isArray(proficiency.ladder) || proficiency.ladder.length === 0) {
      return 'Unknown';
    }
    const xp = this._getProficiencyXp(id);
    let name = proficiency.ladder[0].name;
    for (const tier of proficiency.ladder) {
      if (xp >= _asNumber(tier.threshold)) {
        name = tier.name;
      } else {
        break;
      }
    }
    return name;
  }

  /**
   * Get owned technique entries with resolved metadata.
   *
   * @returns {Array<object>} array of { id, name, description, level, proficiencyName,
   *          proficiencyXp, revenue, cooldownMs, cost, grade, category }.
   */
  getAll() {
    const owned = this._state.techniques.owned;
    const entries = [];
    for (const id of Object.keys(owned)) {
      if (UNSAFE_KEYS.has(id)) continue;
      const definition = this._byId.get(id);
      const entry = owned[id];
      if (!entry || typeof entry !== 'object') continue;
      const level = this.level(id);
      if (level < 1) continue;
      entries.push({
        id,
        name: definition ? definition.name : id,
        description: definition ? definition.description : '',
        level,
        proficiencyName: this.getProficiencyName(id),
        proficiencyXp: this._getProficiencyXp(id),
        revenue: this.getRevenue(id),
        cooldownMs: this.getCooldown(id),
        cost: this.cost(id),
        grade: definition ? (definition.grade || 'Mortal') : 'Mortal',
        category: definition ? (definition.category || 'cultivation') : 'cultivation',
      });
    }
    return entries;
  }

  /**
   * Buy a technique (first level). Spends spirit stones via ResourceSystem.
   *
   * @param {string} id — technique id.
   * @returns {object|null} { id, level } or null on failure.
   */
  buy(id) {
    if (typeof id !== 'string' || id === '') {
      console.warn(`TechniqueSystem: buy('${String(id)}') — id must be a non-empty string.`);
      return null;
    }
    if (UNSAFE_KEYS.has(id)) {
      console.warn(`TechniqueSystem: buy('${id}') — unsafe prototype-alias id.`);
      return null;
    }
    const definition = this._byId.get(id);
    if (!definition) {
      console.warn(`TechniqueSystem: unknown technique id "${id}" — nothing bought.`);
      return null;
    }
    if (this.isOwned(id)) {
      console.warn(`TechniqueSystem: technique "${id}" is already owned — use upgrade().`);
      return null;
    }
    if (!this._resourceSystem) {
      console.warn(`TechniqueSystem: no resource system available — cannot buy "${id}".`);
      return null;
    }
    const stoneCost = this.cost(id);
    if (stoneCost <= 0) {
      console.warn(`TechniqueSystem: "${id}" has no positive cost — nothing bought.`);
      return null;
    }

    const spent = this._resourceSystem.spend('spiritStones', stoneCost);
    if (!spent) return null;

    this._state.techniques.owned[id] = {
      level: 1,
      proficiencyXp: 0,
      lastActivationMs: 0,
    };

    this._writeQiAggregate(this._computeQiAggregate());

    this._eventBus.emit('technique:purchased', { id, level: 1 });
    return { id, level: 1 };
  }

  /**
   * Upgrade an owned technique (increase level by 1).
   *
   * @param {string} id — technique id.
   * @returns {object|null} { level, cost } or null on failure.
   */
  upgrade(id) {
    if (typeof id !== 'string' || id === '') {
      console.warn(`TechniqueSystem: upgrade('${String(id)}') — id must be a non-empty string.`);
      return null;
    }
    if (UNSAFE_KEYS.has(id)) {
      console.warn(`TechniqueSystem: upgrade('${id}') — unsafe prototype-alias id.`);
      return null;
    }
    const definition = this._byId.get(id);
    if (!definition) {
      console.warn(`TechniqueSystem: unknown technique id "${id}" — nothing upgraded.`);
      return null;
    }
    if (!this.isOwned(id)) {
      console.warn(`TechniqueSystem: technique "${id}" is not owned — use buy() first.`);
      return null;
    }
    if (!this._resourceSystem) {
      console.warn(`TechniqueSystem: no resource system available — cannot upgrade "${id}".`);
      return null;
    }
    const stoneCost = this.cost(id);
    if (stoneCost <= 0) {
      console.warn(`TechniqueSystem: "${id}" has no positive cost — nothing upgraded.`);
      return null;
    }

    const spent = this._resourceSystem.spend('spiritStones', stoneCost);
    if (!spent) return null;

    const current = this._state.techniques.owned[id];
    current.level = Math.max(Math.trunc(_asNumber(current.level)) + 1, 1);

    this._writeQiAggregate(this._computeQiAggregate());

    const result = { id, level: current.level, cost: stoneCost };
    this._eventBus.emit('technique:upgraded', result);
    return result;
  }

  /**
   * Compute a milestone multiplier for a technique. Milestones of the
   * same type stack multiplicatively.
   *
   * @param {string} id — technique id.
   * @param {string} type — 'revenue' or 'cooldown'.
   * @returns {number} the stacked multiplier (1.0 base).
   */
  _computeMultiplier(id, type) {
    const definition = this._byId.get(id);
    if (!definition) return 1;
    const milestones = definition.milestones;
    if (!milestones || typeof milestones !== 'object') return 1;
    const level = this.level(id);
    const milestoneLevels = Object.keys(milestones)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
    let multiplier = 1;
    for (const milestone of milestoneLevels) {
      if (level >= milestone) {
        const entry = milestones[String(milestone)];
        if (entry && entry.type === type) {
          multiplier *= _asNumber(entry.value);
        }
      }
    }
    return multiplier > 0 ? multiplier : 1;
  }

  /**
   * Tick handler (bound; invoked via 'loop:update'). For each owned technique,
   * if the cooldown has elapsed, generate qi and proficiency XP.
   *
   * @param {object} [payload] — { deltaMs, elapsedMs, tick }.
   */
  _onUpdate(payload) {
    this._ensureSlice();
    const now = this._nowFn();
    let totalQi = 0;
    const activated = [];

    for (const id of Object.keys(this._state.techniques.owned)) {
      if (UNSAFE_KEYS.has(id)) continue;
      const entry = this._state.techniques.owned[id];
      if (!entry || typeof entry !== 'object') continue;
      const level = this.level(id);
      if (level < 1) continue;

      const cooldown = this.getCooldown(id);
      if (cooldown <= 0) continue;

      const lastMs = _asNumber(entry.lastActivationMs);
      if (now - lastMs < cooldown) continue;

      const revenue = this.getRevenue(id);
      if (revenue <= 0) continue;

      totalQi += revenue;
      activated.push({ id, revenue });

      // Advance proficiency XP.
      const definition = this._byId.get(id);
      const proficiency = definition && definition.proficiency;
      if (proficiency) {
        const xpPerActivation = _asNumber(proficiency.xpPerActivation);
        if (xpPerActivation > 0) {
          const currentXp = _asNumber(entry.proficiencyXp);
          const nextXp = Number.isFinite(currentXp + xpPerActivation) ? currentXp + xpPerActivation : currentXp;
          entry.proficiencyXp = nextXp;
        }
      }

      entry.lastActivationMs = now;
    }

    // Accumulate qi via state write (direct — same pattern as QiSystem).
    if (totalQi > 0) {
      const current = _asNumber(this._state.cultivation.qi);
      const room = Math.max(_asNumber(this._state.cultivation.qiMax) - current, 0);
      const added = Math.min(totalQi, room);

      if (added > 0) {
        const newQi = current + added;
        if (Number.isFinite(newQi)) {
          this._state.cultivation.qi = newQi;
        }
      }

      // Emit per-technique activation events.
      for (const activation of activated) {
        if (this._eventBus.hasListeners('technique:activated')) {
          this._eventBus.emit('technique:activated', {
            id: activation.id,
            qiGenerated: activation.revenue,
          });
        }
      }
    }

    // Always sync the qi aggregate (it can change on upgrade even without tick).
    this._writeQiAggregate(this._computeQiAggregate());
  }

  /**
   * Aggregate the qi/s rate contribution across all owned techniques.
   * Formula: revenue / (cooldownMs / 1000) for each technique.
   *
   * @returns {number} aggregate qi/s rate.
   */
  _computeQiAggregate() {
    let sum = 0;
    for (const id of Object.keys(this._state.techniques.owned)) {
      if (UNSAFE_KEYS.has(id)) continue;
      const level = this.level(id);
      if (level < 1) continue;
      const revenue = this.getRevenue(id);
      const cooldown = this.getCooldown(id);
      if (revenue > 0 && cooldown > 0) {
        sum += revenue / (cooldown / 1000);
      }
    }
    return sum;
  }

  /**
   * Write the aggregate to cultivation.qiSources.techniques, only when it
   * differs from the current value.
   *
   * @param {number} aggregate — qi/s to expose.
   */
  _writeQiAggregate(aggregate) {
    const value = _safeFinite(aggregate);
    if (
      this._state.cultivation &&
      this._state.cultivation.qiSources &&
      this._state.cultivation.qiSources.techniques !== value
    ) {
      this._state.cultivation.qiSources.techniques = value;
    }
  }

  /**
   * Read the technique catalog from the injected DataManager.
   *
   * @returns {Array<object>} the catalog.
   */
  _readDefinitions() {
    if (!this._dataManager) return [];
    if (typeof this._dataManager.getAll !== 'function') return [];
    return this._dataManager.getAll('techniques');
  }

  /**
   * Repair the techniques slice to a canonical shape before any read/write.
   *
   * @returns {object} the (possibly repaired) slice.
   */
  _ensureSlice() {
    const current = this._state.techniques;
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      current.owned === null ||
      typeof current.owned !== 'object' ||
      Array.isArray(current.owned)
    ) {
      this._state.techniques = _freshTechniquesSlice();
      return this._state.techniques;
    }
    // Drop prototype-alias owned keys and clamp non-finite values.
    const owned = current.owned;
    for (const key of Object.keys(owned)) {
      if (UNSAFE_KEYS.has(key)) {
        delete owned[key];
        continue;
      }
      const entry = owned[key];
      if (!entry || typeof entry !== 'object') {
        delete owned[key];
        continue;
      }
      entry.level = Math.max(Math.trunc(_asNumber(entry.level)), 0);
      entry.proficiencyXp = _safeFinite(_asNumber(entry.proficiencyXp));
      entry.lastActivationMs = _safeFinite(_asNumber(entry.lastActivationMs));
    }
    return current;
  }

  /**
   * Read the proficiency XP of a technique, or 0.
   *
   * @param {string} id — technique id.
   * @returns {number} XP amount.
   */
  _getProficiencyXp(id) {
    const entry = this._state.techniques.owned[id];
    if (!entry || typeof entry !== 'object') return 0;
    return Math.max(_safeFinite(_asNumber(entry.proficiencyXp)), 0);
  }
}

/** Coerce a value to a finite number, treating anything unusable as 0. */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Drop overflow into a finite upper bound. */
function _safeFinite(value) {
  if (!Number.isFinite(value)) return 0;
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if (value < 0) return 0;
  return value;
}
