/**
 * systems/physiques.js — PhysiqueSystem (single owner of the cultivator's
 * physique state and its multiplier slots).
 *
 * The Phase-3 physique system (DESIGN.md 'Physiques' — data-driven body quality
 * affecting breakthrough success, lifespan, health and power; DESIGN.md
 * 'Interactions' — "Physique affects breakthrough success"). The physique
 * state is set through external means (the future character-gen flow, the
 * developer console and tests). No character-gen roll exists yet, so
 * setPhysique() is exposed for the future flow, the developer console and
 * tests. The system is the ONLY writer of four physique locations:
 * state.physiques (the canonical physique shape), the cultivation slot
 * cultivation.physiqueBreakthroughBonus (which the BreakthroughSystem stacks
 * into the outcome roll) and player.physique (the UI display name).
 *
 * Data-driven content: the ladder (id, name, description, breakthroughBonus,
 * lifespanMultiplier, healthMultiplier, powerMultiplier) comes from
 * dataManager.getAll('physiques') (data/physiques/physiques.json via
 * data/manifest.json — one entry per state, file order is the ladder
 * Ordinary → Chaos). The fresh-game 'ordinary' state is the canonical
 * default (1.0× multipliers, zero bonus). A MISSING 'physiques' collection
 * degrades neutrally: count 0, no state writes and setPhysique() returns
 * null. Definitions are snapshotted and coerced ONCE at construction (a
 * deep-frozen DataManager cache can never be trusted to be well-formed):
 * non-object entries and entries without a usable id are skipped; duplicate
 * ids keep the first occurrence; every kept entry is coerced to the canonical
 * internal shape (name falls back to id, each multiplier to the neutral 1
 * when not a finite number > 0, breakthroughBonus to 0 when not a finite
 * number >= 0 — an unusable factor can never poison the slot).
 *
 * setPhysique(physiqueId) applies the physique from the data ladder: it looks
 * up the id in the coerced snapshot and, when found, writes ALL owned
 * locations (state.physiques, cultivation.physiqueBreakthroughBonus and
 * player.physique). An unknown id or an empty ladder returns null and
 * mutates nothing. Emits NO events — PLANS.md defines no physique event and
 * there is no consumer (the system holds the injected bus for the future
 * event contract only).
 *
 * State owned (writes): state.physiques (the full canonical shape),
 * cultivation.physiqueBreakthroughBonus (the breakthrough-success slot) and
 * player.physique (the display name). All are part of the canonical
 * GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the physiques, cultivation and
 * player slices are repaired to the canonical fresh shapes when unusable
 * (null, a primitive or an array) before ANY read or write — a broken
 * slice must never abort boot or throw per call. A hostile restored
 * multiplier (NaN, Infinity, negative, <= 0) is coerced to the neutral 1
 * on read and a hostile breakthroughBonus (NaN, Infinity, negative) to 0;
 * the constructor syncs cultivation.physiqueBreakthroughBonus and
 * player.physique from the current state.physiques immediately (same
 * reasoning as the MeridianSystem's constructor sync: a restored save shows
 * the right multiplier before the first tick), so a restored physique lands
 * its factors in the slots and the fresh ordinary shape keeps the slots at
 * neutral — restored saves stay numerically identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing
 * to tear down — the physique only changes through setPhysique(), so no
 * destroy() is needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setPhysique() as a step after the Spirit Root Roll, the
 * lifespanMultiplier feeds future aging mechanics, healthMultiplier feeds
 * combat, powerMultiplier feeds a global-power slot. All data-driven, no
 * code changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, coerceMultiplier, freshCultivationSlice, freshPlayerSlice } from '../core/game-state.js';

export class PhysiqueSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, MeridianSystem,
   *        QiSystem, RealmSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no physique event), so the reference is
   *        reserved, never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the physique
   *        ladder from the 'physiques' collection. When absent the ladder
   *        is empty — count 0, no state writes, setPhysique() returns null.
   *        Content is never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('physiques' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed physiques/cultivation/player slice (null,
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

    // Constructor sync: write the breakthrough-bonus slot and the display
    // name from the current physique's factors (coerced, neutral defaults
    // when unusable) so a restored save shows the right bonus before the
    // first tick — same reasoning as the MeridianSystem's constructor sync.
    // The fresh ordinary shape reads 0 bonus, 1.0× multipliers, so restored
    // saves stay numerically identical.
    this._syncSlots();
  }

  /**
   * @returns {number} the number of physique definitions (0 when the
   *          'physiques' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the physique id (e.g. 'iron-body').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT physique — never mutates state.
   * Every field is coerced defensively to the canonical shape (the fresh
   * ordinary defaults when the restored slice lacks a usable value), so a
   * hostile save can never yield a malformed/partial object and the read
   * never throws. The returned object is a fresh copy — mutating it never
   * leaks into the system or the state.
   *
   * @returns {{ id: string, name: string, breakthroughBonus: number,
   *            lifespanMultiplier: number, healthMultiplier: number,
   *            powerMultiplier: number }} the current physique.
   */
  getCurrent() {
    this._ensureSlices();
    const physique = this._state.physiques;
    return {
      id:
        typeof physique.id === 'string' && physique.id !== ''
          ? physique.id
          : 'ordinary',
      name:
        typeof physique.name === 'string' && physique.name !== ''
          ? physique.name
          : 'Ordinary Body',
      breakthroughBonus: _coerceBonus(physique.breakthroughBonus),
      lifespanMultiplier: coerceMultiplier(physique.lifespanMultiplier),
      healthMultiplier: coerceMultiplier(physique.healthMultiplier),
      powerMultiplier: coerceMultiplier(physique.powerMultiplier),
    };
  }

  /**
   * Apply a physique state by id from the data ladder. Looks up the id in
   * the coerced snapshot and, when found, writes ALL owned locations:
   * state.physiques (the full canonical shape, with the multipliers from
   * the definition), cultivation.physiqueBreakthroughBonus and
   * player.physique (the display name). An unknown id (not in the ladder),
   * an empty ladder or a non-string id returns null and mutates nothing.
   * Emits NO events.
   *
   * @param {string} physiqueId — the physique id to apply (e.g. 'iron-body').
   * @returns {{ id: string, name: string, breakthroughBonus: number,
   *            lifespanMultiplier: number, healthMultiplier: number,
   *            powerMultiplier: number }|null} the applied physique identity,
   *            or null when the id is not in the ladder.
   */
  setPhysique(physiqueId) {
    this._ensureSlices();
    if (typeof physiqueId !== 'string' || physiqueId === '') return null;

    const definition = this._byId.get(physiqueId);
    if (!definition) return null;

    this._state.physiques = {
      id: definition.id,
      name: definition.name,
      breakthroughBonus: definition.breakthroughBonus,
      lifespanMultiplier: definition.lifespanMultiplier,
      healthMultiplier: definition.healthMultiplier,
      powerMultiplier: definition.powerMultiplier,
    };
    this._state.cultivation.physiqueBreakthroughBonus = definition.breakthroughBonus;
    this._state.player.physique = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      breakthroughBonus: definition.breakthroughBonus,
      lifespanMultiplier: definition.lifespanMultiplier,
      healthMultiplier: definition.healthMultiplier,
      powerMultiplier: definition.powerMultiplier,
    };
  }

  /**
   * Read the physique ladder from the injected DataManager, snapshotting
   * and coercing it ONCE into the canonical internal shape. Returns an empty
   * array when no DataManager was injected or it lacks getAll() — count 0,
   * no state writes, setPhysique() returns null. Hostile entries are
   * skipped defensively (a hostile lookalike must not poison the ladder):
   * non-objects and entries without a non-empty id; duplicate ids keep the
   * FIRST occurrence; file order is preserved. No throw, no fallback to
   * hardcoded defaults (the data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the coerced ladder (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('physiques');
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
   * passed the id gate and the first-wins dedup, so the map is a
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
   * Coerce a cached physique definition into the canonical internal shape
   * (fresh object — never the deep-frozen cache). Returns null (skipped)
   * when the definition is unusable: not a plain object or no non-empty id.
   * Surviving entries coerce every field defensively: name falls back to id,
   * each multiplier to the neutral 1 when not a finite number > 0, and
   * breakthroughBonus to 0 when not a finite number >= 0 — an unusable
   * factor can never poison the slots.
   *
   * @param {object} definition — a cached (frozen) physique definition.
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
      breakthroughBonus: _coerceBonus(definition.breakthroughBonus),
      lifespanMultiplier: coerceMultiplier(definition.lifespanMultiplier),
      healthMultiplier: coerceMultiplier(definition.healthMultiplier),
      powerMultiplier: coerceMultiplier(definition.powerMultiplier),
    };
  }

  /**
   * Write the breakthrough-bonus slot and the display name from the current
   * physique's factors (coerced, neutral defaults when not finite) — the
   * constructor sync that keeps a restored save's bonus in the slot before
   * the first tick. A hostile restored value can never reach the slots: the
   * coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncSlots() {
    this._state.cultivation.physiqueBreakthroughBonus = _coerceBonus(
      this._state.physiques.breakthroughBonus
    );
    this._state.player.physique =
      typeof this._state.physiques.name === 'string' &&
      this._state.physiques.name !== ''
        ? this._state.physiques.name
        : 'Ordinary Body';
  }

  /**
   * Make sure the physiques, cultivation and player slices are plain
   * objects before any read/write against them. A malformed slice restored
   * from an attacker-shaped save (null, a primitive or an array) is replaced
   * with the canonical fresh slice — restore-trust: a broken top-level slice
   * must never abort boot or throw per call (player is included because
   * setPhysique() writes player.physique). A healthy restored slice (even one
   * with extra or missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('physiques', _freshPhysiquesSlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
    this._ensureSlice('player', freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'physiques').
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
 * The canonical fresh physiques slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored physiques slice is unusable
 * (null, a primitive or an array) — the ordinary state (1.0× multipliers,
 * zero breakthrough bonus).
 *
 * @returns {{ id: string, name: string, breakthroughBonus: number,
 *            lifespanMultiplier: number, healthMultiplier: number,
 *            powerMultiplier: number }} the canonical physiques slice.
 */
function _freshPhysiquesSlice() {
  return {
    id: 'ordinary',
    name: 'Ordinary Body',
    breakthroughBonus: 0,
    lifespanMultiplier: 1,
    healthMultiplier: 1,
    powerMultiplier: 1,
  };
}

/**
 * Coerce a breakthough-bonus value: a finite number >= 0 is kept, anything
 * unusable (NaN, Infinity, negative) reads as the neutral 0 — a hostile
 * value can never shift the success weight beyond the data contract.
 *
 * @param {*} value — raw breakthroughBonus from the definition or state.
 * @returns {number} the bonus value (>= 0).
 */
function _coerceBonus(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
