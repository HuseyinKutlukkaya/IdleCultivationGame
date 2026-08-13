/**
 * tests/unit/talents.test.mjs — unit tests for js/systems/talents.js.
 *
 * Exercises the TalentSystem (single owner of the cultivator's talent state
 * and its future-consumer learning-speed slot) against a fake DataManager
 * lookalike serving the 'talents' ladder — the same injection pattern the
 * shipped bootstrap uses. Covered: construction boot-sync (fresh state stays
 * ordinary with the cultivation slot at 1; a restored talent lands its
 * multiplier in the slot before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setTalent() writing ALL
 * owned locations (state.talents fields,
 * cultivation.talentLearningSpeedMultiplier, player.talent), setTalent()
 * rejecting unknown ids and empty/non-string ids, the no-dataManager neutral
 * degradation (count 0, setTalent returns null, zero state writes),
 * hostile-definition coercion/skipping (non-objects, missing/empty ids
 * skipped; missing name/multiplier coerced to safe defaults — an unusable
 * factor can never poison the slot), restore-trust slice repair (malformed
 * talents/cultivation/player slices never abort boot), old-save compatibility
 * (no talents slice → repaired to ordinary, slot 1), the hostile restored
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
import { TalentSystem } from '../../js/systems/talents.js';

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
 * The canonical fresh talent slice (mirrors core/game-state.js) — the
 * ordinary state (1.0× multiplier).
 */
const ORDINARY_TALENT = {
  id: 'ordinary',
  name: 'Ordinary',
  learningSpeedMultiplier: 1.0,
};

/**
 * The fixture talent ladder — the same contract shape as the shipped ladder
 * (id, name, description, learningSpeedMultiplier). Worst→best in ladder
 * order: Dull → Prodigy.
 */
const LADDER = deepFreeze([
  {
    id: 'dull',
    name: 'Dull',
    description: 'A slow, unremarkable learner — new arts take hold only through great effort.',
    learningSpeedMultiplier: 0.70,
  },
  {
    id: 'slow',
    name: 'Slow',
    description: 'A deliberate learner who needs time and repetition before lessons stick.',
    learningSpeedMultiplier: 0.85,
  },
  {
    id: 'ordinary',
    name: 'Ordinary',
    description: 'An average aptitude for learning — no gift, but no hindrance either.',
    learningSpeedMultiplier: 1.00,
  },
  {
    id: 'bright',
    name: 'Bright',
    description: 'A quick mind that picks up techniques and crafts with noticeable ease.',
    learningSpeedMultiplier: 1.20,
  },
  {
    id: 'gifted',
    name: 'Gifted',
    description: 'A naturally talented learner whose insight shortens the path to mastery.',
    learningSpeedMultiplier: 1.50,
  },
  {
    id: 'genius',
    name: 'Genius',
    description: 'A rare intellect that grasps profound arts after a single glance.',
    learningSpeedMultiplier: 1.90,
  },
  {
    id: 'prodigy',
    name: 'Prodigy',
    description: 'An unheard-of talent — the Dao itself seems to bend toward their understanding.',
    learningSpeedMultiplier: 2.50,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'talents' ladder through
 * getAll — the shape the real DataManager exposes to the shipped systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.talents] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ talents = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'talents') return [...talents];
      return [];
    },
  };
}

/**
 * Build a TalentSystem instance with a fresh state clone (unless overridden)
 * and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, talents: TalentSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const talents = new TalentSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, talents, dataManager };
}

test('fresh-boot state stays ordinary with the cultivation slot at 1', () => {
  const state = structuredClone(GameState);
  const { talents } = makeSystem({ state });

  // The ladder snapshot loaded (7 canonical entries) and the fresh talent
  // is the canonical ordinary state.
  assert.equal(talents.count, 7);
  assert.deepEqual(state.talents, ORDINARY_TALENT);
  assert.equal(state.cultivation.talentLearningSpeedMultiplier, 1.0);
  assert.equal(state.player.talent, 'Ordinary');
  assert.deepEqual(talents.getCurrent(), ORDINARY_TALENT);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { talents } = makeSystem();

  assert.equal(talents.count, 7);
  assert.equal(talents.byId('ordinary').name, 'Ordinary');
  assert.equal(talents.byId('ordinary').learningSpeedMultiplier, 1.00);
  assert.equal(talents.byId('prodigy').learningSpeedMultiplier, 2.50);
  assert.equal(talents.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = talents.byId('ordinary');
  copy.name = 'Hacked';
  assert.equal(talents.byId('ordinary').name, 'Ordinary');
});

test('setTalent() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['dull', 0.70],
    ['slow', 0.85],
    ['ordinary', 1.00],
    ['bright', 1.20],
    ['gifted', 1.50],
    ['genius', 1.90],
    ['prodigy', 2.50],
  ];
  for (const [id, learningSpeed] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { talents } = makeSystem({ state });

    const result = talents.setTalent(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, learningSpeedMultiplier: learningSpeed },
      `setTalent("${id}")`
    );

    // The setTalent writes ALL owned locations.
    assert.deepEqual(state.talents, {
      id,
      name: definition.name,
      learningSpeedMultiplier: learningSpeed,
    });
    assert.equal(state.cultivation.talentLearningSpeedMultiplier, learningSpeed);
    assert.equal(state.player.talent, definition.name);
    // The read API agrees with the written state.
    assert.equal(talents.getCurrent().id, id);
  }
});

test('setTalent() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { talents } = makeSystem({ state });

    const result = talents.setTalent(id);
    assert.equal(result, null);
    assert.deepEqual(state.talents, before.talents);
    assert.equal(
      state.cultivation.talentLearningSpeedMultiplier,
      before.cultivation.talentLearningSpeedMultiplier
    );
    assert.equal(state.player.talent, before.player.talent);
  }
});

test('setTalent() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { talents } = makeSystem({ state });

    const result = talents.setTalent(id);
    assert.equal(result, null);
    assert.deepEqual(state.talents, before.talents);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setTalent returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { talents } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({
    state: structuredClone(GameState),
    dataManager: { getAll: () => [] },
  });

  assert.equal(talents.count, 0);
  assert.equal(talents.byId('ordinary'), null);
  assert.equal(talents.setTalent('ordinary'), null);
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.talents.count, 0);
  assert.equal(empty.talents.setTalent('ordinary'), null);
  assert.deepEqual(empty.state.talents, ORDINARY_TALENT);
  assert.equal(empty.state.cultivation.talentLearningSpeedMultiplier, 1.0);
});

test('hostile talent definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', learningSpeedMultiplier: 0.5 },
    // Skipped: empty id.
    { id: '', name: 'Empty', learningSpeedMultiplier: 1 },
    // Coerced: name/multiplier unusable → safe defaults
    // (name falls back to id, multiplier to neutral 1).
    { id: 'broken-def', name: 42, learningSpeedMultiplier: 'bogus' },
    // Coerced: hostile multiplier neutralizes to 1.
    { id: 'clamped', name: 'Clamped', learningSpeedMultiplier: Infinity },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', learningSpeedMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { talents } = makeSystem({
    state,
    dataManager: makeDataManager({ talents: hostile }),
  });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(talents.count, 2);
  assert.deepEqual(talents.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    learningSpeedMultiplier: 1, // bogus → neutral 1
  });
  assert.deepEqual(talents.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    learningSpeedMultiplier: 1, // Infinity → neutral 1
  });

  // setTalent over the hostile ladder still writes safe values — a set
  // entry's multiplier can never poison the slot.
  const result = talents.setTalent('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.talentLearningSpeedMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.talentLearningSpeedMultiplier), true);
});

test('restore-trust: malformed talents/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.talents = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { talents } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps the cultivation slot at the neutral 1.
    assert.deepEqual(state.talents, ORDINARY_TALENT);
    assert.equal(state.cultivation.talentLearningSpeedMultiplier, 1.0);
    assert.equal(state.player.talent, 'Ordinary');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(talents.count, 7); // the ladder still loaded
    assert.deepEqual(talents.getCurrent(), ORDINARY_TALENT);

    // The repaired player slice accepts setTalent's write.
    const result = talents.setTalent('gifted');
    assert.equal(result.id, 'gifted');
    assert.equal(state.player.talent, 'Gifted');
  }
});

test('old-save compatibility: a save without the talent keys repairs to ordinary, slot 1', () => {
  const state = structuredClone(GameState);
  delete state.talents;
  delete state.cultivation.talentLearningSpeedMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { talents } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.talents, ORDINARY_TALENT);
  assert.equal(state.cultivation.talentLearningSpeedMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(talents.getCurrent(), ORDINARY_TALENT);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.talents.learningSpeedMultiplier = multiplier;

    const { talents } = makeSystem({ state }); // must not throw

    assert.equal(talents.getCurrent().learningSpeedMultiplier, 1);
    assert.equal(Number.isFinite(talents.getCurrent().learningSpeedMultiplier), true);
  }
});

test('a restored talent lands its multiplier in the cultivation slot on boot', () => {
  const state = structuredClone(GameState);
  state.talents = {
    id: 'gifted',
    name: 'Gifted',
    learningSpeedMultiplier: 1.50,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes the cultivation slot only — same pattern as SoulSystem).
  state.player.talent = 'Gifted';

  const { talents } = makeSystem({ state });

  // The constructor sync wrote the restored talent's multiplier into the
  // slot the future learning systems will read from the first tick.
  assert.equal(state.cultivation.talentLearningSpeedMultiplier, 1.50);
  assert.equal(state.player.talent, 'Gifted');
  assert.deepEqual(talents.getCurrent(), {
    id: 'gifted',
    name: 'Gifted',
    learningSpeedMultiplier: 1.50,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.talents = {
    id: 'prodigy',
    name: 'Prodigy',
    learningSpeedMultiplier: 2.50,
  };
  const { talents } = makeSystem({ state });

  const snapshot = talents.getCurrent();
  snapshot.id = 'hacked';
  snapshot.learningSpeedMultiplier = 999;

  const again = talents.getCurrent();
  assert.equal(again.id, 'prodigy');
  assert.equal(again.learningSpeedMultiplier, 2.50);
});
