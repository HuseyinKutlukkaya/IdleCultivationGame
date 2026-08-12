/**
 * tests/unit/bloodlines.test.mjs — unit tests for
 * js/systems/bloodlines.js.
 *
 * Exercises the BloodlineSystem (single owner of the cultivator's bloodline
 * state and its multiplier slots) against a fake DataManager lookalike
 * serving the 'bloodlines' ladder — the same injection pattern the shipped
 * bootstrap uses. Covered: construction boot-sync (fresh state stays
 * ancient-human with all cultivation slots at 1; a restored bloodline lands
 * its multipliers in the slots before the first tick), the count getter and
 * the byId() lookup (shallow copy, null for unknown ids), setBloodline()
 * writing ALL owned locations (state.bloodlines fields,
 * cultivation.bloodlineSpeedMultiplier,
 * cultivation.bloodlineQiMaxMultiplier, player.bloodline),
 * setBloodline() rejecting unknown ids and empty/non-string ids, the
 * no-dataManager neutral degradation (count 0, setBloodline returns null,
 * zero state writes), hostile-definition coercion/skipping (non-objects,
 * missing/empty ids skipped; missing name/multipliers coerced to safe
 * defaults — an unusable factor can never poison the slot), restore-trust
 * slice repair (malformed bloodlines/cultivation/player slices never abort
 * boot), old-save compatibility (no bloodlines slice → repaired to
 * ancient-human, all slots 1), the hostile restored multiplier coercion
 * (NaN/Infinity/negative → neutral 1, never a non-finite slot write) and
 * getCurrent() being a read-only defensive snapshot (mutating it never
 * leaks).
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
import { BloodlineSystem } from '../../js/systems/bloodlines.js';

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
 * The canonical fresh bloodlines slice (mirrors core/game-state.js) — the
 * ancient-human state (all 1.0× multipliers).
 */
const ANCIENT_HUMAN = {
  id: 'ancient-human',
  name: 'Ancient Human',
  cultivationSpeedMultiplier: 1.0,
  qiMaxMultiplier: 1.0,
};

/**
 * The fixture bloodline ladder — the same contract shape as the shipped
 * ladder (id, name, description, cultivationSpeedMultiplier,
 * qiMaxMultiplier). Worst→best in ladder order: Ancient Human → Chaos Blood.
 */
const LADDER = deepFreeze([
  {
    id: 'ancient-human',
    name: 'Ancient Human',
    description: 'The baseline bloodline of every mortal — no innate edge, no weakness.',
    cultivationSpeedMultiplier: 1.00,
    qiMaxMultiplier: 1.00,
  },
  {
    id: 'tiger',
    name: 'Tiger Bloodline',
    description: 'A ferocious bloodline that drives cultivation with relentless momentum.',
    cultivationSpeedMultiplier: 1.15,
    qiMaxMultiplier: 1.10,
  },
  {
    id: 'turtle',
    name: 'Turtle Bloodline',
    description: 'A steady bloodline that deepens the qi reservoirs beyond the norm.',
    cultivationSpeedMultiplier: 1.25,
    qiMaxMultiplier: 1.20,
  },
  {
    id: 'qilin',
    name: 'Qilin Bloodline',
    description: 'An auspicious bloodline that quickens cultivation and swells the dantian.',
    cultivationSpeedMultiplier: 1.40,
    qiMaxMultiplier: 1.35,
  },
  {
    id: 'phoenix',
    name: 'Phoenix Bloodline',
    description: 'A reborn bloodline whose vigour accelerates cultivation and broadens capacity.',
    cultivationSpeedMultiplier: 1.60,
    qiMaxMultiplier: 1.50,
  },
  {
    id: 'dragon',
    name: 'Dragon Bloodline',
    description: 'A sovereign bloodline whose might hastens cultivation and expands the sea of qi.',
    cultivationSpeedMultiplier: 1.85,
    qiMaxMultiplier: 1.70,
  },
  {
    id: 'celestial',
    name: 'Celestial Bloodline',
    description: 'A heaven-touched bloodline that cultivates with uncanny swiftness and vast reserves.',
    cultivationSpeedMultiplier: 2.20,
    qiMaxMultiplier: 2.00,
  },
  {
    id: 'chaos-blood',
    name: 'Chaos Bloodline',
    description: 'A primordial bloodline that bends the laws of cultivation — unrivalled speed and depth.',
    cultivationSpeedMultiplier: 2.75,
    qiMaxMultiplier: 2.50,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'bloodlines' ladder
 * through getAll — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.bloodlines] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ bloodlines = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'bloodlines') return [...bloodlines];
      return [];
    },
  };
}

/**
 * Build a BloodlineSystem instance with a fresh state clone (unless
 * overridden) and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, bloodlines: BloodlineSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const bloodlines = new BloodlineSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, bloodlines, dataManager };
}

test('fresh-boot state stays ancient-human with all cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { bloodlines } = makeSystem({ state });

  // The ladder snapshot loaded (8 canonical entries) and the fresh bloodline
  // is the canonical ancient-human state.
  assert.equal(bloodlines.count, 8);
  assert.deepEqual(state.bloodlines, ANCIENT_HUMAN);
  assert.equal(state.cultivation.bloodlineSpeedMultiplier, 1.0);
  assert.equal(state.cultivation.bloodlineQiMaxMultiplier, 1.0);
  assert.equal(state.player.bloodline, 'Ancient Human');
  assert.deepEqual(bloodlines.getCurrent(), ANCIENT_HUMAN);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { bloodlines } = makeSystem();

  assert.equal(bloodlines.count, 8);
  assert.equal(bloodlines.byId('ancient-human').name, 'Ancient Human');
  assert.equal(bloodlines.byId('ancient-human').cultivationSpeedMultiplier, 1.00);
  assert.equal(bloodlines.byId('chaos-blood').qiMaxMultiplier, 2.50);
  assert.equal(bloodlines.byId('chaos-blood').cultivationSpeedMultiplier, 2.75);
  assert.equal(bloodlines.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = bloodlines.byId('ancient-human');
  copy.name = 'Hacked';
  assert.equal(bloodlines.byId('ancient-human').name, 'Ancient Human');
});

test('setBloodline() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['ancient-human', 1.00, 1.00],
    ['tiger', 1.15, 1.10],
    ['turtle', 1.25, 1.20],
    ['qilin', 1.40, 1.35],
    ['phoenix', 1.60, 1.50],
    ['dragon', 1.85, 1.70],
    ['celestial', 2.20, 2.00],
    ['chaos-blood', 2.75, 2.50],
  ];
  for (const [id, speed, qiMax] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { bloodlines } = makeSystem({ state });

    const result = bloodlines.setBloodline(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, cultivationSpeedMultiplier: speed, qiMaxMultiplier: qiMax },
      `setBloodline("${id}")`
    );

    // The setBloodline writes ALL owned locations.
    assert.deepEqual(state.bloodlines, {
      id,
      name: definition.name,
      cultivationSpeedMultiplier: speed,
      qiMaxMultiplier: qiMax,
    });
    assert.equal(state.cultivation.bloodlineSpeedMultiplier, speed);
    assert.equal(state.cultivation.bloodlineQiMaxMultiplier, qiMax);
    assert.equal(state.player.bloodline, definition.name);
    // The read API agrees with the written state.
    assert.equal(bloodlines.getCurrent().id, id);
  }
});

test('setBloodline() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { bloodlines } = makeSystem({ state });

    const result = bloodlines.setBloodline(id);
    assert.equal(result, null);
    assert.deepEqual(state.bloodlines, before.bloodlines);
    assert.equal(state.cultivation.bloodlineSpeedMultiplier, before.cultivation.bloodlineSpeedMultiplier);
    assert.equal(state.player.bloodline, before.player.bloodline);
  }
});

test('setBloodline() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { bloodlines } = makeSystem({ state });

    const result = bloodlines.setBloodline(id);
    assert.equal(result, null);
    assert.deepEqual(state.bloodlines, before.bloodlines);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setBloodline returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { bloodlines } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({ state: structuredClone(GameState), dataManager: { getAll: () => [] } });

  assert.equal(bloodlines.count, 0);
  assert.equal(bloodlines.byId('ancient-human'), null);
  assert.equal(bloodlines.setBloodline('ancient-human'), null);
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.bloodlines.count, 0);
  assert.equal(empty.bloodlines.setBloodline('ancient-human'), null);
  assert.deepEqual(empty.state.bloodlines, ANCIENT_HUMAN);
  assert.equal(empty.state.cultivation.bloodlineSpeedMultiplier, 1.0);
});

test('hostile bloodline definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', cultivationSpeedMultiplier: 0.5, qiMaxMultiplier: 1 },
    // Skipped: empty id.
    { id: '', name: 'Empty', cultivationSpeedMultiplier: 1, qiMaxMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, cultivationSpeedMultiplier: 'bogus', qiMaxMultiplier: -5 },
    // Coerced: hostile multipliers neutralize to 1.
    {
      id: 'clamped',
      name: 'Clamped',
      cultivationSpeedMultiplier: Infinity,
      qiMaxMultiplier: 0,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', cultivationSpeedMultiplier: 2, qiMaxMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { bloodlines } = makeSystem({ state, dataManager: makeDataManager({ bloodlines: hostile }) });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(bloodlines.count, 2);
  assert.deepEqual(bloodlines.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    cultivationSpeedMultiplier: 1, // bogus → neutral 1
    qiMaxMultiplier: 1, // -5 → neutral 1
  });
  assert.deepEqual(bloodlines.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    cultivationSpeedMultiplier: 1, // Infinity → neutral 1
    qiMaxMultiplier: 1, // 0 → neutral 1
  });

  // setBloodline over the hostile ladder still writes safe values — a set
  // entry's multipliers can never poison the slots.
  const result = bloodlines.setBloodline('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.bloodlineSpeedMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.bloodlineSpeedMultiplier), true);
});

test('restore-trust: malformed bloodlines/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.bloodlines = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { bloodlines } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps all cultivation slots at the neutral 1.
    assert.deepEqual(state.bloodlines, ANCIENT_HUMAN);
    assert.equal(state.cultivation.bloodlineSpeedMultiplier, 1.0);
    assert.equal(state.cultivation.bloodlineQiMaxMultiplier, 1.0);
    assert.equal(state.player.bloodline, 'Ancient Human');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(bloodlines.count, 8); // the ladder still loaded
    assert.deepEqual(bloodlines.getCurrent(), ANCIENT_HUMAN);

    // The repaired player slice accepts setBloodline's write.
    const result = bloodlines.setBloodline('dragon');
    assert.equal(result.id, 'dragon');
    assert.equal(state.player.bloodline, 'Dragon Bloodline');
  }
});

test('old-save compatibility: a save without the bloodlines keys repairs to ancient-human, all slots 1', () => {
  const state = structuredClone(GameState);
  delete state.bloodlines;
  delete state.cultivation.bloodlineSpeedMultiplier;
  delete state.cultivation.bloodlineQiMaxMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { bloodlines } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.bloodlines, ANCIENT_HUMAN);
  assert.equal(state.cultivation.bloodlineSpeedMultiplier, 1.0);
  assert.equal(state.cultivation.bloodlineQiMaxMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(bloodlines.getCurrent(), ANCIENT_HUMAN);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.bloodlines.cultivationSpeedMultiplier = multiplier;
    state.bloodlines.qiMaxMultiplier = multiplier;

    const { bloodlines } = makeSystem({ state }); // must not throw

    assert.equal(bloodlines.getCurrent().cultivationSpeedMultiplier, 1);
    assert.equal(bloodlines.getCurrent().qiMaxMultiplier, 1);
    assert.equal(Number.isFinite(bloodlines.getCurrent().cultivationSpeedMultiplier), true);
  }
});

test('a restored bloodline lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.bloodlines = {
    id: 'dragon',
    name: 'Dragon Bloodline',
    cultivationSpeedMultiplier: 1.85,
    qiMaxMultiplier: 1.70,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes cultivation slots only — same pattern as MeridianSystem).
  state.player.bloodline = 'Dragon Bloodline';

  const { bloodlines } = makeSystem({ state });

  // The constructor sync wrote the restored bloodline's multipliers into the
  // slots the QiSystem and future systems read from the first tick.
  assert.equal(state.cultivation.bloodlineSpeedMultiplier, 1.85);
  assert.equal(state.cultivation.bloodlineQiMaxMultiplier, 1.70);
  assert.equal(state.player.bloodline, 'Dragon Bloodline');
  assert.deepEqual(bloodlines.getCurrent(), {
    id: 'dragon',
    name: 'Dragon Bloodline',
    cultivationSpeedMultiplier: 1.85,
    qiMaxMultiplier: 1.70,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.bloodlines = {
    id: 'celestial',
    name: 'Celestial Bloodline',
    cultivationSpeedMultiplier: 2.20,
    qiMaxMultiplier: 2.00,
  };
  const { bloodlines } = makeSystem({ state });

  const snapshot = bloodlines.getCurrent();
  snapshot.id = 'hacked';
  snapshot.cultivationSpeedMultiplier = 999;
  snapshot.qiMaxMultiplier = -1;

  const again = bloodlines.getCurrent();
  assert.equal(again.id, 'celestial');
  assert.equal(again.cultivationSpeedMultiplier, 2.20);
  assert.equal(again.qiMaxMultiplier, 2.00);
});
