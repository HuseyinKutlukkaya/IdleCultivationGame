/**
 * systems/realms.js — RealmSystem (single owner of the realm ladder).
 *
 * The Phase-3 realm system. RealmSystem owns the CANONICAL realm ladder —
 * the data-driven 15-tier progression (Mortal → Beyond Heaven) from
 * data/realms/realms.json — and the realm's applied effects. It resolves
 * the current realm from state.cultivation.realm (id, name or tier number;
 * the stored DISPLAY NAME stays in state because the UI binds it and old
 * saves store names), writes the canonical identity + effect slots into the
 * cultivation slice and exposes the read API the UI and future systems
 * consume. The future BreakthroughSystem will call setRealm() to advance
 * the ladder; it never subscribes to the loop — realms only change through
 * setRealm() or the boot resolution.
 *
 * Data-driven content: the ladder comes from dataManager.getAll('realms')
 * (data/realms/realms.json via data/manifest.json). File order is tier
 * order (guaranteed by tests/data/realms.test.mjs). Nothing is hardcoded —
 * realm ids, names, tiers, the three effect multipliers (qiMaxMultiplier,
 * cultivationSpeedMultiplier, powerMultiplier) and lifespanYears all come
 * from the definitions. A MISSING 'realms' collection is silent (an empty
 * ladder — every read returns neutral values and setRealm rejects), and a
 * definition missing an effect field coerces to a neutral default (see
 * _coerceMultiplier / _coerceLifespan).
 *
 * State owned (writes): cultivation.realm (display name),
 * cultivation.realmTier (numeric tier 0..14), cultivation.nextRealm (the
 * next realm's display name, null at the top realm — the renderer renders
 * null as "—") and cultivation.realmEffects ({ qiMaxMultiplier,
 * cultivationSpeedMultiplier, powerMultiplier, lifespanYears } — the
 * consumer slots QiSystem reads for its cap/rate stacking). All paths are
 * part of the canonical GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the cultivation slice is repaired
 * to the canonical fresh shape when unusable (null, a primitive or an
 * array) before ANY read or write — a broken slice must never abort boot.
 * Effect coercion is defensive: a missing, non-positive or non-finite
 * multiplier writes 1 (neutral — never zero out a cap/rate) and a missing
 * or non-finite lifespanYears writes 0 (never negative). An unresolvable
 * stored realm (id/name/tier not in the ladder) recovers to tier 0 with a
 * warning; an empty ladder leaves state untouched.
 *
 * Event contract (all emitted on the injected eventBus; no subscriptions —
 * realms never change on their own):
 *   realm:changed { realmId, realmName, tier, effects } — emitted on every
 *     successful setRealm() call (never on a rejected one, never when the
 *     target is already the current realm, and NOT on boot resolution — the
 *     boot writes state before any consumer subscribes and the renderer's
 *     initial flush already reflects it).
 *
 * Pure gameplay — no DOM access, no storage I/O, no loop subscription and
 * no destroy() (there are no listeners to tear down). Public lookups return
 * shallow copies ({ ...def }), mirroring UpgradeSystem.list()/get(), so
 * callers can never mutate the deep-frozen cached definitions. This module
 * depends solely on the shared GameState and EventBus singletons and the
 * injected DataManager (all injectable for deterministic tests).
 *
 * Future expansion (see DESIGN.md/PLANS.md): Breakthroughs call setRealm()
 * to advance the ladder; spirit roots and techniques stack more multipliers
 * into cultivation.realmEffects (or a config multiplier block) that the
 * QiSystem already reads — the cap/rate hooks in js/systems/qi.js multiply
 * every factor in without touching the resource math.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

export class RealmSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as QiSystem, MeditationSystem,
   *        UpgradeSystem, OfflineProgress, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the realm ladder
   *        from the 'realms' collection. When absent the ladder is empty —
   *        every read returns neutral values and setRealm() rejects. Realm
   *        content is never hardcoded.
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `cultivation` block is read for layerFactor (default 0.15) and
   *        layerMax (default 9). A missing block is silent (defaults apply).
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('realms' collection). */
    this._dataManager = options.dataManager || null;

    const cultivationConfig = (options.config && options.config.cultivation) || {};
    /** @type {number} layerFactor — progressive difficulty per sub-layer. */
    this._layerFactor = _readFiniteNumber(
      cultivationConfig.layerFactor,
      0.15,
      'layerFactor'
    );
    /** @type {number} fixed number of sub-layers per realm. */
    this._layerMax = _readPositiveInteger(
      cultivationConfig.layerMax,
      9,
      'layerMax'
    );

    // Restore-trust: a malformed cultivation slice (null, a primitive or an
    // array) restored from an attacker-shaped save must never abort boot —
    // repair it to the canonical fresh slice before any read/write below.
    this._ensureCultivationSlice();

    // Snapshot the ladder at construction time (file order = tier order).
    // Cached definitions are deep-frozen by the DataManager; the array
    // itself stays a reference snapshot for lookup performance.
    this._definitions = this._readDefinitions();

    /** @type {Map<string, object>} id → definition (O(1) lookup). */
    this._byId = new Map();
    /** @type {Map<string, object>} exact display name → definition. */
    this._byName = new Map();
    /** @type {Map<string, object>} lowercased display name → definition. */
    this._byNameLower = new Map();
    /** @type {Map<number, object>} tier → definition. */
    this._byTier = new Map();
    this._buildIndexes();

    // Resolve the current realm from the restored state and write the
    // canonical identity + effects (see _resolveBootRealm).
    this._resolveBootRealm();
  }

  /**
   * @returns {number} the number of realms in the ladder (0 when the
   *          'realms' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * @returns {Array<object>} shallow copies of the cached realm definitions
   *          (file order = tier order preserved). Mutating a returned copy
   *          never leaks into the deep-frozen ladder.
   */
  list() {
    return this._definitions.map((definition) => ({ ...definition }));
  }

  /**
   * Look up a single definition by realm id.
   *
   * @param {string} id — the realm id (e.g. 'qi-gathering').
   * @returns {object|null} a shallow copy of the definition, or null when
   *          the id is unknown.
   */
  byId(id) {
    const definition = this._byId.get(id);
    return definition ? { ...definition } : null;
  }

  /**
   * Look up a single definition by display name. Exact match first, then a
   * case-insensitive match ('mortal', 'Mortal' and 'MORTAL' all resolve).
   *
   * @param {string} name — the realm display name.
   * @returns {object|null} a shallow copy of the definition, or null when
   *          the name is unknown.
   */
  byName(name) {
    if (typeof name !== 'string') return null;
    const exact = this._byName.get(name);
    if (exact) return { ...exact };
    const folded = this._byNameLower.get(name.toLowerCase());
    return folded ? { ...folded } : null;
  }

  /**
   * Look up a single definition by numeric tier.
   *
   * @param {number} tier — the realm tier (0..14 in the canonical ladder).
   * @returns {object|null} a shallow copy of the definition, or null when
   *          the tier is unknown.
   */
  byTier(tier) {
    const definition = this._byTier.get(tier);
    return definition ? { ...definition } : null;
  }

  /**
   * @returns {object|null} a shallow copy of the current realm's definition
   *          (resolved from state.cultivation.realmTier — written
   *          canonically by the boot resolution and every setRealm), or
   *          null when the ladder is empty.
   */
  current() {
    const definition = this._byTier.get(this._state.cultivation.realmTier);
    return definition ? { ...definition } : null;
  }

  /**
   * @returns {object|null} a shallow copy of the NEXT realm's definition
   *          (tier + 1), or null when the current realm is the top of the
   *          ladder (or the ladder is empty).
   */
  next() {
    const current = this.current();
    if (!current) return null;
    const definition = this._byTier.get(current.tier + 1);
    return definition ? { ...definition } : null;
  }

  /**
   * @returns {boolean} true when the current realm is the top of the
   *          ladder (no higher tier exists) — or false when the ladder is
   *          empty (nothing is "maxed").
   */
  get isMaxRealm() {
    const current = this.current();
    if (!current) return false;
    return !this._byTier.has(current.tier + 1);
  }

  /**
   * @returns {number} the current realm's qiMaxMultiplier (the cap factor
   *          the QiSystem reads), coerced to a neutral 1 when missing,
   *          non-positive or non-finite — a missing effect field must never
   *          zero out the qi cap. 1 when the ladder is empty.
   */
  get qiMaxMultiplier() {
    return this._currentEffect('qiMaxMultiplier', _coerceMultiplier);
  }

  /**
   * @returns {number} the current realm's cultivationSpeedMultiplier (the
   *          rate factor the QiSystem reads), coerced to a neutral 1 when
   *          missing, non-positive or non-finite. 1 when the ladder is
   *          empty.
   */
  get cultivationSpeedMultiplier() {
    return this._currentEffect('cultivationSpeedMultiplier', _coerceMultiplier);
  }

  /**
   * @returns {number} the current realm's powerMultiplier (future consumer
   *          slot), coerced to a neutral 1 when missing, non-positive or
   *          non-finite. 1 when the ladder is empty.
   */
  get powerMultiplier() {
    return this._currentEffect('powerMultiplier', _coerceMultiplier);
  }

  /**
   * @returns {number} the current realm's lifespanYears (future consumer
   *          slot), coerced to 0 when missing, negative or non-finite —
   *          never negative. 0 when the ladder is empty.
   */
  get lifespanYears() {
    return this._currentEffect('lifespanYears', _coerceLifespan);
  }

  /**
   * @returns {Array<object>} a copy of the current realm's unlocks array,
   *          or [] when absent (a definition without an unlocks field, or
   *          an empty ladder).
   */
  get unlocks() {
    const current = this.current();
    if (!current) return [];
    return Array.isArray(current.unlocks) ? [...current.unlocks] : [];
  }

  /**
   * Change the current realm — the mutation the future BreakthroughSystem
   * will call. Accepts a realm id ('qi-gathering'), a display name
   * ('Qi Gathering', exact then case-insensitive) or a numeric tier (1).
   *
   * Rejected (returns false, no mutation, no event):
   *   - unknown target (id/name/tier not in the ladder) — warns once;
   *   - the target IS the already-current realm — silent no-op (mirrors
   *     MeditationSystem.start()/stop() semantics).
   *
   * @param {string|number} target — realm id, display name or numeric tier.
   * @returns {boolean} true when the realm changed.
   */
  setRealm(target) {
    if (this._definitions.length === 0) {
      console.warn(
        `RealmSystem: no realm definitions loaded — cannot change realm.`
      );
      return false;
    }
    const definition = this._resolve(target);
    if (!definition) {
      console.warn(
        `RealmSystem: unknown realm "${String(target)}" — nothing changed.`
      );
      return false;
    }
    const current = this.current();
    if (current && current.tier === definition.tier) return false;

    this._apply(definition);
    this._eventBus.emit('realm:changed', {
      realmId: definition.id,
      realmName: definition.name,
      tier: definition.tier,
      effects: { ...this._state.cultivation.realmEffects },
    });
    return true;
  }

  /**
   * Advance one sub-layer within the current realm. Only valid when the
   * cultivator is below layer 9 — at layer 9 the realm breakthrough gates.
   * Resets realmProgress to 0 and updates realmProgressMax for the new layer
   * (scaled by the layerFactor from config.cultivation). Emits
   * 'realm:layerAdvanced' on success.
   *
   * @returns {boolean} true when the layer advanced (1 → 2, … → 9).
   */
  advanceLayer() {
    const currentLayer = _asPositiveInteger(
      this._state.cultivation.realmLayer,
      1
    );
    if (currentLayer >= this._layerMax) return false;

    const newLayer = currentLayer + 1;
    // Compute the new progress max BEFORE writing the new layer — the
    // computation extracts the base from the current max and current layer.
    const newMax = this._computeLayerProgressMax(currentLayer, newLayer);
    this._state.cultivation.realmLayer = newLayer;
    this._state.cultivation.realmProgress = 0;
    this._state.cultivation.realmProgressMax = newMax;

    this._eventBus.emit('realm:layerAdvanced', {
      layer: newLayer,
      realm: this._state.cultivation.realm,
      realmId: this.current() ? this.current().id : null,
    });
    return true;
  }

  /**
   * Compute the realmProgressMax for a target sub-layer within the current
   * realm. The base is realmProgressMax at layer 1 (the breakthrough entry's
   * requiredProgress); the formula is:
   *
   *   max = base × (1 + layerFactor × (targetLayer − 1))
   *
   * At layer 1 the factor is 1 (no scaling). The base is extracted from the
   * current realmProgressMax by dividing by the current layer's factor.
   *
   * @param {number} currentLayer — the current sub-layer (1..layerMax).
   * @param {number} targetLayer — the target sub-layer (1..layerMax).
   * @returns {number} the computed realmProgressMax for the target layer.
   */
  _computeLayerProgressMax(currentLayer, targetLayer) {
    const currentMax = Number(this._state.cultivation.realmProgressMax);
    const currentFactor =
      1 + this._layerFactor * (currentLayer - 1);
    const base = Number.isFinite(currentMax) && currentFactor > 0
      ? currentMax / currentFactor
      : currentMax;
    const targetFactor =
      1 + this._layerFactor * (targetLayer - 1);
    return Math.max(Math.round(base * targetFactor), 1);
  }

  /**
   * of its fields. A malformed slice restored from an attacker-shaped save
   * (null, a primitive or an array) is replaced with the canonical fresh
   * cultivation shape — restore-trust: a broken top-level slice must never
   * abort boot. A healthy restored slice (extra/missing fields) keeps its
   * own fields.
   *
   * @returns {void}
   */
  _ensureCultivationSlice() {
    const cultivation = this._state.cultivation;
    if (
      cultivation === null ||
      typeof cultivation !== 'object' ||
      Array.isArray(cultivation)
    ) {
      this._state.cultivation = _freshCultivationSlice();
    }
  }

  /**
   * Read the realm ladder from the injected DataManager. Returns an empty
   * array when no DataManager was injected or it lacks getAll() — every
   * read then returns neutral values and setRealm() rejects. Entries that
   * are not plain objects are skipped defensively (a hostile lookalike must
   * not poison the indexes). No throw, no fallback to hardcoded defaults
   * (the data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the ladder (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('realms');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (definition) =>
        definition !== null &&
        typeof definition === 'object' &&
        !Array.isArray(definition)
    );
  }

  /**
   * Build the id / name / name-lower / tier lookup indexes over the
   * snapshot. First occurrence wins on any collision (defensive — the
   * data tests already guarantee uniqueness). Tier keys use the definition
   * tier when it is a finite number, else the array index (file order =
   * tier order is the data contract).
   *
   * @returns {void}
   */
  _buildIndexes() {
    this._definitions.forEach((definition, index) => {
      const id = definition.id;
      if (typeof id === 'string' && id !== '' && !this._byId.has(id)) {
        this._byId.set(id, definition);
        const name = definition.name;
        if (typeof name === 'string' && name !== '') {
          if (!this._byName.has(name)) this._byName.set(name, definition);
          const folded = name.toLowerCase();
          if (!this._byNameLower.has(folded)) {
            this._byNameLower.set(folded, definition);
          }
        }
      }
      const tier = Number(definition.tier);
      const tierKey = Number.isFinite(tier) ? tier : index;
      if (!this._byTier.has(tierKey)) this._byTier.set(tierKey, definition);
    });
  }

  /**
   * Resolve a target (id | display name | numeric tier) to a ladder
   * definition. Strings try the id index first, then the exact-name index,
   * then the case-insensitive-name index. Anything else (and any miss)
   * yields null.
   *
   * @param {string|number} target — realm id, display name or numeric tier.
   * @returns {object|null} the cached (frozen) definition, or null.
   */
  _resolve(target) {
    if (typeof target === 'number') {
      return this._byTier.get(target) || null;
    }
    if (typeof target === 'string') {
      const byId = this._byId.get(target);
      if (byId) return byId;
      const byName = this._byName.get(target);
      if (byName) return byName;
      return this._byNameLower.get(target.toLowerCase()) || null;
    }
    return null;
  }

  /**
   * Resolve the current realm from the restored state (construction) and
   * write the canonical identity + effects via _apply. An empty ladder is a
   * neutral no-op — state stays exactly as restored. An unresolvable stored
   * realm with a non-empty ladder warns once and recovers to tier 0 (the
   * first realm) so the game always has a valid realm identity.
   *
   * @returns {void}
   */
  _resolveBootRealm() {
    if (this._definitions.length === 0) return;

    const stored = this._state.cultivation.realm;
    const definition = this._resolve(stored);
    if (definition) {
      this._apply(definition);
      return;
    }
    console.warn(
      `RealmSystem: stored realm "${String(stored)}" is not in the ladder — recovering to tier 0 (${this._definitions[0].name}).`
    );
    this._apply(this._definitions[0]);
  }

  /**
   * Write the canonical realm identity + effects for a definition into the
   * cultivation slice: the display name (UI binds it), the numeric tier
   * (the progression key), the next realm's display name (null at the top
   * of the ladder — the renderer renders null as "—") and the four effect
   * slots with defensive coercion (see _coerceMultiplier / _coerceLifespan
   * — a definition that lacks effect fields, e.g. a minimal canned fixture,
   * lands neutral defaults instead of undefined).
   *
   * @param {object} definition — a cached (frozen) ladder definition.
   * @returns {void}
   */
  _apply(definition) {
    this._state.cultivation.realm = definition.name;
    this._state.cultivation.realmTier = definition.tier;
    this._state.cultivation.realmLayer = 1;
    const next = this._byTier.get(definition.tier + 1);
    this._state.cultivation.nextRealm = next ? next.name : null;
    this._state.cultivation.realmEffects = {
      qiMaxMultiplier: _coerceMultiplier(definition.qiMaxMultiplier),
      cultivationSpeedMultiplier: _coerceMultiplier(
        definition.cultivationSpeedMultiplier
      ),
      powerMultiplier: _coerceMultiplier(definition.powerMultiplier),
      lifespanYears: _coerceLifespan(definition.lifespanYears),
    };
  }

  /**
   * Read a single effect field off the current realm definition and coerce
   * it with the given helper, returning the neutral fallback when the
   * ladder is empty.
   *
   * @param {string} key — effect field name on the definition.
   * @param {(value: *) => number} coerce — defensive coercion helper.
   * @returns {number} the coerced effect value.
   */
  _currentEffect(key, coerce) {
    const current = this.current();
    if (!current) return coerce(undefined);
    return coerce(current[key]);
  }
}

/**
 * The canonical fresh cultivation slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored cultivation slice is
 * unusable (null, a primitive or an array) — a broken top-level slice must
 * never abort boot. The qiSources shape stays the local per-file fallback
 * ({ meditation: 0 }), same as qi.js/meditation.js.
 *
 * @returns {object} the canonical cultivation slice.
 */
function _freshCultivationSlice() {
  return {
    realm: 'Mortal',
    realmTier: 0,
    realmStage: 1,
    realmLayer: 1,
    realmLayerMax: 9,
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
 * Coerce a realm effect multiplier. A missing, non-positive or non-finite
 * value defaults to 1 (the neutral "no effect" factor — never 0, so a
 * malformed definition or hostile save can never zero out a cap or rate).
 *
 * @param {*} value — raw multiplier value from the definition.
 * @returns {number} the validated multiplier (>= 1).
 */
function _coerceMultiplier(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Coerce a realm lifespan (in years). A missing, non-finite or negative
 * value defaults to 0 — never negative.
 *
 * @param {*} value — raw lifespan value from the definition.
 * @returns {number} the validated lifespan (>= 0).
 */
function _coerceLifespan(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed > 0 ? parsed : 0;
}

/**
 * Read a finite tuning option, falling back to a default. A missing value
 * falls back silently; a present but invalid value warns once.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _readFiniteNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  if (value !== undefined) {
    console.warn(
      `RealmSystem: invalid "${name}" (${String(value)}) — using the default ${fallback}.`
    );
  }
  return fallback;
}

/**
 * Read a positive integer tuning option, falling back to a default.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _readPositiveInteger(value, fallback, name) {
  const parsed = Number(value);
  if (
    Number.isFinite(parsed) &&
    parsed > 0 &&
    Number.isInteger(parsed)
  ) {
    return parsed;
  }
  if (value !== undefined) {
    console.warn(
      `RealmSystem: invalid "${name}" (${String(value)}) — using the default ${fallback}.`
    );
  }
  return fallback;
}

/**
 * Coerce a value to a positive integer, keeping a floor of 1 (never 0).
 *
 * @param {*} value — raw value.
 * @param {number} floor — minimum value to return when unusable.
 * @returns {number} the validated value (>= 1).
 */
function _asPositiveInteger(value, floor) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed)
    : floor;
}
