/**
 * systems/resources.js — ResourceSystem (single owner of the wallet resources).
 *
 * The Phase-2 wallet-resource system. It owns every spendable/earnable
 * resource count (state.resources.<id>) declared by config.resources.items —
 * spirit stones, herbs, jade and qi-condensation pills in the shipped config,
 * but nothing is hardcoded: ids, labels and caps all come from JSON, so the
 * Data Author can add, rename or retune a currency without touching code.
 * The system exposes the wallet primitives (get / canAfford / add / spend)
 * that future producers and consumers (herb gathering, sect income, pill
 * refinement, breakthroughs, ...) call to earn or burn resources, and it is
 * the single owner of the balances — other systems never write
 * state.resources directly.
 *
 * Data-driven tuning: every resource comes from config.resources.items:
 *   { id, label?, capPath? } — id is the state.resources key (required),
 *   label falls back to the id, capPath is an OPTIONAL dot path into state
 *   of that resource's cap (absent = uncapped). A MISSING config.resources
 *   block is silent (manages nothing); a present but non-array items warns
 *   once and manages nothing; malformed entries (null, non-object, missing
 *   or empty id) are skipped with warnings and duplicates keep the first
 *   occurrence (mirroring the _readSources pattern in qi and _readProducers
 *   in offline-progress).
 *
 * State owned (writes): state.resources.<id> for every declared resource.
 * The `resources` slice is part of the canonical GameState (see
 * core/game-state.js), so it always exists; every numeric read is still
 * coerced with a fail-safe _asNumber so a malformed or legacy value can
 * never poison the math.
 *
 * Restore-trust (attacker-shaped saves): before ANY read or write the
 * `resources` slice is repaired to the canonical fresh shape when it is
 * unusable (null, a primitive or an array) — a broken slice must never
 * abort boot or throw per call, while a healthy restored slice keeps its
 * own fields (missing resource keys read as 0). add() also drops a gain
 * entirely when current + added would not be finite: a restored balance at
 * the double limit must never put Infinity into state (see add()'s
 * finite-write guard, mirroring QiSystem's tick guard and offline-progress's
 * producer guard).
 *
 * Event contract (all emitted on the injected eventBus):
 *   resource:changed { id, label, delta, total } — fired ONLY when a write
 *     actually happened (never for zero/no-op calls). delta is SIGNED
 *     (+added for add(), −spent for spend()) and total is the post-change
 *     balance; label comes from the declaration.
 *
 * Pure gameplay — no DOM access, no storage I/O, no loop subscription and
 * no destroy() (there are no listeners to tear down). Per-second production
 * is deliberately out of scope: no resource producer exists yet, and the
 * first one arrives later driving gains through add() following the
 * qi/offline patterns — this system must never subscribe to 'loop:update'.
 * Systems communicate through the EventBus only; this module depends solely
 * on the shared GameState and EventBus singletons (both injectable for
 * deterministic tests).
 *
 * Future expansion (see DESIGN.md/PLANS.md): per-resource cap growth, pill
 * and market economies, and producer-side multipliers — producers earn by
 * calling add() and consumers burn by calling spend(), so the wallet math
 * stays unchanged.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** Keys that alias the prototype chain and must never be traversed. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ResourceSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `resources` block is read for items. A missing block is silent
   *        (manages nothing); a present but non-array items warns once.
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as MeditationSystem, QiSystem,
   *        OfflineProgress, DataManager, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   */
  constructor(options = {}) {
    const resources = (options.config && options.config.resources) || {};

    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;

    /** @type {Array<{id: string, label: string, capPath: string|null}>} */
    this._items = _readItems(resources.items);

    // Restore-trust: a malformed resources slice (null, a primitive or an
    // array) restored from an attacker-shaped save must never abort boot —
    // repair it to the canonical fresh slice before any API call can run.
    this._ensureSlice('resources', _freshResourcesSlice);
  }

  /**
   * @returns {Array<{id: string, label: string, capPath: string|null}>} shallow
   *          copies of the declared resources — mutating a returned copy never
   *          leaks back into the system.
   */
  get resources() {
    return this._items.map((item) => ({ ...item }));
  }

  /**
   * Read a resource's current balance. Silent fail-safe: the stored value is
   * coerced via _asNumber (a missing field, a non-numeric value or Infinity
   * reads as 0), and an unknown id (not declared in config) reads as 0 with
   * no warning — reads never warn.
   *
   * @param {string} id — declared resource id (state.resources.<id>).
   * @returns {number} the current balance, 0 when absent or unusable.
   */
  get(id) {
    this._ensureSlice('resources', _freshResourcesSlice);
    const resource = this._itemById(id);
    if (!resource) return 0; // unknown ids read as 0 silently
    return _asNumber(this._state.resources[id]);
  }

  /**
   * Whether the current balance covers the requested amount. Both operands
   * are coerced via _asNumber (a non-positive or non-finite amount is always
   * affordable); an unknown id fails SILENTLY — reads never warn.
   *
   * @param {string} id — declared resource id.
   * @param {number} amount — requested amount (any type, coerced).
   * @returns {boolean} true when current >= amount (or amount <= 0), false
   *          otherwise; false for unknown ids.
   */
  canAfford(id, amount) {
    this._ensureSlice('resources', _freshResourcesSlice);
    const resource = this._itemById(id);
    if (!resource) return false; // unknown ids fail silently

    const current = _asNumber(this._state.resources[id]);
    const parsed = _asNumber(amount);
    if (parsed <= 0) return true;
    return current >= parsed;
  }

  /**
   * Add a positive amount to a resource. The gain is clamped to the room left
   * below the resource's cap (when capPath is declared and resolves; no
   * capPath, or an unsafe/unresolvable one, means uncapped). Returns the
   * number actually added (>= 0); when anything was added it writes
   * state.resources.<id> = current + added and emits 'resource:changed' with
   * a positive delta. A non-positive or non-finite requested amount returns 0
   * with no write and no event; an unknown id warns and returns 0; and
   * the finite-write guard drops the whole gain when current + added would
   * not be finite (Infinity must never enter state).
   *
   * @param {string} id — declared resource id.
   * @param {number} amount — amount to add (any type, coerced).
   * @returns {number} the amount actually added (0 when nothing was).
   */
  add(id, amount) {
    this._ensureSlice('resources', _freshResourcesSlice);

    const resource = this._itemById(id);
    if (!resource) {
      console.warn(`ResourceSystem: unknown resource id "${String(id)}" — nothing added.`);
      return 0;
    }

    const requested = _asNumber(amount);
    if (requested <= 0) return 0;

    const current = _asNumber(this._state.resources[id]);
    const cap = this._readCap(resource);
    const room = cap === null ? Infinity : Math.max(cap - current, 0);
    const added = Math.min(requested, room);

    // Zero room below the cap (or a cap already at/below the balance) is a
    // legitimate no-op: nothing added, no write, no event.
    if (added <= 0) return 0;

    const total = current + added;
    // Finite-write guard (mirrors the QiSystem tick guard and the
    // offline-progress _applyProducer guard): a restored balance near the
    // double limit plus a huge finite add must never put Infinity into state
    // — when the sum is not finite, skip the write and the event entirely.
    if (!Number.isFinite(total)) return 0;

    this._state.resources[id] = total;
    this._eventBus.emit('resource:changed', {
      id: resource.id,
      label: resource.label,
      delta: added,
      total,
    });
    return added;
  }

  /**
   * Deduct a positive amount from a resource. Returns true and emits
   * 'resource:changed' with a NEGATIVE delta only when the full amount was
   * actually deducted; an insufficient balance, a non-positive (or
   * non-finite) amount and an unknown id (which warns) all return false
   * with no write and no event. The finite-write guard (mirroring add) skips
   * a spend whose result would not be finite — Infinity must never enter
   * state.
   *
   * @param {string} id — declared resource id.
   * @param {number} amount — amount to spend (any type, coerced).
   * @returns {boolean} true when the full amount was deducted.
   */
  spend(id, amount) {
    this._ensureSlice('resources', _freshResourcesSlice);

    const resource = this._itemById(id);
    if (!resource) {
      console.warn(`ResourceSystem: unknown resource id "${String(id)}" — nothing spent.`);
      return false;
    }

    const parsed = _asNumber(amount);
    if (parsed <= 0) return false;

    const current = _asNumber(this._state.resources[id]);
    if (current < parsed) return false;

    const total = current - parsed;
    // Finite-write guard: current and parsed are both finite and current >=
    // parsed, so this is provably finite today — the check stays as defense
    // in depth so a future coercion change can never put Infinity into state.
    if (!Number.isFinite(total)) return false;

    this._state.resources[id] = total;
    this._eventBus.emit('resource:changed', {
      id: resource.id,
      label: resource.label,
      delta: -parsed,
      total,
    });
    return true;
  }

  /**
   * Make sure the resources slice is a plain object before ANY read or write
   * against it. A malformed slice restored from an attacker-shaped save (null,
   * a primitive or an array) is replaced with the canonical fresh slice from
   * the fallback factory — restore-trust: a broken slice must never abort
   * boot or throw per call. A healthy restored slice (even one with extra or
   * missing fields) is never clobbered — missing resource keys simply read
   * as 0 through _asNumber.
   *
   * @param {string} name — top-level slice name in state (e.g. 'resources').
   * @param {() => object} fallback — factory returning the canonical fresh slice.
   * @returns {object} the (possibly repaired) slice.
   */
  _ensureSlice(name, fallback) {
    const current = this._state[name];
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      this._state[name] = fallback();
    }
    return this._state[name];
  }

  /**
   * Look up a declared resource by id.
   *
   * @param {string} id — resource id to find.
   * @returns {{id: string, label: string, capPath: string|null}|null} the
   *          declaration, or null when the id is not declared.
   */
  _itemById(id) {
    return this._items.find((item) => item.id === id) || null;
  }

  /**
   * Resolve a resource's cap from its declared capPath. Returns null (the
   * "no cap" sentinel) when no capPath is declared, when the path does not
   * resolve to a usable value (missing/unsafe path, null) or when the
   * resolved value is not a finite number — an unsafe or unresolvable capPath
   * is treated as no cap, never pollutes Object.prototype and never throws.
   *
   * @param {{id: string, label: string, capPath: string|null}} resource —
   *        validated resource declaration.
   * @returns {number|null} the cap, or null when uncapped.
   */
  _readCap(resource) {
    if (resource.capPath === null) return null;
    const value = this._readPath(resource.capPath);
    if (value === undefined || value === null) return null; // unsafe/unresolvable → no cap
    const cap = Number(value);
    return Number.isFinite(cap) ? cap : null; // non-finite resolved value → no cap
  }

  /**
   * Resolve a dot path (e.g. "resources.herbsCap") through the game state.
   * Missing intermediate segments short-circuit to undefined, and segments
   * that alias the prototype chain (`__proto__`, `constructor`, `prototype`)
   * are treated as missing — a capPath can never reach Object.prototype
   * (defense in depth; paths are dev-authored config, not user input).
   *
   * @param {string} path — dot-separated path into the state object.
   * @returns {*} the value at the path, or undefined when a segment is missing.
   */
  _readPath(path) {
    let current = this._state;
    for (const segment of String(path).split('.')) {
      if (current === null || current === undefined || UNSAFE_KEYS.has(segment)) {
        return undefined;
      }
      current = current[segment];
    }
    return current;
  }
}

/**
 * The canonical fresh resources slice (mirrors core/game-state.js). Used as
 * the restore-trust fallback when a restored resources slice is unusable
 * (null, a primitive or an array) — a broken slice must never abort boot.
 *
 * @returns {object} the canonical resources slice.
 */
function _freshResourcesSlice() {
  return {
    spiritStones: 0,
    herbs: 0,
    jade: 0,
    qiCondensationPills: 0,
  };
}

/**
 * Read and validate the resource item list from config. Entries without a
 * non-empty string id — or whose id aliases the prototype chain
 * (`__proto__`, `constructor`, `prototype`), which must never become state
 * keys — are skipped with a warning; the rest are normalized (label falls
 * back to id, capPath to null) and duplicates keep the first occurrence
 * with a warning. A missing "items" key is silent — it simply means no
 * resources are managed.
 *
 * @param {*} raw — raw value of config.resources.items.
 * @returns {Array<{id: string, label: string, capPath: string|null}>}
 *          the validated items.
 */
function _readItems(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.warn('ResourceSystem: "items" must be an array — ignoring resources.');
    return [];
  }

  const items = [];
  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn('ResourceSystem: skipping a resource that is not an object.');
      continue;
    }
    if (typeof entry.id !== 'string' || entry.id === '') {
      console.warn('ResourceSystem: skipping a resource without a non-empty id.');
      continue;
    }
    // A prototype-alias id (__proto__/constructor/prototype) must never
    // become a state.resources key: the __proto__ accessor silently drops
    // writes and constructor/prototype shadow own keys, so the id is
    // rejected here — the resource stays permanently unknown (get/canAfford
    // fail silently, add/spend warn and fail safe) and the balance can never
    // change behind a positive return value.
    if (UNSAFE_KEYS.has(entry.id)) {
      console.warn(`ResourceSystem: skipping resource with unsafe id "${entry.id}".`);
      continue;
    }
    if (seen.has(entry.id)) {
      console.warn(`ResourceSystem: duplicate resource id "${entry.id}" — keeping the first.`);
      continue;
    }
    seen.add(entry.id);
    items.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
      capPath: typeof entry.capPath === 'string' && entry.capPath !== '' ? entry.capPath : null,
    });
  }
  return items;
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no resources" value — never a tuning number).
 *
 * @param {*} value — raw value (balance, amount or cap).
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
