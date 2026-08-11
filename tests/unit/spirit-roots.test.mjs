/**
 * tests/unit/spirit-roots.test.mjs — unit tests for
 * js/systems/spirit-roots.js.
 *
 * Exercises the SpiritRootSystem (single owner of the cultivator's spirit
 * root and its cultivation-speed slot) against a fake DataManager lookalike
 * serving the 'spirit-roots' ladder — the same injection pattern the shipped
 * bootstrap uses. Covered: construction boot-sync (fresh state stays
 * unawakened with the cultivation slot at 1; a restored root lands its
 * speedMultiplier in the slot before the first tick), the count getter and
 * the byId() lookup (shallow copy, null for unknown ids), the roll() weighted
 * draw honoring an injected random source across the ladder (low roll →
 * no-root, mid → mid tiers, near-total → chaos) writing ALL three owned
 * locations (state.spiritRoot fields, cultivation.spiritRootMultiplier,
 * player.spiritRoot), the hostile-random fallback (NaN/negative/>1 still
 * selects a valid entry — the last one), the no-dataManager neutral
 * degradation (count 0, roll rejects 'no-definitions', zero state writes),
 * hostile-definition coercion/skipping (non-objects, missing/empty ids and
 * bad weights skipped; missing name/tier/elements/attributes/speedMultiplier
 * coerced to safe defaults — an unusable factor can never poison the slot),
 * restore-trust slice repair (malformed spiritRoot/cultivation/player slices
 * never abort boot), old-save compatibility (no spiritRoot slice → repaired
 * to unawakened, multiplier 1), the hostile restored multiplier coercion
 * (NaN/Infinity/negative/0 → neutral 1, never a non-finite slot write) and
 * current() being a read-only defensive snapshot (mutating it never leaks).
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
import { SpiritRootSystem } from '../../js/systems/spirit-roots.js';

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
 * The canonical fresh spirit root slice (mirrors core/game-state.js) — the
 * unawakened pre-roll state.
 */
const UNAWAKENED = {
  id: 'unawakened',
  name: 'Unawakened',
  tier: -1,
  elements: [],
  purity: 0,
  stability: 0,
  growth: 0,
  mutation: 0,
  compatibility: 0,
  speedMultiplier: 1,
};

/**
 * The fixture spirit root ladder — the same contract shape as the shipped
 * ladder (id, name, tier, description, elements, attributes, speedMultiplier,
 * weight). Worst→best in ladder order: total weight = 262, so for
 * roll = random() × 262 the buckets are no-root [0,100), pseudo-root
 * [100,160), mixed-root [160,200), three-element [200,225), dual-element
 * [225,240), single-element [240,250), mutated [250,256), heavenly [256,259),
 * divine [259,261), chaos [261,262).
 */
const LADDER = deepFreeze([
  {
    id: 'no-root',
    name: 'No Root',
    tier: 0,
    description: 'A cultivator without an elemental affinity.',
    elements: [],
    attributes: { purity: 0, stability: 0.05, growth: 0, mutation: 0, compatibility: 0.1 },
    speedMultiplier: 0.85,
    weight: 100,
  },
  {
    id: 'pseudo-root',
    name: 'Pseudo Root',
    tier: 1,
    description: 'A faint elemental trace, too weak to cultivate properly.',
    elements: [],
    attributes: { purity: 0.1, stability: 0.15, growth: 0.1, mutation: 0.05, compatibility: 0.2 },
    speedMultiplier: 0.9,
    weight: 60,
  },
  {
    id: 'mixed-root',
    name: 'Mixed Root',
    tier: 2,
    description: 'Several weak elemental affinities blended together.',
    elements: [],
    attributes: { purity: 0.2, stability: 0.3, growth: 0.2, mutation: 0.1, compatibility: 0.3 },
    speedMultiplier: 0.95,
    weight: 40,
  },
  {
    id: 'three-element',
    name: 'Three Element',
    tier: 3,
    description: 'Three balanced elemental affinities within a single root.',
    elements: ['fire', 'water', 'earth'],
    attributes: { purity: 0.35, stability: 0.45, growth: 0.4, mutation: 0.2, compatibility: 0.5 },
    speedMultiplier: 1.05,
    weight: 25,
  },
  {
    id: 'dual-element',
    name: 'Dual Element',
    tier: 4,
    description: 'Two complementary elemental affinities within a single root.',
    elements: ['fire', 'wood'],
    attributes: { purity: 0.5, stability: 0.6, growth: 0.55, mutation: 0.3, compatibility: 0.65 },
    speedMultiplier: 1.2,
    weight: 15,
  },
  {
    id: 'single-element',
    name: 'Single Element',
    tier: 5,
    description: 'A single, focused elemental affinity.',
    elements: ['lightning'],
    attributes: { purity: 0.65, stability: 0.75, growth: 0.7, mutation: 0.45, compatibility: 0.8 },
    speedMultiplier: 1.4,
    weight: 10,
  },
  {
    id: 'mutated',
    name: 'Mutated',
    tier: 6,
    description: 'An elemental affinity mutated beyond its original form.',
    elements: ['ice'],
    attributes: { purity: 0.7, stability: 0.8, growth: 0.8, mutation: 0.85, compatibility: 0.85 },
    speedMultiplier: 1.6,
    weight: 6,
  },
  {
    id: 'heavenly',
    name: 'Heavenly',
    tier: 7,
    description: 'An exceptionally pure and powerful elemental affinity.',
    elements: ['light'],
    attributes: { purity: 0.85, stability: 0.85, growth: 0.85, mutation: 0.9, compatibility: 0.9 },
    speedMultiplier: 1.9,
    weight: 3,
  },
  {
    id: 'divine',
    name: 'Divine',
    tier: 8,
    description: 'A divine-grade elemental affinity of remarkable potential.',
    elements: ['space'],
    attributes: { purity: 0.95, stability: 0.9, growth: 0.9, mutation: 0.95, compatibility: 0.95 },
    speedMultiplier: 2.2,
    weight: 2,
  },
  {
    id: 'chaos',
    name: 'Chaos',
    tier: 9,
    description: 'An affinity that echoes primordial chaos itself.',
    elements: ['time'],
    attributes: { purity: 1, stability: 0.95, growth: 1, mutation: 1, compatibility: 1 },
    speedMultiplier: 2.7,
    weight: 1,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'spirit-roots' ladder
 * through getAll — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.spiritRoots] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ spiritRoots = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'spirit-roots') return [...spiritRoots];
      return [];
    },
  };
}

/**
 * Build a SpiritRootSystem instance with a fresh state clone (unless
 * overridden) and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @param {() => number} [options.random] — random source for the roll
 *        (defaults to () => 0 — a deterministic low roll).
 * @returns {{ state: object, spiritRoots: SpiritRootSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const spiritRoots = new SpiritRootSystem({
    state,
    eventBus: EventBus,
    dataManager,
    random: options.random || (() => 0),
  });
  return { state, spiritRoots, dataManager };
}

test('fresh-boot state stays unawakened with the cultivation slot at 1', () => {
  const state = structuredClone(GameState);
  const { spiritRoots } = makeSystem({ state });

  // The ladder snapshot loaded (10 canonical entries) and the fresh root is
  // the canonical unawakened pre-roll state.
  assert.equal(spiritRoots.count, 10);
  assert.deepEqual(state.spiritRoot, UNAWAKENED);
  assert.equal(state.cultivation.spiritRootMultiplier, 1);
  assert.equal(state.player.spiritRoot, 'Unawakened');
  assert.deepEqual(spiritRoots.current(), UNAWAKENED);
  assert.deepEqual(spiritRoots.current().elements, []);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { spiritRoots } = makeSystem();

  assert.equal(spiritRoots.count, 10);
  assert.equal(spiritRoots.byId('no-root').name, 'No Root');
  assert.equal(spiritRoots.byId('chaos').speedMultiplier, 2.7);
  assert.equal(spiritRoots.byId('missing'), null);
  // 'unawakened' is the fresh-game pre-roll state — deliberately NOT in the
  // data ladder.
  assert.equal(spiritRoots.byId('unawakened'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = spiritRoots.byId('no-root');
  copy.name = 'Hacked';
  assert.equal(spiritRoots.byId('no-root').name, 'No Root');
});

test('roll() with an injected random selects deterministically across the ladder', () => {
  // Buckets for roll = random() × 262 (total weight): no-root [0,100),
  // pseudo-root [100,160), mixed-root [160,200), …, chaos [261,262).
  const cases = [
    [() => 0, 'no-root', 0, 0.85],
    [() => 0.01, 'no-root', 0, 0.85],
    [() => 0.5, 'pseudo-root', 1, 0.9],
    [() => 0.7, 'mixed-root', 2, 0.95],
    [() => 0.8, 'three-element', 3, 1.05],
    [() => 0.999, 'chaos', 9, 2.7],
  ];
  for (const [random, id, tier, speedMultiplier] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { spiritRoots } = makeSystem({ state, random });

    const result = spiritRoots.roll();
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, tier, speedMultiplier },
      `random() -> ${id}`
    );

    // The roll writes ALL three owned locations.
    assert.deepEqual(state.spiritRoot, {
      id,
      name: definition.name,
      tier,
      elements: [...definition.elements],
      purity: definition.attributes.purity,
      stability: definition.attributes.stability,
      growth: definition.attributes.growth,
      mutation: definition.attributes.mutation,
      compatibility: definition.attributes.compatibility,
      speedMultiplier,
    });
    assert.equal(state.cultivation.spiritRootMultiplier, speedMultiplier);
    assert.equal(state.player.spiritRoot, definition.name);
    // The read API agrees with the written state.
    assert.equal(spiritRoots.current().id, id);
  }
});

test('roll() copies the elements array — later mutation never poisons the ladder', () => {
  const state = structuredClone(GameState);
  const { spiritRoots } = makeSystem({ state, random: () => 0.8 }); // three-element

  const result = spiritRoots.roll();
  assert.equal(result.id, 'three-element');
  assert.deepEqual(state.spiritRoot.elements, ['fire', 'water', 'earth']);

  // A hostile mutation of the written state must not corrupt the next roll.
  state.spiritRoot.elements.push('junk');
  state.spiritRoot.elements.splice(0, 1);
  const again = spiritRoots.roll();
  assert.equal(again.id, 'three-element');
  assert.deepEqual(state.spiritRoot.elements, ['fire', 'water', 'earth']);
});

test('roll() with a hostile random source still selects a valid entry (the last one)', () => {
  // NaN, negative and > 1 reads must never throw, never select nothing —
  // they fall through the cumulative walk to the LAST ladder entry (chaos).
  for (const random of [() => NaN, () => -1, () => 2, () => 1.0001]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { spiritRoots } = makeSystem({ state, random });

    assert.deepEqual(spiritRoots.roll(), {
      id: 'chaos',
      name: 'Chaos',
      tier: 9,
      speedMultiplier: 2.7,
    });
    assert.equal(state.spiritRoot.id, 'chaos');
    assert.equal(state.cultivation.spiritRootMultiplier, 2.7);
    assert.equal(state.player.spiritRoot, 'Chaos');
  }
});

test('without a dataManager the system degrades neutrally: count 0, roll rejects, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { spiritRoots } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({ state: structuredClone(GameState), dataManager: { getAll: () => [] } });

  assert.equal(spiritRoots.count, 0);
  assert.equal(spiritRoots.byId('no-root'), null);
  assert.deepEqual(spiritRoots.roll(), { outcome: null, reason: 'no-definitions' });
  // Zero state writes: the rejected roll left every slice untouched.
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.spiritRoots.count, 0);
  assert.deepEqual(empty.spiritRoots.roll(), { outcome: null, reason: 'no-definitions' });
  assert.deepEqual(empty.state.spiritRoot, UNAWAKENED);
  assert.equal(empty.state.cultivation.spiritRootMultiplier, 1);
});

test('hostile spirit root definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', tier: 5, elements: [], attributes: {}, speedMultiplier: 1, weight: 10 },
    // Skipped: empty id.
    { id: '', name: 'Empty', tier: 5, elements: [], attributes: {}, speedMultiplier: 1, weight: 10 },
    // Skipped: weight not a finite number > 0 (a broken bucket would corrupt
    // the cumulative walk).
    { id: 'zero-weight', name: 'Zero Weight', tier: 5, elements: [], attributes: {}, speedMultiplier: 1, weight: 0 },
    { id: 'nan-weight', name: 'NaN Weight', tier: 5, elements: [], attributes: {}, speedMultiplier: 1, weight: NaN },
    // Coerced: name/tier/speedMultiplier/elements unusable → safe defaults
    // (name falls back to id, tier to 0, elements to [], speed to 1).
    { id: 'broken', name: 42, tier: 'bogus', elements: 'junk', attributes: {}, speedMultiplier: 'bogus', weight: 50 },
    // Coerced: hostile attribute values clamp into 0..1, elements filter to
    // strings, speedMultiplier neutralizes.
    {
      id: 'clamped',
      name: 'Clamped',
      tier: 7,
      elements: [1, 'time', null],
      attributes: { purity: 2, stability: -1, growth: NaN },
      speedMultiplier: -5,
      weight: 20,
    },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken', name: 'Broken Duplicate', tier: 1, elements: [], attributes: {}, speedMultiplier: 1, weight: 30 },
  ]);
  const state = structuredClone(GameState);
  const { spiritRoots } = makeSystem({ state, dataManager: makeDataManager({ spiritRoots: hostile }) });

  // Only 'broken' and 'clamped' survived (6 entries skipped).
  assert.equal(spiritRoots.count, 2);
  assert.deepEqual(spiritRoots.byId('broken'), {
    id: 'broken',
    name: 'broken', // name fell back to the id
    tier: 0, // unusable tier → 0
    elements: [], // unusable elements → []
    purity: 0,
    stability: 0,
    growth: 0,
    mutation: 0,
    compatibility: 0,
    speedMultiplier: 1, // unusable factor → neutral 1
    weight: 50,
  });
  assert.deepEqual(spiritRoots.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    tier: 7,
    elements: ['time'], // non-strings dropped
    purity: 1, // 2 clamps into 0..1
    stability: 0, // -1 clamps into 0..1
    growth: 0, // NaN → neutral 0
    mutation: 0,
    compatibility: 0,
    speedMultiplier: 1, // -5 → neutral 1
    weight: 20,
  });

  // The roll over the hostile ladder still writes safe values — a rolled
  // entry's speedMultiplier can never poison the slot.
  const result = spiritRoots.roll(); // random 0 → 'broken' (weight 50 of 70)
  assert.equal(result.id, 'broken');
  assert.equal(state.cultivation.spiritRootMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.spiritRootMultiplier), true);
});

test('restore-trust: malformed spiritRoot/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.spiritRoot = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { spiritRoots } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps the cultivation slot at the neutral 1.
    assert.deepEqual(state.spiritRoot, UNAWAKENED);
    assert.equal(state.cultivation.spiritRootMultiplier, 1);
    assert.equal(state.player.spiritRoot, 'Unawakened');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(spiritRoots.count, 10); // the ladder still loaded
    assert.deepEqual(spiritRoots.current(), UNAWAKENED);

    // The repaired player slice accepts the roll's write.
    const result = spiritRoots.roll();
    assert.equal(result.id, 'no-root');
    assert.equal(state.player.spiritRoot, 'No Root');
  }
});

test('old-save compatibility: a save without the spirit-root keys repairs to unawakened, multiplier 1', () => {
  const state = structuredClone(GameState);
  delete state.spiritRoot;
  delete state.cultivation.spiritRootMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { spiritRoots } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.spiritRoot, UNAWAKENED);
  assert.equal(state.cultivation.spiritRootMultiplier, 1);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(spiritRoots.current(), UNAWAKENED);
});

test('a hostile restored speedMultiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.spiritRoot.speedMultiplier = multiplier;

    const { spiritRoots } = makeSystem({ state }); // must not throw

    assert.equal(state.cultivation.spiritRootMultiplier, 1);
    assert.equal(Number.isFinite(state.cultivation.spiritRootMultiplier), true);
    assert.equal(spiritRoots.current().speedMultiplier, 1);
    // A hostile slot value never leaks into the read either.
    state.cultivation.spiritRootMultiplier = multiplier;
    assert.equal(spiritRoots.current().speedMultiplier, 1);
  }
});

test('a restored spirit root lands its multiplier in the cultivation slot on boot', () => {
  const state = structuredClone(GameState);
  state.spiritRoot = {
    id: 'single-element',
    name: 'Single Element',
    tier: 5,
    elements: ['lightning'],
    purity: 0.65,
    stability: 0.75,
    growth: 0.7,
    mutation: 0.45,
    compatibility: 0.8,
    speedMultiplier: 1.4,
  };

  const { spiritRoots } = makeSystem({ state });

  // The constructor sync wrote the restored root's factor into the slot the
  // QiSystem stacks from the first tick; the display name is untouched.
  assert.equal(state.cultivation.spiritRootMultiplier, 1.4);
  assert.equal(state.player.spiritRoot, 'Unawakened');
  assert.deepEqual(spiritRoots.current(), {
    id: 'single-element',
    name: 'Single Element',
    tier: 5,
    elements: ['lightning'],
    purity: 0.65,
    stability: 0.75,
    growth: 0.7,
    mutation: 0.45,
    compatibility: 0.8,
    speedMultiplier: 1.4,
  });
});

test('current() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.spiritRoot = {
    id: 'mutated',
    name: 'Mutated',
    tier: 6,
    elements: ['ice'],
    purity: 0.7,
    stability: 0.8,
    growth: 0.8,
    mutation: 0.85,
    compatibility: 0.85,
    speedMultiplier: 1.6,
  };
  const { spiritRoots } = makeSystem({ state });

  const snapshot = spiritRoots.current();
  snapshot.id = 'hacked';
  snapshot.elements.push('junk');
  snapshot.speedMultiplier = 999;

  const again = spiritRoots.current();
  assert.equal(again.id, 'mutated');
  assert.deepEqual(again.elements, ['ice']);
  assert.equal(again.speedMultiplier, 1.6);
  assert.deepEqual(state.spiritRoot.elements, ['ice']);
});
