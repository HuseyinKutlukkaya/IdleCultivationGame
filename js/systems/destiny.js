/**
 * systems/destiny.js — DestinySystem (single owner of the cultivator's
 * destiny state and its two cultivation multiplier slots).
 *
 * The Phase-3 destiny system (DESIGN.md 'Destiny' — hidden luck: fortunate
 * encounters, rare teachers, hidden treasures vs. calamities, betrayals, poor
 * opportunities). The destiny state is set through external means (the future
 * character-gen flow, the developer console and tests). No character-gen roll
 * exists yet, so setDestiny() is exposed for the future flow, the developer
 * console and tests. The system is the ONLY writer of the destiny locations:
 * state.destiny (the canonical destiny shape), the two FUTURE-CONSUMER
 * cultivation slots cultivation.destinyFortuneMultiplier /
 * cultivation.destinyCalamityMultiplier (no system reads them yet — DESIGN.md
 * 'Destiny affects the world'; the encounter/calamity consumers land later,
 * same precedent as the soul slots, which are written today and read by no
 * system yet), and player.destiny (the UI display name).
 *
 * Data-driven content: the ladder (id, name, description, fortuneMultiplier,
 * calamityMultiplier) comes from dataManager.getAll('destiny')
 * (data/destiny/destiny.json via data/manifest.json — one entry per state,
 * file order is the ladder Doomed → Son of Heaven). The fresh-game 'mundane'
 * state is the canonical default (all 1.0× multipliers). A MISSING 'destiny'
 * collection degrades neutrally: count 0, no state writes and setDestiny()
 * returns null. Definitions are snapshotted and coerced ONCE at construction
 * (a deep-frozen DataManager cache can never be trusted to be well-formed):
 * non-object entries and entries without a usable id are skipped; duplicate
 * ids keep the first occurrence; every kept entry is coerced to the canonical
 * internal shape (name falls back to id, each multiplier to the neutral 1
 * when not a finite number > 0 — an unusable factor can never poison the
 * slot).
 *
 * setDestiny(destinyId) applies the destiny from the data ladder: it looks up
 * the id in the coerced snapshot and, when found, writes ALL owned locations
 * (state.destiny, cultivation.destinyFortuneMultiplier,
 * cultivation.destinyCalamityMultiplier and player.destiny). An unknown id or
 * an empty ladder returns null and mutates nothing. Emits NO events — PLANS.md
 * defines no destiny event and there is no consumer (the system holds the
 * injected bus for the future event contract only).
 *
 * State owned (writes): state.destiny (the full canonical shape), the two
 * future-consumer cultivation slots (which the future encounter/calamity
 * systems will read) and player.destiny (the display name). All are part of
 * the canonical GameState (see core/game-state.js). qi.js, techniques.js and
 * breakthroughs.js are deliberately NOT touched — the destiny slots have no
 * consumer today.
 *
 * Restore-trust (attacker-shaped saves): the destiny, cultivation and player
 * slices are repaired to the canonical fresh shapes when unusable (null, a
 * primitive or an array) before ANY read or write — a broken slice must never
 * abort boot or throw per call. A hostile restored multiplier (NaN, Infinity,
 * negative, <= 0) is coerced to the neutral 1 on read and can never reach the
 * cultivation slots; the constructor syncs the two cultivation slots from the
 * current state.destiny immediately (same reasoning as the SoulSystem's
 * constructor sync: a restored save shows the right multipliers before the
 * first tick), so a restored destiny lands its factors in the slots and the
 * fresh mundane shape keeps the slots at 1 — restored saves stay numerically
 * identical to today.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. This module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected DataManager. It has NO 'loop:update' subscription and nothing to
 * tear down — the destiny only changes through setDestiny(), so no destroy()
 * is needed (the class stays minimal).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the character-generation flow
 * calls setDestiny() as a step; the two slots are written today for the
 * future encounter/calamity consumers — when they land, the bonuses read the
 * slots with no further code. All data-driven, no code changes required.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, coerceMultiplier, freshCultivationSlice, freshPlayerSlice } from '../core/game-state.js';

export class DestinySystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as SpiritRootSystem, MeridianSystem,
   *        PhysiqueSystem, DantianSystem, BloodlineSystem, SoulSystem,
   *        TalentSystem, ComprehensionSystem, QiSystem, RealmSystem and
   *        Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton. Held for the future
   *        event contract only — the system currently emits nothing
   *        (PLANS.md defines no destiny event), so the reference is reserved,
   *        never subscribed.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the destiny ladder
   *        from the 'destiny' collection. When absent the ladder is empty —
   *        count 0, no state writes, setDestiny() returns null. Content is
   *        never hardcoded.
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events (reserved; unused). */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('destiny' collection). */
    this._dataManager = options.dataManager || null;

    // Restore-trust: a malformed destiny/cultivation/player slice (null,
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
    // current destiny's factors (coerced, neutral 1 when unusable) so a
    // restored save shows the right multipliers before the first tick —
    // same reasoning as the SoulSystem's constructor sync. The fresh
    // mundane shape reads all 1.0×, so restored saves stay numerically
    // identical.
    this._syncMultipliers();
  }

  /**
   * @returns {number} the number of destiny definitions (0 when the 'destiny'
   *          collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single ladder entry by id.
   *
   * @param {string} id — the destiny id (e.g. 'blessed').
   * @returns {object|null} a shallow copy of the coerced definition, or null
   *          when the ladder holds no such id.
   */
  byId(id) {
    const definition = this._byId.get(id);
    if (!definition) return null;
    return { ...definition };
  }

  /**
   * Read-only snapshot of the CURRENT destiny — never mutates state. Every
   * field is coerced defensively to the canonical shape (the fresh mundane
   * defaults when the restored slice lacks a usable value), so a hostile save
   * can never yield a malformed/partial object and the read never throws. The
   * returned object is a fresh copy — mutating it never leaks into the system
   * or the state.
   *
   * @returns {{ id: string, name: string, fortuneMultiplier: number,
   *            calamityMultiplier: number }} the current destiny.
   */
  getCurrent() {
    this._ensureSlices();
    const destiny = this._state.destiny;
    return {
      id:
        typeof destiny.id === 'string' && destiny.id !== ''
          ? destiny.id
          : 'mundane',
      name:
        typeof destiny.name === 'string' && destiny.name !== ''
          ? destiny.name
          : 'Mundane',
      fortuneMultiplier: coerceMultiplier(destiny.fortuneMultiplier),
      calamityMultiplier: coerceMultiplier(destiny.calamityMultiplier),
    };
  }

  /**
   * Apply a destiny by id from the data ladder. Looks up the id in the
   * coerced snapshot and, when found, writes ALL owned locations:
   * state.destiny (the full canonical shape, with the multipliers from the
   * definition), the two future-consumer cultivation slots
   * cultivation.destinyFortuneMultiplier / cultivation.destinyCalamityMultiplier
   * (no system reads them yet — the encounter/calamity consumers land later,
   * per DESIGN.md 'Destiny affects the world'), and player.destiny (the
   * display name). An unknown id (not in the ladder), an empty ladder or a
   * non-string id returns null and mutates nothing. Emits NO events.
   *
   * @param {string} destinyId — the destiny id to apply (e.g. 'blessed').
   * @returns {{ id: string, name: string, fortuneMultiplier: number,
   *            calamityMultiplier: number }|null} the applied destiny
   *            identity, or null when the id is not in the ladder.
   */
  setDestiny(destinyId) {
    this._ensureSlices();
    if (typeof destinyId !== 'string' || destinyId === '') return null;

    const definition = this._byId.get(destinyId);
    if (!definition) return null;

    this._state.destiny = {
      id: definition.id,
      name: definition.name,
      fortuneMultiplier: definition.fortuneMultiplier,
      calamityMultiplier: definition.calamityMultiplier,
    };
    this._state.cultivation.destinyFortuneMultiplier = definition.fortuneMultiplier;
    this._state.cultivation.destinyCalamityMultiplier = definition.calamityMultiplier;
    this._state.player.destiny = definition.name;

    return {
      id: definition.id,
      name: definition.name,
      fortuneMultiplier: definition.fortuneMultiplier,
      calamityMultiplier: definition.calamityMultiplier,
    };
  }

  /**
   * Read the destiny ladder from the injected DataManager, snapshotting and
   * coercing it ONCE into the canonical internal shape. Returns an empty array
   * when no DataManager was injected or it lacks getAll() — count 0, no state
   * writes, setDestiny() returns null. Hostile entries are skipped
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
    const raw = this._dataManager.getAll('destiny');
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
   * Coerce a cached destiny definition into the canonical internal shape
   * (fresh object — never the deep-frozen cache). Returns null (skipped) when
   * the definition is unusable: not a plain object or no non-empty id.
   * Surviving entries coerce every field defensively: name falls back to id
   * and each multiplier to the neutral 1 when not a finite number > 0 — an
   * unusable factor can never poison the cultivation slots.
   *
   * @param {object} definition — a cached (frozen) destiny definition.
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
      fortuneMultiplier: coerceMultiplier(definition.fortuneMultiplier),
      calamityMultiplier: coerceMultiplier(definition.calamityMultiplier),
    };
  }

  /**
   * Write the two cultivation multiplier slots from the current destiny's
   * factors (coerced, neutral 1 when not a finite number > 0) — the
   * constructor sync that keeps a restored save's multipliers in the slots
   * before the first tick. A hostile restored value can never reach the
   * slots: the coercion happens here, on every write path of this system.
   *
   * @returns {void}
   */
  _syncMultipliers() {
    this._state.cultivation.destinyFortuneMultiplier = coerceMultiplier(
      this._state.destiny.fortuneMultiplier
    );
    this._state.cultivation.destinyCalamityMultiplier = coerceMultiplier(
      this._state.destiny.calamityMultiplier
    );
  }

  /**
   * Make sure the destiny, cultivation and player slices are plain objects
   * before any read/write against them. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with the
   * canonical fresh slice — restore-trust: a broken top-level slice must never
   * abort boot or throw per call (player is included because setDestiny()
   * writes player.destiny). A healthy restored slice (even one with extra or
   * missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('destiny', _freshDestinySlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
    this._ensureSlice('player', freshPlayerSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'destiny').
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
 * The canonical fresh destiny slice (mirrors core/game-state.js). Used as the
 * restore-trust fallback when a restored destiny slice is unusable (null, a
 * primitive or an array) — the mundane state (all 1.0× multipliers).
 *
 * @returns {{ id: string, name: string, fortuneMultiplier: number,
 *            calamityMultiplier: number }} the canonical destiny slice.
 */
function _freshDestinySlice() {
  return {
    id: 'mundane',
    name: 'Mundane',
    fortuneMultiplier: 1.0,
    calamityMultiplier: 1.0,
  };
}
