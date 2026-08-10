/**
 * tests/unit/inventory.test.mjs — unit tests for js/systems/inventory.js.
 *
 * Exercises the InventorySystem (single owner of the carried stacks): the
 * data-driven definition resolution through the injected DataManager (unknown
 * ids and prototype-alias ids rejected with warnings, no DataManager → every
 * add rejected without crashing, unusable stackSize falls back to 1), the
 * slot math (one slot per DISTINCT stack, used recomputed on every write), the
 * add() flow (creates stacks, stacks onto existing stacks first, splits at
 * stackSize, never exceeds the slot capacity, emits signed deltas only on real
 * writes), the remove() flow (drains across stacks, frees slots as stacks
 * empty, PARTIAL-removal contract: removing beyond owned removes everything
 * available and returns the actual amount, silent no-ops for non-carried ids
 * and non-positive amounts), the config tuning (missing block silent,
 * configured slots.total authoritative, invalid configured total warns once),
 * restore-trust slice repair (null/primitive/array inventory, non-array
 * items, malformed stack entries skipped with counts normalized, slots.used
 * recomputed on repair, invalid stored slots.total falls back to 20, repair
 * also runs before any read after external corruption), defensive-copy
 * getters and count()/has() read semantics.
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine) and the shared EventBus (cleared in beforeEach so event
 * assertions start clean), plus a tiny fake dataManager serving 1–3 item
 * definitions. No clock or loop is needed — InventorySystem never subscribes
 * to 'loop:update'.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { InventorySystem } from '../../js/systems/inventory.js';

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * The fake item catalog backing the injected dataManager. Mirrors the real
 * data/items/items.json contract ({ id, name, category, grade, quality,
 * value, stackSize, tags, icon }) — but the system only ever reads
 * stackSize, so the rest is faithful filler.
 *
 * @type {Object<string, object>}
 */
const ITEM_CATALOG = {
  'spirit-herb': {
    id: 'spirit-herb',
    name: 'Spirit Herb',
    category: 'herb',
    grade: 'Mortal',
    quality: 'Normal',
    value: 5,
    stackSize: 99,
    tags: ['herb', 'alchemy'],
    icon: '',
  },
  'qi-condensation-pill': {
    id: 'qi-condensation-pill',
    name: 'Qi Condensation Pill',
    category: 'pill',
    grade: 'Mortal',
    quality: 'Normal',
    value: 10,
    stackSize: 99,
    tags: ['pill', 'cultivation'],
    icon: '',
  },
  'mortal-sword': {
    id: 'mortal-sword',
    name: 'Mortal Sword',
    category: 'artifact',
    grade: 'Mortal',
    quality: 'Normal',
    value: 50,
    stackSize: 1,
    tags: ['artifact', 'equipment'],
    icon: '',
  },
};

/**
 * Build a tiny fake dataManager serving the item catalog (plus overrides).
 *
 * @param {Object<string, object>} [overrides] — extra/changed definitions
 *        keyed by id (merged over ITEM_CATALOG).
 * @returns {{ get: (collection: string, id: string) => object|undefined }}
 *          the fake dataManager.
 */
function makeDataManager(overrides = {}) {
  const catalog = { ...ITEM_CATALOG, ...overrides };
  return {
    get(collection, id) {
      if (collection !== 'items') return undefined;
      return catalog[id];
    },
  };
}

/**
 * Build a config with an inventory block (mirrors the optional
 * config.inventory tuning contract) plus optional overrides.
 *
 * @param {object} [overrides] — key/values merged over the inventory block.
 * @returns {object} a config object.
 */
function makeConfig(overrides = {}) {
  return {
    inventory: {
      slots: { total: 20 },
      ...overrides,
    },
  };
}

/**
 * Build an InventorySystem instance with a fresh state clone (unless
 * overridden) and the fake dataManager (unless overridden).
 *
 * @param {object} [options] — overrides for config/state/dataManager.
 * @param {object} [options.config] — config to inject (defaults to makeConfig()).
 * @param {object} [options.state] — state to inject (defaults to a GameState clone).
 * @param {object|null} [options.dataManager] — dataManager to inject (defaults
 *        to makeDataManager(); pass null to test the absent-dataManager mode).
 * @returns {InventorySystem} the system instance.
 */
function makeSystem(options = {}) {
  const config = options.config === undefined ? makeConfig() : options.config;
  const state = options.state === undefined ? structuredClone(GameState) : options.state;
  const dataManager = options.dataManager === undefined ? makeDataManager() : options.dataManager;
  return new InventorySystem({ config, state, eventBus: EventBus, dataManager });
}

// --- config tuning ----------------------------------------------------------

test('a missing config.inventory block is silent and uses the canonical state defaults', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem({ config: {}, state });

  // No warning for the missing block and the canonical defaults.
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(system.totalSlots, 20);
  assert.equal(system.usedSlots, 0);
  assert.equal(system.remainingSlots, 20);
  assert.deepEqual(state.inventory.items, []);
});

test('the configured slots.total tunes the capacity and stays authoritative', () => {
  const state = structuredClone(GameState);
  state.inventory.slots.total = 12; // a stale stored value
  const system = makeSystem({
    config: { inventory: { slots: { total: 30 } } },
    state,
  });

  // Config wins over the stored value and the capacity math follows it.
  assert.equal(system.totalSlots, 30);
  assert.equal(state.inventory.slots.total, 30);

  // Capacity is actually enforced at the configured number.
  const small = makeSystem({ config: { inventory: { slots: { total: 3 } } } });
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));

  assert.equal(small.add('spirit-herb', 250), 250); // 99 per stack, capped at 3 slots
  assert.equal(small.usedSlots, 3);
  assert.deepEqual(small.inventory, [
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 52 },
  ]);
  // Fill the room left in the partial stack (existing stacks take priority).
  assert.equal(small.add('spirit-herb', 47), 47);
  assert.deepEqual(small.inventory, [
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 99 },
  ]);
  // Every stack is full and no slots remain → 0 added, no event.
  assert.equal(small.add('spirit-herb', 1), 0);
  assert.equal(changed.length, 2);
});

test('an invalid configured slots.total warns once and falls back to the state value', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  state.inventory.slots.total = 25;

  const system = makeSystem({ config: { inventory: { slots: { total: -5 } } }, state });

  assert.equal(warn.mock.callCount(), 1);
  // Falls back to the stored state value (a valid positive integer).
  assert.equal(system.totalSlots, 25);
  assert.equal(state.inventory.slots.total, 25);
});

// --- add() ------------------------------------------------------------------

test('add() creates a stack, syncs slots.used and count()/has() reflect it', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state });

  assert.equal(system.add('spirit-herb', 7), 7);
  assert.deepEqual(state.inventory.items, [{ id: 'spirit-herb', count: 7 }]);
  assert.equal(state.inventory.slots.used, 1);
  assert.equal(system.usedSlots, 1);
  assert.equal(system.remainingSlots, 19);
  assert.equal(system.count('spirit-herb'), 7);
  assert.equal(system.has('spirit-herb', 7), true);
  assert.equal(system.has('spirit-herb', 8), false);
});

test('add() fills an existing stack before opening a new one', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state });

  system.add('spirit-herb', 10);
  system.add('spirit-herb', 5);

  // Still a single stack (stackSize 99) — no new slot was opened.
  assert.deepEqual(state.inventory.items, [{ id: 'spirit-herb', count: 15 }]);
  assert.equal(system.usedSlots, 1);
  assert.equal(system.count('spirit-herb'), 15);
});

test('add() respects stackSize and splits into new stacks when a stack is full', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state });

  // stackSize 99: the 125th item opens a second stack.
  assert.equal(system.add('spirit-herb', 125), 125);
  assert.deepEqual(state.inventory.items, [
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 26 },
  ]);
  assert.equal(system.usedSlots, 2);
  assert.equal(system.count('spirit-herb'), 125);
});

test('add() respects the slot capacity and never exceeds it', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ config: { inventory: { slots: { total: 3 } } }, state });

  // 3 slots × 99 per stack = 297; the last stack only holds the leftover.
  assert.equal(system.add('spirit-herb', 300), 297);
  assert.equal(system.usedSlots, 3);
  assert.deepEqual(state.inventory.items, [
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 99 },
    { id: 'spirit-herb', count: 99 },
  ]);

  // A full inventory is a legitimate no-op: 0 added, no write, no event.
  assert.equal(system.add('spirit-herb', 5), 0);
  assert.equal(changed.length, 1);
  assert.equal(state.inventory.slots.used, 3);
});

test('add() with an unknown id warns, writes nothing and emits nothing', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state });

  assert.equal(system.add('unknown-item', 5), 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(state.inventory.items, []);
  assert.equal(state.inventory.slots.used, 0);
  assert.equal(changed.length, 0);
  assert.equal(system.count('unknown-item'), 0); // reads never warn
  assert.equal(warn.mock.callCount(), 1);
});

test('add() with a prototype-alias id is rejected as unsafe', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state });

  for (const id of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(system.add(id, 5), 0);
  }
  // Three unsafe-id warnings; no stack was ever created.
  assert.equal(warn.mock.callCount(), 3);
  assert.deepEqual(state.inventory.items, []);
  assert.equal(changed.length, 0);

  // Object.prototype stays untouched and the safe catalog still works.
  assert.equal({}.x, undefined);
  assert.equal({}.hasOwnProperty('x'), false);
  assert.equal(system.add('spirit-herb', 3), 3);
});

test('add() with a non-positive or non-finite amount writes nothing', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state });

  assert.equal(system.add('spirit-herb', 0), 0);
  assert.equal(system.add('spirit-herb', -3), 0);
  assert.equal(system.add('spirit-herb', Infinity), 0);
  assert.equal(system.add('spirit-herb', NaN), 0);
  assert.equal(system.add('spirit-herb', 'not-a-number'), 0);
  assert.equal(system.add('spirit-herb'), 0); // undefined amount → 0
  assert.deepEqual(state.inventory.items, []);
  assert.equal(state.inventory.slots.used, 0);
  assert.equal(changed.length, 0);
  assert.equal(warn.mock.callCount(), 0);
});

test('add() emits inventory:changed with a signed delta and totals, only on real writes', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state });

  const added = system.add('spirit-herb', 15);

  assert.equal(added, 15);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0], {
    id: 'spirit-herb',
    delta: 15,
    count: 15,
    usedSlots: 1,
    totalSlots: 20,
  });

  // A stacking add emits the running totals.
  assert.equal(system.add('spirit-herb', 5), 5);
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[1], {
    id: 'spirit-herb',
    delta: 5,
    count: 20,
    usedSlots: 1,
    totalSlots: 20,
  });

  // No-op calls emit nothing — the event list grows only on real writes. A
  // full inventory (capacity 1, one slot taken) is a real no-op case.
  const capped = makeSystem({ config: { inventory: { slots: { total: 1 } } } });
  capped.add('mortal-sword', 1); // the single slot is now taken
  const cappedEvents = [];
  EventBus.subscribe('inventory:changed', (payload) => cappedEvents.push(payload));
  assert.equal(capped.add('mortal-sword', 1), 0); // no slot left → nothing added
  assert.equal(cappedEvents.length, 0);
});

test('add() falls back to a stack size of 1 when the definition has no usable stackSize', () => {
  const dataManager = makeDataManager({
    'broken-item': { id: 'broken-item', name: 'Broken', stackSize: 'many' },
    'no-stack-item': { id: 'no-stack-item', name: 'No Stack', stackSize: undefined },
  });
  const state = structuredClone(GameState);
  const system = makeSystem({ state, dataManager });

  // stackSize 'many' is unusable → each item occupies its own slot.
  assert.equal(system.add('broken-item', 3), 3);
  assert.deepEqual(state.inventory.items, [
    { id: 'broken-item', count: 1 },
    { id: 'broken-item', count: 1 },
    { id: 'broken-item', count: 1 },
  ]);
  assert.equal(system.usedSlots, 3);

  assert.equal(system.add('no-stack-item', 2), 2);
  assert.equal(system.usedSlots, 5);
});

// --- remove() ---------------------------------------------------------------

test('remove() decrements across stacks, frees slots when a stack empties and emits correctly', () => {
  const dataManager = makeDataManager({
    'spirit-herb': { ...ITEM_CATALOG['spirit-herb'], stackSize: 20 },
  });
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state, dataManager });

  system.add('spirit-herb', 30); // stacks [20, 10], used 2
  assert.equal(system.usedSlots, 2);

  // Drain 22: consumes the 20-stack entirely (slot freed) + 2 from the second.
  assert.equal(system.remove('spirit-herb', 22), 22);
  assert.deepEqual(state.inventory.items, [{ id: 'spirit-herb', count: 8 }]);
  assert.equal(state.inventory.slots.used, 1);
  assert.deepEqual(changed.at(-1), {
    id: 'spirit-herb',
    delta: -22,
    count: 8,
    usedSlots: 1,
    totalSlots: 20,
  });

  // Removing the whole remaining stack frees the last slot.
  assert.equal(system.remove('spirit-herb', 8), 8);
  assert.deepEqual(state.inventory.items, []);
  assert.equal(state.inventory.slots.used, 0);
  assert.equal(changed.at(-1).delta, -8);
  assert.equal(changed.at(-1).count, 0);
  assert.equal(changed.at(-1).usedSlots, 0);

  // Every write emitted a signed delta: the add, then two removes.
  assert.equal(changed.length, 3);
  assert.deepEqual(changed.map((payload) => payload.delta), [30, -22, -8]);
});

test('remove() beyond owned removes what is there (partial-removal contract)', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state });

  system.add('spirit-herb', 10);

  // Removing more than carried removes everything available and reports the
  // actual amount — never an error, never a negative count.
  assert.equal(system.remove('spirit-herb', 25), 10);
  assert.deepEqual(state.inventory.items, []);
  assert.equal(state.inventory.slots.used, 0);
  assert.equal(changed.at(-1).delta, -10);
  assert.equal(changed.at(-1).count, 0);
  assert.equal(system.count('spirit-herb'), 0);
});

test('remove() with non-positive, non-finite or absent targets is a silent no-op', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state });
  system.add('spirit-herb', 10);

  assert.equal(system.remove('spirit-herb', 0), 0);
  assert.equal(system.remove('spirit-herb', -1), 0);
  assert.equal(system.remove('spirit-herb', NaN), 0);
  assert.equal(system.remove('spirit-herb', Infinity), 0);
  assert.equal(system.remove('spirit-herb', 'nope'), 0);
  assert.equal(system.remove('spirit-herb'), 0); // undefined amount → 0
  // An id that is not carried is an ordinary answer — no warning, no event.
  assert.equal(system.remove('unknown-item', 5), 0);
  assert.equal(warn.mock.callCount(), 0);

  assert.deepEqual(state.inventory.items, [{ id: 'spirit-herb', count: 10 }]);
  assert.equal(changed.length, 1); // only the original add emitted
});

// --- reads ------------------------------------------------------------------

test('count() returns 0 for absent or unknown ids silently', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const system = makeSystem({});

  assert.equal(system.count('spirit-herb'), 0);
  assert.equal(system.count('unknown-item'), 0);
  assert.equal(warn.mock.callCount(), 0);
});

test('has() reports coverage and never warns', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const system = makeSystem({ state });
  system.add('spirit-herb', 10);

  assert.equal(system.has('spirit-herb', 10), true);
  assert.equal(system.has('spirit-herb', 11), false);
  assert.equal(system.has('spirit-herb', 0), true);
  assert.equal(system.has('spirit-herb', -5), true);
  assert.equal(system.has('spirit-herb', Infinity), true); // coerces to 0
  assert.equal(system.has('unknown-item', 1), false);
  assert.equal(warn.mock.callCount(), 0);
});

test('the inventory getter returns defensive copies', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state });
  system.add('spirit-herb', 3);
  system.add('spirit-herb', 3); // two stacks after a split? no — one stack of 6

  // Mutating a returned copy must not leak back into the state.
  const copy = system.inventory;
  copy[0].id = 'hacked';
  copy[0].count = 999;

  assert.deepEqual(system.inventory, [{ id: 'spirit-herb', count: 6 }]);
  assert.deepEqual(state.inventory.items, [{ id: 'spirit-herb', count: 6 }]);
});

// --- restore-trust ----------------------------------------------------------

test('a malformed restored inventory slice is repaired on construction', () => {
  const state = structuredClone(GameState);
  state.inventory = null;

  const system = makeSystem({ state }); // must not throw

  assert.deepEqual(state.inventory, { slots: { total: 20, used: 0 }, items: [] });
  assert.equal(system.totalSlots, 20);
  assert.equal(system.remainingSlots, 20);

  // Adds flow normally after the repair.
  assert.equal(system.add('spirit-herb', 5), 5);
  assert.equal(state.inventory.slots.used, 1);
});

test('restored primitive and array inventory slices are repaired, healthy slices survive', () => {
  const primitive = structuredClone(GameState);
  primitive.inventory = 5; // a primitive top-level slice
  makeSystem({ state: primitive }); // must not throw
  assert.deepEqual(primitive.inventory, { slots: { total: 20, used: 0 }, items: [] });

  const array = structuredClone(GameState);
  array.inventory = [1, 2, 3]; // an array top-level slice
  makeSystem({ state: array }); // must not throw
  assert.deepEqual(array.inventory, { slots: { total: 20, used: 0 }, items: [] });

  // A healthy restored slice keeps its own fields — but the effective total
  // is the CONFIGURED tuning when one is declared, so this check uses a config
  // WITHOUT an inventory block to let the stored 30 survive untouched.
  const healthy = structuredClone(GameState);
  healthy.inventory = { slots: { total: 30, used: 1 }, items: [{ id: 'spirit-herb', count: 4 }] };
  const system = makeSystem({ config: {}, state: healthy });
  assert.equal(healthy.inventory.slots.total, 30);
  assert.equal(healthy.inventory.slots.used, 1);
  assert.deepEqual(healthy.inventory.items, [{ id: 'spirit-herb', count: 4 }]);
  assert.equal(system.count('spirit-herb'), 4);
});

test('malformed stack entries are skipped and slots.used is recomputed on repair', () => {
  const state = structuredClone(GameState);
  state.inventory.slots.used = 99; // a stored `used` that must never be trusted
  state.inventory.items = [
    null, // not an object
    'nope', // primitive entry
    42, // number entry
    ['array'], // array entry
    { count: 5 }, // missing id
    { id: 42, count: 5 }, // non-string id
    { id: '', count: 5 }, // empty id
    { id: 'spirit-herb', count: -1 }, // negative count → unusable
    { id: 'spirit-herb', count: 0 }, // zero count → unusable
    { id: 'spirit-herb', count: NaN }, // non-finite count → unusable
    { id: 'spirit-herb', count: Infinity }, // non-finite count → unusable
    { id: '__proto__', count: 5 }, // prototype-alias id → skipped (defense)
    { id: 'spirit-herb', count: '7' }, // numeric string → normalized to 7
    { id: 'qi-condensation-pill', count: 3 }, // healthy
  ];

  const system = makeSystem({ state }); // must not throw

  // Only the two usable stacks survive; the numeric string coerced to 7.
  assert.deepEqual(state.inventory.items, [
    { id: 'spirit-herb', count: 7 },
    { id: 'qi-condensation-pill', count: 3 },
  ]);
  // slots.used was recomputed from the actual stacks (2), not the stored 99.
  assert.equal(state.inventory.slots.used, 2);
  assert.equal(system.usedSlots, 2);
  assert.equal(system.remainingSlots, 18);
  assert.equal(system.count('spirit-herb'), 7);
  assert.equal(system.count('qi-condensation-pill'), 3);
});

test('an invalid stored slots.total falls back to the canonical 20', () => {
  // No config inventory block here — the stored value must be the deciding
  // factor (a configured total would override it by design).
  for (const bad of [0, -5, 2.5, 'abc', Infinity, NaN]) {
    const state = structuredClone(GameState);
    state.inventory.slots.total = bad;
    state.inventory.items = [{ id: 'spirit-herb', count: 3 }];

    const system = makeSystem({ config: {}, state }); // must not throw
    assert.equal(system.totalSlots, 20, `stored total ${String(bad)} must fall back to 20`);
    assert.equal(system.remainingSlots, 19); // used 1 recomputed from the stack
  }
});

test('restored non-array items and non-object slots are repaired on construction', () => {
  // A healthy slice whose items is a non-array (here: a primitive) → [].
  const noItems = structuredClone(GameState);
  noItems.inventory = { slots: { total: 20, used: 5 }, items: 'junk' };
  makeSystem({ state: noItems }); // must not throw
  assert.deepEqual(noItems.inventory.items, []);
  assert.equal(noItems.inventory.slots.used, 0); // recomputed, never trusted

  // items null → [] too.
  const nullItems = structuredClone(GameState);
  nullItems.inventory = { slots: { total: 20, used: 5 }, items: null };
  makeSystem({ state: nullItems });
  assert.deepEqual(nullItems.inventory.items, []);
  assert.equal(nullItems.inventory.slots.used, 0);

  // slots not an object → a fresh slots container, used recomputed.
  const badSlots = structuredClone(GameState);
  badSlots.inventory = { slots: null, items: [{ id: 'spirit-herb', count: 3 }] };
  const system = makeSystem({ state: badSlots }); // must not throw
  assert.deepEqual(badSlots.inventory.slots, { total: 20, used: 1 });
  assert.equal(system.count('spirit-herb'), 3);
});

test('a malformed inventory slice is repaired before any read, not only at construction', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state });
  system.add('spirit-herb', 5);

  // External corruption after construction must be repaired on the next call.
  state.inventory = null;
  assert.equal(system.count('spirit-herb'), 0); // repaired, never throws
  assert.deepEqual(state.inventory, { slots: { total: 20, used: 0 }, items: [] });

  // Corrupted items after construction are repaired too.
  state.inventory.items = ['junk', null, { id: 'spirit-herb', count: 2 }];
  assert.equal(system.remove('spirit-herb', 1), 1);
  assert.deepEqual(state.inventory.items, [{ id: 'spirit-herb', count: 1 }]);
  assert.equal(state.inventory.slots.used, 1);
});

// --- absent dataManager -----------------------------------------------------

test('add() rejects every item when no dataManager is available, without crashing', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('inventory:changed', (payload) => changed.push(payload));
  const system = makeSystem({ state, dataManager: null });

  // Every id is unknown without a definition resolver — warn + 0, nothing
  // added, never a hardcoded fallback.
  assert.equal(system.add('spirit-herb', 5), 0);
  assert.equal(system.add('qi-condensation-pill', 3), 0);
  assert.equal(warn.mock.callCount(), 2);
  assert.deepEqual(state.inventory.items, []);
  assert.equal(state.inventory.slots.used, 0);
  assert.equal(changed.length, 0);
  assert.equal(system.count('spirit-herb'), 0);

  // Reads still work and the system remains usable.
  assert.equal(system.totalSlots, 20);
  assert.equal(system.remainingSlots, 20);
});
