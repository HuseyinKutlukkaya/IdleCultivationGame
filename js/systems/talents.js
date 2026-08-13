/**
 * systems/talents.js — TalentSystem (single owner of the cultivator's talent
 * state and its learning-speed cultivation slot).
 *
 * The Phase-3 talent system (DESIGN.md 'Talent' — global learning speed: it
 * influences techniques, alchemy, formation mastery, artifact crafting and Dao
 * comprehension). The talent state is set through external means (the future
 * character-gen flow, the developer console and tests). No character-gen roll
 * exists yet, so setTalent() is exposed for the future flow, the developer
 * console and tests. The system is the ONLY writer of the talent locations:
 * state.talents (the canonical talent shape), the FUTURE-CONSUMER cultivation
 * slot cultivation.talentLearningSpeedMultiplier (no system reads it yet —
 * DESIGN.md 'Talent affects learning'; the technique/alchemy/formation/Dao
 * consumers land later, same precedent as the soul slots, which are written
 * today and read by no system yet), and player.talent (the UI display name).
 *
 * Data-driven content: the ladder (id, name, description,
 * learningSpeedMultiplier) comes from dataManager.getAll('talents')
 * (data/talents/talents.json via data/manifest.json — one entry per state,
 * file order is the ladder Dull → Prodigy). The fresh-game 'ordinary' state is
 * the canonical default (all 1.0× multipliers). A MISSING 'talents' collection
 * degrades neutrally: count 0, no state writes and setTalent() returns null.
 * Definitions are snapshotted and coerced ONCE at construction (a deep-frozen
 * DataManager cache can never be trusted to be well-formed): non-object
 * entries and entries without a usable id are skipped; duplicate ids keep the
 * first occurrence; every kept entry is coerced to the canonical internal
 * shape (name falls back to id, the multiplier to the neutral 1 when not a
 * finite number > 0 — an unusable factor can never poison the slot).
 *
 * setTalent(talentId) applies the talent from the data ladder: it looks up the
 * id in the coerced snapshot and, when found, writes ALL owned locations
 * (state.talents, cultivation.talentLearningSpeedMultiplier and player.talent).
 * An unknown id or an empty ladder returns null and mutates nothing. Emits NO
 * events — PLANS.md defines no talent event and there is no consumer (the
 * system holds the injected bus for the future event contract only).
 *
 * State owned (writes): state.talents (the full canonical shape), the
 * future-consumer cultivation slot (which the future technique/alchemy/Dao
 * learning systems will read) and player.talent (the display name). All are
 * part of the canonical GameState (see core/game-state.js). qi.js,
 * techniques.js and breakthroughs.js are deliberately NOT touched — the talent
 * slot has no consumer today.
 *
 * Restore-trust (attacker-shaped saves): the talents, cultivation and player
 * slices are repaired to the canonical fresh shapes when unusable (null, a
 * primitive or an array) before ANY read or write — a broken slice must never
 * abort boot or throw per call. A hostile restored multiplier (NaN, Infinity,
 * negative, <= 0) is coerced to the neutral 1 on read and can never reach the
 * cultivation slot; the constructor syncs the cultivation slot from the
 * current state.talents immediately (same reasoning as the SoulSystem's
 * constructor sync: a restored save shows the right multiplier before the
 * first tick), so a restored talent lands its factor in the slot and the fresh
 * ordinary shape keeps the slot at 1 — restored saves stay numerically
 * identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing to
 * tear down — the talent only changes through setTalent(), so no destroy() is
 * needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setTalent() as a step; the slot is written today for the future
 * learning consumers — when they land, the bonuses read the slot with no
 * further code. All data-driven, no code changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

export class TalentSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, MeridianSystem,
   *        PhysiqueSystem, DantianSystem, BloodlineSystem, SoulSystem,
   *        QiSystem, RealmSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no talent event), so the reference is reserved,
   *        never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the talent ladder
   *        from the 'talents' collection. When absent the ladder is empty —
   *        count 0, no state writes, setTalent() returns null. Content is
   *        never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('talents' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed talents/cultivation/player slice (null,
    // a primitive or an array) restored from an attacker-shaped save must
    // never abort boot — repair all three before any read/write below.
    this._ensureSlices();

    // Snapshot + coerce the ladder at construction time (file order =
    // ladder order). Cached definitions are deep-frozen by the DataManager
    // and can never be trusted to be well-formed, so every entry is coerced
    // into the canonical internal shape once; hostile entries are skipped.
    this._definitions = this._readDefinitions();

    /** @type {Map<string, object>} id → coerced definition (O(1) lookup). */
    this._byId = new Map();
    this._buildIndexes();

    // Constructor sync: write the cultivation multiplier slot from the
    // current talent's factor (coerced, neutral 1 when unusable) so a
    // restored save shows the right multiplier before the first tick —
    // same reasoning as the SoulSystem's constructor sync. The fresh
    // ordinary shape reads 1.0×, so restored saves stay numerically
    // identical.
    this._syncMultiplier();
  }

  /**
   * @returns {number} the number of talent definitions (0 when the 'talents'
   *          collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the talent id (e.g. 'gifted').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT talent — never mutates state. Every
   * field is coerced defensively to the canonical shape (the fresh ordinary
   * defaults when the restored slice lacks a usable value), so a hostile save
   * can never yield a malformed/partial object and the read never throws. The
   * returned object is a fresh copy — mutating it never leaks into the system
   * or the state.
   *
   * @returns {{ id: string, name: string, learningSpeedMultiplier: number }}
   *          the current talent.
   */
  getCurrent() {
    this._ensureSlices();
    const talent = this._state.talents;
    return {
      id: typeof talent.id === 'string' && talent.id !== '' ? talent.id : 'ordinary',
      name:
        typeof talent.name === 'string' && talent.name !== '' ? talent.name : 'Ordinary',
      learningSpeedMultiplier: _coerceMultiplier(talent.learningSpeedMultiplier),
    };
  }

  /**
   * Apply a talent by id from the data ladder. Looks up the id in the coerced
   * snapshot and, when found, writes ALL owned locations: state.talents (the
   * full canonical shape, with the multiplier from the definition), the
   * future-consumer cultivation slot
   * cultivation.talentLearningSpeedMultiplier (no system reads it yet — the
   * technique/alchemy/formation/Dao learning consumers land later, per
   * DESIGN.md 'Talent affects learning'), and player.talent (the display
   * name). An unknown id (not in the ladder), an empty ladder or a non-string
   * id returns null and mutates nothing. Emits NO events.
   *
   * @param {string} talentId — the talent id to apply (e.g. 'gifted').
   * @returns {{ id: string, name: string, learningSpeedMultiplier: number }|null}
   *          the applied talent identity, or null when the id is not in the
   *          ladder.
   */
  setTalent(talentId) {
    this._ensureSlices();
    if (typeof talentId !== 'string' || talentId === '') return null;

    const definition = this._byId.get(talentId);
    if (!definition) return null;

    this._state.talents = {
      id: definition.id,
      name: definition.name,
      learningSpeedMultiplier: definition.learningSpeedMultiplier,
    };
    this._state.cultivation.talentLearningSpeedMultiplier =
      definition.learningSpeedMultiplier;
    this._state.player.talent = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      learningSpeedMultiplier: definition.learningSpeedMultiplier,
    };
  }

  /**
   * Read the talent ladder from the injected DataManager, snapshotting and
   * coercing it ONCE into the canonical internal shape. Returns an empty array
   * when no DataManager was injected or it lacks getAll() — count 0, no state
   * writes, setTalent() returns null. Hostile entries are skipped defensively
   * (a hostile lookalike must not poison the ladder): non-objects and entries
   * without a non-empty id; duplicate ids keep the FIRST occurrence; file
   * order is preserved. No throw, no fallback to hardcoded defaults (the
   * data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the coerced ladder (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('talents');
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
   * Coerce a cached talent definition into the canonical internal shape (fresh
   * object — never the deep-frozen cache). Returns null (skipped) when the
   * definition is unusable: not a plain object or no non-empty id. Surviving
   * entries coerce every field defensively: name falls back to id and the
   * multiplier to the neutral 1 when not a finite number > 0 — an unusable
   * factor can never poison the cultivation slot.
   *
   * @param {object} definition — a cached (frozen) talent definition.
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
      learningSpeedMultiplier: _coerceMultiplier(definition.learningSpeedMultiplier),
    };
  }

  /**
   * Write the cultivation multiplier slot from the current talent's factor
   * (coerced, neutral 1 when not a finite number > 0) — the constructor sync
   * that keeps a restored save's multiplier in the slot before the first
   * tick. A hostile restored value can never reach the slot: the coercion
   * happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultiplier() {
    this._state.cultivation.talentLearningSpeedMultiplier = _coerceMultiplier(
      this._state.talents.learningSpeedMultiplier
    );
  }

  /**
   * Make sure the talents, cultivation and player slices are plain objects
   * before any read/write against them. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with the
   * canonical fresh slice — restore-trust: a broken top-level slice must never
   * abort boot or throw per call (player is included because setTalent()
   * writes player.talent). A healthy restored slice (even one with extra or
   * missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('talents', _freshTalentSlice);
    this._ensureSlice('cultivation', _freshCultivationSlice);
    this._ensureSlice('player', _freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'talents').
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
 * The canonical fresh talent slice (mirrors core/game-state.js). Used as the
 * restore-trust fallback when a restored talent slice is unusable (null, a
 * primitive or an array) — the ordinary state (1.0× multiplier).
 *
 * @returns {{ id: string, name: string, learningSpeedMultiplier: number }}
 *          the canonical talent slice.
 */
function _freshTalentSlice() {
  return {
    id: 'ordinary',
    name: 'Ordinary',
    learningSpeedMultiplier: 1.0,
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
 * setTalent() writes player.talent, so a broken player slice must never throw
 * there.
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
