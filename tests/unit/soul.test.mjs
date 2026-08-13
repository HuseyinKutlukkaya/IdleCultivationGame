/**
 * tests/unit/soul.test.mjs — unit tests for js/systems/soul.js.
 *
 * Exercises the SoulSystem (single owner of the cultivator's soul state and
 * its four future-consumer multiplier slots) against a fake DataManager
 * lookalike serving the 'soul' ladder — the same injection pattern the
 * shipped bootstrap uses. Covered: construction boot-sync (fresh state stays
 * stable with all four cultivation slots at 1; a restored soul lands its
 * multipliers in the slots before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setSoul() writing ALL
 * owned locations (state.soul fields,
 * cultivation.soulStabilityMultiplier, cultivation.soulPurityMultiplier,
 * cultivation.soulWillpowerMultiplier, cultivation.soulComprehensionMultiplier,
 * player.soul), setSoul() rejecting unknown ids and empty/non-string ids, the
 * no-dataManager neutral degradation (count 0, setSoul returns null, zero
 * state writes), hostile-definition coercion/skipping (non-objects,
 * missing/empty ids skipped; missing name/multipliers coerced to safe
 * defaults — an unusable factor can never poison the slot), restore-trust
 * slice repair (malformed soul/cultivation/player slices never abort boot),
 * old-save compatibility (no soul slice → repaired to stable, all slots 1),
 * the hostile restored multiplier coercion (NaN/Infinity/negative → neutral 1,
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
import { SoulSystem } from '../../js/systems/soul.js';

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
 * The canonical fresh soul slice (mirrors core/game-state.js) — the stable
 * state (all 1.0× multipliers).
 */
const STABLE_SOUL = {
  id: 'stable',
  name: 'Stable Soul',
  stabilityMultiplier: 1.0,
  purityMultiplier: 1.0,
  willpowerMultiplier: 1.0,
  comprehensionMultiplier: 1.0,
};

/**
 * The fixture soul ladder — the same contract shape as the shipped ladder
 * (id, name, description, stabilityMultiplier, purityMultiplier,
 * willpowerMultiplier, comprehensionMultiplier). Worst→best in ladder order:
 * Shattered → Chaos Soul.
 */
const LADDER = deepFreeze([
  {
    id: 'shattered',
    name: 'Shattered Soul',
    description: 'A soul scarred by trauma and neglect — its light dim, its will frayed.',
    stabilityMultiplier: 0.70,
    purityMultiplier: 0.70,
    willpowerMultiplier: 0.60,
    comprehensionMultiplier: 0.70,
  },
  {
    id: 'fragile',
    name: 'Fragile Soul',
    description: 'A brittle soul that startles easily — whole, yet quick to waver.',
    stabilityMultiplier: 0.85,
    purityMultiplier: 0.85,
    willpowerMultiplier: 0.80,
    comprehensionMultiplier: 0.85,
  },
  {
    id: 'stable',
    name: 'Stable Soul',
    description: 'A balanced soul — the steady foundation every cultivator builds upon.',
    stabilityMultiplier: 1.00,
    purityMultiplier: 1.00,
    willpowerMultiplier: 1.00,
    comprehensionMultiplier: 1.00,
  },
  {
    id: 'firm',
    name: 'Firm Soul',
    description: 'A resolute soul whose conviction steadies the mind and sharpens intent.',
    stabilityMultiplier: 1.15,
    purityMultiplier: 1.10,
    willpowerMultiplier: 1.20,
    comprehensionMultiplier: 1.10,
  },
  {
    id: 'radiant',
    name: 'Radiant Soul',
    description: 'A luminous soul that burns bright — its willpower blazing like a newborn sun.',
    stabilityMultiplier: 1.35,
    purityMultiplier: 1.25,
    willpowerMultiplier: 1.50,
    comprehensionMultiplier: 1.25,
  },
  {
    id: 'grand',
    name: 'Grand Soul',
    description: 'A majestic soul whose presence commands awe — depth and strength in harmony.',
    stabilityMultiplier: 1.60,
    purityMultiplier: 1.45,
    willpowerMultiplier: 1.90,
    comprehensionMultiplier: 1.45,
  },
  {
    id: 'chaos-soul',
    name: 'Chaos Soul',
    description: 'A primordial, all-consuming soul that bends the very laws of spirit.',
    stabilityMultiplier: 2.00,
    purityMultiplier: 1.70,
    willpowerMultiplier: 2.50,
    comprehensionMultiplier: 1.70,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'soul' ladder through
 * getAll — the shape the real DataManager exposes to the shipped systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.soul] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ soul = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'soul') return [...soul];
      return [];
    },
  };
}

/**
 * Build a SoulSystem instance with a fresh state clone (unless overridden)
 * and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, soul: SoulSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const soul = new SoulSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, soul, dataManager };
}

test('fresh-boot state stays stable with all cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { soul } = makeSystem({ state });

  // The ladder snapshot loaded (7 canonical entries) and the fresh soul
  // is the canonical stable state.
  assert.equal(soul.count, 7);
  assert.deepEqual(state.soul, STABLE_SOUL);
  assert.equal(state.cultivation.soulStabilityMultiplier, 1.0);
  assert.equal(state.cultivation.soulPurityMultiplier, 1.0);
  assert.equal(state.cultivation.soulWillpowerMultiplier, 1.0);
  assert.equal(state.cultivation.soulComprehensionMultiplier, 1.0);
  assert.equal(state.player.soul, 'Stable Soul');
  assert.deepEqual(soul.getCurrent(), STABLE_SOUL);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { soul } = makeSystem();

  assert.equal(soul.count, 7);
  assert.equal(soul.byId('stable').name, 'Stable Soul');
  assert.equal(soul.byId('stable').stabilityMultiplier, 1.00);
  assert.equal(soul.byId('chaos-soul').willpowerMultiplier, 2.50);
  assert.equal(soul.byId('chaos-soul').comprehensionMultiplier, 1.70);
  assert.equal(soul.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = soul.byId('stable');
  copy.name = 'Hacked';
  assert.equal(soul.byId('stable').name, 'Stable Soul');
});

test('setSoul() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['shattered', 0.70, 0.70, 0.60, 0.70],
    ['fragile', 0.85, 0.85, 0.80, 0.85],
    ['stable', 1.00, 1.00, 1.00, 1.00],
    ['firm', 1.15, 1.10, 1.20, 1.10],
    ['radiant', 1.35, 1.25, 1.50, 1.25],
    ['grand', 1.60, 1.45, 1.90, 1.45],
    ['chaos-soul', 2.00, 1.70, 2.50, 1.70],
  ];
  for (const [id, stability, purity, willpower, comprehension] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { soul } = makeSystem({ state });

    const result = soul.setSoul(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      {
        id,
        name: definition.name,
        stabilityMultiplier: stability,
        purityMultiplier: purity,
        willpowerMultiplier: willpower,
        comprehensionMultiplier: comprehension,
      },
      `setSoul("${id}")`
    );

    // The setSoul writes ALL owned locations.
    assert.deepEqual(state.soul, {
      id,
      name: definition.name,
      stabilityMultiplier: stability,
      purityMultiplier: purity,
      willpowerMultiplier: willpower,
      comprehensionMultiplier: comprehension,
    });
    assert.equal(state.cultivation.soulStabilityMultiplier, stability);
    assert.equal(state.cultivation.soulPurityMultiplier, purity);
    assert.equal(state.cultivation.soulWillpowerMultiplier, willpower);
    assert.equal(state.cultivation.soulComprehensionMultiplier, comprehension);
    assert.equal(state.player.soul, definition.name);
    // The read API agrees with the written state.
    assert.equal(soul.getCurrent().id, id);
  }
});

test('setSoul() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { soul } = makeSystem({ state });

    const result = soul.setSoul(id);
    assert.equal(result, null);
    assert.deepEqual(state.soul, before.soul);
    assert.equal(state.cultivation.soulStabilityMultiplier, before.cultivation.soulStabilityMultiplier);
    assert.equal(state.player.soul, before.player.soul);
  }
});

test('setSoul() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { soul } = makeSystem({ state });

    const result = soul.setSoul(id);
    assert.equal(result, null);
    assert.deepEqual(state.soul, before.soul);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setSoul returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { soul } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({ state: structuredClone(GameState), dataManager: { getAll: () => [] } });

  assert.equal(soul.count, 0);
  assert.equal(soul.byId('stable'), null);
  assert.equal(soul.setSoul('stable'), null);
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.soul.count, 0);
  assert.equal(empty.soul.setSoul('stable'), null);
  assert.deepEqual(empty.state.soul, STABLE_SOUL);
  assert.equal(empty.state.cultivation.soulStabilityMultiplier, 1.0);
});

test('hostile soul definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', stabilityMultiplier: 0.5, purityMultiplier: 1, willpowerMultiplier: 1, comprehensionMultiplier: 1 },
    // Skipped: empty id.
    { id: '', name: 'Empty', stabilityMultiplier: 1, purityMultiplier: 1, willpowerMultiplier: 1, comprehensionMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, stabilityMultiplier: 'bogus', purityMultiplier: -5, willpowerMultiplier: 'junk', comprehensionMultiplier: 0 },
    // Coerced: hostile multipliers neutralize to 1.
    {
      id: 'clamped',
      name: 'Clamped',
      stabilityMultiplier: Infinity,
      purityMultiplier: 0,
      willpowerMultiplier: -Infinity,
      comprehensionMultiplier: NaN,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', stabilityMultiplier: 2, purityMultiplier: 2, willpowerMultiplier: 2, comprehensionMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { soul } = makeSystem({ state, dataManager: makeDataManager({ soul: hostile }) });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(soul.count, 2);
  assert.deepEqual(soul.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    stabilityMultiplier: 1, // bogus → neutral 1
    purityMultiplier: 1, // -5 → neutral 1
    willpowerMultiplier: 1, // junk → neutral 1
    comprehensionMultiplier: 1, // 0 → neutral 1
  });
  assert.deepEqual(soul.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    stabilityMultiplier: 1, // Infinity → neutral 1
    purityMultiplier: 1, // 0 → neutral 1
    willpowerMultiplier: 1, // -Infinity → neutral 1
    comprehensionMultiplier: 1, // NaN → neutral 1
  });

  // setSoul over the hostile ladder still writes safe values — a set
  // entry's multipliers can never poison the slots.
  const result = soul.setSoul('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.soulStabilityMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.soulStabilityMultiplier), true);
});

test('restore-trust: malformed soul/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.soul = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { soul } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps all cultivation slots at the neutral 1.
    assert.deepEqual(state.soul, STABLE_SOUL);
    assert.equal(state.cultivation.soulStabilityMultiplier, 1.0);
    assert.equal(state.cultivation.soulPurityMultiplier, 1.0);
    assert.equal(state.cultivation.soulWillpowerMultiplier, 1.0);
    assert.equal(state.cultivation.soulComprehensionMultiplier, 1.0);
    assert.equal(state.player.soul, 'Stable Soul');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(soul.count, 7); // the ladder still loaded
    assert.deepEqual(soul.getCurrent(), STABLE_SOUL);

    // The repaired player slice accepts setSoul's write.
    const result = soul.setSoul('radiant');
    assert.equal(result.id, 'radiant');
    assert.equal(state.player.soul, 'Radiant Soul');
  }
});

test('old-save compatibility: a save without the soul keys repairs to stable, all slots 1', () => {
  const state = structuredClone(GameState);
  delete state.soul;
  delete state.cultivation.soulStabilityMultiplier;
  delete state.cultivation.soulPurityMultiplier;
  delete state.cultivation.soulWillpowerMultiplier;
  delete state.cultivation.soulComprehensionMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { soul } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.soul, STABLE_SOUL);
  assert.equal(state.cultivation.soulStabilityMultiplier, 1.0);
  assert.equal(state.cultivation.soulPurityMultiplier, 1.0);
  assert.equal(state.cultivation.soulWillpowerMultiplier, 1.0);
  assert.equal(state.cultivation.soulComprehensionMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(soul.getCurrent(), STABLE_SOUL);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.soul.stabilityMultiplier = multiplier;
    state.soul.purityMultiplier = multiplier;
    state.soul.willpowerMultiplier = multiplier;
    state.soul.comprehensionMultiplier = multiplier;

    const { soul } = makeSystem({ state }); // must not throw

    assert.equal(soul.getCurrent().stabilityMultiplier, 1);
    assert.equal(soul.getCurrent().purityMultiplier, 1);
    assert.equal(soul.getCurrent().willpowerMultiplier, 1);
    assert.equal(soul.getCurrent().comprehensionMultiplier, 1);
    assert.equal(Number.isFinite(soul.getCurrent().stabilityMultiplier), true);
  }
});

test('a restored soul lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.soul = {
    id: 'radiant',
    name: 'Radiant Soul',
    stabilityMultiplier: 1.35,
    purityMultiplier: 1.25,
    willpowerMultiplier: 1.50,
    comprehensionMultiplier: 1.25,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes cultivation slots only — same pattern as BloodlineSystem).
  state.player.soul = 'Radiant Soul';

  const { soul } = makeSystem({ state });

  // The constructor sync wrote the restored soul's multipliers into the
  // slots the future enlightenment/Dao systems will read from the first tick.
  assert.equal(state.cultivation.soulStabilityMultiplier, 1.35);
  assert.equal(state.cultivation.soulPurityMultiplier, 1.25);
  assert.equal(state.cultivation.soulWillpowerMultiplier, 1.50);
  assert.equal(state.cultivation.soulComprehensionMultiplier, 1.25);
  assert.equal(state.player.soul, 'Radiant Soul');
  assert.deepEqual(soul.getCurrent(), {
    id: 'radiant',
    name: 'Radiant Soul',
    stabilityMultiplier: 1.35,
    purityMultiplier: 1.25,
    willpowerMultiplier: 1.50,
    comprehensionMultiplier: 1.25,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.soul = {
    id: 'chaos-soul',
    name: 'Chaos Soul',
    stabilityMultiplier: 2.00,
    purityMultiplier: 1.70,
    willpowerMultiplier: 2.50,
    comprehensionMultiplier: 1.70,
  };
  const { soul } = makeSystem({ state });

  const snapshot = soul.getCurrent();
  snapshot.id = 'hacked';
  snapshot.stabilityMultiplier = 999;
  snapshot.willpowerMultiplier = -1;

  const again = soul.getCurrent();
  assert.equal(again.id, 'chaos-soul');
  assert.equal(again.stabilityMultiplier, 2.00);
  assert.equal(again.willpowerMultiplier, 2.50);
});
