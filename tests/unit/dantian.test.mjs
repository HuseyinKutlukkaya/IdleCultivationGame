/**
 * tests/unit/dantian.test.mjs — unit tests for
 * js/systems/dantian.js.
 *
 * Exercises the DantianSystem (single owner of the cultivator's dantian
 * state and its multiplier slots) against a fake DataManager lookalike
 * serving the 'dantian' ladder — the same injection pattern the shipped
 * bootstrap uses. Covered: construction boot-sync (fresh state stays
 * normal with all cultivation slots at 1; a restored dantian lands its
 * multipliers in the slots before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setDantian() writing
 * ALL owned locations (state.dantian fields,
 * cultivation.dantianCapacityMultiplier,
 * cultivation.dantianDensityMultiplier,
 * cultivation.dantianPurityMultiplier,
 * cultivation.dantianEfficiencyMultiplier, player.dantian), setDantian()
 * rejecting unknown ids and empty/non-string ids, the no-dataManager neutral
 * degradation (count 0, setDantian returns null, zero state writes),
 * hostile-definition coercion/skipping (non-objects, missing/empty ids
 * skipped; missing name/multipliers coerced to safe defaults — an unusable
 * factor can never poison the slot), restore-trust slice repair (malformed
 * dantian/cultivation/player slices never abort boot), old-save compatibility
 * (no dantian slice → repaired to normal, all slots 1), the hostile restored
 * multiplier coercion (NaN/Infinity/negative → neutral 1, never a non-finite
 * slot write) and getCurrent() being a read-only defensive snapshot (mutating
 * it never leaks).
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine) and the shared EventBus (cleared in beforeEach so event
 * assertions start clean).
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { DantianSystem } from '../../js/systems/dantian.js';

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Recursively freeze a value (mirrors DataManager._deepFreeze) so the fake
 * definitions behave like real cached definitions at runtime.
 *
 * @param {*} value — value to deep-freeze.
 * @returns {*} the frozen value.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * The canonical fresh dantian slice (mirrors core/game-state.js) — the
 * normal state (all 1.0× multipliers).
 */
const NORMAL = {
  id: 'normal',
  name: 'Normal Dantian',
  capacityMultiplier: 1.0,
  densityMultiplier: 1.0,
  purityMultiplier: 1.0,
  efficiencyMultiplier: 1.0,
};

/**
 * The fixture dantian ladder — the same contract shape as the shipped
 * ladder (id, name, description, capacityMultiplier, densityMultiplier,
 * purityMultiplier, efficiencyMultiplier). Worst→best in ladder order:
 * Cracked → Void.
 */
const LADDER = deepFreeze([
  {
    id: 'cracked',
    name: 'Cracked Dantian',
    description: 'A fractured dantian that barely holds qi.',
    capacityMultiplier: 0.60,
    densityMultiplier: 0.60,
    purityMultiplier: 0.60,
    efficiencyMultiplier: 0.60,
  },
  {
    id: 'small',
    name: 'Small Dantian',
    description: 'A cramped dantian — enough to cultivate, barely.',
    capacityMultiplier: 0.80,
    densityMultiplier: 0.80,
    purityMultiplier: 0.80,
    efficiencyMultiplier: 0.80,
  },
  {
    id: 'normal',
    name: 'Normal Dantian',
    description: 'A standard-sized dantian — a solid foundation.',
    capacityMultiplier: 1.00,
    densityMultiplier: 1.00,
    purityMultiplier: 1.00,
    efficiencyMultiplier: 1.00,
  },
  {
    id: 'large',
    name: 'Large Dantian',
    description: 'An expanded dantian — qi reserves deepen.',
    capacityMultiplier: 1.40,
    densityMultiplier: 1.20,
    purityMultiplier: 1.15,
    efficiencyMultiplier: 1.10,
  },
  {
    id: 'perfect',
    name: 'Perfect Dantian',
    description: 'A flawless dantian — qi condenses without waste.',
    capacityMultiplier: 1.80,
    densityMultiplier: 1.50,
    purityMultiplier: 1.35,
    efficiencyMultiplier: 1.25,
  },
  {
    id: 'golden',
    name: 'Golden Dantian',
    description: 'A dantian tempered to gold — qi burns like a furnace.',
    capacityMultiplier: 2.50,
    densityMultiplier: 2.00,
    purityMultiplier: 1.70,
    efficiencyMultiplier: 1.50,
  },
  {
    id: 'universe',
    name: 'Universe Dantian',
    description: 'A dantian that mirrors a universe within — qi is endless.',
    capacityMultiplier: 4.00,
    densityMultiplier: 3.00,
    purityMultiplier: 2.50,
    efficiencyMultiplier: 2.00,
  },
  {
    id: 'void',
    name: 'Void Dantian',
    description: 'A dantian that is the void itself — qi bends to the cultivator\'s will.',
    capacityMultiplier: 6.00,
    densityMultiplier: 5.00,
    purityMultiplier: 4.00,
    efficiencyMultiplier: 3.00,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'dantian' ladder
 * through getAll — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.dantian] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ dantian = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'dantian') return [...dantian];
      return [];
    },
  };
}

/**
 * Build a DantianSystem instance with a fresh state clone (unless
 * overridden) and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, dantian: DantianSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const dantian = new DantianSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, dantian, dataManager };
}

test('fresh-boot state stays normal with all cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { dantian } = makeSystem({ state });

  // The ladder snapshot loaded (8 canonical entries) and the fresh dantian
  // is the canonical normal state.
  assert.equal(dantian.count, 8);
  assert.deepEqual(state.dantian, NORMAL);
  assert.equal(state.cultivation.dantianCapacityMultiplier, 1.0);
  assert.equal(state.cultivation.dantianDensityMultiplier, 1.0);
  assert.equal(state.cultivation.dantianPurityMultiplier, 1.0);
  assert.equal(state.cultivation.dantianEfficiencyMultiplier, 1.0);
  assert.equal(state.player.dantian, 'Normal Dantian');
  assert.deepEqual(dantian.getCurrent(), NORMAL);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { dantian } = makeSystem();

  assert.equal(dantian.count, 8);
  assert.equal(dantian.byId('cracked').name, 'Cracked Dantian');
  assert.equal(dantian.byId('cracked').capacityMultiplier, 0.60);
  assert.equal(dantian.byId('void').capacityMultiplier, 6.00);
  assert.equal(dantian.byId('void').efficiencyMultiplier, 3.00);
  assert.equal(dantian.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = dantian.byId('normal');
  copy.name = 'Hacked';
  assert.equal(dantian.byId('normal').name, 'Normal Dantian');
});

test('setDantian() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['cracked', 0.60, 0.60, 0.60, 0.60],
    ['small', 0.80, 0.80, 0.80, 0.80],
    ['normal', 1.00, 1.00, 1.00, 1.00],
    ['large', 1.40, 1.20, 1.15, 1.10],
    ['perfect', 1.80, 1.50, 1.35, 1.25],
    ['golden', 2.50, 2.00, 1.70, 1.50],
    ['universe', 4.00, 3.00, 2.50, 2.00],
    ['void', 6.00, 5.00, 4.00, 3.00],
  ];
  for (const [id, capacity, density, purity, efficiency] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { dantian } = makeSystem({ state });

    const result = dantian.setDantian(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, capacityMultiplier: capacity, densityMultiplier: density, purityMultiplier: purity, efficiencyMultiplier: efficiency },
      `setDantian("${id}")`
    );

    // The setDantian writes ALL owned locations.
    assert.deepEqual(state.dantian, {
      id,
      name: definition.name,
      capacityMultiplier: capacity,
      densityMultiplier: density,
      purityMultiplier: purity,
      efficiencyMultiplier: efficiency,
    });
    assert.equal(state.cultivation.dantianCapacityMultiplier, capacity);
    assert.equal(state.cultivation.dantianDensityMultiplier, density);
    assert.equal(state.cultivation.dantianPurityMultiplier, purity);
    assert.equal(state.cultivation.dantianEfficiencyMultiplier, efficiency);
    assert.equal(state.player.dantian, definition.name);
    // The read API agrees with the written state.
    assert.equal(dantian.getCurrent().id, id);
  }
});

test('setDantian() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { dantian } = makeSystem({ state });

    const result = dantian.setDantian(id);
    assert.equal(result, null);
    assert.deepEqual(state.dantian, before.dantian);
    assert.equal(state.cultivation.dantianCapacityMultiplier, before.cultivation.dantianCapacityMultiplier);
    assert.equal(state.player.dantian, before.player.dantian);
  }
});

test('setDantian() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { dantian } = makeSystem({ state });

    const result = dantian.setDantian(id);
    assert.equal(result, null);
    assert.deepEqual(state.dantian, before.dantian);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setDantian returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { dantian } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({ state: structuredClone(GameState), dataManager: { getAll: () => [] } });

  assert.equal(dantian.count, 0);
  assert.equal(dantian.byId('normal'), null);
  assert.equal(dantian.setDantian('normal'), null);
  assert.deepEqual(dantian.getCurrent(), NORMAL);
  // Zero state writes: the rejected setDantian left every slice untouched.
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.dantian.count, 0);
  assert.equal(empty.dantian.setDantian('normal'), null);
  assert.deepEqual(empty.state.dantian, NORMAL);
  assert.equal(empty.state.cultivation.dantianCapacityMultiplier, 1.0);
});

test('hostile dantian definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', capacityMultiplier: 0.5, densityMultiplier: 1, purityMultiplier: 1, efficiencyMultiplier: 1 },
    // Skipped: empty id.
    { id: '', name: 'Empty', capacityMultiplier: 1, densityMultiplier: 1, purityMultiplier: 1, efficiencyMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, capacityMultiplier: 'bogus', densityMultiplier: 'bad', purityMultiplier: -5, efficiencyMultiplier: NaN },
    // Coerced: hostile multipliers neutralize to 1.
    {
      id: 'clamped',
      name: 'Clamped',
      capacityMultiplier: Infinity,
      densityMultiplier: 0,
      purityMultiplier: 0,
      efficiencyMultiplier: -3,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', capacityMultiplier: 2, densityMultiplier: 2, purityMultiplier: 2, efficiencyMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { dantian } = makeSystem({ state, dataManager: makeDataManager({ dantian: hostile }) });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(dantian.count, 2);
  assert.deepEqual(dantian.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    capacityMultiplier: 1, // bogus → neutral 1
    densityMultiplier: 1, // bad → neutral 1
    purityMultiplier: 1, // -5 → neutral 1
    efficiencyMultiplier: 1, // NaN → neutral 1
  });
  assert.deepEqual(dantian.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    capacityMultiplier: 1, // Infinity → neutral 1
    densityMultiplier: 1, // 0 → neutral 1
    purityMultiplier: 1, // 0 → neutral 1
    efficiencyMultiplier: 1, // -3 → neutral 1
  });

  // setDantian over the hostile ladder still writes safe values — a set
  // entry's multipliers can never poison the slots.
  const result = dantian.setDantian('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.dantianCapacityMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.dantianCapacityMultiplier), true);
});

test('restore-trust: malformed dantian/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.dantian = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { dantian } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps all cultivation slots at the neutral 1.
    assert.deepEqual(state.dantian, NORMAL);
    assert.equal(state.cultivation.dantianCapacityMultiplier, 1.0);
    assert.equal(state.cultivation.dantianDensityMultiplier, 1.0);
    assert.equal(state.player.dantian, 'Normal Dantian');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(dantian.count, 8); // the ladder still loaded
    assert.deepEqual(dantian.getCurrent(), NORMAL);

    // The repaired player slice accepts setDantian's write.
    const result = dantian.setDantian('large');
    assert.equal(result.id, 'large');
    assert.equal(state.player.dantian, 'Large Dantian');
  }
});

test('old-save compatibility: a save without the dantian keys repairs to normal, all slots 1', () => {
  const state = structuredClone(GameState);
  delete state.dantian;
  delete state.cultivation.dantianCapacityMultiplier;
  delete state.cultivation.dantianDensityMultiplier;
  delete state.cultivation.dantianPurityMultiplier;
  delete state.cultivation.dantianEfficiencyMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { dantian } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.dantian, NORMAL);
  assert.equal(state.cultivation.dantianCapacityMultiplier, 1.0);
  assert.equal(state.cultivation.dantianDensityMultiplier, 1.0);
  assert.equal(state.cultivation.dantianPurityMultiplier, 1.0);
  assert.equal(state.cultivation.dantianEfficiencyMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(dantian.getCurrent(), NORMAL);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.dantian.capacityMultiplier = multiplier;
    state.dantian.densityMultiplier = multiplier;
    state.dantian.purityMultiplier = multiplier;
    state.dantian.efficiencyMultiplier = multiplier;

    const { dantian } = makeSystem({ state }); // must not throw

    assert.equal(dantian.getCurrent().capacityMultiplier, 1);
    assert.equal(dantian.getCurrent().densityMultiplier, 1);
    assert.equal(dantian.getCurrent().purityMultiplier, 1);
    assert.equal(dantian.getCurrent().efficiencyMultiplier, 1);
    assert.equal(Number.isFinite(dantian.getCurrent().capacityMultiplier), true);
  }
});

test('a restored dantian lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.dantian = {
    id: 'large',
    name: 'Large Dantian',
    capacityMultiplier: 1.40,
    densityMultiplier: 1.20,
    purityMultiplier: 1.15,
    efficiencyMultiplier: 1.10,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes cultivation slots only — same pattern as MeridianSystem).
  state.player.dantian = 'Large Dantian';

  const { dantian } = makeSystem({ state });

  // The constructor sync wrote the restored dantian's multipliers into the
  // slots the QiSystem and future systems read from the first tick.
  assert.equal(state.cultivation.dantianCapacityMultiplier, 1.40);
  assert.equal(state.cultivation.dantianDensityMultiplier, 1.20);
  assert.equal(state.cultivation.dantianPurityMultiplier, 1.15);
  assert.equal(state.cultivation.dantianEfficiencyMultiplier, 1.10);
  assert.equal(state.player.dantian, 'Large Dantian');
  assert.deepEqual(dantian.getCurrent(), {
    id: 'large',
    name: 'Large Dantian',
    capacityMultiplier: 1.40,
    densityMultiplier: 1.20,
    purityMultiplier: 1.15,
    efficiencyMultiplier: 1.10,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.dantian = {
    id: 'golden',
    name: 'Golden Dantian',
    capacityMultiplier: 2.50,
    densityMultiplier: 2.00,
    purityMultiplier: 1.70,
    efficiencyMultiplier: 1.50,
  };
  const { dantian } = makeSystem({ state });

  const snapshot = dantian.getCurrent();
  snapshot.id = 'hacked';
  snapshot.capacityMultiplier = 999;
  snapshot.purityMultiplier = -1;

  const again = dantian.getCurrent();
  assert.equal(again.id, 'golden');
  assert.equal(again.capacityMultiplier, 2.50);
  assert.equal(again.purityMultiplier, 1.70);
});
