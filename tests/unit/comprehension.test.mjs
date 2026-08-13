/**
 * tests/unit/comprehension.test.mjs — unit tests for js/systems/comprehension.js.
 *
 * Exercises the ComprehensionSystem (single owner of the cultivator's
 * comprehension state and its three future-consumer multiplier slots) against
 * a fake DataManager lookalike serving the 'comprehension' ladder — the same
 * injection pattern the shipped bootstrap uses. Covered: construction
 * boot-sync (fresh state stays standard with all three cultivation slots at 1;
 * a restored comprehension lands its multipliers in the slots before the first
 * tick), the count getter and the byId() lookup (shallow copy, null for
 * unknown ids), setComprehension() writing ALL owned locations (state.
 * comprehension fields, cultivation.comprehensionDaoProgressMultiplier,
 * cultivation.comprehensionTechniqueEfficiencyMultiplier, cultivation.
 * comprehensionBreakthroughEfficiencyMultiplier, player.comprehension),
 * setComprehension() rejecting unknown ids and empty/non-string ids, the
 * no-dataManager neutral degradation (count 0, setComprehension returns null,
 * zero state writes), hostile-definition coercion/skipping (non-objects,
 * missing/empty ids skipped; missing name/multipliers coerced to safe defaults
 * — an unusable factor can never poison the slot), restore-trust slice repair
 * (malformed comprehension/cultivation/player slices never abort boot),
 * old-save compatibility (no comprehension slice → repaired to standard, all
 * slots 1), the hostile restored multiplier coercion (NaN/Infinity/negative →
 * neutral 1, never a non-finite slot write) and getCurrent() being a read-only
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
import { ComprehensionSystem } from '../../js/systems/comprehension.js';

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
 * The canonical fresh comprehension slice (mirrors core/game-state.js) — the
 * standard state (all 1.0× multipliers).
 */
const STANDARD_COMPREHENSION = {
  id: 'standard',
  name: 'Standard',
  daoProgressMultiplier: 1.0,
  techniqueEfficiencyMultiplier: 1.0,
  breakthroughEfficiencyMultiplier: 1.0,
};

/**
 * The fixture comprehension ladder — the same contract shape as the shipped
 * ladder (id, name, description, daoProgressMultiplier,
 * techniqueEfficiencyMultiplier, breakthroughEfficiencyMultiplier). Worst→best
 * in ladder order: Shallow → Dao Heart.
 */
const LADDER = deepFreeze([
  {
    id: 'shallow',
    name: 'Shallow',
    description: 'A surface understanding of the Dao — deep truths slip through the mind like water through fingers.',
    daoProgressMultiplier: 0.70,
    techniqueEfficiencyMultiplier: 0.70,
    breakthroughEfficiencyMultiplier: 0.70,
  },
  {
    id: 'limited',
    name: 'Limited',
    description: 'A narrow understanding that grasps only the most straightforward teachings.',
    daoProgressMultiplier: 0.85,
    techniqueEfficiencyMultiplier: 0.85,
    breakthroughEfficiencyMultiplier: 0.85,
  },
  {
    id: 'standard',
    name: 'Standard',
    description: 'An ordinary comprehension of the Dao — enough to follow the common path.',
    daoProgressMultiplier: 1.00,
    techniqueEfficiencyMultiplier: 1.00,
    breakthroughEfficiencyMultiplier: 1.00,
  },
  {
    id: 'insightful',
    name: 'Insightful',
    description: 'A perceptive mind that pierces beneath the surface of every teaching.',
    daoProgressMultiplier: 1.15,
    techniqueEfficiencyMultiplier: 1.10,
    breakthroughEfficiencyMultiplier: 1.10,
  },
  {
    id: 'penetrating',
    name: 'Penetrating',
    description: 'An understanding that cuts to the heart of any technique or principle.',
    daoProgressMultiplier: 1.35,
    techniqueEfficiencyMultiplier: 1.25,
    breakthroughEfficiencyMultiplier: 1.20,
  },
  {
    id: 'enlightened',
    name: 'Enlightened',
    description: 'A profound comprehension — the mysteries of the Dao unfold almost unbidden.',
    daoProgressMultiplier: 1.60,
    techniqueEfficiencyMultiplier: 1.45,
    breakthroughEfficiencyMultiplier: 1.35,
  },
  {
    id: 'dao-heart',
    name: 'Dao Heart',
    description: 'An unshakeable understanding of the Way — principles and techniques resolve themselves before it.',
    daoProgressMultiplier: 2.00,
    techniqueEfficiencyMultiplier: 1.70,
    breakthroughEfficiencyMultiplier: 1.55,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'comprehension' ladder
 * through getAll — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.comprehension] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ comprehension = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'comprehension') return [...comprehension];
      return [];
    },
  };
}

/**
 * Build a ComprehensionSystem instance with a fresh state clone (unless
 * overridden) and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, comprehension: ComprehensionSystem,
 *             dataManager: object }} the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const comprehension = new ComprehensionSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, comprehension, dataManager };
}

test('fresh-boot state stays standard with all cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { comprehension } = makeSystem({ state });

  // The ladder snapshot loaded (7 canonical entries) and the fresh
  // comprehension is the canonical standard state.
  assert.equal(comprehension.count, 7);
  assert.deepEqual(state.comprehension, STANDARD_COMPREHENSION);
  assert.equal(state.cultivation.comprehensionDaoProgressMultiplier, 1.0);
  assert.equal(state.cultivation.comprehensionTechniqueEfficiencyMultiplier, 1.0);
  assert.equal(state.cultivation.comprehensionBreakthroughEfficiencyMultiplier, 1.0);
  assert.equal(state.player.comprehension, 'Standard');
  assert.deepEqual(comprehension.getCurrent(), STANDARD_COMPREHENSION);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { comprehension } = makeSystem();

  assert.equal(comprehension.count, 7);
  assert.equal(comprehension.byId('standard').name, 'Standard');
  assert.equal(comprehension.byId('standard').daoProgressMultiplier, 1.00);
  assert.equal(comprehension.byId('dao-heart').daoProgressMultiplier, 2.00);
  assert.equal(comprehension.byId('dao-heart').techniqueEfficiencyMultiplier, 1.70);
  assert.equal(comprehension.byId('dao-heart').breakthroughEfficiencyMultiplier, 1.55);
  assert.equal(comprehension.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = comprehension.byId('standard');
  copy.name = 'Hacked';
  assert.equal(comprehension.byId('standard').name, 'Standard');
});

test('setComprehension() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['shallow', 0.70, 0.70, 0.70],
    ['limited', 0.85, 0.85, 0.85],
    ['standard', 1.00, 1.00, 1.00],
    ['insightful', 1.15, 1.10, 1.10],
    ['penetrating', 1.35, 1.25, 1.20],
    ['enlightened', 1.60, 1.45, 1.35],
    ['dao-heart', 2.00, 1.70, 1.55],
  ];
  for (const [id, daoProgress, techniqueEfficiency, breakthroughEfficiency] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { comprehension } = makeSystem({ state });

    const result = comprehension.setComprehension(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      {
        id,
        name: definition.name,
        daoProgressMultiplier: daoProgress,
        techniqueEfficiencyMultiplier: techniqueEfficiency,
        breakthroughEfficiencyMultiplier: breakthroughEfficiency,
      },
      `setComprehension("${id}")`
    );

    // The setComprehension writes ALL owned locations.
    assert.deepEqual(state.comprehension, {
      id,
      name: definition.name,
      daoProgressMultiplier: daoProgress,
      techniqueEfficiencyMultiplier: techniqueEfficiency,
      breakthroughEfficiencyMultiplier: breakthroughEfficiency,
    });
    assert.equal(state.cultivation.comprehensionDaoProgressMultiplier, daoProgress);
    assert.equal(
      state.cultivation.comprehensionTechniqueEfficiencyMultiplier,
      techniqueEfficiency
    );
    assert.equal(
      state.cultivation.comprehensionBreakthroughEfficiencyMultiplier,
      breakthroughEfficiency
    );
    assert.equal(state.player.comprehension, definition.name);
    // The read API agrees with the written state.
    assert.equal(comprehension.getCurrent().id, id);
  }
});

test('setComprehension() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { comprehension } = makeSystem({ state });

    const result = comprehension.setComprehension(id);
    assert.equal(result, null);
    assert.deepEqual(state.comprehension, before.comprehension);
    assert.equal(
      state.cultivation.comprehensionDaoProgressMultiplier,
      before.cultivation.comprehensionDaoProgressMultiplier
    );
    assert.equal(state.player.comprehension, before.player.comprehension);
  }
});

test('setComprehension() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { comprehension } = makeSystem({ state });

    const result = comprehension.setComprehension(id);
    assert.equal(result, null);
    assert.deepEqual(state.comprehension, before.comprehension);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setComprehension returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { comprehension } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({
    state: structuredClone(GameState),
    dataManager: { getAll: () => [] },
  });

  assert.equal(comprehension.count, 0);
  assert.equal(comprehension.byId('standard'), null);
  assert.equal(comprehension.setComprehension('standard'), null);
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.comprehension.count, 0);
  assert.equal(empty.comprehension.setComprehension('standard'), null);
  assert.deepEqual(empty.state.comprehension, STANDARD_COMPREHENSION);
  assert.equal(empty.state.cultivation.comprehensionDaoProgressMultiplier, 1.0);
});

test('hostile comprehension definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', daoProgressMultiplier: 0.5, techniqueEfficiencyMultiplier: 1, breakthroughEfficiencyMultiplier: 1 },
    // Skipped: empty id.
    { id: '', name: 'Empty', daoProgressMultiplier: 1, techniqueEfficiencyMultiplier: 1, breakthroughEfficiencyMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, daoProgressMultiplier: 'bogus', techniqueEfficiencyMultiplier: -5, breakthroughEfficiencyMultiplier: 0 },
    // Coerced: hostile multipliers neutralize to 1.
    {
      id: 'clamped',
      name: 'Clamped',
      daoProgressMultiplier: Infinity,
      techniqueEfficiencyMultiplier: -Infinity,
      breakthroughEfficiencyMultiplier: NaN,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', daoProgressMultiplier: 2, techniqueEfficiencyMultiplier: 2, breakthroughEfficiencyMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { comprehension } = makeSystem({
    state,
    dataManager: makeDataManager({ comprehension: hostile }),
  });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(comprehension.count, 2);
  assert.deepEqual(comprehension.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    daoProgressMultiplier: 1, // bogus → neutral 1
    techniqueEfficiencyMultiplier: 1, // -5 → neutral 1
    breakthroughEfficiencyMultiplier: 1, // 0 → neutral 1
  });
  assert.deepEqual(comprehension.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    daoProgressMultiplier: 1, // Infinity → neutral 1
    techniqueEfficiencyMultiplier: 1, // -Infinity → neutral 1
    breakthroughEfficiencyMultiplier: 1, // NaN → neutral 1
  });

  // setComprehension over the hostile ladder still writes safe values — a set
  // entry's multipliers can never poison the slots.
  const result = comprehension.setComprehension('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.comprehensionDaoProgressMultiplier, 1);
  assert.equal(
    Number.isFinite(state.cultivation.comprehensionDaoProgressMultiplier),
    true
  );
});

test('restore-trust: malformed comprehension/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.comprehension = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { comprehension } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps all cultivation slots at the neutral 1.
    assert.deepEqual(state.comprehension, STANDARD_COMPREHENSION);
    assert.equal(state.cultivation.comprehensionDaoProgressMultiplier, 1.0);
    assert.equal(state.cultivation.comprehensionTechniqueEfficiencyMultiplier, 1.0);
    assert.equal(state.cultivation.comprehensionBreakthroughEfficiencyMultiplier, 1.0);
    assert.equal(state.player.comprehension, 'Standard');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(comprehension.count, 7); // the ladder still loaded
    assert.deepEqual(comprehension.getCurrent(), STANDARD_COMPREHENSION);

    // The repaired player slice accepts setComprehension's write.
    const result = comprehension.setComprehension('insightful');
    assert.equal(result.id, 'insightful');
    assert.equal(state.player.comprehension, 'Insightful');
  }
});

test('old-save compatibility: a save without the comprehension keys repairs to standard, all slots 1', () => {
  const state = structuredClone(GameState);
  delete state.comprehension;
  delete state.cultivation.comprehensionDaoProgressMultiplier;
  delete state.cultivation.comprehensionTechniqueEfficiencyMultiplier;
  delete state.cultivation.comprehensionBreakthroughEfficiencyMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { comprehension } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.comprehension, STANDARD_COMPREHENSION);
  assert.equal(state.cultivation.comprehensionDaoProgressMultiplier, 1.0);
  assert.equal(state.cultivation.comprehensionTechniqueEfficiencyMultiplier, 1.0);
  assert.equal(state.cultivation.comprehensionBreakthroughEfficiencyMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(comprehension.getCurrent(), STANDARD_COMPREHENSION);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.comprehension.daoProgressMultiplier = multiplier;
    state.comprehension.techniqueEfficiencyMultiplier = multiplier;
    state.comprehension.breakthroughEfficiencyMultiplier = multiplier;

    const { comprehension } = makeSystem({ state }); // must not throw

    assert.equal(comprehension.getCurrent().daoProgressMultiplier, 1);
    assert.equal(comprehension.getCurrent().techniqueEfficiencyMultiplier, 1);
    assert.equal(comprehension.getCurrent().breakthroughEfficiencyMultiplier, 1);
    assert.equal(
      Number.isFinite(comprehension.getCurrent().daoProgressMultiplier),
      true
    );
  }
});

test('a restored comprehension lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.comprehension = {
    id: 'enlightened',
    name: 'Enlightened',
    daoProgressMultiplier: 1.60,
    techniqueEfficiencyMultiplier: 1.45,
    breakthroughEfficiencyMultiplier: 1.35,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes the cultivation slots only — same pattern as SoulSystem).
  state.player.comprehension = 'Enlightened';

  const { comprehension } = makeSystem({ state });

  // The constructor sync wrote the restored comprehension's multipliers into
  // the slots the future Dao/technique-efficiency systems will read from the
  // first tick.
  assert.equal(state.cultivation.comprehensionDaoProgressMultiplier, 1.60);
  assert.equal(state.cultivation.comprehensionTechniqueEfficiencyMultiplier, 1.45);
  assert.equal(state.cultivation.comprehensionBreakthroughEfficiencyMultiplier, 1.35);
  assert.equal(state.player.comprehension, 'Enlightened');
  assert.deepEqual(comprehension.getCurrent(), {
    id: 'enlightened',
    name: 'Enlightened',
    daoProgressMultiplier: 1.60,
    techniqueEfficiencyMultiplier: 1.45,
    breakthroughEfficiencyMultiplier: 1.35,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.comprehension = {
    id: 'dao-heart',
    name: 'Dao Heart',
    daoProgressMultiplier: 2.00,
    techniqueEfficiencyMultiplier: 1.70,
    breakthroughEfficiencyMultiplier: 1.55,
  };
  const { comprehension } = makeSystem({ state });

  const snapshot = comprehension.getCurrent();
  snapshot.id = 'hacked';
  snapshot.daoProgressMultiplier = 999;
  snapshot.breakthroughEfficiencyMultiplier = -1;

  const again = comprehension.getCurrent();
  assert.equal(again.id, 'dao-heart');
  assert.equal(again.daoProgressMultiplier, 2.00);
  assert.equal(again.breakthroughEfficiencyMultiplier, 1.55);
});
