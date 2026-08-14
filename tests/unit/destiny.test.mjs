/**
 * tests/unit/destiny.test.mjs — unit tests for js/systems/destiny.js.
 *
 * Exercises the DestinySystem (single owner of the cultivator's destiny state
 * and its two future-consumer multiplier slots) against a fake DataManager
 * lookalike serving the 'destiny' ladder — the same injection pattern the
 * shipped bootstrap uses. Covered: construction boot-sync (fresh state stays
 * mundane with both cultivation slots at 1; a restored destiny lands its
 * multipliers in the slots before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setDestiny() writing ALL
 * owned locations (state.destiny fields,
 * cultivation.destinyFortuneMultiplier, cultivation.destinyCalamityMultiplier,
 * player.destiny), setDestiny() rejecting unknown ids and empty/non-string
 * ids, the no-dataManager neutral degradation (count 0, setDestiny returns
 * null, zero state writes), hostile-definition coercion/skipping (non-objects,
 * missing/empty ids skipped; missing name/multipliers coerced to safe
 * defaults — an unusable factor can never poison the slot), restore-trust
 * slice repair (malformed destiny/cultivation/player slices never abort
 * boot), old-save compatibility (no destiny slice → repaired to mundane, all
 * slots 1), the hostile restored multiplier coercion (NaN/Infinity/negative →
 * neutral 1, never a non-finite slot write), getCurrent() being a read-only
 * defensive snapshot (mutating it never leaks) and the 2026-08-13
 * slice-factory consolidation (the shared restore-trust factories are
 * imported from js/core/game-state.js — a hostile cultivation/player repair
 * yields exactly the game-state.js factory output, and the module source
 * declares no local copies).
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
import {
  GameState,
  freshCultivationSlice,
  freshPlayerSlice,
} from '../../js/core/game-state.js';
import { DestinySystem } from '../../js/systems/destiny.js';

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
 * The canonical fresh destiny slice (mirrors core/game-state.js) — the
 * mundane state (all 1.0× multipliers).
 */
const MUNDANE_DESTINY = {
  id: 'mundane',
  name: 'Mundane',
  fortuneMultiplier: 1.0,
  calamityMultiplier: 1.0,
};

/**
 * The fixture destiny ladder — the same contract shape as the shipped ladder
 * (id, name, description, fortuneMultiplier, calamityMultiplier). Worst→best
 * in ladder order: Doomed → Son of Heaven.
 */
const LADDER = deepFreeze([
  {
    id: 'doomed',
    name: 'Doomed',
    description: 'A fate that courts disaster — calamity shadows every step, and fortune slips through the fingers like mist.',
    fortuneMultiplier: 0.55,
    calamityMultiplier: 0.60,
  },
  {
    id: 'ill-fated',
    name: 'Ill-Fated',
    description: 'Bad omens follow wherever they walk; promising doors tend to close just before they arrive.',
    fortuneMultiplier: 0.75,
    calamityMultiplier: 0.80,
  },
  {
    id: 'mundane',
    name: 'Mundane',
    description: 'A common lot shared by most cultivators — no special favor, no unusual curse, just the long road ahead.',
    fortuneMultiplier: 1.00,
    calamityMultiplier: 1.00,
  },
  {
    id: 'favored',
    name: 'Favored',
    description: 'The heavens seem to smile on their path — lucky encounters and useful opportunities appear with pleasing regularity.',
    fortuneMultiplier: 1.25,
    calamityMultiplier: 1.20,
  },
  {
    id: 'blessed',
    name: 'Blessed',
    description: 'Fortune bends toward them like a loyal servant; hidden treasures and rare teachers find their way to their door.',
    fortuneMultiplier: 1.60,
    calamityMultiplier: 1.45,
  },
  {
    id: 'heavenly-favored',
    name: 'Heavenly-Favored',
    description: 'The will of heaven itself seems to arrange the world around them — calamities veer away and opportunities abound.',
    fortuneMultiplier: 2.00,
    calamityMultiplier: 1.75,
  },
  {
    id: 'son-of-heaven',
    name: 'Son of Heaven',
    description: 'A destiny as vast as the sky — the heavens themselves conspire on their behalf, and calamity dare not touch them.',
    fortuneMultiplier: 2.50,
    calamityMultiplier: 2.10,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'destiny' ladder through
 * getAll — the shape the real DataManager exposes to the shipped systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.destiny] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ destiny = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'destiny') return [...destiny];
      return [];
    },
  };
}

/**
 * Build a DestinySystem instance with a fresh state clone (unless overridden)
 * and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, destiny: DestinySystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const destiny = new DestinySystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, destiny, dataManager };
}

test('fresh-boot state stays mundane with the cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { destiny } = makeSystem({ state });

  // The ladder snapshot loaded (7 canonical entries) and the fresh destiny
  // is the canonical mundane state.
  assert.equal(destiny.count, 7);
  assert.deepEqual(state.destiny, MUNDANE_DESTINY);
  assert.equal(state.cultivation.destinyFortuneMultiplier, 1.0);
  assert.equal(state.cultivation.destinyCalamityMultiplier, 1.0);
  assert.equal(state.player.destiny, 'Mundane');
  assert.deepEqual(destiny.getCurrent(), MUNDANE_DESTINY);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { destiny } = makeSystem();

  assert.equal(destiny.count, 7);
  assert.equal(destiny.byId('mundane').name, 'Mundane');
  assert.equal(destiny.byId('mundane').fortuneMultiplier, 1.00);
  assert.equal(destiny.byId('son-of-heaven').fortuneMultiplier, 2.50);
  assert.equal(destiny.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = destiny.byId('mundane');
  copy.name = 'Hacked';
  assert.equal(destiny.byId('mundane').name, 'Mundane');
});

test('setDestiny() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['doomed', 0.55, 0.60],
    ['ill-fated', 0.75, 0.80],
    ['mundane', 1.00, 1.00],
    ['favored', 1.25, 1.20],
    ['blessed', 1.60, 1.45],
    ['heavenly-favored', 2.00, 1.75],
    ['son-of-heaven', 2.50, 2.10],
  ];
  for (const [id, fortune, calamity] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { destiny } = makeSystem({ state });

    const result = destiny.setDestiny(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, fortuneMultiplier: fortune, calamityMultiplier: calamity },
      `setDestiny("${id}")`
    );

    // The setDestiny writes ALL owned locations.
    assert.deepEqual(state.destiny, {
      id,
      name: definition.name,
      fortuneMultiplier: fortune,
      calamityMultiplier: calamity,
    });
    assert.equal(state.cultivation.destinyFortuneMultiplier, fortune);
    assert.equal(state.cultivation.destinyCalamityMultiplier, calamity);
    assert.equal(state.player.destiny, definition.name);
    // The read API agrees with the written state.
    assert.equal(destiny.getCurrent().id, id);
  }
});

test('setDestiny() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { destiny } = makeSystem({ state });

    const result = destiny.setDestiny(id);
    assert.equal(result, null);
    assert.deepEqual(state.destiny, before.destiny);
    assert.equal(
      state.cultivation.destinyFortuneMultiplier,
      before.cultivation.destinyFortuneMultiplier
    );
    assert.equal(
      state.cultivation.destinyCalamityMultiplier,
      before.cultivation.destinyCalamityMultiplier
    );
    assert.equal(state.player.destiny, before.player.destiny);
  }
});

test('setDestiny() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { destiny } = makeSystem({ state });

    const result = destiny.setDestiny(id);
    assert.equal(result, null);
    assert.deepEqual(state.destiny, before.destiny);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setDestiny returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { destiny } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({
    state: structuredClone(GameState),
    dataManager: { getAll: () => [] },
  });

  assert.equal(destiny.count, 0);
  assert.equal(destiny.byId('mundane'), null);
  assert.equal(destiny.setDestiny('mundane'), null);
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.destiny.count, 0);
  assert.equal(empty.destiny.setDestiny('mundane'), null);
  assert.deepEqual(empty.state.destiny, MUNDANE_DESTINY);
  assert.equal(empty.state.cultivation.destinyFortuneMultiplier, 1.0);
  assert.equal(empty.state.cultivation.destinyCalamityMultiplier, 1.0);
});

test('hostile destiny definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', fortuneMultiplier: 0.5, calamityMultiplier: 0.5 },
    // Skipped: empty id.
    { id: '', name: 'Empty', fortuneMultiplier: 1, calamityMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, fortuneMultiplier: 'bogus', calamityMultiplier: NaN },
    // Coerced: hostile multipliers neutralize to 1.
    { id: 'clamped', name: 'Clamped', fortuneMultiplier: Infinity, calamityMultiplier: -3 },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', fortuneMultiplier: 2, calamityMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { destiny } = makeSystem({
    state,
    dataManager: makeDataManager({ destiny: hostile }),
  });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(destiny.count, 2);
  assert.deepEqual(destiny.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    fortuneMultiplier: 1, // bogus → neutral 1
    calamityMultiplier: 1, // NaN → neutral 1
  });
  assert.deepEqual(destiny.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    fortuneMultiplier: 1, // Infinity → neutral 1
    calamityMultiplier: 1, // -3 → neutral 1
  });

  // setDestiny over the hostile ladder still writes safe values — a set
  // entry's multipliers can never poison the slots.
  const result = destiny.setDestiny('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.destinyFortuneMultiplier, 1);
  assert.equal(state.cultivation.destinyCalamityMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.destinyFortuneMultiplier), true);
  assert.equal(Number.isFinite(state.cultivation.destinyCalamityMultiplier), true);
});

test('restore-trust: malformed destiny/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.destiny = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { destiny } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps the cultivation slots at the neutral 1.
    assert.deepEqual(state.destiny, MUNDANE_DESTINY);
    assert.equal(state.cultivation.destinyFortuneMultiplier, 1.0);
    assert.equal(state.cultivation.destinyCalamityMultiplier, 1.0);
    assert.equal(state.player.destiny, 'Mundane');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(destiny.count, 7); // the ladder still loaded
    assert.deepEqual(destiny.getCurrent(), MUNDANE_DESTINY);

    // The repaired player slice accepts setDestiny's write.
    const result = destiny.setDestiny('blessed');
    assert.equal(result.id, 'blessed');
    assert.equal(state.player.destiny, 'Blessed');
  }
});

test('old-save compatibility: a save without the destiny keys repairs to mundane, slots 1', () => {
  const state = structuredClone(GameState);
  delete state.destiny;
  delete state.cultivation.destinyFortuneMultiplier;
  delete state.cultivation.destinyCalamityMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { destiny } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.destiny, MUNDANE_DESTINY);
  assert.equal(state.cultivation.destinyFortuneMultiplier, 1.0);
  assert.equal(state.cultivation.destinyCalamityMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(destiny.getCurrent(), MUNDANE_DESTINY);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.destiny.fortuneMultiplier = multiplier;
    state.destiny.calamityMultiplier = multiplier;

    const { destiny } = makeSystem({ state }); // must not throw

    assert.equal(destiny.getCurrent().fortuneMultiplier, 1);
    assert.equal(destiny.getCurrent().calamityMultiplier, 1);
    assert.equal(Number.isFinite(destiny.getCurrent().fortuneMultiplier), true);
    assert.equal(Number.isFinite(destiny.getCurrent().calamityMultiplier), true);
  }
});

test('a restored destiny lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.destiny = {
    id: 'blessed',
    name: 'Blessed',
    fortuneMultiplier: 1.60,
    calamityMultiplier: 1.45,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes the cultivation slots only — same pattern as SoulSystem).
  state.player.destiny = 'Blessed';

  const { destiny } = makeSystem({ state });

  // The constructor sync wrote the restored destiny's multipliers into the
  // slots the future encounter/calamity systems will read from the first tick.
  assert.equal(state.cultivation.destinyFortuneMultiplier, 1.60);
  assert.equal(state.cultivation.destinyCalamityMultiplier, 1.45);
  assert.equal(state.player.destiny, 'Blessed');
  assert.deepEqual(destiny.getCurrent(), {
    id: 'blessed',
    name: 'Blessed',
    fortuneMultiplier: 1.60,
    calamityMultiplier: 1.45,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.destiny = {
    id: 'son-of-heaven',
    name: 'Son of Heaven',
    fortuneMultiplier: 2.50,
    calamityMultiplier: 2.10,
  };
  const { destiny } = makeSystem({ state });

  const snapshot = destiny.getCurrent();
  snapshot.id = 'hacked';
  snapshot.fortuneMultiplier = 999;

  const again = destiny.getCurrent();
  assert.equal(again.id, 'son-of-heaven');
  assert.equal(again.fortuneMultiplier, 2.50);
});

test('the shared restore-trust factories are imported from game-state.js (hostile cultivation/player repair yields their output)', () => {
  // Locks in the 2026-08-13 slice-factory consolidation: DestinySystem must
  // use the shared factories from js/core/game-state.js for its repair path
  // (never a local copy), so a hostile cultivation/player slice is repaired
  // to EXACTLY the canonical game-state.js factory output — including the
  // destiny slots and the player.destiny display name.
  const state = structuredClone(GameState);
  state.cultivation = null;
  state.player = 'junk';

  const { destiny } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.cultivation, freshCultivationSlice());
  assert.deepEqual(state.player, freshPlayerSlice());
  assert.equal(state.cultivation.destinyFortuneMultiplier, 1);
  assert.equal(state.cultivation.destinyCalamityMultiplier, 1);
  assert.equal(state.player.destiny, 'Mundane');
  assert.deepEqual(destiny.getCurrent(), MUNDANE_DESTINY);
});

test('destiny.js imports the shared restore-trust factories from game-state.js (no local copies)', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../js/systems/destiny.js', import.meta.url), 'utf8')
  );
  // The module must import the shared factories from ../core/game-state.js.
  assert.match(
    source,
    /from\s+['"]\.\.\/core\/game-state\.js['"]/,
    'destiny.js must import from ../core/game-state.js'
  );
  // And must NOT declare any local restore-trust factory copy.
  assert.ok(
    !source.includes('function _freshCultivationSlice'),
    'no local freshCultivationSlice copy allowed'
  );
  assert.ok(
    !source.includes('function _freshPlayerSlice'),
    'no local freshPlayerSlice copy allowed'
  );
  assert.ok(
    !source.includes('function _coerceMultiplier'),
    'no local coerceMultiplier copy allowed'
  );
});
