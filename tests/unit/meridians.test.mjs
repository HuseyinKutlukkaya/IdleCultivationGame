/**
 * tests/unit/meridians.test.mjs — unit tests for
 * js/systems/meridians.js.
 *
 * Exercises the MeridianSystem (single owner of the cultivator's meridian
 * state and its qi-circulation multiplier slots) against a fake DataManager
 * lookalike serving the 'meridians' ladder — the same injection pattern the
 * shipped bootstrap uses. Covered: construction boot-sync (fresh state stays
 * normal with both cultivation slots at 1; a restored meridian lands its
 * factors in the slots before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setState() writing ALL
 * four owned locations (state.meridians fields,
 * cultivation.meridianCapacityMultiplier, cultivation.meridianFlowMultiplier,
 * player.meridians), setState() rejecting unknown ids and empty/non-string
 * ids, the no-dataManager neutral degradation (count 0, setState returns null,
 * zero state writes), hostile-definition coercion/skipping (non-objects,
 * missing/empty ids skipped; missing name/multipliers coerced to safe defaults
 * — an unusable factor can never poison the slot), restore-trust slice repair
 * (malformed meridians/cultivation/player slices never abort boot), old-save
 * compatibility (no meridians slice → repaired to normal, multipliers 1), the
 * hostile restored multiplier coercion (NaN/Infinity/negative/0 → neutral 1,
 * never a non-finite slot write) and getCurrent() being a read-only defensive
 * snapshot (mutating it never leaks).
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
import { MeridianSystem } from '../../js/systems/meridians.js';

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
 * The canonical fresh meridians slice (mirrors core/game-state.js) — the
 * normal state (1.0×1.0).
 */
const NORMAL = {
  id: 'normal',
  name: 'Normal',
  capacityMultiplier: 1.0,
  flowMultiplier: 1.0,
};

/**
 * The fixture meridian ladder — the same contract shape as the shipped
 * ladder (id, name, description, capacityMultiplier, flowMultiplier).
 * Worst→best in ladder order: Broken → Heavenly.
 */
const LADDER = deepFreeze([
  {
    id: 'broken',
    name: 'Broken',
    description: 'Shattered meridians — qi leaks through every crack.',
    capacityMultiplier: 0.70,
    flowMultiplier: 0.60,
  },
  {
    id: 'damaged',
    name: 'Damaged',
    description: 'Frayed meridians — qi flows sluggishly through partially blocked paths.',
    capacityMultiplier: 0.85,
    flowMultiplier: 0.80,
  },
  {
    id: 'normal',
    name: 'Normal',
    description: 'Healthy meridians — qi circulates steadily without obstruction.',
    capacityMultiplier: 1.00,
    flowMultiplier: 1.00,
  },
  {
    id: 'wide',
    name: 'Wide',
    description: 'Broadened meridians — qi rushes through widened channels.',
    capacityMultiplier: 1.25,
    flowMultiplier: 1.10,
  },
  {
    id: 'perfect',
    name: 'Perfect',
    description: 'Flawless meridians — qi flows with perfect efficiency.',
    capacityMultiplier: 1.60,
    flowMultiplier: 1.25,
  },
  {
    id: 'golden',
    name: 'Golden',
    description: 'Golden meridians — tempered by tribulation, qi surges through them.',
    capacityMultiplier: 2.00,
    flowMultiplier: 1.50,
  },
  {
    id: 'heavenly',
    name: 'Heavenly',
    description: 'Heavenly meridians — the body\'s qi network rivals an immortal\'s.',
    capacityMultiplier: 2.50,
    flowMultiplier: 1.80,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'meridians' ladder
 * through getAll — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.meridians] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ meridians = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'meridians') return [...meridians];
      return [];
    },
  };
}

/**
 * Build a MeridianSystem instance with a fresh state clone (unless
 * overridden) and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, meridians: MeridianSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const meridians = new MeridianSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, meridians, dataManager };
}

test('fresh-boot state stays normal with both cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { meridians } = makeSystem({ state });

  // The ladder snapshot loaded (7 canonical entries) and the fresh meridian
  // is the canonical normal state.
  assert.equal(meridians.count, 7);
  assert.deepEqual(state.meridians, NORMAL);
  assert.equal(state.cultivation.meridianCapacityMultiplier, 1);
  assert.equal(state.cultivation.meridianFlowMultiplier, 1);
  assert.equal(state.player.meridians, 'Normal');
  assert.deepEqual(meridians.getCurrent(), NORMAL);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { meridians } = makeSystem();

  assert.equal(meridians.count, 7);
  assert.equal(meridians.byId('broken').name, 'Broken');
  assert.equal(meridians.byId('broken').capacityMultiplier, 0.70);
  assert.equal(meridians.byId('heavenly').flowMultiplier, 1.80);
  assert.equal(meridians.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = meridians.byId('normal');
  copy.name = 'Hacked';
  assert.equal(meridians.byId('normal').name, 'Normal');
});

test('setState() changes id and multipliers and writes all four owned locations', () => {
  // Apply every ladder entry and verify all four location writes.
  const cases = [
    ['broken', 0.70, 0.60],
    ['damaged', 0.85, 0.80],
    ['normal', 1.00, 1.00],
    ['wide', 1.25, 1.10],
    ['perfect', 1.60, 1.25],
    ['golden', 2.00, 1.50],
    ['heavenly', 2.50, 1.80],
  ];
  for (const [id, capacityMultiplier, flowMultiplier] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { meridians } = makeSystem({ state });

    const result = meridians.setState(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, capacityMultiplier, flowMultiplier },
      `setState("${id}")`
    );

    // The setState writes ALL four owned locations.
    assert.deepEqual(state.meridians, {
      id,
      name: definition.name,
      capacityMultiplier,
      flowMultiplier,
    });
    assert.equal(state.cultivation.meridianCapacityMultiplier, capacityMultiplier);
    assert.equal(state.cultivation.meridianFlowMultiplier, flowMultiplier);
    assert.equal(state.player.meridians, definition.name);
    // The read API agrees with the written state.
    assert.equal(meridians.getCurrent().id, id);
  }
});

test('setState() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { meridians } = makeSystem({ state });

    const result = meridians.setState(id);
    assert.equal(result, null);
    assert.deepEqual(state.meridians, before.meridians);
    assert.equal(state.cultivation.meridianCapacityMultiplier, before.cultivation.meridianCapacityMultiplier);
    assert.equal(state.cultivation.meridianFlowMultiplier, before.cultivation.meridianFlowMultiplier);
    assert.equal(state.player.meridians, before.player.meridians);
  }
});

test('setState() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { meridians } = makeSystem({ state });

    const result = meridians.setState(id);
    assert.equal(result, null);
    assert.deepEqual(state.meridians, before.meridians);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setState returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { meridians } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({ state: structuredClone(GameState), dataManager: { getAll: () => [] } });

  assert.equal(meridians.count, 0);
  assert.equal(meridians.byId('normal'), null);
  assert.equal(meridians.setState('normal'), null);
  assert.deepEqual(meridians.getCurrent(), NORMAL);
  // Zero state writes: the rejected setState left every slice untouched.
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.meridians.count, 0);
  assert.equal(empty.meridians.setState('normal'), null);
  assert.deepEqual(empty.state.meridians, NORMAL);
  assert.equal(empty.state.cultivation.meridianCapacityMultiplier, 1);
  assert.equal(empty.state.cultivation.meridianFlowMultiplier, 1);
});

test('hostile meridian definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', capacityMultiplier: 1, flowMultiplier: 1 },
    // Skipped: empty id.
    { id: '', name: 'Empty', capacityMultiplier: 1, flowMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, capacityMultiplier: 'bogus', flowMultiplier: -5 },
    // Coerced: hostile multipliers neutralize to 1.
    {
      id: 'clamped',
      name: 'Clamped',
      capacityMultiplier: NaN,
      flowMultiplier: 0,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', capacityMultiplier: 2, flowMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { meridians } = makeSystem({ state, dataManager: makeDataManager({ meridians: hostile }) });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(meridians.count, 2);
  assert.deepEqual(meridians.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    capacityMultiplier: 1, // bogus → neutral 1
    flowMultiplier: 1, // -5 → neutral 1
  });
  assert.deepEqual(meridians.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    capacityMultiplier: 1, // NaN → neutral 1
    flowMultiplier: 1, // 0 → neutral 1
  });

  // setState over the hostile ladder still writes safe values — a rolled
  // entry's multipliers can never poison the slots.
  const result = meridians.setState('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.meridianCapacityMultiplier, 1);
  assert.equal(state.cultivation.meridianFlowMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.meridianCapacityMultiplier), true);
});

test('restore-trust: malformed meridians/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.meridians = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { meridians } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps the cultivation slots at the neutral 1.
    assert.deepEqual(state.meridians, NORMAL);
    assert.equal(state.cultivation.meridianCapacityMultiplier, 1);
    assert.equal(state.cultivation.meridianFlowMultiplier, 1);
    assert.equal(state.player.meridians, 'Normal');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(meridians.count, 7); // the ladder still loaded
    assert.deepEqual(meridians.getCurrent(), NORMAL);

    // The repaired player slice accepts setState's write.
    const result = meridians.setState('golden');
    assert.equal(result.id, 'golden');
    assert.equal(state.player.meridians, 'Golden');
  }
});

test('old-save compatibility: a save without the meridians keys repairs to normal, multipliers 1', () => {
  const state = structuredClone(GameState);
  delete state.meridians;
  delete state.cultivation.meridianCapacityMultiplier;
  delete state.cultivation.meridianFlowMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { meridians } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.meridians, NORMAL);
  assert.equal(state.cultivation.meridianCapacityMultiplier, 1);
  assert.equal(state.cultivation.meridianFlowMultiplier, 1);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(meridians.getCurrent(), NORMAL);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.meridians.capacityMultiplier = multiplier;
    state.meridians.flowMultiplier = multiplier;

    const { meridians } = makeSystem({ state }); // must not throw

    assert.equal(state.cultivation.meridianCapacityMultiplier, 1);
    assert.equal(state.cultivation.meridianFlowMultiplier, 1);
    assert.equal(Number.isFinite(state.cultivation.meridianCapacityMultiplier), true);
    assert.equal(Number.isFinite(state.cultivation.meridianFlowMultiplier), true);
    assert.equal(meridians.getCurrent().capacityMultiplier, 1);
    assert.equal(meridians.getCurrent().flowMultiplier, 1);
  }
});

test('a restored meridian lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.meridians = {
    id: 'perfect',
    name: 'Perfect',
    capacityMultiplier: 1.60,
    flowMultiplier: 1.25,
  };

  const { meridians } = makeSystem({ state });

  // The constructor sync wrote the restored meridian's factors into the slots
  // the QiSystem stacks from the first tick; the display name is untouched.
  assert.equal(state.cultivation.meridianCapacityMultiplier, 1.60);
  assert.equal(state.cultivation.meridianFlowMultiplier, 1.25);
  assert.deepEqual(meridians.getCurrent(), {
    id: 'perfect',
    name: 'Perfect',
    capacityMultiplier: 1.60,
    flowMultiplier: 1.25,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.meridians = {
    id: 'golden',
    name: 'Golden',
    capacityMultiplier: 2.00,
    flowMultiplier: 1.50,
  };
  const { meridians } = makeSystem({ state });

  const snapshot = meridians.getCurrent();
  snapshot.id = 'hacked';
  snapshot.capacityMultiplier = 999;
  snapshot.flowMultiplier = -1;

  const again = meridians.getCurrent();
  assert.equal(again.id, 'golden');
  assert.equal(again.capacityMultiplier, 2.00);
  assert.equal(again.flowMultiplier, 1.50);
});
