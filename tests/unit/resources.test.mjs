/**
 * tests/unit/resources.test.mjs — unit tests for js/systems/resources.js.
 *
 * Exercises the ResourceSystem (single owner of the wallet resources): the
 * config-driven item list (missing block silent, non-array items warns once,
 * malformed entries skipped with warnings, label fallback, duplicate ids keep
 * the first and warn), restore-trust slice repair (null/primitive/array
 * state.resources restored to the canonical fresh slice on construction AND
 * before any read/write, healthy slices keep their own fields), the wallet
 * primitives (get with silent fail-safe coercion, canAfford, add with cap
 * clamping and the finite-write guard, spend with negative deltas and its
 * fail-safes), the 'resource:changed' payload { id, label, delta, total },
 * safe capPath resolution (missing/unsafe/non-finite caps treated as
 * uncapped, Object.prototype never polluted), the defensive-copy resources
 * getter and per-resource independence.
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine) and the shared EventBus (cleared in beforeEach so event
 * assertions start clean). No clock or loop is needed — ResourceSystem is a
 * pure wallet API and never subscribes to 'loop:update'.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { ResourceSystem } from '../../js/systems/resources.js';

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a standard config with a resources block (mirrors the real
 * data/game-config.json block) plus optional overrides.
 *
 * @param {object} [overrides] — key/values merged over the resources block.
 * @returns {object} a config object.
 */
function makeConfig(overrides = {}) {
  return {
    resources: {
      items: [
        { id: 'spiritStones', label: 'Spirit Stones' },
        { id: 'herbs', label: 'Herbs' },
        { id: 'jade', label: 'Jade' },
        { id: 'qiCondensationPills', label: 'Qi Condensation Pills' },
      ],
      ...overrides,
    },
  };
}

/**
 * Build a ResourceSystem instance with a fresh state clone (unless overridden).
 *
 * Tests below pin wallet mechanics at a 0-stones baseline so the assertion
 * surface stays predictable — the master's parting gift (50 stones, see
 * js/core/game-state.js) is a production-only concern. The fixture zeroes
 * spiritStones when the slice still carries the canonical 50-gift (i.e.
 * either a fresh clone OR an explicit `state` that nobody touched); a
 * non-canonical spiritStones (a test that explicitly set spiritStones to
 * 42, or set state.resources to null / array / a primitive) is left
 * untouched so the test's own setup survives. This way the default fixture
 * is the empty-wallet baseline, and tests that want different baselines
 * stay self-describing.
 *
 * @param {object} [config] — config to inject (defaults to makeConfig()).
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @returns {ResourceSystem} the system instance.
 */
function makeSystem(config = makeConfig(), state) {
  const effective = state === undefined ? structuredClone(GameState) : state;
  // Test fixture: zero the canonical gift so wallet-math assertions operate
  // at the empty-wallet baseline. A slice that already carries a different
  // value (set by a test, or repaired from a malformed shape) is left
  // alone — the test's intent or the repair path stays observable.
  if (
    effective.resources
    && typeof effective.resources === 'object'
    && !Array.isArray(effective.resources)
    && effective.resources.spiritStones === 50
  ) {
    effective.resources.spiritStones = 0;
  }
  return new ResourceSystem({ config, state: effective, eventBus: EventBus });
}

test('a missing config.resources block is silent and manages nothing', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem({}, state);

  // No warning for the missing block and no declared resources.
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(system.resources, []);

  // Reads are silent and fail-safe against undeclared ids.
  assert.equal(system.get('spiritStones'), 0);
  assert.equal(system.canAfford('spiritStones', 5), false);
  assert.equal(warn.mock.callCount(), 0);

  // Writes against undeclared ids warn and fail safe — nothing managed.
  assert.equal(system.add('spiritStones', 5), 0);
  assert.equal(system.spend('spiritStones', 5), false);
  assert.equal(warn.mock.callCount(), 2);
  assert.equal(state.resources.spiritStones, 0);
});

test('a non-array resources.items warns once and yields no resources', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const system = makeSystem(makeConfig({ items: 'spiritStones' }));

  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(system.resources, []);
});

test('malformed items are skipped with warnings, valid ones are kept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const config = makeConfig({
    items: [
      null, // not an object
      'not-an-object', // non-object entry
      ['array'], // array entry
      { label: 'No Id' }, // missing id
      { id: 42 }, // non-string id
      { id: '' }, // empty id
      { id: 'spiritStones' }, // no label → falls back to the id
      { id: 'herbs', label: 'Herbs' }, // full label
      { id: 'jade', label: 'Jade', capPath: 'resources.jadeCap' },
      { id: 'qiCondensationPills', capPath: 42 }, // non-string capPath → null
      { id: 'spiritStones', label: 'Dupe' }, // duplicate → keep the first, warn
    ],
  });

  const system = makeSystem(config);

  // null + non-object + array + missing id + non-string id + empty id +
  // duplicate = seven warnings; the four valid entries are kept.
  assert.equal(warn.mock.callCount(), 7);
  assert.deepEqual(system.resources, [
    { id: 'spiritStones', label: 'spiritStones', capPath: null },
    { id: 'herbs', label: 'Herbs', capPath: null },
    { id: 'jade', label: 'Jade', capPath: 'resources.jadeCap' },
    { id: 'qiCondensationPills', label: 'qiCondensationPills', capPath: null },
  ]);
});

test('prototype-alias ids are rejected at config read and stay unknown', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const config = makeConfig({
    items: [
      { id: '__proto__', label: 'Proto' },
      { id: 'constructor', label: 'Ctor' },
      { id: 'prototype', label: 'ProtoType' },
      { id: 'spiritStones', label: 'Spirit Stones' },
    ],
  });
  const state = structuredClone(GameState);
  const system = makeSystem(config, state);

  // All three prototype-alias ids are skipped with a warning; the safe id
  // in the same config is kept — the guard only drops the unsafe entries.
  assert.equal(warn.mock.callCount(), 3);
  assert.deepEqual(system.resources, [
    { id: 'spiritStones', label: 'Spirit Stones', capPath: null },
  ]);

  // add()/spend() on a rejected id behave as unknown: warn + fail safe (no
  // write, no event), so the balance can never change behind a report.
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  assert.equal(system.add('__proto__', 5), 0);
  assert.equal(system.spend('constructor', 1), false);
  assert.equal(system.canAfford('prototype', 1), false);
  assert.equal(system.get('__proto__'), 0);
  assert.equal(warn.mock.callCount(), 5); // 3 config + add + spend
  assert.equal(changed.length, 0);

  // Object.prototype stays untouched.
  assert.equal({}.x, undefined);
  assert.equal({}.hasOwnProperty('x'), false);

  // The non-alias id from the same config is fully functional.
  assert.equal(system.add('spiritStones', 7), 7);
  assert.equal(state.resources.spiritStones, 7);
});

test('a malformed restored resources slice is repaired on construction', () => {
  const state = structuredClone(GameState);
  state.resources = null;

  const system = makeSystem(makeConfig(), state); // must not throw

  // Repaired to the canonical fresh resources slice (see core/game-state.js).
  // The master's parting gift lives at 50 stones on every repair — a
  // hostile save that nulls state.resources gets the canonical origin
  // endowment back, not a bare-zero restart (defense-in-depth: the
  // restore-trust path is lore-consistent).
  assert.deepEqual(state.resources, {
    spiritStones: 50,
    herbs: 0,
    jade: 0,
    qiCondensationPills: 0,
  });

  // Gains and spends flow normally after repair. The repaired slice
  // includes the master's parting gift (50 stones), so the post-spend
  // balance is 50 + 10 - 4 = 56.
  assert.equal(system.add('spiritStones', 10), 10);
  assert.equal(state.resources.spiritStones, 60);
  assert.equal(system.spend('spiritStones', 4), true);
  assert.equal(state.resources.spiritStones, 56);
});

test('restored primitive and array slices are repaired, healthy slices survive', () => {
  const primitive = structuredClone(GameState);
  primitive.resources = 5; // a primitive top-level slice
  makeSystem(makeConfig(), primitive); // must not throw
  assert.deepEqual(primitive.resources, {
    spiritStones: 50,
    herbs: 0,
    jade: 0,
    qiCondensationPills: 0,
  });

  const array = structuredClone(GameState);
  array.resources = [1, 2, 3]; // an array top-level slice
  makeSystem(makeConfig(), array); // must not throw
  assert.deepEqual(array.resources, {
    spiritStones: 50,
    herbs: 0,
    jade: 0,
    qiCondensationPills: 0,
  });

  // A healthy restored slice keeps its own fields — missing keys read as 0.
  const healthy = structuredClone(GameState);
  healthy.resources = { spiritStones: 42, herbs: 7 };
  const system = makeSystem(makeConfig(), healthy);
  assert.equal(healthy.resources.spiritStones, 42);
  assert.equal(healthy.resources.herbs, 7);
  assert.equal(system.get('jade'), 0); // undeclared-state key reads as 0
});

test('a malformed resources slice is repaired before any read, not only at construction', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(makeConfig(), state);

  // External corruption after construction must be repaired on the next call.
  // The repair re-seeds the master's parting gift (50 stones); get() reads
  // through the freshly repaired slice.
  state.resources = null;
  assert.equal(system.get('spiritStones'), 50); // repaired, never throws
  assert.deepEqual(state.resources, {
    spiritStones: 50,
    herbs: 0,
    jade: 0,
    qiCondensationPills: 0,
  });

  // A spend after an array-shaped corruption flows through the repair too;
  // the freshly repaired 50-stone balance makes the 1-stone spend succeed
  // (the wallet has enough — formerly the test pre-gift expected a zero
  // balance, but with the gift active a single-stone spend is affordable).
  state.resources = [];
  assert.equal(system.spend('spiritStones', 1), true);
  assert.deepEqual(state.resources, {
    spiritStones: 49,
    herbs: 0,
    jade: 0,
    qiCondensationPills: 0,
  });
});

test('get() reads balances through a silent fail-safe coercion', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  state.resources.spiritStones = 25;
  state.resources.herbs = '10'; // numeric string coerces
  state.resources.jade = Infinity; // non-finite → 0
  state.resources.qiCondensationPills = NaN; // → 0
  const system = makeSystem(makeConfig(), state);

  assert.equal(system.get('spiritStones'), 25);
  assert.equal(system.get('herbs'), 10);
  assert.equal(system.get('jade'), 0);
  assert.equal(system.get('qiCondensationPills'), 0);

  // A declared resource whose field is missing from a restored slice → 0.
  delete state.resources.herbs;
  assert.equal(system.get('herbs'), 0);

  // Unknown ids read as 0 silently (reads never warn).
  assert.equal(system.get('unknown'), 0);
  assert.equal(warn.mock.callCount(), 0);
});

test('add() writes state and emits resource:changed with a positive delta', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(makeConfig(), state);

  const added = system.add('spiritStones', 15);

  assert.equal(added, 15);
  assert.equal(state.resources.spiritStones, 15);
  assert.equal(changed.length, 1);
  // Payload shape: { id, label, delta, total } — the label from the
  // declaration, a positive delta and the post-change balance.
  assert.deepEqual(changed[0], {
    id: 'spiritStones',
    label: 'Spirit Stones',
    delta: 15,
    total: 15,
  });

  // The next add emits the running total.
  assert.equal(system.add('spiritStones', 5), 5);
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[1], {
    id: 'spiritStones',
    label: 'Spirit Stones',
    delta: 5,
    total: 20,
  });
  assert.equal(state.resources.spiritStones, 20);
});

test('add() clamps to the room below a declared cap', () => {
  const state = structuredClone(GameState);
  state.resources.herbsCap = '100'; // a numeric string cap coerces too
  state.resources.herbs = 90;
  const config = makeConfig({
    items: [
      { id: 'spiritStones', label: 'Spirit Stones' },
      { id: 'herbs', label: 'Herbs', capPath: 'resources.herbsCap' },
    ],
  });
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(config, state);

  // Room is 10 → only 10 of the requested 25 get added (returns the actual).
  assert.equal(system.add('herbs', 25), 10);
  assert.equal(state.resources.herbs, 100);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0], { id: 'herbs', label: 'Herbs', delta: 10, total: 100 });

  // At the cap: zero room → adds 0, no write, no event.
  assert.equal(system.add('herbs', 5), 0);
  assert.equal(state.resources.herbs, 100);
  assert.equal(changed.length, 1);

  // A resource without a capPath is uncapped.
  assert.equal(system.add('spiritStones', 25), 25);
  assert.equal(state.resources.spiritStones, 25);
});

test('add() with a non-positive or non-finite amount writes nothing', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(makeConfig(), state);

  assert.equal(system.add('spiritStones', 0), 0);
  assert.equal(system.add('spiritStones', -3), 0);
  assert.equal(system.add('spiritStones', Infinity), 0);
  assert.equal(system.add('spiritStones', NaN), 0);
  assert.equal(system.add('spiritStones', 'not-a-number'), 0);
  assert.equal(system.add('spiritStones'), 0); // undefined amount → 0
  assert.equal(state.resources.spiritStones, 0);
  assert.equal(changed.length, 0);

  // Unknown id → warns once, returns 0, writes nothing.
  assert.equal(system.add('unknown', 5), 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(state.resources.unknown, undefined);
  assert.equal(changed.length, 0);
});

test('the finite-write guard skips an add that would overflow to Infinity', () => {
  const state = structuredClone(GameState);
  state.resources.spiritStones = 1e308; // restored near the double limit
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(makeConfig(), state);

  // 1e308 + 1e308 is not finite → the whole add is skipped: no write, no
  // event, the balance stays untouched and finite.
  assert.equal(system.add('spiritStones', 1e308), 0);
  assert.equal(state.resources.spiritStones, 1e308);
  assert.equal(changed.length, 0);
  assert.equal(Number.isFinite(state.resources.spiritStones), true);
});

test('spend() deducts and emits resource:changed with a negative delta', () => {
  const state = structuredClone(GameState);
  state.resources.jade = 50;
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(makeConfig(), state);

  assert.equal(system.spend('jade', 20), true);
  assert.equal(state.resources.jade, 30);
  assert.equal(changed.length, 1);
  // delta is SIGNED — a spend carries a negative delta; total is post-change.
  assert.deepEqual(changed[0], { id: 'jade', label: 'Jade', delta: -20, total: 30 });

  // Spending down to exactly zero still writes and emits.
  assert.equal(system.spend('jade', 30), true);
  assert.equal(state.resources.jade, 0);
  assert.equal(changed.length, 2);
  assert.deepEqual(changed[1], { id: 'jade', label: 'Jade', delta: -30, total: 0 });
});

test('spend() fails safely for insufficient, non-positive or unknown targets', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  state.resources.spiritStones = 10;
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(makeConfig(), state);

  // Insufficient balance → false, no write, no event.
  assert.equal(system.spend('spiritStones', 11), false);
  assert.equal(state.resources.spiritStones, 10);
  assert.equal(changed.length, 0);

  // An exact-balance spend passes.
  assert.equal(system.spend('spiritStones', 10), true);
  assert.equal(state.resources.spiritStones, 0);
  assert.equal(changed.length, 1);

  // Non-positive amounts → false (nothing deducted).
  assert.equal(system.spend('spiritStones', 0), false);
  assert.equal(system.spend('spiritStones', -1), false);
  assert.equal(system.spend('spiritStones', NaN), false);
  assert.equal(state.resources.spiritStones, 0);
  assert.equal(changed.length, 1);

  // Unknown id → warns once, false.
  assert.equal(system.spend('unknown', 5), false);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(state.resources.unknown, undefined);
  assert.equal(changed.length, 1);
});

test('canAfford() reports affordability without ever warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const system = makeSystem(makeConfig(), state);

  // makeSystem() always zeroes spiritStones; preset a non-zero balance on
  // the constructed system (the wallet primitive the rest of the test
  // exercises) without re-coupling to a passing-in convention.
  state.resources.spiritStones = 10;

  assert.equal(system.canAfford('spiritStones', 10), true);
  assert.equal(system.canAfford('spiritStones', 11), false);
  assert.equal(system.canAfford('spiritStones', 0), true);
  assert.equal(system.canAfford('spiritStones', -5), true);
  assert.equal(system.canAfford('spiritStones', Infinity), true); // coerces to 0

  // Unknown ids fail silently — reads never warn.
  assert.equal(system.canAfford('unknown', 1), false);
  assert.equal(warn.mock.callCount(), 0);
});

test('the resources getter returns defensive copies with normalized capPath', () => {
  const config = makeConfig({
    items: [
      { id: 'spiritStones', label: 'Spirit Stones' },
      { id: 'herbs', label: 'Herbs', capPath: 'resources.herbsCap' },
    ],
  });
  const system = makeSystem(config);

  // Mutating a returned copy must not leak back into the system.
  const copy = system.resources;
  copy[0].id = 'hacked';
  copy[0].label = 'Hacked';
  copy[0].capPath = 'evil';

  // capPath is null when absent and a string when declared.
  assert.deepEqual(system.resources, [
    { id: 'spiritStones', label: 'Spirit Stones', capPath: null },
    { id: 'herbs', label: 'Herbs', capPath: 'resources.herbsCap' },
  ]);
});

test('unsafe capPaths are treated as uncapped and never pollute Object.prototype', () => {
  for (const capPath of ['__proto__.x', 'constructor.prototype.x']) {
    EventBus.clear();
    const config = makeConfig({
      items: [{ id: 'spiritStones', label: 'Spirit Stones', capPath }],
    });
    const state = structuredClone(GameState);

    const system = makeSystem(config, state); // construction never throws

    // Uncapped: the huge add is not clamped by the poisoned path.
    assert.equal(system.add('spiritStones', 50), 50);
    assert.equal(state.resources.spiritStones, 50);
    // Object.prototype is untouched, whatever the path looked like.
    assert.equal({}.x, undefined);
    assert.equal({}.hasOwnProperty('x'), false);
  }
});

test('an unresolvable capPath is treated as uncapped', () => {
  const config = makeConfig({
    items: [{ id: 'herbs', label: 'Herbs', capPath: 'resources.herbsMissingCap' }],
  });
  const state = structuredClone(GameState); // no herbsMissingCap field
  const system = makeSystem(config, state);

  assert.equal(system.add('herbs', 42), 42);
  assert.equal(state.resources.herbs, 42);
});

test('a capPath resolving to null or a non-finite value is treated as uncapped', () => {
  const config = makeConfig({
    items: [
      { id: 'a', label: 'A', capPath: 'resources.aCap' },
      { id: 'b', label: 'B', capPath: 'resources.bCap' },
    ],
  });
  const state = structuredClone(GameState);
  state.resources.aCap = null; // null cap → uncapped
  state.resources.bCap = Infinity; // non-finite cap → uncapped
  const system = makeSystem(config, state);

  assert.equal(system.add('a', 100), 100);
  assert.equal(system.add('b', 100), 100);
  assert.equal(state.resources.a, 100);
  assert.equal(state.resources.b, 100);
});

test('resources are independent — touching one never affects another', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('resource:changed', (payload) => changed.push(payload));
  const system = makeSystem(makeConfig(), state);

  system.add('spiritStones', 10);
  system.add('herbs', 3);
  system.spend('spiritStones', 4);

  assert.equal(state.resources.spiritStones, 6);
  assert.equal(state.resources.herbs, 3);
  assert.equal(state.resources.jade, 0);
  assert.equal(state.resources.qiCondensationPills, 0);
  assert.deepEqual(changed.map((p) => p.id), ['spiritStones', 'herbs', 'spiritStones']);
  assert.deepEqual(changed.map((p) => p.delta), [10, 3, -4]);
});

