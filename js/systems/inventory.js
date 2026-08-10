/**
 * systems/inventory.js — InventorySystem (single owner of the carried stacks).
 *
 * The Phase-2 basic inventory system. It owns every carried item stack
 * (state.inventory.items — an array of { id, count } stacks) and the slot
 * accounting (state.inventory.slots.used = the number of DISTINCT stacks, not
 * the total item count). add()/remove() are the only writers: future
 * producers (herb gathering, quest rewards, sect income, ...) earn items by
 * calling add() and consumers (pill refinement, crafting, selling, ...) burn
 * them by calling remove(). The full Phase-4 inventory (filter/sort/search)
 * is out of scope here, but the stacked-array shape and the slot math are
 * designed so those features read the same stacks without touching the write
 * primitives.
 *
 * Data-driven content: item definitions (ids, names, stackSize, ...) come
 * from the DataManager's 'items' collection (data/items/items.json) via
 * dataManager.get('items', id) — nothing is hardcoded. The slot capacity
 * (slots.total) is tuned by config.inventory.slots.total when present; a
 * MISSING config.inventory block is silent (the canonical state default of 20
 * governs), and an invalid configured total warns once and falls back to the
 * state value. A definition whose stackSize is missing or unusable falls back
 * to 1 (each item occupies its own slot — always safe, never exceeds the cap).
 *
 * State owned (writes): state.inventory.items, state.inventory.slots.used
 * (and, when repaired or tuned, state.inventory.slots.total). The `inventory`
 * slice is part of the canonical GameState (see core/game-state.js), so it
 * always exists; every numeric read is still coerced with a fail-safe
 * _asNumber so a malformed or legacy value can never poison the math.
 *
 * Restore-trust (attacker-shaped saves): before ANY read or write the
 * `inventory` slice is repaired to the canonical fresh shape when it is
 * unusable (null, a primitive or an array) — a broken slice must never abort
 * boot or throw per call. A restored items list that is not an array is
 * replaced with []; a stack entry that is not { id: string, count: number }
 * — including prototype-alias ids (__proto__/constructor/prototype) and
 * non-finite or non-positive counts — is skipped (defense); usable entries
 * are ALWAYS rebuilt through _normalizeStack so coercible values (count:
 * '7', count: [7]) become canonical numbers at restore (never left in state
 * to corrupt add()'s `count += fill` math later); the restored stacks are
 * clamped to the slot capacity (a save can never boot over-capacity);
 * slots.used is ALWAYS recomputed from the actual stacks (a stored `used` is
 * never trusted, even on a shape-healthy slice); and the stored slots.total
 * is kept only when it is a positive finite integer, else it falls back to
 * the canonical default (20). add() also rejects prototype-alias ids at the
 * boundary (mirroring the ResourceSystem config-time rejection) so a stack
 * id can never become an object key for a consumer that looks items up by
 * id, and a saved unsafe stack can never silently vanish on a later reload.
 *
 * Event contract (all emitted on the injected eventBus):
 *   inventory:changed { id, delta, count, usedSlots, totalSlots } — fired
 *   ONLY when a write actually happened (never for zero/no-op calls). delta
 *   is SIGNED (+added for add(), −removed for remove()) and count is the
 *   item's total across every stack after the change.
 *
 * Pure gameplay — no DOM access, no storage I/O, no loop subscription and no
 * destroy() (there are no listeners to tear down). Per-second production is
 * deliberately out of scope: this system must never subscribe to
 * 'loop:update'. Systems communicate through the EventBus only; this module
 * depends solely on the shared GameState and EventBus singletons (both
 * injectable for deterministic tests) plus the injectable DataManager (which
 * resolves item definitions — when it is absent every definition lookup
 * resolves nothing and add() rejects unknown items with a warning, never
 * hardcoding metadata).
 *
 * Future expansion (see DESIGN.md/PLANS.md): the Phase-4 full inventory
 * (filter/sort/search) reads the same stacks; multisource gains arrive by
 * driving gains through add() following the qi/offline patterns — the write
 * math stays unchanged.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** Keys that alias the prototype chain and must never become stack ids. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Canonical default slot capacity (mirrors core/game-state.js). */
const DEFAULT_TOTAL_SLOTS = 20;

export class InventorySystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `inventory` block is read for slots.total. A missing block is
   *        silent (the canonical state default of 20 governs); a present but
   *        invalid slots.total warns once and falls back to the state value.
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as MeditationSystem, QiSystem,
   *        ResourceSystem, OfflineProgress, DataManager, GameLoop and
   *        Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {object} [options.dataManager] — DataManager (or a lookalike with
   *        a `get(collection, id)` method) resolving item definitions from
   *        the 'items' collection. Optional: when absent every definition
   *        lookup resolves nothing, so add() rejects all items with a warning
   *        (metadata is never hardcoded).
   */
  constructor(options = {}) {
    const inventory = (options.config && options.config.inventory) || {};

    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} definition resolver ('items' collection), if any. */
    this._dataManager = options.dataManager || null;

    /** @type {number|null} configured slot capacity; null = use the state value. */
    this._configuredTotalSlots = _readConfiguredTotalSlots(inventory);

    // Restore-trust: a malformed inventory slice (null, a primitive or an
    // array) restored from an attacker-shaped save must never abort boot —
    // repair it to the canonical fresh slice before any API call can run.
    this._ensureInventorySlice();
  }

  /**
   * @returns {Array<{id: string, count: number}>} shallow copies of the
   *          current stacks — mutating a returned copy never leaks back into
   *          the system.
   */
  get inventory() {
    this._ensureInventorySlice();
    return this._state.inventory.items.map((stack) => ({ ...stack }));
  }

  /**
   * @returns {number} the slot capacity (positive finite integer, kept in
   *          sync with the state value and any configured tuning).
   */
  get totalSlots() {
    this._ensureInventorySlice();
    return this._state.inventory.slots.total;
  }

  /**
   * @returns {number} the number of slots currently occupied (one per DISTINCT
   *          stack, not per item).
   */
  get usedSlots() {
    this._ensureInventorySlice();
    return _asNumber(this._state.inventory.slots.used);
  }

  /**
   * @returns {number} the number of slots left before the capacity is reached.
   *          Negative only for an inconsistent restored save (more stacks than
   *          slots); add() guards against that case and never opens a stack
   *          beyond the capacity.
   */
  get remainingSlots() {
    this._ensureInventorySlice();
    return this._state.inventory.slots.total - _asNumber(this._state.inventory.slots.used);
  }

  /**
   * Total count of an item across every stack. Silent fail-safe: an absent id
   * (or an id whose stacks were repaired away) reads as 0 with no warning —
   * reads never warn.
   *
   * @param {string} id — item id to count.
   * @returns {number} the total count across stacks, 0 when absent.
   */
  count(id) {
    this._ensureInventorySlice();
    let total = 0;
    for (const stack of this._state.inventory.items) {
      if (stack.id === id) total += _asNumber(stack.count);
    }
    return total;
  }

  /**
   * Whether the carried amount of an item covers the requested amount. Both
   * operands are coerced via _asNumber (a non-positive or non-finite amount
   * is always satisfied); an absent id fails SILENTLY — reads never warn.
   *
   * @param {string} id — item id to check.
   * @param {number} amount — requested amount (any type, coerced).
   * @returns {boolean} true when the carried count >= amount (or amount <= 0),
   *          false otherwise; false for absent ids.
   */
  has(id, amount) {
    const parsed = _asNumber(amount);
    if (parsed <= 0) return true;
    return this.count(id) >= parsed;
  }

  /**
   * Add a positive amount of an item. The definition is resolved through the
   * DataManager's 'items' collection (an unknown id — or one that aliases the
   * prototype chain — warns and returns 0; with no DataManager every id is
   * unknown, so everything is rejected with a warning and nothing is ever
   * hardcoded). Items stack onto existing stacks first, up to each stack's
   * stackSize, then open NEW stacks only while slots remain — the carried
   * amount never exceeds the capacity. Returns the number actually added
   * (>= 0); when anything was added it syncs slots.used and emits
   * 'inventory:changed' with a positive delta. A non-positive or non-finite
   * requested amount returns 0 with no write and no event.
   *
   * @param {string} id — item id (resolved via the DataManager).
   * @param {number} amount — amount to add (any type, coerced).
   * @returns {number} the amount actually added (0 when nothing was).
   */
  add(id, amount) {
    this._ensureInventorySlice();

    // A prototype-alias id is rejected at the boundary (mirroring the
    // ResourceSystem config-time rejection) so a stack id can never become an
    // object key for a consumer that looks items up by id — the id stays
    // permanently unknown (warn + fail safe, no write, no event).
    if (UNSAFE_KEYS.has(id)) {
      console.warn(`InventorySystem: unsafe item id "${String(id)}" — nothing added.`);
      return 0;
    }

    const definition = this._resolveDefinition(id);
    if (!definition) {
      console.warn(`InventorySystem: unknown item id "${String(id)}" — nothing added.`);
      return 0;
    }

    const requested = _asNumber(amount);
    if (requested <= 0) return 0;

    const stackSize = _readStackSize(definition);
    const items = this._state.inventory.items;
    const totalSlots = this._state.inventory.slots.total;
    let remaining = requested;

    // 1) Stack onto existing stacks first, up to each stack's stackSize
    //    (room is clamped to the stackSize, so a count can never exceed it —
    //    the per-stack fill is provably finite by construction).
    for (const stack of items) {
      if (remaining <= 0) break;
      if (stack.id !== id) continue;
      const room = Math.max(stackSize - stack.count, 0);
      if (room <= 0) continue;
      const fill = Math.min(remaining, room);
      stack.count += fill;
      remaining -= fill;
    }

    // 2) Open NEW stacks only while slots remain (each iteration consumes one
    //    slot, so the loop is bounded by the capacity).
    while (remaining > 0 && items.length < totalSlots) {
      const fill = Math.min(remaining, stackSize);
      items.push({ id, count: fill });
      remaining -= fill;
    }

    const added = requested - remaining;
    // Zero room (e.g. a full inventory, or every stack at its stackSize) is a
    // legitimate no-op: nothing added, no write, no event.
    if (added <= 0) return 0;

    this._syncUsedSlots();
    this._eventBus.emit('inventory:changed', {
      id,
      delta: added,
      count: this.count(id),
      usedSlots: this._state.inventory.slots.used,
      totalSlots: this._state.inventory.slots.total,
    });
    return added;
  }

  /**
   * Remove a positive amount of an item. Stacks are drained front-to-back;
   * a stack that empties is removed (freeing its slot) and a partially-drained
   * stack is decremented in place. CONTRACT: partial removal — removing more
   * than is carried removes everything available and returns that actual
   * amount (never an error, never a negative count). Returns the number
   * actually removed (>= 0); when anything was removed it syncs slots.used and
   * emits 'inventory:changed' with a negative delta. A non-positive or
   * non-finite amount, or an item that is not carried, is a silent no-op (0,
   * no write, no event — unlike add(), remove() never warns: an id you do not
   * carry is an ordinary answer, not a mistake).
   *
   * @param {string} id — item id to remove.
   * @param {number} amount — amount to remove (any type, coerced).
   * @returns {number} the amount actually removed (0 when nothing was).
   */
  remove(id, amount) {
    this._ensureInventorySlice();

    const requested = _asNumber(amount);
    if (requested <= 0) return 0;

    const items = this._state.inventory.items;
    let remaining = requested;

    for (let index = 0; index < items.length && remaining > 0; ) {
      const stack = items[index];
      if (stack.id !== id) {
        index += 1;
        continue;
      }
      if (stack.count <= remaining) {
        remaining -= stack.count;
        items.splice(index, 1); // stack emptied → its slot is freed
      } else {
        stack.count -= remaining;
        remaining = 0;
      }
    }

    const removed = requested - remaining;
    if (removed <= 0) return 0;

    this._syncUsedSlots();
    this._eventBus.emit('inventory:changed', {
      id,
      delta: -removed,
      count: this.count(id),
      usedSlots: this._state.inventory.slots.used,
      totalSlots: this._state.inventory.slots.total,
    });
    return removed;
  }

  /**
   * Resolve an item definition through the injected DataManager (the 'items'
   * collection). When no DataManager is available every lookup resolves
   * nothing — metadata is never hardcoded, so an inventory system without
   * content rejects all adds with a warning.
   *
   * @param {string} id — item id to look up.
   * @returns {object|undefined} the deep-frozen definition, or undefined.
   */
  _resolveDefinition(id) {
    if (!this._dataManager) return undefined;
    return this._dataManager.get('items', id);
  }

  /**
   * Keep state.inventory.slots.used in sync with the actual stack count,
   * writing only when it differs (keeps renderer partial-refresh comparisons
   * stable, same pattern as the qi/meditation sync helpers).
   *
   * @returns {void}
   */
  _syncUsedSlots() {
    const used = this._state.inventory.items.length;
    if (this._state.inventory.slots.used !== used) {
      this._state.inventory.slots.used = used;
    }
  }

  /**
   * Make sure the inventory slice is canonical before ANY read or write
   * against it. Restore-trust: a malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with the
   * canonical fresh slice; a non-array items is replaced with []; stack
   * entries that are not { id: string, count: number } (including
   * prototype-alias ids and non-finite/non-positive counts) are skipped;
   * usable entries are ALWAYS rebuilt through _normalizeStack so coercible
   * values (count: '7') become canonical numbers; the stacks are clamped to
   * the slot capacity; slots.used is ALWAYS synced to the actual stack count
   * (a stored `used` is never trusted); and the stored slots.total is kept
   * only when it is a positive finite integer (else the canonical default of
   * 20, or the configured tuning when one was declared).
   *
   * @returns {object} the (possibly repaired) inventory slice.
   */
  _ensureInventorySlice() {
    let repaired = false;
    const current = this._state.inventory;
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      this._state.inventory = _freshInventorySlice();
      repaired = true;
    }

    const inventory = this._state.inventory;

    if (!Array.isArray(inventory.items)) {
      inventory.items = [];
      repaired = true;
    } else {
      // ALWAYS rebuild the stacks through _normalizeStack, and mark repaired
      // whenever a normalized stack differs from its raw entry (count: '7' →
      // 7, count: [7] → 7). Keeping the raw array when nothing was skipped
      // would leave coercible-but-string counts in state, and add()'s
      // `count += fill` would then concatenate strings ('7' + 5 → '75'),
      // permanently corrupting counts into the save.
      let changed = false;
      const stacks = [];
      for (const entry of inventory.items) {
        const stack = _normalizeStack(entry);
        if (stack) {
          stacks.push(stack);
          if (stack.count !== entry.count || stack.id !== entry.id) {
            changed = true;
          }
        } else {
          changed = true; // malformed entry skipped (defense)
        }
      }
      if (changed) {
        inventory.items = stacks;
        repaired = true;
      }
    }

    if (
      inventory.slots === null ||
      typeof inventory.slots !== 'object' ||
      Array.isArray(inventory.slots)
    ) {
      inventory.slots = { total: DEFAULT_TOTAL_SLOTS, used: 0 };
      repaired = true;
    }

    const total = _readTotalSlots(inventory.slots.total, this._configuredTotalSlots);
    if (inventory.slots.total !== total) {
      inventory.slots.total = total;
      repaired = true;
    }

    // Restore-trust clamp: a hostile save may carry more stacks than the
    // capacity allows (add() enforces the cap, restore must too) — truncate
    // to the effective capacity so the inventory can never boot over-capacity.
    if (inventory.items.length > inventory.slots.total) {
      inventory.items = inventory.items.slice(0, inventory.slots.total);
      repaired = true;
    }

    // Never trust a stored `used` — recompute it from the actual stacks (one
    // slot per distinct stack) unconditionally, not only when something else
    // was repaired: a lying stored `used` on a shape-healthy slice must not
    // feed wrong numbers into the slots bindings.
    if (inventory.slots.used !== inventory.items.length) {
      inventory.slots.used = inventory.items.length;
      repaired = true;
    }

    return inventory;
  }
}

/**
 * The canonical fresh inventory slice (mirrors core/game-state.js). Used as
 * the restore-trust fallback when a restored inventory slice is unusable
 * (null, a primitive or an array) — a broken slice must never abort boot.
 *
 * @returns {object} the canonical inventory slice.
 */
function _freshInventorySlice() {
  return {
    slots: {
      total: DEFAULT_TOTAL_SLOTS,
      used: 0,
    },
    items: [],
  };
}

/**
 * Read and validate the configured slot capacity from config.inventory. A
 * missing block (or a missing slots.total) is silent — the state value
 * governs instead; a present but invalid value warns once and falls back to
 * the state value too (mirroring the _readNonNegativeNumber pattern in
 * meditation/qi/offline-progress).
 *
 * @param {object} inventory — raw config.inventory block.
 * @returns {number|null} the configured capacity, or null when none usable.
 */
function _readConfiguredTotalSlots(inventory) {
  const raw = inventory && inventory.slots ? inventory.slots.total : undefined;
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(
    `InventorySystem: invalid "slots.total" (${String(raw)}) — using the state value.`
  );
  return null;
}

/**
 * Resolve the effective slot capacity for a stored value: the configured
 * tuning wins when one was declared (data-driven tuning is authoritative over
 * a stale save value), otherwise the stored value is kept when it is a
 * positive finite integer, else the canonical default (20) — an
 * attacker-shaped total must never abort boot or produce a nonsensical
 * capacity.
 *
 * @param {*} stored — stored state.inventory.slots.total value.
 * @param {number|null} configured — configured capacity from
 *        config.inventory.slots.total, or null when none declared.
 * @returns {number} the effective positive integer capacity.
 */
function _readTotalSlots(stored, configured) {
  if (configured !== null) return configured;
  const parsed = Number(stored);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOTAL_SLOTS;
}

/**
 * Validate and normalize a restored stack entry. Returns the canonical
 * { id, count } shape when the entry is a usable stack — a plain object with
 * a non-empty string id that does not alias the prototype chain and a finite
 * count > 0 (numeric strings coerce, non-finite/zero/negative counts are
 * unusable) — or null when the entry must be skipped (defense against
 * attacker-shaped saves).
 *
 * @param {*} entry — raw stack entry from a restored items list.
 * @returns {{id: string, count: number}|null} the normalized stack, or null.
 */
function _normalizeStack(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.id !== 'string' || entry.id === '' || UNSAFE_KEYS.has(entry.id)) {
    return null;
  }
  const count = _asNumber(entry.count);
  if (count <= 0) return null;
  return { id: entry.id, count };
}

/**
 * The per-stack capacity from an item definition. A definition without a
 * usable stackSize (missing, non-finite, non-integer or non-positive) falls
 * back to 1 — each item then occupies its own slot, which is always safe and
 * can never exceed the inventory capacity.
 *
 * @param {object} definition — resolved item definition (deep-frozen by the
 *        DataManager).
 * @returns {number} the effective stack size (positive integer).
 */
function _readStackSize(definition) {
  const parsed = Number(definition.stackSize);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no items" value — never a tuning number).
 *
 * @param {*} value — raw value (stack count or requested amount).
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
