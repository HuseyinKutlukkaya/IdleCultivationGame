/**
 * systems/meridians.js — MeridianSystem (single owner of the cultivator's
 * meridian state and its qi-circulation multiplier slots).
 *
 * The Phase-3 meridian system (DESIGN.md 'Meridians' — qi circulation
 * affecting capacity and flow rate; DESIGN.md 'Interactions' — "Meridians
 * affect circulation"). The meridian state is set by the future character-gen
 * flow or through external means (the developer console and tests). No
 * character-gen roll exists yet, so setState() is exposed for the future
 * flow, the developer console and tests. The system is the ONLY writer of
 * four meridian locations: state.meridians (the canonical meridian shape),
 * the two cultivation multiplier slots (cultivation.meridianCapacityMultiplier
 * and cultivation.meridianFlowMultiplier, which the QiSystem stacks into the
 * qi cap and per-second rate respectively) and player.meridians (the UI
 * display name).
 *
 * Data-driven content: the ladder (id, name, description, capacityMultiplier,
 * flowMultiplier) comes from dataManager.getAll('meridians')
 * (data/meridians/meridians.json via data/manifest.json — one entry per
 * state, file order is the ladder Broken → Heavenly). The fresh-game
 * 'normal' state is the canonical default (1.0×1.0). A MISSING 'meridians'
 * collection degrades neutrally: count 0, no state writes and setState()
 * returns null. Definitions are snapshotted and coerced ONCE at construction
 * (a deep-frozen DataManager cache can never be trusted to be well-formed):
 * non-object entries and entries without a usable id are skipped; duplicate
 * ids keep the first occurrence; every kept entry is coerced to the canonical
 * internal shape (name falls back to id, each multiplier to the neutral 1
 * when not a finite number > 0 — an unusable factor can never poison the
 * slot).
 *
 * setState(meridianId) applies the meridian from the data ladder: it looks
 * up the id in the coerced snapshot and, when found, writes ALL four owned
 * locations (state.meridians, cultivation.meridianCapacityMultiplier,
 * cultivation.meridianFlowMultiplier and player.meridians). An unknown id or
 * an empty ladder returns null and mutates nothing. Emits NO events —
 * PLANS.md defines no meridian event and there is no consumer (the system
 * holds the injected bus for the future event contract only).
 *
 * State owned (writes): state.meridians (the full canonical shape),
 * cultivation.meridianCapacityMultiplier (the qi-cap slot),
 * cultivation.meridianFlowMultiplier (the qi-rate slot) and
 * player.meridians (the display name). All are part of the canonical
 * GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the meridians, cultivation and
 * player slices are repaired to the canonical fresh shapes when unusable
 * (null, a primitive or an array) before ANY read or write — a broken
 * slice must never abort boot or throw per call. A hostile restored
 * multiplier (NaN, Infinity, negative, <= 0) is coerced to the neutral 1
 * on read and can never reach the cultivation slots; the constructor syncs
 * cultivation.meridianCapacityMultiplier and cultivation.meridianFlowMultiplier
 * from the current state.meridians immediately (same reasoning as the
 * QiSystem's constructor sync: a restored save shows the right multipliers
 * before the first tick), so a restored meridian lands its factors in the
 * slots and the fresh normal shape keeps the slots at 1 — restored saves
 * stay numerically identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing
 * to tear down — the meridian only changes through setState(), so no
 * destroy() is needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setState() as step 7 (after the Spirit Root Roll), `purityMultiplier`
 * and `mutations` (Twin Network, Spiral, Dragon, Phoenix, Void) are reserved
 * for later phases — no consumer yet. All data-driven, no code changes
 * required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, coerceMultiplier, freshCultivationSlice, freshPlayerSlice } from '../core/game-state.js';

export class MeridianSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, QiSystem,
   *        RealmSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no meridian event), so the reference is
   *        reserved, never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the meridian
   *        ladder from the 'meridians' collection. When absent the ladder
   *        is empty — count 0, no state writes, setState() returns null.
   *        Content is never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('meridians' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed meridians/cultivation/player slice (null,
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

    // Constructor sync: write the cultivation multiplier slots from the
    // current meridian's factors (coerced, neutral 1 when unusable) so a
    // restored save shows the right multipliers before the first tick —
    // same reasoning as the QiSystem's constructor sync. The fresh normal
    // shape reads 1.0×1.0, so restored saves stay numerically identical.
    this._syncMultipliers();
  }

  /**
   * @returns {number} the number of meridian definitions (0 when the
   *          'meridians' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the meridian id (e.g. 'golden').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT meridian — never mutates state.
   * Every field is coerced defensively to the canonical shape (the fresh
   * normal defaults when the restored slice lacks a usable value), so a
   * hostile save can never yield a malformed/partial object and the read
   * never throws. The returned object is a fresh copy — mutating it never
   * leaks into the system or the state.
   *
   * @returns {{ id: string, name: string, capacityMultiplier: number,
   *            flowMultiplier: number }} the current meridian.
   */
  getCurrent() {
    this._ensureSlices();
    const meridian = this._state.meridians;
    return {
      id:
        typeof meridian.id === 'string' && meridian.id !== ''
          ? meridian.id
          : 'normal',
      name:
        typeof meridian.name === 'string' && meridian.name !== ''
          ? meridian.name
          : 'Normal',
      capacityMultiplier: coerceMultiplier(meridian.capacityMultiplier),
      flowMultiplier: coerceMultiplier(meridian.flowMultiplier),
    };
  }

  /**
   * Apply a meridian state by id from the data ladder. Looks up the id in
   * the coerced snapshot and, when found, writes ALL four owned locations:
   * state.meridians (the full canonical shape, with the multipliers from
   * the definition), cultivation.meridianCapacityMultiplier,
   * cultivation.meridianFlowMultiplier and player.meridians (the display
   * name). An unknown id (not in the ladder), an empty ladder or a
   * non-string id returns null and mutates nothing. Emits NO events.
   *
   * @param {string} meridianId — the meridian id to apply (e.g. 'wide').
   * @returns {{ id: string, name: string, capacityMultiplier: number,
   *            flowMultiplier: number }|null} the applied meridian identity,
   *            or null when the id is not in the ladder.
   */
  setState(meridianId) {
    this._ensureSlices();
    if (typeof meridianId !== 'string' || meridianId === '') return null;

    const definition = this._byId.get(meridianId);
    if (!definition) return null;

    this._state.meridians = {
      id: definition.id,
      name: definition.name,
      capacityMultiplier: definition.capacityMultiplier,
      flowMultiplier: definition.flowMultiplier,
    };
    this._state.cultivation.meridianCapacityMultiplier = definition.capacityMultiplier;
    this._state.cultivation.meridianFlowMultiplier = definition.flowMultiplier;
    this._state.player.meridians = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      capacityMultiplier: definition.capacityMultiplier,
      flowMultiplier: definition.flowMultiplier,
    };
  }

  /**
   * Read the meridian ladder from the injected DataManager, snapshotting
   * and coercing it ONCE into the canonical internal shape. Returns an empty
   * array when no DataManager was injected or it lacks getAll() — count 0,
   * no state writes, setState() returns null. Hostile entries are
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
    const raw = this._dataManager.getAll('meridians');
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
   * Coerce a cached meridian definition into the canonical internal shape
   * (fresh object — never the deep-frozen cache). Returns null (skipped)
   * when the definition is unusable: not a plain object or no non-empty id.
   * Surviving entries coerce every field defensively: name falls back to id
   * and each multiplier to the neutral 1 when not a finite number > 0 — an
   * unusable factor can never poison the cultivation slots.
   *
   * @param {object} definition — a cached (frozen) meridian definition.
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
      capacityMultiplier: coerceMultiplier(definition.capacityMultiplier),
      flowMultiplier: coerceMultiplier(definition.flowMultiplier),
    };
  }

  /**
   * Write the cultivation multiplier slots from the current meridian's
   * factors (coerced, neutral 1 when not a finite number > 0) — the
   * constructor sync that keeps a restored save's multipliers in the slots
   * before the first tick. A hostile restored value can never reach the
   * slots: the coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultipliers() {
    this._state.cultivation.meridianCapacityMultiplier = coerceMultiplier(
      this._state.meridians.capacityMultiplier
    );
    this._state.cultivation.meridianFlowMultiplier = coerceMultiplier(
      this._state.meridians.flowMultiplier
    );
  }

  /**
   * Make sure the meridians, cultivation and player slices are plain
   * objects before any read/write against them. A malformed slice restored
   * from an attacker-shaped save (null, a primitive or an array) is replaced
   * with the canonical fresh slice — restore-trust: a broken top-level slice
   * must never abort boot or throw per call (player is included because
   * setState() writes player.meridians). A healthy restored slice (even one
   * with extra or missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('meridians', _freshMeridiansSlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
    this._ensureSlice('player', freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'meridians').
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
 * The canonical fresh meridians slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored meridians slice is unusable
 * (null, a primitive or an array) — the normal state (1.0×1.0).
 *
 * @returns {{ id: string, name: string, capacityMultiplier: number,
 *            flowMultiplier: number }} the canonical meridians slice.
 */
function _freshMeridiansSlice() {
  return {
    id: 'normal',
    name: 'Normal',
    capacityMultiplier: 1.0,
    flowMultiplier: 1.0,
  };
}
