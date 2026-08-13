/**
 * systems/soul.js — SoulSystem (single owner of the cultivator's soul state
 * and its cultivation multiplier slots).
 *
 * The Phase-3 soul system (DESIGN.md 'Soul' — spiritual strength: stability,
 * purity, willpower, comprehension). The soul state is set through external
 * means (the future character-gen flow, the developer console and tests). No
 * character-gen roll exists yet, so setSoul() is exposed for the future flow,
 * the developer console and tests. The system is the ONLY writer of the soul
 * locations: state.soul (the canonical soul shape), the four FUTURE-CONSUMER
 * cultivation slots cultivation.soulStabilityMultiplier /
 * cultivation.soulPurityMultiplier / cultivation.soulWillpowerMultiplier /
 * cultivation.soulComprehensionMultiplier (no system reads them yet — DESIGN.md
 * 'Soul affects enlightenment'; the Dao/technique-efficiency consumers land
 * later, same precedent as dantian's density/purity/efficiency slots, which
 * are written today and read by no system yet), and player.soul (the UI
 * display name).
 *
 * Data-driven content: the ladder (id, name, description, stabilityMultiplier,
 * purityMultiplier, willpowerMultiplier, comprehensionMultiplier) comes from
 * dataManager.getAll('soul') (data/soul/soul.json via data/manifest.json — one
 * entry per state, file order is the ladder Shattered → Chaos Soul). The
 * fresh-game 'stable' state is the canonical default (all 1.0× multipliers). A
 * MISSING 'soul' collection degrades neutrally: count 0, no state writes and
 * setSoul() returns null. Definitions are snapshotted and coerced ONCE at
 * construction (a deep-frozen DataManager cache can never be trusted to be
 * well-formed): non-object entries and entries without a usable id are
 * skipped; duplicate ids keep the first occurrence; every kept entry is
 * coerced to the canonical internal shape (name falls back to id, each
 * multiplier to the neutral 1 when not a finite number > 0 — an unusable
 * factor can never poison the slot).
 *
 * setSoul(soulId) applies the soul from the data ladder: it looks up the id in
 * the coerced snapshot and, when found, writes ALL owned locations (state.soul,
 * cultivation.soulStabilityMultiplier, cultivation.soulPurityMultiplier,
 * cultivation.soulWillpowerMultiplier, cultivation.soulComprehensionMultiplier
 * and player.soul). An unknown id or an empty ladder returns null and mutates
 * nothing. Emits NO events — PLANS.md defines no soul event and there is no
 * consumer (the system holds the injected bus for the future event contract
 * only).
 *
 * State owned (writes): state.soul (the full canonical shape), the four
 * future-consumer cultivation slots (which future enlightenment/Dao systems
 * will read) and player.soul (the display name). All are part of the canonical
 * GameState (see core/game-state.js). qi.js is deliberately NOT touched — the
 * soul slots have no consumer today.
 *
 * Restore-trust (attacker-shaped saves): the soul, cultivation and player
 * slices are repaired to the canonical fresh shapes when unusable (null, a
 * primitive or an array) before ANY read or write — a broken slice must never
 * abort boot or throw per call. A hostile restored multiplier (NaN, Infinity,
 * negative, <= 0) is coerced to the neutral 1 on read and can never reach the
 * cultivation slots; the constructor syncs the four cultivation slots from the
 * current state.soul immediately (same reasoning as the BloodlineSystem's
 * constructor sync: a restored save shows the right multipliers before the
 * first tick), so a restored soul lands its factors in the slots and the fresh
 * stable shape keeps the slots at 1 — restored saves stay numerically
 * identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing to
 * tear down — the soul only changes through setSoul(), so no destroy() is
 * needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setSoul() as a step; the four slots are written today for the future
 * enlightenment/Dao consumers — when they land, the bonuses read the slots
 * with no further code. All data-driven, no code changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, coerceMultiplier, freshCultivationSlice, freshPlayerSlice } from '../core/game-state.js';

export class SoulSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, MeridianSystem,
   *        PhysiqueSystem, DantianSystem, BloodlineSystem, QiSystem,
   *        RealmSystem and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no soul event), so the reference is reserved,
   *        never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the soul ladder
   *        from the 'soul' collection. When absent the ladder is empty —
   *        count 0, no state writes, setSoul() returns null. Content is
   *        never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('soul' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed soul/cultivation/player slice (null,
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
    // current soul's factors (coerced, neutral 1 when unusable) so a
    // restored save shows the right multipliers before the first tick —
    // same reasoning as the BloodlineSystem's constructor sync. The fresh
    // stable shape reads all 1.0×, so restored saves stay numerically
    // identical.
    this._syncMultipliers();
  }

  /**
   * @returns {number} the number of soul definitions (0 when the 'soul'
   *          collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the soul id (e.g. 'radiant').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT soul — never mutates state. Every
   * field is coerced defensively to the canonical shape (the fresh stable
   * defaults when the restored slice lacks a usable value), so a hostile
   * save can never yield a malformed/partial object and the read never
   * throws. The returned object is a fresh copy — mutating it never leaks
   * into the system or the state.
   *
   * @returns {{ id: string, name: string, stabilityMultiplier: number,
   *            purityMultiplier: number, willpowerMultiplier: number,
   *            comprehensionMultiplier: number }} the current soul.
   */
  getCurrent() {
    this._ensureSlices();
    const soul = this._state.soul;
    return {
      id:
        typeof soul.id === 'string' && soul.id !== ''
          ? soul.id
          : 'stable',
      name:
        typeof soul.name === 'string' && soul.name !== ''
          ? soul.name
          : 'Stable Soul',
      stabilityMultiplier: coerceMultiplier(soul.stabilityMultiplier),
      purityMultiplier: coerceMultiplier(soul.purityMultiplier),
      willpowerMultiplier: coerceMultiplier(soul.willpowerMultiplier),
      comprehensionMultiplier: coerceMultiplier(soul.comprehensionMultiplier),
    };
  }

  /**
   * Apply a soul by id from the data ladder. Looks up the id in the coerced
   * snapshot and, when found, writes ALL owned locations: state.soul (the
   * full canonical shape, with the multipliers from the definition), the
   * four future-consumer cultivation slots
   * cultivation.soulStabilityMultiplier / cultivation.soulPurityMultiplier /
   * cultivation.soulWillpowerMultiplier / cultivation.soulComprehensionMultiplier
   * (no system reads them yet — the enlightenment/Dao consumers land later,
   * per DESIGN.md 'Soul affects enlightenment'), and player.soul (the display
   * name). An unknown id (not in the ladder), an empty ladder or a non-string
   * id returns null and mutates nothing. Emits NO events.
   *
   * @param {string} soulId — the soul id to apply (e.g. 'radiant').
   * @returns {{ id: string, name: string, stabilityMultiplier: number,
   *            purityMultiplier: number, willpowerMultiplier: number,
   *            comprehensionMultiplier: number }|null} the applied soul
   *            identity, or null when the id is not in the ladder.
   */
  setSoul(soulId) {
    this._ensureSlices();
    if (typeof soulId !== 'string' || soulId === '') return null;

    const definition = this._byId.get(soulId);
    if (!definition) return null;

    this._state.soul = {
      id: definition.id,
      name: definition.name,
      stabilityMultiplier: definition.stabilityMultiplier,
      purityMultiplier: definition.purityMultiplier,
      willpowerMultiplier: definition.willpowerMultiplier,
      comprehensionMultiplier: definition.comprehensionMultiplier,
    };
    this._state.cultivation.soulStabilityMultiplier = definition.stabilityMultiplier;
    this._state.cultivation.soulPurityMultiplier = definition.purityMultiplier;
    this._state.cultivation.soulWillpowerMultiplier = definition.willpowerMultiplier;
    this._state.cultivation.soulComprehensionMultiplier = definition.comprehensionMultiplier;
    this._state.player.soul = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      stabilityMultiplier: definition.stabilityMultiplier,
      purityMultiplier: definition.purityMultiplier,
      willpowerMultiplier: definition.willpowerMultiplier,
      comprehensionMultiplier: definition.comprehensionMultiplier,
    };
  }

  /**
   * Read the soul ladder from the injected DataManager, snapshotting and
   * coercing it ONCE into the canonical internal shape. Returns an empty array
   * when no DataManager was injected or it lacks getAll() — count 0, no state
   * writes, setSoul() returns null. Hostile entries are skipped defensively
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
    const raw = this._dataManager.getAll('soul');
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
   * Coerce a cached soul definition into the canonical internal shape (fresh
   * object — never the deep-frozen cache). Returns null (skipped) when the
   * definition is unusable: not a plain object or no non-empty id. Surviving
   * entries coerce every field defensively: name falls back to id and each
   * multiplier to the neutral 1 when not a finite number > 0 — an unusable
   * factor can never poison the cultivation slots.
   *
   * @param {object} definition — a cached (frozen) soul definition.
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
      stabilityMultiplier: coerceMultiplier(definition.stabilityMultiplier),
      purityMultiplier: coerceMultiplier(definition.purityMultiplier),
      willpowerMultiplier: coerceMultiplier(definition.willpowerMultiplier),
      comprehensionMultiplier: coerceMultiplier(definition.comprehensionMultiplier),
    };
  }

  /**
   * Write the four cultivation multiplier slots from the current soul's
   * factors (coerced, neutral 1 when not a finite number > 0) — the
   * constructor sync that keeps a restored save's multipliers in the slots
   * before the first tick. A hostile restored value can never reach the
   * slots: the coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultipliers() {
    this._state.cultivation.soulStabilityMultiplier = coerceMultiplier(
      this._state.soul.stabilityMultiplier
    );
    this._state.cultivation.soulPurityMultiplier = coerceMultiplier(
      this._state.soul.purityMultiplier
    );
    this._state.cultivation.soulWillpowerMultiplier = coerceMultiplier(
      this._state.soul.willpowerMultiplier
    );
    this._state.cultivation.soulComprehensionMultiplier = coerceMultiplier(
      this._state.soul.comprehensionMultiplier
    );
  }

  /**
   * Make sure the soul, cultivation and player slices are plain objects
   * before any read/write against them. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with the
   * canonical fresh slice — restore-trust: a broken top-level slice must never
   * abort boot or throw per call (player is included because setSoul() writes
   * player.soul). A healthy restored slice (even one with extra or missing
   * fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('soul', _freshSoulSlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
    this._ensureSlice('player', freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'soul').
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
 * The canonical fresh soul slice (mirrors core/game-state.js). Used as the
 * restore-trust fallback when a restored soul slice is unusable (null, a
 * primitive or an array) — the stable state (all 1.0× multipliers).
 *
 * @returns {{ id: string, name: string, stabilityMultiplier: number,
 *            purityMultiplier: number, willpowerMultiplier: number,
 *            comprehensionMultiplier: number }} the canonical soul slice.
 */
function _freshSoulSlice() {
  return {
    id: 'stable',
    name: 'Stable Soul',
    stabilityMultiplier: 1.0,
    purityMultiplier: 1.0,
    willpowerMultiplier: 1.0,
    comprehensionMultiplier: 1.0,
  };
}
