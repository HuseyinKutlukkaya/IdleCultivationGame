/**
 * systems/spirit-roots.js — SpiritRootSystem (single owner of the
 * cultivator's spirit root and its cultivation-speed slot).
 *
 * The Phase-3 spirit root system (DESIGN.md 'Spirit Roots' — the primary
 * cultivation affinity that determines cultivation speed, elemental
 * affinity, future techniques, sect and Dao compatibility; DESIGN.md
 * 'Cultivation Speed' — "affected by: Spirit Root…"; DESIGN.md
 * 'Interactions' — "Spirit Root affects cultivation"). The spirit root is
 * rolled during Character Generation (DESIGN.md 'Character Generation'
 * step 4 — the Spirit Root Roll). No character-gen flow exists yet, so
 * roll() is exposed for the future flow, the developer console and tests.
 * The system is the ONLY writer of the three spirit-root locations:
 * state.spiritRoot (the canonical root shape), the cultivation-speed slot
 * cultivation.spiritRootMultiplier (which the QiSystem stacks into the
 * per-second rate aggregate) and player.spiritRoot (the UI display name).
 *
 * Data-driven content: the ladder (id, name, tier, description, elements,
 * attributes, speedMultiplier, weight) comes from
 * dataManager.getAll('spirit-roots') (data/spirit-roots/spirit-roots.json
 * via data/manifest.json — one entry per tier, file order is the ladder
 * order, canonical ids are the ten DESIGN.md types no-root … chaos). The
 * fresh-game 'unawakened' state is deliberately NOT in the table (it lives
 * in game-state at multiplier 1 — a pre-roll placeholder). A MISSING
 * 'spirit-roots' collection degrades neutrally: count 0, no state writes
 * and roll() rejects 'no-definitions'. Definitions are snapshotted and
 * coerced ONCE at construction (a deep-frozen DataManager cache can never
 * be trusted to be well-formed): non-object entries, entries without a
 * usable id and entries whose weight is not a finite number > 0 are
 * skipped; duplicate ids keep the first occurrence; every kept entry is
 * coerced to the canonical internal shape (name falls back to id, tier to
 * 0, elements to a fresh array of strings, each attribute to a finite
 * value clamped into 0..1 and speedMultiplier to the neutral 1 when not a
 * finite number > 0 — an unusable factor can never poison the slot).
 *
 * roll() is the Spirit Root Roll: a weighted draw over the ladder (total
 * weight = sum of weights; roll = random() × total; walk cumulative, a
 * larger weight = a wider bucket). A hostile random source (NaN, negative,
 * > 1) must still select a valid entry: non-finite/negative reads are
 * coerced to 1 (the roll lands exactly on the total → the walk falls
 * through to the LAST entry) and a > 1 read rolls past the total to the
 * same fall-through — the same tail discipline as the tribulations
 * _rollOutcome walk. On success the system writes ALL THREE owned
 * locations: state.spiritRoot is REPLACED with the canonical root object
 * (elements copied fresh), cultivation.spiritRootMultiplier = the rolled
 * speedMultiplier and player.spiritRoot = the rolled name. An empty
 * ladder returns { outcome: null, reason: 'no-definitions' } and mutates
 * nothing. roll() emits NO events — PLANS.md defines no spirit-root event
 * and there is no consumer (the system holds the injected bus for the
 * future event contract only).
 *
 * State owned (writes): state.spiritRoot (the full canonical shape),
 * cultivation.spiritRootMultiplier (the speed slot) and
 * player.spiritRoot (the display name). All are part of the canonical
 * GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the spiritRoot, cultivation and
 * player slices are repaired to the canonical fresh shapes when unusable
 * (null, a primitive or an array) before ANY read or write — a broken
 * slice must never abort boot or throw per call. A hostile restored
 * speedMultiplier (NaN, Infinity, negative, <= 0) is coerced to the
 * neutral 1 on read and can never reach the cultivation slot; the
 * constructor syncs cultivation.spiritRootMultiplier from the current
 * state.spiritRoot.speedMultiplier immediately (same reasoning as the
 * QiSystem's constructor sync: a restored save shows the right multiplier
 * before the first tick), so a restored root lands its factor in the slot
 * and the fresh unawakened shape keeps the slot at 1 — restored saves
 * stay numerically identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager and random source. It has NO 'loop:update'
 * subscription and nothing to tear down — the spirit root only changes
 * through roll(), so no destroy() is needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls roll() as step 4 (physique/bloodline rolls follow), elemental
 * affinity consumers read state.spiritRoot.elements, and sect/Dao
 * compatibility reads the five attributes — all data-driven, no code
 * changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, coerceMultiplier, freshCultivationSlice, freshPlayerSlice } from '../core/game-state.js';

/** The five canonical DESIGN.md spirit-root attribute keys. */
const ATTRIBUTE_KEYS = ['purity', 'stability', 'growth', 'mutation', 'compatibility'];

export class SpiritRootSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as QiSystem, RealmSystem,
   *        TribulationSystem, BreakthroughSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no spirit-root event), so the reference is
   *        reserved, never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the spirit root
   *        ladder from the 'spirit-roots' collection. When absent the ladder
   *        is empty — count 0, no state writes, roll() rejects
   *        'no-definitions'. Content is never hardcoded.
   * @param {() => number} [options.random] — uniform [0,1) source for the
   *        weighted roll; defaults to Math.random (injectable for
   *        deterministic tests).
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('spirit-roots' collection). */
    this._dataManager = options.dataManager || null;
    /** @type {() => number} uniform [0,1) source for the weighted roll. */
    this._random = typeof options.random === 'function' ? options.random : Math.random;

    // Restore-trust: a malformed spiritRoot/cultivation/player slice (null,
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

    // Constructor sync: write the cultivation-speed slot from the current
    // spirit root's speedMultiplier (coerced, neutral 1 when unusable) so a
    // restored save shows the right multiplier before the first tick — same
    // reasoning as the QiSystem's constructor sync. The fresh unawakened
    // shape reads 1, so restored saves stay numerically identical to today.
    this._syncMultiplier();
  }

  /**
   * @returns {number} the number of spirit root definitions (0 when the
   *          'spirit-roots' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the spirit root id (e.g. 'single-element').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id ('unawakened' — the fresh
   *          pre-roll state — never matches). The copy is deep enough that
   *          mutating its elements array can never leak into the internal
   *          ladder (the array is copied, not shared).
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition, elements: [...definition.elements] };
  }

  /**
   * Read-only snapshot of the CURRENT spirit root — never mutates state.
   * Every field is coerced defensively to the canonical shape (the fresh
   * unawakened defaults when the restored slice lacks a usable value), so a
   * hostile save can never yield a malformed/partial object and the read
   * never throws. The returned object is a fresh copy — mutating it (or its
   * elements array) never leaks into the system or the state.
   *
   * @returns {{ id: string, name: string, tier: number, elements: string[],
   *            purity: number, stability: number, growth: number,
   *            mutation: number, compatibility: number,
   *            speedMultiplier: number }} the current root.
   */
  current() {
    this._ensureSlices();
    const root = this._state.spiritRoot;
    return {
      id:
        typeof root.id === 'string' && root.id !== '' ? root.id : 'unawakened',
      name:
        typeof root.name === 'string' && root.name !== '' ? root.name : 'Unawakened',
      tier: _coerceTier(root.tier),
      elements: _coerceElements(root.elements),
      purity: _coerceAttribute(root.purity),
      stability: _coerceAttribute(root.stability),
      growth: _coerceAttribute(root.growth),
      mutation: _coerceAttribute(root.mutation),
      compatibility: _coerceAttribute(root.compatibility),
      speedMultiplier: coerceMultiplier(root.speedMultiplier),
    };
  }

  /**
   * The Spirit Root Roll (DESIGN.md Character Generation step 4). Weighted
   * draw over the ladder via the injected random source: roll = random() ×
   * totalWeight, walked cumulatively against the per-entry weights (a larger
   * weight = a wider bucket). A hostile random source (NaN, negative, > 1)
   * must still select a valid entry — a non-finite/negative read is coerced
   * to 1 (the roll lands exactly on the total → the walk falls through to
   * the LAST entry) and a > 1 read rolls past the total to the same
   * fall-through, mirroring the tribulations _rollOutcome tail discipline.
   *
   * On success writes ALL three owned locations: state.spiritRoot is
   * REPLACED with the canonical root object (elements copied fresh),
   * cultivation.spiritRootMultiplier = the rolled speedMultiplier and
   * player.spiritRoot = the rolled name. Emits NO events (PLANS.md defines
   * no spirit-root event and there is no consumer). An empty ladder returns
   * { outcome: null, reason: 'no-definitions' } and mutates nothing.
   *
   * @returns {{ id: string, name: string, tier: number, speedMultiplier: number }|
   *            { outcome: null, reason: 'no-definitions' }} the rolled root's
   *            identity (or the empty-ladder rejection).
   */
  roll() {
    this._ensureSlices();
    if (this._definitions.length === 0) {
      return { outcome: null, reason: 'no-definitions' };
    }

    const totalWeight = this._definitions.reduce(
      (sum, definition) => sum + definition.weight,
      0
    );
    const raw = this._random();
    const roll = (Number.isFinite(raw) && raw >= 0 ? raw : 1) * totalWeight;

    let cumulative = 0;
    let selected = this._definitions[this._definitions.length - 1];
    for (const definition of this._definitions) {
      cumulative += definition.weight;
      if (roll < cumulative) {
        selected = definition;
        break;
      }
    }

    this._state.spiritRoot = {
      id: selected.id,
      name: selected.name,
      tier: selected.tier,
      elements: [...selected.elements],
      purity: selected.purity,
      stability: selected.stability,
      growth: selected.growth,
      mutation: selected.mutation,
      compatibility: selected.compatibility,
      speedMultiplier: selected.speedMultiplier,
    };
    this._state.cultivation.spiritRootMultiplier = selected.speedMultiplier;
    this._state.player.spiritRoot = selected.name;

    return {
      id: selected.id,
      name: selected.name,
      tier: selected.tier,
      speedMultiplier: selected.speedMultiplier,
    };
  }

  /**
   * Read the spirit root ladder from the injected DataManager, snapshotting
   * and coercing it ONCE into the canonical internal shape. Returns an empty
   * array when no DataManager was injected or it lacks getAll() — count 0,
   * no state writes, roll() rejects 'no-definitions'. Hostile entries are
   * skipped defensively (a hostile lookalike must not poison the ladder):
   * non-objects, entries without a non-empty id and entries whose weight is
   * not a finite number > 0; duplicate ids keep the FIRST occurrence; file
   * order is preserved. No throw, no fallback to hardcoded defaults (the
   * data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the coerced ladder (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('spirit-roots');
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
   * passed the id/weight gate and the first-wins dedup, so the map is a
   * total, collision-free index over the snapshot.
   *
   * @returns {void}
   */
  _buildIndexes() {
    for (const definition of this._definitions) {
      this._byId.set(definition.id, definition);
    }
  }

  /**
   * Coerce a cached spirit root definition into the canonical internal shape
   * (fresh object — never the deep-frozen cache). Returns null (skipped)
   * when the definition is unusable for the roll: not a plain object, no
   * non-empty id, or a weight that is not a finite number > 0 (a broken
   * bucket would corrupt the cumulative walk). Surviving entries coerce
   * every other field defensively: name falls back to id, tier to 0,
   * elements to a fresh array of strings, each attribute to a finite value
   * clamped into 0..1 (neutral 0 when unusable) and speedMultiplier to the
   * neutral 1 when not a finite number > 0 — an unusable factor can never
   * poison the cultivation slot.
   *
   * @param {object} definition — a cached (frozen) spirit root definition.
   * @returns {object|null} the coerced entry, or null (skipped).
   */
  _coerceDefinition(definition) {
    if (typeof definition.id !== 'string' || definition.id === '') return null;
    const weight = _asNumber(definition.weight);
    if (weight <= 0) return null;

    const attributes = definition.attributes;
    const attributeSource =
      attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)
        ? attributes
        : {};
    const coercedAttributes = {};
    for (const key of ATTRIBUTE_KEYS) {
      coercedAttributes[key] = _coerceAttribute(attributeSource[key]);
    }

    return {
      id: definition.id,
      name:
        typeof definition.name === 'string' && definition.name !== ''
          ? definition.name
          : definition.id,
      tier: _coerceTier(definition.tier),
      elements: _coerceElements(definition.elements),
      purity: coercedAttributes.purity,
      stability: coercedAttributes.stability,
      growth: coercedAttributes.growth,
      mutation: coercedAttributes.mutation,
      compatibility: coercedAttributes.compatibility,
      speedMultiplier: coerceMultiplier(definition.speedMultiplier),
      weight,
    };
  }

  /**
   * Write the cultivation-speed slot from the current spirit root's
   * speedMultiplier (coerced, neutral 1 when not a finite number > 0) — the
   * constructor sync that keeps a restored save's multiplier in the slot
   * before the first tick. A hostile restored value can never reach the
   * slot: the coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultiplier() {
    this._state.cultivation.spiritRootMultiplier = coerceMultiplier(
      this._state.spiritRoot.speedMultiplier
    );
  }

  /**
   * Make sure the spiritRoot, cultivation and player slices are plain
   * objects before any read/write against them. A malformed slice restored
   * from an attacker-shaped save (null, a primitive or an array) is replaced
   * with the canonical fresh slice — restore-trust: a broken top-level slice
   * must never abort boot or throw per call (player is included because
   * roll() writes player.spiritRoot). A healthy restored slice (even one
   * with extra or missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('spiritRoot', _freshSpiritRootSlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
    this._ensureSlice('player', freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'spiritRoot').
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
 * The canonical fresh spirit root slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored spiritRoot slice is unusable
 * (null, a primitive or an array) — the unawakened pre-roll state (tier -1
 * below the data ladder, no elements, neutral 1 cultivation speed).
 *
 * @returns {{ id: string, name: string, tier: number, elements: string[],
 *            purity: number, stability: number, growth: number,
 *            mutation: number, compatibility: number,
 *            speedMultiplier: number }} the canonical spirit root slice.
 */
function _freshSpiritRootSlice() {
  return {
    id: 'unawakened',
    name: 'Unawakened',
    tier: -1,
    elements: [],
    purity: 0,
    stability: 0,
    growth: 0,
    mutation: 0,
    compatibility: 0,
    speedMultiplier: 1,
  };
}

/**
 * Coerce a spirit root tier: a finite number is kept, anything unusable
 * reads as 0 (the worst ladder tier — neutral, never a poison).
 *
 * @param {*} value — raw tier from the definition or state.
 * @returns {number} the tier value (finite).
 */
function _coerceTier(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Coerce an elements list: an array yields a fresh array of its string
 * members (non-strings dropped); anything else reads as an empty array.
 *
 * @param {*} value — raw elements from the definition or state.
 * @returns {string[]} the coerced elements (fresh copy).
 */
function _coerceElements(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((element) => typeof element === 'string');
}

/**
 * Coerce one of the five canonical spirit-root attributes (purity, stability,
 * growth, mutation, compatibility): a finite value clamps into 0..1 (a
 * hostile out-of-range value can never exceed the canonical range); anything
 * unusable reads as the neutral 0.
 *
 * @param {*} value — raw attribute from the definition or state.
 * @returns {number} the attribute value (0..1).
 */
function _coerceAttribute(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no effect" value — never a tuning number).
 *
 * @param {*} value — raw number-ish value.
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
