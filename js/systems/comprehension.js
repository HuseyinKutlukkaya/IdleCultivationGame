/**
 * systems/comprehension.js — ComprehensionSystem (single owner of the
 * cultivator's comprehension state and its three cultivation multiplier slots).
 *
 * The Phase-3 comprehension system (DESIGN.md 'Comprehension' — understanding:
 * higher comprehension allows faster Dao progress, better technique efficiency
 * and reduced breakthrough requirements). The comprehension state is set
 * through external means (the future character-gen flow, the developer console
 * and tests). No character-gen roll exists yet, so setComprehension() is
 * exposed for the future flow, the developer console and tests. The system is
 * the ONLY writer of the comprehension locations: state.comprehension (the
 * canonical comprehension shape), the three FUTURE-CONSUMER cultivation slots
 * cultivation.comprehensionDaoProgressMultiplier /
 * cultivation.comprehensionTechniqueEfficiencyMultiplier /
 * cultivation.comprehensionBreakthroughEfficiencyMultiplier (no system reads
 * them yet — DESIGN.md 'Comprehension allows faster Dao progress, better
 * technique efficiency, reduced breakthrough requirements'; the Dao/
 * technique-efficiency consumers land later, same precedent as the soul slots,
 * which are written today and read by no system yet), and
 * player.comprehension (the UI display name).
 *
 * Data-driven content: the ladder (id, name, description, daoProgressMultiplier,
 * techniqueEfficiencyMultiplier, breakthroughEfficiencyMultiplier) comes from
 * dataManager.getAll('comprehension') (data/comprehension/comprehension.json
 * via data/manifest.json — one entry per state, file order is the ladder
 * Shallow → Dao Heart). The fresh-game 'standard' state is the canonical
 * default (all 1.0× multipliers). A MISSING 'comprehension' collection degrades
 * neutrally: count 0, no state writes and setComprehension() returns null.
 * Definitions are snapshotted and coerced ONCE at construction (a deep-frozen
 * DataManager cache can never be trusted to be well-formed): non-object
 * entries and entries without a usable id are skipped; duplicate ids keep the
 * first occurrence; every kept entry is coerced to the canonical internal
 * shape (name falls back to id, each multiplier to the neutral 1 when not a
 * finite number > 0 — an unusable factor can never poison the slot).
 *
 * setComprehension(comprehensionId) applies the comprehension from the data
 * ladder: it looks up the id in the coerced snapshot and, when found, writes
 * ALL owned locations (state.comprehension, cultivation.
 * comprehensionDaoProgressMultiplier, cultivation.
 * comprehensionTechniqueEfficiencyMultiplier, cultivation.
 * comprehensionBreakthroughEfficiencyMultiplier and player.comprehension). An
 * unknown id or an empty ladder returns null and mutates nothing. Emits NO
 * events — PLANS.md defines no comprehension event and there is no consumer
 * (the system holds the injected bus for the future event contract only).
 *
 * State owned (writes): state.comprehension (the full canonical shape), the
 * three future-consumer cultivation slots (which the future Dao /
 * technique-efficiency / breakthrough systems will read) and
 * player.comprehension (the display name). All are part of the canonical
 * GameState (see core/game-state.js). qi.js, techniques.js and
 * breakthroughs.js are deliberately NOT touched — the comprehension slots have
 * no consumer today.
 *
 * Restore-trust (attacker-shaped saves): the comprehension, cultivation and
 * player slices are repaired to the canonical fresh shapes when unusable
 * (null, a primitive or an array) before ANY read or write — a broken slice
 * must never abort boot or throw per call. A hostile restored multiplier (NaN,
 * Infinity, negative, <= 0) is coerced to the neutral 1 on read and can never
 * reach the cultivation slots; the constructor syncs the three cultivation
 * slots from the current state.comprehension immediately (same reasoning as
 * the SoulSystem's constructor sync: a restored save shows the right
 * multipliers before the first tick), so a restored comprehension lands its
 * factors in the slots and the fresh standard shape keeps the slots at 1 —
 * restored saves stay numerically identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing to
 * tear down — the comprehension only changes through setComprehension(), so no
 * destroy() is needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setComprehension() as a step; the three slots are written today for
 * the future Dao / technique-efficiency / breakthrough consumers — when they
 * land, the bonuses read the slots with no further code. All data-driven, no
 * code changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

export class ComprehensionSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, MeridianSystem,
   *        PhysiqueSystem, DantianSystem, BloodlineSystem, SoulSystem,
   *        TalentSystem, QiSystem, RealmSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no comprehension event), so the reference is
   *        reserved, never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the comprehension
   *        ladder from the 'comprehension' collection. When absent the ladder
   *        is empty — count 0, no state writes, setComprehension() returns
   *        null. Content is never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('comprehension' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed comprehension/cultivation/player slice
    // (null, a primitive or an array) restored from an attacker-shaped save
    // must never abort boot — repair all three before any read/write below.
    this._ensureSlices();

    // Snapshot + coerce the ladder at construction time (file order =
    // ladder order). Cached definitions are deep-frozen by the DataManager
    // and can never be trusted to be well-formed, so every entry is coerced
    // into the canonical internal shape once; hostile entries are skipped.
    this._definitions = this._readDefinitions();

    /** @type {Map<string, object>} id → coerced definition (O(1) lookup). */
    this._byId = new Map();
    this._buildIndexes();

    // Constructor sync: write the cultivation multiplier slots from the
    // current comprehension's factors (coerced, neutral 1 when unusable) so a
    // restored save shows the right multipliers before the first tick — same
    // reasoning as the SoulSystem's constructor sync. The fresh standard
    // shape reads all 1.0×, so restored saves stay numerically identical.
    this._syncMultipliers();
  }

  /**
   * @returns {number} the number of comprehension definitions (0 when the
   *          'comprehension' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the comprehension id (e.g. 'insightful').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT comprehension — never mutates state.
   * Every field is coerced defensively to the canonical shape (the fresh
   * standard defaults when the restored slice lacks a usable value), so a
   * hostile save can never yield a malformed/partial object and the read never
   * throws. The returned object is a fresh copy — mutating it never leaks into
   * the system or the state.
   *
   * @returns {{ id: string, name: string, daoProgressMultiplier: number,
   *            techniqueEfficiencyMultiplier: number,
   *            breakthroughEfficiencyMultiplier: number }} the current
   *            comprehension.
   */
  getCurrent() {
    this._ensureSlices();
    const comprehension = this._state.comprehension;
    return {
      id:
        typeof comprehension.id === 'string' && comprehension.id !== ''
          ? comprehension.id
          : 'standard',
      name:
        typeof comprehension.name === 'string' && comprehension.name !== ''
          ? comprehension.name
          : 'Standard',
      daoProgressMultiplier: _coerceMultiplier(comprehension.daoProgressMultiplier),
      techniqueEfficiencyMultiplier: _coerceMultiplier(
        comprehension.techniqueEfficiencyMultiplier
      ),
      breakthroughEfficiencyMultiplier: _coerceMultiplier(
        comprehension.breakthroughEfficiencyMultiplier
      ),
    };
  }

  /**
   * Apply a comprehension by id from the data ladder. Looks up the id in the
   * coerced snapshot and, when found, writes ALL owned locations:
   * state.comprehension (the full canonical shape, with the multipliers from
   * the definition), the three future-consumer cultivation slots
   * cultivation.comprehensionDaoProgressMultiplier /
   * cultivation.comprehensionTechniqueEfficiencyMultiplier /
   * cultivation.comprehensionBreakthroughEfficiencyMultiplier (no system reads
   * them yet — the Dao/technique-efficiency consumers land later, per
   * DESIGN.md 'Comprehension allows faster Dao progress, better technique
   * efficiency, reduced breakthrough requirements'), and player.comprehension
   * (the display name). An unknown id (not in the ladder), an empty ladder or
   * a non-string id returns null and mutates nothing. Emits NO events.
   *
   * @param {string} comprehensionId — the comprehension id to apply
   *        (e.g. 'insightful').
   * @returns {{ id: string, name: string, daoProgressMultiplier: number,
   *            techniqueEfficiencyMultiplier: number,
   *            breakthroughEfficiencyMultiplier: number }|null} the applied
   *            comprehension identity, or null when the id is not in the
   *            ladder.
   */
  setComprehension(comprehensionId) {
    this._ensureSlices();
    if (typeof comprehensionId !== 'string' || comprehensionId === '') return null;

    const definition = this._byId.get(comprehensionId);
    if (!definition) return null;

    this._state.comprehension = {
      id: definition.id,
      name: definition.name,
      daoProgressMultiplier: definition.daoProgressMultiplier,
      techniqueEfficiencyMultiplier: definition.techniqueEfficiencyMultiplier,
      breakthroughEfficiencyMultiplier: definition.breakthroughEfficiencyMultiplier,
    };
    this._state.cultivation.comprehensionDaoProgressMultiplier =
      definition.daoProgressMultiplier;
    this._state.cultivation.comprehensionTechniqueEfficiencyMultiplier =
      definition.techniqueEfficiencyMultiplier;
    this._state.cultivation.comprehensionBreakthroughEfficiencyMultiplier =
      definition.breakthroughEfficiencyMultiplier;
    this._state.player.comprehension = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      daoProgressMultiplier: definition.daoProgressMultiplier,
      techniqueEfficiencyMultiplier: definition.techniqueEfficiencyMultiplier,
      breakthroughEfficiencyMultiplier: definition.breakthroughEfficiencyMultiplier,
    };
  }

  /**
   * Read the comprehension ladder from the injected DataManager, snapshotting
   * and coercing it ONCE into the canonical internal shape. Returns an empty
   * array when no DataManager was injected or it lacks getAll() — count 0, no
   * state writes, setComprehension() returns null. Hostile entries are skipped
   * defensively (a hostile lookalike must not poison the ladder): non-objects
   * and entries without a non-empty id; duplicate ids keep the FIRST
   * occurrence; file order is preserved. No throw, no fallback to hardcoded
   * defaults (the data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the coerced ladder (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('comprehension');
    if (!Array.isArray(raw)) return [];

    const ladder = [];
    const seen = new Set();
    for (const definition of raw) {
      if (
        definition === null ||
        typeof definition !== 'object' ||
        Array.isArray(definition)
      ) {
        continue;
      }
      const coerced = this._coerceDefinition(definition);
      if (!coerced) continue;
      if (seen.has(coerced.id)) continue; // dedup: first occurrence wins
      seen.add(coerced.id);
      ladder.push(coerced);
    }
    return ladder;
  }

  /**
   * Build the id lookup index over the coerced ladder. Every entry already
   * passed the id gate and the first-wins dedup, so the map is a total,
   * collision-free index over the snapshot.
   *
   * @returns {void}
   */
  _buildIndexes() {
    for (const definition of this._definitions) {
      this._byId.set(definition.id, definition);
    }
  }

  /**
   * Coerce a cached comprehension definition into the canonical internal shape
   * (fresh object — never the deep-frozen cache). Returns null (skipped) when
   * the definition is unusable: not a plain object or no non-empty id.
   * Surviving entries coerce every field defensively: name falls back to id
   * and each multiplier to the neutral 1 when not a finite number > 0 — an
   * unusable factor can never poison the cultivation slots.
   *
   * @param {object} definition — a cached (frozen) comprehension definition.
   * @returns {object|null} the coerced entry, or null (skipped).
   */
  _coerceDefinition(definition) {
    if (typeof definition.id !== 'string' || definition.id === '') return null;

    return {
      id: definition.id,
      name:
        typeof definition.name === 'string' && definition.name !== ''
          ? definition.name
          : definition.id,
      daoProgressMultiplier: _coerceMultiplier(definition.daoProgressMultiplier),
      techniqueEfficiencyMultiplier: _coerceMultiplier(
        definition.techniqueEfficiencyMultiplier
      ),
      breakthroughEfficiencyMultiplier: _coerceMultiplier(
        definition.breakthroughEfficiencyMultiplier
      ),
    };
  }

  /**
   * Write the three cultivation multiplier slots from the current
   * comprehension's factors (coerced, neutral 1 when not a finite number > 0)
   * — the constructor sync that keeps a restored save's multipliers in the
   * slots before the first tick. A hostile restored value can never reach the
   * slots: the coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultipliers() {
    this._state.cultivation.comprehensionDaoProgressMultiplier = _coerceMultiplier(
      this._state.comprehension.daoProgressMultiplier
    );
    this._state.cultivation.comprehensionTechniqueEfficiencyMultiplier =
      _coerceMultiplier(this._state.comprehension.techniqueEfficiencyMultiplier);
    this._state.cultivation.comprehensionBreakthroughEfficiencyMultiplier =
      _coerceMultiplier(this._state.comprehension.breakthroughEfficiencyMultiplier);
  }

  /**
   * Make sure the comprehension, cultivation and player slices are plain
   * objects before any read/write against them. A malformed slice restored
   * from an attacker-shaped save (null, a primitive or an array) is replaced
   * with the canonical fresh slice — restore-trust: a broken top-level slice
   * must never abort boot or throw per call (player is included because
   * setComprehension() writes player.comprehension). A healthy restored slice
   * (even one with extra or missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('comprehension', _freshComprehensionSlice);
    this._ensureSlice('cultivation', _freshCultivationSlice);
    this._ensureSlice('player', _freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state
   *        (e.g. 'comprehension').
   * @param {() => object} fallback — factory returning the canonical fresh slice.
   * @returns {object} the (possibly repaired) slice.
   */
  _ensureSlice(name, fallback) {
    const current = this._state[name];
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      this._state[name] = fallback();
    }
    return this._state[name];
  }
}

/**
 * The canonical fresh comprehension slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored comprehension slice is
 * unusable (null, a primitive or an array) — the standard state (all 1.0×
 * multipliers).
 *
 * @returns {{ id: string, name: string, daoProgressMultiplier: number,
 *            techniqueEfficiencyMultiplier: number,
 *            breakthroughEfficiencyMultiplier: number }} the canonical
 *            comprehension slice.
 */
function _freshComprehensionSlice() {
  return {
    id: 'standard',
    name: 'Standard',
    daoProgressMultiplier: 1.0,
    techniqueEfficiencyMultiplier: 1.0,
    breakthroughEfficiencyMultiplier: 1.0,
  };
}

/**
 * The canonical fresh cultivation slice (mirrors core/game-state.js exactly,
 * INCLUDING talentLearningSpeedMultiplier: 1, comprehensionDaoProgressMultiplier:
 * 1, comprehensionTechniqueEfficiencyMultiplier: 1 and
 * comprehensionBreakthroughEfficiencyMultiplier: 1). Used as the restore-trust
 * fallback when a restored cultivation slice is unusable (null, a primitive or
 * an array) — a broken top-level slice must never abort boot or throw per call.
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
    spiritRootMultiplier: 1,
    meridianCapacityMultiplier: 1,
    meridianFlowMultiplier: 1,
    physiqueBreakthroughBonus: 0,
    dantianCapacityMultiplier: 1,
    dantianDensityMultiplier: 1,
    dantianPurityMultiplier: 1,
    dantianEfficiencyMultiplier: 1,
    bloodlineSpeedMultiplier: 1,
    bloodlineQiMaxMultiplier: 1,
    soulStabilityMultiplier: 1,
    soulPurityMultiplier: 1,
    soulWillpowerMultiplier: 1,
    soulComprehensionMultiplier: 1,
    talentLearningSpeedMultiplier: 1,
    comprehensionDaoProgressMultiplier: 1,
    comprehensionTechniqueEfficiencyMultiplier: 1,
    comprehensionBreakthroughEfficiencyMultiplier: 1,
    qi: 0,
    qiMax: 100,
    qiPerSecond: 0,
    qiSources: { meditation: 0, upgrades: 0, techniques: 0 },
    breakthroughs: 0,
  };
}

/**
 * The canonical fresh player slice (mirrors core/game-state.js). Used as the
 * restore-trust fallback when a restored player slice is unusable —
 * setComprehension() writes player.comprehension, so a broken player slice
 * must never throw there.
 *
 * @returns {object} the canonical player slice.
 */
function _freshPlayerSlice() {
  return {
    name: 'Unnamed Cultivator',
    title: '',
    spiritRoot: 'Unawakened',
    physique: 'Ordinary Body',
    bloodline: 'Ancient Human',
    soul: 'Stable Soul',
    talent: 'Ordinary',
    comprehension: 'Standard',
    meridians: 'Normal',
    dantian: 'Normal Dantian',
  };
}

/**
 * Coerce a multiplier value: a finite number > 0 is kept, anything unusable
 * (NaN, Infinity, negative, 0) reads as the neutral 1 — a hostile value can
 * never zero a cap or push Infinity.
 *
 * @param {*} value — raw multiplier from the definition or state.
 * @returns {number} the multiplier value (> 0).
 */
function _coerceMultiplier(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
