/**
 * systems/bloodlines.js — BloodlineSystem (single owner of the cultivator's
 * bloodline state and its cultivation multiplier slots).
 *
 * The Phase-3 bloodline system (DESIGN.md 'Bloodlines' — a data-driven passive
 * bonus to cultivation speed and qi capacity). The bloodline state is set
 * through external means (the future character-gen flow, the developer
 * console and tests). No character-gen roll exists yet, so setBloodline() is
 * exposed for the future flow, the developer console and tests. The system is
 * the ONLY writer of the bloodline locations: state.bloodlines (the canonical
 * bloodline shape), the cultivation slots cultivation.bloodlineSpeedMultiplier
 * (which the QiSystem stacks into the per-second rate aggregate) and
 * cultivation.bloodlineQiMaxMultiplier (which the QiSystem stacks into the qi
 * cap alongside the realm/meridian/dantian factors), and player.bloodline (the
 * UI display name).
 *
 * Data-driven content: the ladder (id, name, description,
 * cultivationSpeedMultiplier, qiMaxMultiplier) comes from
 * dataManager.getAll('bloodlines') (data/bloodlines/bloodlines.json via
 * data/manifest.json — one entry per state, file order is the ladder
 * Ancient Human → Chaos Blood). The fresh-game 'ancient-human' state is the
 * canonical default (all 1.0× multipliers). A MISSING 'bloodlines' collection
 * degrades neutrally: count 0, no state writes and setBloodline() returns null.
 * Definitions are snapshotted and coerced ONCE at construction (a deep-frozen
 * DataManager cache can never be trusted to be well-formed): non-object
 * entries and entries without a usable id are skipped; duplicate ids keep the
 * first occurrence; every kept entry is coerced to the canonical internal
 * shape (name falls back to id, each multiplier to the neutral 1 when not a
 * finite number > 0 — an unusable factor can never poison the slot).
 *
 * setBloodline(bloodlineId) applies the bloodline from the data ladder: it
 * looks up the id in the coerced snapshot and, when found, writes ALL owned
 * locations (state.bloodlines, cultivation.bloodlineSpeedMultiplier,
 * cultivation.bloodlineQiMaxMultiplier and player.bloodline). An unknown id or
 * an empty ladder returns null and mutates nothing. Emits NO events — PLANS.md
 * defines no bloodline event and there is no consumer (the system holds the
 * injected bus for the future event contract only).
 *
 * State owned (writes): state.bloodlines (the full canonical shape),
 * cultivation.bloodlineSpeedMultiplier (the qi-rate slot the QiSystem reads),
 * cultivation.bloodlineQiMaxMultiplier (the qi-cap slot the QiSystem reads)
 * and player.bloodline (the display name). All are part of the canonical
 * GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the bloodlines, cultivation and
 * player slices are repaired to the canonical fresh shapes when unusable
 * (null, a primitive or an array) before ANY read or write — a broken slice
 * must never abort boot or throw per call. A hostile restored multiplier
 * (NaN, Infinity, negative, <= 0) is coerced to the neutral 1 on read and can
 * never reach the cultivation slots; the constructor syncs
 * cultivation.bloodlineSpeedMultiplier and cultivation.bloodlineQiMaxMultiplier
 * from the current state.bloodlines immediately (same reasoning as the
 * MeridianSystem's / DantianSystem's constructor sync: a restored save shows
 * the right multipliers before the first tick), so a restored bloodline lands
 * its factors in the slots and the fresh ancient-human shape keeps the slots
 * at 1 — restored saves stay numerically identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing to
 * tear down — the bloodline only changes through setBloodline(), so no
 * destroy() is needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setBloodline() as a step; both slots are already read by the QiSystem,
 * so the cultivation-speed and qi-cap bonuses land with no further code. All
 * data-driven, no code changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, coerceMultiplier, freshCultivationSlice, freshPlayerSlice } from '../core/game-state.js';

export class BloodlineSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, MeridianSystem,
   *        PhysiqueSystem, DantianSystem, QiSystem, RealmSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no bloodline event), so the reference is
   *        reserved, never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the bloodline
   *        ladder from the 'bloodlines' collection. When absent the ladder
   *        is empty — count 0, no state writes, setBloodline() returns null.
   *        Content is never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('bloodlines' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed bloodlines/cultivation/player slice (null,
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
    // current bloodline's factors (coerced, neutral 1 when unusable) so a
    // restored save shows the right multipliers before the first tick —
    // same reasoning as the MeridianSystem's / DantianSystem's constructor
    // sync. The fresh ancient-human shape reads all 1.0×, so restored saves
    // stay numerically identical.
    this._syncMultipliers();
  }

  /**
   * @returns {number} the number of bloodline definitions (0 when the
   *          'bloodlines' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the bloodline id (e.g. 'dragon').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT bloodline — never mutates state. Every
   * field is coerced defensively to the canonical shape (the fresh
   * ancient-human defaults when the restored slice lacks a usable value), so
   * a hostile save can never yield a malformed/partial object and the read
   * never throws. The returned object is a fresh copy — mutating it never
   * leaks into the system or the state.
   *
   * @returns {{ id: string, name: string, cultivationSpeedMultiplier: number,
   *            qiMaxMultiplier: number }} the current bloodline.
   */
  getCurrent() {
    this._ensureSlices();
    const bloodline = this._state.bloodlines;
    return {
      id:
        typeof bloodline.id === 'string' && bloodline.id !== ''
          ? bloodline.id
          : 'ancient-human',
      name:
        typeof bloodline.name === 'string' && bloodline.name !== ''
          ? bloodline.name
          : 'Ancient Human',
      cultivationSpeedMultiplier: coerceMultiplier(bloodline.cultivationSpeedMultiplier),
      qiMaxMultiplier: coerceMultiplier(bloodline.qiMaxMultiplier),
    };
  }

  /**
   * Apply a bloodline by id from the data ladder. Looks up the id in the
   * coerced snapshot and, when found, writes ALL owned locations:
   * state.bloodlines (the full canonical shape, with the multipliers from
   * the definition), cultivation.bloodlineSpeedMultiplier (the QiSystem
   * stacks this into the per-second rate) and cultivation.bloodlineQiMaxMultiplier
   * (the QiSystem stacks this into the qi cap — alongside the realm/meridian/
   * dantian factors), and player.bloodline (the display name). An unknown id
   * (not in the ladder), an empty ladder or a non-string id returns null and
   * mutates nothing. Emits NO events.
   *
   * @param {string} bloodlineId — the bloodline id to apply (e.g. 'dragon').
   * @returns {{ id: string, name: string, cultivationSpeedMultiplier: number,
   *            qiMaxMultiplier: number }|null} the applied bloodline identity,
   *            or null when the id is not in the ladder.
   */
  setBloodline(bloodlineId) {
    this._ensureSlices();
    if (typeof bloodlineId !== 'string' || bloodlineId === '') return null;

    const definition = this._byId.get(bloodlineId);
    if (!definition) return null;

    this._state.bloodlines = {
      id: definition.id,
      name: definition.name,
      cultivationSpeedMultiplier: definition.cultivationSpeedMultiplier,
      qiMaxMultiplier: definition.qiMaxMultiplier,
    };
    this._state.cultivation.bloodlineSpeedMultiplier = definition.cultivationSpeedMultiplier;
    this._state.cultivation.bloodlineQiMaxMultiplier = definition.qiMaxMultiplier;
    this._state.player.bloodline = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      cultivationSpeedMultiplier: definition.cultivationSpeedMultiplier,
      qiMaxMultiplier: definition.qiMaxMultiplier,
    };
  }

  /**
   * Read the bloodline ladder from the injected DataManager, snapshotting and
   * coercing it ONCE into the canonical internal shape. Returns an empty array
   * when no DataManager was injected or it lacks getAll() — count 0, no state
   * writes, setBloodline() returns null. Hostile entries are skipped
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
    const raw = this._dataManager.getAll('bloodlines');
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
   * Coerce a cached bloodline definition into the canonical internal shape
   * (fresh object — never the deep-frozen cache). Returns null (skipped)
   * when the definition is unusable: not a plain object or no non-empty id.
   * Surviving entries coerce every field defensively: name falls back to id
   * and each multiplier to the neutral 1 when not a finite number > 0 — an
   * unusable factor can never poison the cultivation slots.
   *
   * @param {object} definition — a cached (frozen) bloodline definition.
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
      cultivationSpeedMultiplier: coerceMultiplier(definition.cultivationSpeedMultiplier),
      qiMaxMultiplier: coerceMultiplier(definition.qiMaxMultiplier),
    };
  }

  /**
   * Write the cultivation multiplier slots from the current bloodline's
   * factors (coerced, neutral 1 when not a finite number > 0) — the
   * constructor sync that keeps a restored save's multipliers in the slots
   * before the first tick. A hostile restored value can never reach the
   * slots: the coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultipliers() {
    this._state.cultivation.bloodlineSpeedMultiplier = coerceMultiplier(
      this._state.bloodlines.cultivationSpeedMultiplier
    );
    this._state.cultivation.bloodlineQiMaxMultiplier = coerceMultiplier(
      this._state.bloodlines.qiMaxMultiplier
    );
  }

  /**
   * Make sure the bloodlines, cultivation and player slices are plain objects
   * before any read/write against them. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with the
   * canonical fresh slice — restore-trust: a broken top-level slice must never
   * abort boot or throw per call (player is included because setBloodline()
   * writes player.bloodline). A healthy restored slice (even one with extra or
   * missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('bloodlines', _freshBloodlinesSlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
    this._ensureSlice('player', freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'bloodlines').
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
 * The canonical fresh bloodlines slice (mirrors core/game-state.js). Used as
 * the restore-trust fallback when a restored bloodlines slice is unusable
 * (null, a primitive or an array) — the ancient-human state (all 1.0×
 * multipliers).
 *
 * @returns {{ id: string, name: string, cultivationSpeedMultiplier: number,
 *            qiMaxMultiplier: number }} the canonical bloodlines slice.
 */
function _freshBloodlinesSlice() {
  return {
    id: 'ancient-human',
    name: 'Ancient Human',
    cultivationSpeedMultiplier: 1.0,
    qiMaxMultiplier: 1.0,
  };
}
