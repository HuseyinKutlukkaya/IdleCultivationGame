/**
 * tests/unit/physiques.test.mjs — unit tests for
 * js/systems/physiques.js.
 *
 * Exercises the PhysiqueSystem (single owner of the cultivator's physique
 * state and its multiplier slots) against a fake DataManager lookalike
 * serving the 'physiques' ladder — the same injection pattern the shipped
 * bootstrap uses. Covered: construction boot-sync (fresh state stays
 * ordinary with the breakthrough-bonus slot at 0; a restored physique lands
 * its bonus in the slot before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setPhysique() writing
 * ALL owned locations (state.physiques fields,
 * cultivation.physiqueBreakthroughBonus, player.physique), setPhysique()
 * rejecting unknown ids and empty/non-string ids, the no-dataManager neutral
 * degradation (count 0, setPhysique returns null, zero state writes),
 * hostile-definition coercion/skipping (non-objects, missing/empty ids
 * skipped; missing name/multipliers/bonus coerced to safe defaults — an
 * unusable factor can never poison the slot), restore-trust slice repair
 * (malformed physiques/cultivation/player slices never abort boot), old-save
 * compatibility (no physiques slice → repaired to ordinary, bonus 0), the
 * hostile restored multiplier/bonus coercion (NaN/Infinity/negative → neutral
 * 1 / 0, never a non-finite slot write) and getCurrent() being a read-only
 * defensive snapshot (mutating it never leaks).
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
import { PhysiqueSystem } from '../../js/systems/physiques.js';

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
 * The canonical fresh physiques slice (mirrors core/game-state.js) — the
 * ordinary state (1.0× multipliers, zero breakthrough bonus).
 */
const ORDINARY = {
  id: 'ordinary',
  name: 'Ordinary Body',
  breakthroughBonus: 0,
  lifespanMultiplier: 1,
  healthMultiplier: 1,
  powerMultiplier: 1,
};

/**
 * The fixture physique ladder — the same contract shape as the shipped
 * ladder (id, name, description, breakthroughBonus, lifespanMultiplier,
 * healthMultiplier, powerMultiplier). Worst→best in ladder order:
 * Ordinary → Chaos.
 */
const LADDER = deepFreeze([
  {
    id: 'ordinary',
    name: 'Ordinary Body',
    description: 'An unremarkable mortal physique.',
    breakthroughBonus: 0.00,
    lifespanMultiplier: 1.0,
    healthMultiplier: 1.0,
    powerMultiplier: 1.0,
  },
  {
    id: 'iron-body',
    name: 'Iron Body',
    description: 'A tempered body, hard as iron.',
    breakthroughBonus: 0.05,
    lifespanMultiplier: 1.2,
    healthMultiplier: 1.3,
    powerMultiplier: 1.2,
  },
  {
    id: 'jade-body',
    name: 'Jade Body',
    description: 'A flawless body like precious jade.',
    breakthroughBonus: 0.10,
    lifespanMultiplier: 1.5,
    healthMultiplier: 1.6,
    powerMultiplier: 1.5,
  },
  {
    id: 'saint-body',
    name: 'Saint Body',
    description: 'A holy physique, blessed by the heavens.',
    breakthroughBonus: 0.18,
    lifespanMultiplier: 2.0,
    healthMultiplier: 2.0,
    powerMultiplier: 2.0,
  },
  {
    id: 'immortal-body',
    name: 'Immortal Body',
    description: 'An ageless body that defies mortality.',
    breakthroughBonus: 0.25,
    lifespanMultiplier: 5.0,
    healthMultiplier: 4.0,
    powerMultiplier: 3.5,
  },
  {
    id: 'chaos-body',
    name: 'Chaos Body',
    description: 'A primordial physique born of chaos itself.',
    breakthroughBonus: 0.35,
    lifespanMultiplier: 10.0,
    healthMultiplier: 8.0,
    powerMultiplier: 7.0,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'physiques' ladder
 * through getAll — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.physiques] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ physiques = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'physiques') return [...physiques];
      return [];
    },
  };
}

/**
 * Build a PhysiqueSystem instance with a fresh state clone (unless
 * overridden) and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, physiques: PhysiqueSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const physiques = new PhysiqueSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, physiques, dataManager };
}

test('fresh-boot state stays ordinary with the breakthrough-bonus slot at 0', () => {
  const state = structuredClone(GameState);
  const { physiques } = makeSystem({ state });

  // The ladder snapshot loaded (6 canonical entries) and the fresh physique
  // is the canonical ordinary state.
  assert.equal(physiques.count, 6);
  assert.deepEqual(state.physiques, ORDINARY);
  assert.equal(state.cultivation.physiqueBreakthroughBonus, 0);
  assert.equal(state.player.physique, 'Ordinary Body');
  assert.deepEqual(physiques.getCurrent(), ORDINARY);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { physiques } = makeSystem();

  assert.equal(physiques.count, 6);
  assert.equal(physiques.byId('iron-body').name, 'Iron Body');
  assert.equal(physiques.byId('iron-body').breakthroughBonus, 0.05);
  assert.equal(physiques.byId('chaos-body').powerMultiplier, 7.0);
  assert.equal(physiques.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = physiques.byId('ordinary');
  copy.name = 'Hacked';
  assert.equal(physiques.byId('ordinary').name, 'Ordinary Body');
});

test('setPhysique() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['ordinary', 0, 1.0, 1.0, 1.0],
    ['iron-body', 0.05, 1.2, 1.3, 1.2],
    ['jade-body', 0.10, 1.5, 1.6, 1.5],
    ['saint-body', 0.18, 2.0, 2.0, 2.0],
    ['immortal-body', 0.25, 5.0, 4.0, 3.5],
    ['chaos-body', 0.35, 10.0, 8.0, 7.0],
  ];
  for (const [id, breakthroughBonus, lifespanMultiplier, healthMultiplier, powerMultiplier] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { physiques } = makeSystem({ state });

    const result = physiques.setPhysique(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, breakthroughBonus, lifespanMultiplier, healthMultiplier, powerMultiplier },
      `setPhysique("${id}")`
    );

    // The setPhysique writes ALL owned locations.
    assert.deepEqual(state.physiques, {
      id,
      name: definition.name,
      breakthroughBonus,
      lifespanMultiplier,
      healthMultiplier,
      powerMultiplier,
    });
    assert.equal(state.cultivation.physiqueBreakthroughBonus, breakthroughBonus);
    assert.equal(state.player.physique, definition.name);
    // The read API agrees with the written state.
    assert.equal(physiques.getCurrent().id, id);
  }
});

test('setPhysique() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { physiques } = makeSystem({ state });

    const result = physiques.setPhysique(id);
    assert.equal(result, null);
    assert.deepEqual(state.physiques, before.physiques);
    assert.equal(state.cultivation.physiqueBreakthroughBonus, before.cultivation.physiqueBreakthroughBonus);
    assert.equal(state.player.physique, before.player.physique);
  }
});

test('setPhysique() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { physiques } = makeSystem({ state });

    const result = physiques.setPhysique(id);
    assert.equal(result, null);
    assert.deepEqual(state.physiques, before.physiques);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setPhysique returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { physiques } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({ state: structuredClone(GameState), dataManager: { getAll: () => [] } });

  assert.equal(physiques.count, 0);
  assert.equal(physiques.byId('ordinary'), null);
  assert.equal(physiques.setPhysique('ordinary'), null);
  assert.deepEqual(physiques.getCurrent(), ORDINARY);
  // Zero state writes: the rejected setPhysique left every slice untouched.
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.physiques.count, 0);
  assert.equal(empty.physiques.setPhysique('ordinary'), null);
  assert.deepEqual(empty.state.physiques, ORDINARY);
  assert.equal(empty.state.cultivation.physiqueBreakthroughBonus, 0);
});

test('hostile physique definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', breakthroughBonus: 0.5, lifespanMultiplier: 1, healthMultiplier: 1, powerMultiplier: 1 },
    // Skipped: empty id.
    { id: '', name: 'Empty', breakthroughBonus: 0, lifespanMultiplier: 1, healthMultiplier: 1, powerMultiplier: 1 },
    // Coerced: name/multipliers/bonus unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1, bonus to 0).
    { id: 'broken-def', name: 42, breakthroughBonus: 'bogus', lifespanMultiplier: 'bad', healthMultiplier: -5, powerMultiplier: NaN },
    // Coerced: hostile multipliers neutralize to 1, bonus to 0.
    {
      id: 'clamped',
      name: 'Clamped',
      breakthroughBonus: Infinity,
      lifespanMultiplier: 0,
      healthMultiplier: 0,
      powerMultiplier: -3,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', breakthroughBonus: 0.9, lifespanMultiplier: 2, healthMultiplier: 2, powerMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { physiques } = makeSystem({ state, dataManager: makeDataManager({ physiques: hostile }) });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(physiques.count, 2);
  assert.deepEqual(physiques.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    breakthroughBonus: 0, // bogus → neutral 0
    lifespanMultiplier: 1, // bad → neutral 1
    healthMultiplier: 1, // -5 → neutral 1
    powerMultiplier: 1, // NaN → neutral 1
  });
  assert.deepEqual(physiques.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    breakthroughBonus: 0, // Infinity → neutral 0
    lifespanMultiplier: 1, // 0 → neutral 1
    healthMultiplier: 1, // 0 → neutral 1
    powerMultiplier: 1, // -3 → neutral 1
  });

  // setPhysique over the hostile ladder still writes safe values — a rolled
  // entry's bonus/multipliers can never poison the slots.
  const result = physiques.setPhysique('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.physiqueBreakthroughBonus, 0);
  assert.equal(Number.isFinite(state.cultivation.physiqueBreakthroughBonus), true);
});

test('restore-trust: malformed physiques/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.physiques = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { physiques } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps the breakthrough-bonus slot at the neutral 0.
    assert.deepEqual(state.physiques, ORDINARY);
    assert.equal(state.cultivation.physiqueBreakthroughBonus, 0);
    assert.equal(state.player.physique, 'Ordinary Body');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(physiques.count, 6); // the ladder still loaded
    assert.deepEqual(physiques.getCurrent(), ORDINARY);

    // The repaired player slice accepts setPhysique's write.
    const result = physiques.setPhysique('iron-body');
    assert.equal(result.id, 'iron-body');
    assert.equal(state.player.physique, 'Iron Body');
  }
});

test('old-save compatibility: a save without the physiques keys repairs to ordinary, bonus 0', () => {
  const state = structuredClone(GameState);
  delete state.physiques;
  delete state.cultivation.physiqueBreakthroughBonus;
  state.cultivation.qi = 42; // the old save's own values still land

  const { physiques } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.physiques, ORDINARY);
  assert.equal(state.cultivation.physiqueBreakthroughBonus, 0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(physiques.getCurrent(), ORDINARY);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.physiques.lifespanMultiplier = multiplier;
    state.physiques.healthMultiplier = multiplier;
    state.physiques.powerMultiplier = multiplier;

    const { physiques } = makeSystem({ state }); // must not throw

    assert.equal(physiques.getCurrent().lifespanMultiplier, 1);
    assert.equal(physiques.getCurrent().healthMultiplier, 1);
    assert.equal(physiques.getCurrent().powerMultiplier, 1);
    assert.equal(Number.isFinite(physiques.getCurrent().lifespanMultiplier), true);
  }
});

test('a hostile restored breakthroughBonus is coerced to neutral 0', () => {
  for (const bonus of [NaN, Infinity, -Infinity, -1]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.physiques.breakthroughBonus = bonus;

    const { physiques } = makeSystem({ state }); // must not throw

    assert.equal(state.cultivation.physiqueBreakthroughBonus, 0);
    assert.equal(physiques.getCurrent().breakthroughBonus, 0);
    assert.equal(Number.isFinite(state.cultivation.physiqueBreakthroughBonus), true);
  }
});

test('a restored physique lands its bonus in the cultivation slot on boot', () => {
  const state = structuredClone(GameState);
  state.physiques = {
    id: 'iron-body',
    name: 'Iron Body',
    breakthroughBonus: 0.05,
    lifespanMultiplier: 1.2,
    healthMultiplier: 1.3,
    powerMultiplier: 1.2,
  };

  const { physiques } = makeSystem({ state });

  // The constructor sync wrote the restored physique's bonus into the slot
  // the BreakthroughSystem stacks into the outcome roll from the first
  // attempt; the display name is written.
  assert.equal(state.cultivation.physiqueBreakthroughBonus, 0.05);
  assert.equal(state.player.physique, 'Iron Body');
  assert.deepEqual(physiques.getCurrent(), {
    id: 'iron-body',
    name: 'Iron Body',
    breakthroughBonus: 0.05,
    lifespanMultiplier: 1.2,
    healthMultiplier: 1.3,
    powerMultiplier: 1.2,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.physiques = {
    id: 'jade-body',
    name: 'Jade Body',
    breakthroughBonus: 0.10,
    lifespanMultiplier: 1.5,
    healthMultiplier: 1.6,
    powerMultiplier: 1.5,
  };
  const { physiques } = makeSystem({ state });

  const snapshot = physiques.getCurrent();
  snapshot.id = 'hacked';
  snapshot.breakthroughBonus = 999;
  snapshot.powerMultiplier = -1;

  const again = physiques.getCurrent();
  assert.equal(again.id, 'jade-body');
  assert.equal(again.breakthroughBonus, 0.10);
  assert.equal(again.powerMultiplier, 1.5);
});
