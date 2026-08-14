/**
 * tests/unit/luck.test.mjs — unit tests for js/systems/luck.js.
 *
 * Exercises the LuckSystem (single owner of the cultivator's luck state and
 * its two future-consumer multiplier slots) against a fake DataManager
 * lookalike serving the 'luck' ladder — the same injection pattern the
 * shipped bootstrap uses. Covered: construction boot-sync (fresh state stays
 * average with both cultivation slots at 1; a restored luck lands its
 * multipliers in the slots before the first tick), the count getter and the
 * byId() lookup (shallow copy, null for unknown ids), setLuck() writing ALL
 * owned locations (state.luck fields,
 * cultivation.luckCraftingMultiplier, cultivation.luckDropMultiplier,
 * player.luck), setLuck() rejecting unknown ids and empty/non-string ids, the
 * no-dataManager neutral degradation (count 0, setLuck returns null, zero
 * state writes), hostile-definition coercion/skipping (non-objects,
 * missing/empty ids skipped; missing name/multipliers coerced to safe
 * defaults — an unusable factor can never poison the slot), restore-trust
 * slice repair (malformed luck/cultivation/player slices never abort boot),
 * old-save compatibility (no luck slice → repaired to average, all slots 1),
 * the hostile restored multiplier coercion (NaN/Infinity/negative → neutral 1,
 * never a non-finite slot write), getCurrent() being a read-only defensive
 * snapshot (mutating it never leaks) and the 2026-08-13 slice-factory
 * consolidation (the shared restore-trust factories are imported from
 * js/core/game-state.js — a hostile cultivation/player repair yields exactly
 * the game-state.js factory output, and the module source declares no local
 * copies).
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
import { LuckSystem } from '../../js/systems/luck.js';

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
 * The canonical fresh luck slice (mirrors core/game-state.js) — the average
 * state (all 1.0× multipliers).
 */
const AVERAGE_LUCK = {
  id: 'average',
  name: 'Average',
  craftingMultiplier: 1.0,
  dropMultiplier: 1.0,
};

/**
 * The fixture luck ladder — the same contract shape as the shipped ladder
 * (id, name, description, craftingMultiplier, dropMultiplier). Worst→best in
 * ladder order: Jinxed → Fortune's Darling.
 */
const LADDER = deepFreeze([
  {
    id: 'jinxed',
    name: 'Jinxed',
    description: 'A jinx clings to their hands — crafts crack, drops disappoint, and fortune\'s gifts arrive broken or hollow.',
    craftingMultiplier: 0.60,
    dropMultiplier: 0.55,
  },
  {
    id: 'unlucky',
    name: 'Unlucky',
    description: 'Luck runs against them; the good things of the world are usually just out of reach.',
    craftingMultiplier: 0.80,
    dropMultiplier: 0.75,
  },
  {
    id: 'average',
    name: 'Average',
    description: 'No more and no less fortunate than the next cultivator — the ordinary odds of an ordinary life.',
    craftingMultiplier: 1.00,
    dropMultiplier: 1.00,
  },
  {
    id: 'lucky',
    name: 'Lucky',
    description: 'A glint of fortune follows their hands — crafts come out right and rare finds turn up at just the right time.',
    craftingMultiplier: 1.20,
    dropMultiplier: 1.25,
  },
  {
    id: 'fortunate',
    name: 'Fortunate',
    description: 'Fortune smiles upon their ventures — good results and valuable finds arrive noticeably more often than not.',
    craftingMultiplier: 1.45,
    dropMultiplier: 1.60,
  },
  {
    id: 'heaven-blessed',
    name: 'Heaven-Blessed',
    description: 'Heaven itself blesses their endeavors — fine crafts, rare drops and secret opportunities gather around them.',
    craftingMultiplier: 1.75,
    dropMultiplier: 2.00,
  },
  {
    id: 'fortunes-darling',
    name: 'Fortune\'s Darling',
    description: 'Fortune itself dotes on them like a favored child — the extraordinary becomes their everyday norm.',
    craftingMultiplier: 2.10,
    dropMultiplier: 2.50,
  },
]);

/**
 * Build a fake DataManager lookalike serving the 'luck' ladder through
 * getAll — the shape the real DataManager exposes to the shipped systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.luck] — ladder (defaults to LADDER).
 * @returns {{ getAll: Function }} the lookalike.
 */
function makeDataManager({ luck = LADDER } = {}) {
  return {
    getAll(collection) {
      if (collection === 'luck') return [...luck];
      return [];
    },
  };
}

/**
 * Build a LuckSystem instance with a fresh state clone (unless overridden)
 * and the fixture dataManager lookalike.
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike; pass null to exercise the no-dataManager
 *        neutral degradation).
 * @returns {{ state: object, luck: LuckSystem, dataManager: object }}
 *          the wired system.
 */
function makeSystem(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const luck = new LuckSystem({
    state,
    eventBus: EventBus,
    dataManager,
  });
  return { state, luck, dataManager };
}

test('fresh-boot state stays average with the cultivation slots at 1', () => {
  const state = structuredClone(GameState);
  const { luck } = makeSystem({ state });

  // The ladder snapshot loaded (7 canonical entries) and the fresh luck
  // is the canonical average state.
  assert.equal(luck.count, 7);
  assert.deepEqual(state.luck, AVERAGE_LUCK);
  assert.equal(state.cultivation.luckCraftingMultiplier, 1.0);
  assert.equal(state.cultivation.luckDropMultiplier, 1.0);
  assert.equal(state.player.luck, 'Average');
  assert.deepEqual(luck.getCurrent(), AVERAGE_LUCK);
});

test('count reflects the ladder size and byId() returns shallow copies or null', () => {
  const { luck } = makeSystem();

  assert.equal(luck.count, 7);
  assert.equal(luck.byId('average').name, 'Average');
  assert.equal(luck.byId('average').craftingMultiplier, 1.00);
  assert.equal(luck.byId('fortunes-darling').dropMultiplier, 2.50);
  assert.equal(luck.byId('missing'), null);

  // Shallow copy: mutating the returned object never leaks back.
  const copy = luck.byId('average');
  copy.name = 'Hacked';
  assert.equal(luck.byId('average').name, 'Average');
});

test('setLuck() changes all fields and writes all owned locations', () => {
  // Apply every ladder entry and verify all location writes.
  const cases = [
    ['jinxed', 0.60, 0.55],
    ['unlucky', 0.80, 0.75],
    ['average', 1.00, 1.00],
    ['lucky', 1.20, 1.25],
    ['fortunate', 1.45, 1.60],
    ['heaven-blessed', 1.75, 2.00],
    ['fortunes-darling', 2.10, 2.50],
  ];
  for (const [id, crafting, drop] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { luck } = makeSystem({ state });

    const result = luck.setLuck(id);
    const definition = LADDER.find((entry) => entry.id === id);
    assert.deepEqual(
      result,
      { id, name: definition.name, craftingMultiplier: crafting, dropMultiplier: drop },
      `setLuck("${id}")`
    );

    // The setLuck writes ALL owned locations.
    assert.deepEqual(state.luck, {
      id,
      name: definition.name,
      craftingMultiplier: crafting,
      dropMultiplier: drop,
    });
    assert.equal(state.cultivation.luckCraftingMultiplier, crafting);
    assert.equal(state.cultivation.luckDropMultiplier, drop);
    assert.equal(state.player.luck, definition.name);
    // The read API agrees with the written state.
    assert.equal(luck.getCurrent().id, id);
  }
});

test('setLuck() returns null for unknown ids and mutates nothing', () => {
  for (const id of ['unknown', 'nope', '']) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { luck } = makeSystem({ state });

    const result = luck.setLuck(id);
    assert.equal(result, null);
    assert.deepEqual(state.luck, before.luck);
    assert.equal(
      state.cultivation.luckCraftingMultiplier,
      before.cultivation.luckCraftingMultiplier
    );
    assert.equal(
      state.cultivation.luckDropMultiplier,
      before.cultivation.luckDropMultiplier
    );
    assert.equal(state.player.luck, before.player.luck);
  }
});

test('setLuck() with a non-string id returns null and mutates nothing', () => {
  for (const id of [null, 5, {}, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const before = structuredClone(state);
    const { luck } = makeSystem({ state });

    const result = luck.setLuck(id);
    assert.equal(result, null);
    assert.deepEqual(state.luck, before.luck);
  }
});

test('without a dataManager the system degrades neutrally: count 0, setLuck returns null, zero writes', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state);
  const { luck } = makeSystem({ state, dataManager: null });
  const empty = makeSystem({
    state: structuredClone(GameState),
    dataManager: { getAll: () => [] },
  });

  assert.equal(luck.count, 0);
  assert.equal(luck.byId('average'), null);
  assert.equal(luck.setLuck('average'), null);
  assert.deepEqual(state, before);

  // A lookalike whose getAll returns [] for the collection behaves the same.
  assert.equal(empty.luck.count, 0);
  assert.equal(empty.luck.setLuck('average'), null);
  assert.deepEqual(empty.state.luck, AVERAGE_LUCK);
  assert.equal(empty.state.cultivation.luckCraftingMultiplier, 1.0);
  assert.equal(empty.state.cultivation.luckDropMultiplier, 1.0);
});

test('hostile luck definitions are skipped or coerced to safe defaults', () => {
  const hostile = deepFreeze([
    // Skipped: not a plain object.
    'junk',
    // Skipped: missing id.
    { name: 'Ghost', craftingMultiplier: 0.5, dropMultiplier: 0.5 },
    // Skipped: empty id.
    { id: '', name: 'Empty', craftingMultiplier: 1, dropMultiplier: 1 },
    // Coerced: name/multipliers unusable → safe defaults
    // (name falls back to id, multipliers to neutral 1).
    { id: 'broken-def', name: 42, craftingMultiplier: 'bogus', dropMultiplier: NaN },
    // Coerced: hostile multipliers neutralize to 1.
    { id: 'clamped', name: 'Clamped', craftingMultiplier: Infinity, dropMultiplier: -3 },
    // Dedup: a duplicate id after the first occurrence is skipped.
    { id: 'broken-def', name: 'Broken Duplicate', craftingMultiplier: 2, dropMultiplier: 2 },
  ]);
  const state = structuredClone(GameState);
  const { luck } = makeSystem({
    state,
    dataManager: makeDataManager({ luck: hostile }),
  });

  // Only 'broken-def' and 'clamped' survived (4 entries skipped).
  assert.equal(luck.count, 2);
  assert.deepEqual(luck.byId('broken-def'), {
    id: 'broken-def',
    name: 'broken-def', // name fell back to the id
    craftingMultiplier: 1, // bogus → neutral 1
    dropMultiplier: 1, // NaN → neutral 1
  });
  assert.deepEqual(luck.byId('clamped'), {
    id: 'clamped',
    name: 'Clamped',
    craftingMultiplier: 1, // Infinity → neutral 1
    dropMultiplier: 1, // -3 → neutral 1
  });

  // setLuck over the hostile ladder still writes safe values — a set
  // entry's multipliers can never poison the slots.
  const result = luck.setLuck('broken-def');
  assert.equal(result.id, 'broken-def');
  assert.equal(state.cultivation.luckCraftingMultiplier, 1);
  assert.equal(state.cultivation.luckDropMultiplier, 1);
  assert.equal(Number.isFinite(state.cultivation.luckCraftingMultiplier), true);
  assert.equal(Number.isFinite(state.cultivation.luckDropMultiplier), true);
});

test('restore-trust: malformed luck/cultivation/player slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.luck = malformed;
    state.cultivation = malformed;
    state.player = malformed;

    const { luck } = makeSystem({ state }); // must not throw

    // Every repaired slice lands at the canonical fresh shape; the boot sync
    // keeps the cultivation slots at the neutral 1.
    assert.deepEqual(state.luck, AVERAGE_LUCK);
    assert.equal(state.cultivation.luckCraftingMultiplier, 1.0);
    assert.equal(state.cultivation.luckDropMultiplier, 1.0);
    assert.equal(state.player.luck, 'Average');
    assert.equal(state.player.name, 'Unnamed Cultivator');
    assert.equal(luck.count, 7); // the ladder still loaded
    assert.deepEqual(luck.getCurrent(), AVERAGE_LUCK);

    // The repaired player slice accepts setLuck's write.
    const result = luck.setLuck('fortunate');
    assert.equal(result.id, 'fortunate');
    assert.equal(state.player.luck, 'Fortunate');
  }
});

test('old-save compatibility: a save without the luck keys repairs to average, slots 1', () => {
  const state = structuredClone(GameState);
  delete state.luck;
  delete state.cultivation.luckCraftingMultiplier;
  delete state.cultivation.luckDropMultiplier;
  state.cultivation.qi = 42; // the old save's own values still land

  const { luck } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.luck, AVERAGE_LUCK);
  assert.equal(state.cultivation.luckCraftingMultiplier, 1.0);
  assert.equal(state.cultivation.luckDropMultiplier, 1.0);
  assert.equal(state.cultivation.qi, 42); // untouched by the repair
  assert.deepEqual(luck.getCurrent(), AVERAGE_LUCK);
});

test('a hostile restored multiplier is coerced to neutral 1 — never a non-finite slot write', () => {
  for (const multiplier of [NaN, Infinity, -Infinity, -1, 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.luck.craftingMultiplier = multiplier;
    state.luck.dropMultiplier = multiplier;

    const { luck } = makeSystem({ state }); // must not throw

    assert.equal(luck.getCurrent().craftingMultiplier, 1);
    assert.equal(luck.getCurrent().dropMultiplier, 1);
    assert.equal(Number.isFinite(luck.getCurrent().craftingMultiplier), true);
    assert.equal(Number.isFinite(luck.getCurrent().dropMultiplier), true);
  }
});

test('a restored luck lands its multipliers in the cultivation slots on boot', () => {
  const state = structuredClone(GameState);
  state.luck = {
    id: 'fortunate',
    name: 'Fortunate',
    craftingMultiplier: 1.45,
    dropMultiplier: 1.60,
  };
  // Match the player slot so the display name is consistent (the constructor
  // sync writes the cultivation slots only — same pattern as SoulSystem).
  state.player.luck = 'Fortunate';

  const { luck } = makeSystem({ state });

  // The constructor sync wrote the restored luck's multipliers into the
  // slots the future crafting/drop systems will read from the first tick.
  assert.equal(state.cultivation.luckCraftingMultiplier, 1.45);
  assert.equal(state.cultivation.luckDropMultiplier, 1.60);
  assert.equal(state.player.luck, 'Fortunate');
  assert.deepEqual(luck.getCurrent(), {
    id: 'fortunate',
    name: 'Fortunate',
    craftingMultiplier: 1.45,
    dropMultiplier: 1.60,
  });
});

test('getCurrent() is a read-only defensive snapshot — mutation never leaks', () => {
  const state = structuredClone(GameState);
  state.luck = {
    id: 'fortunes-darling',
    name: 'Fortune\'s Darling',
    craftingMultiplier: 2.10,
    dropMultiplier: 2.50,
  };
  const { luck } = makeSystem({ state });

  const snapshot = luck.getCurrent();
  snapshot.id = 'hacked';
  snapshot.craftingMultiplier = 999;

  const again = luck.getCurrent();
  assert.equal(again.id, 'fortunes-darling');
  assert.equal(again.craftingMultiplier, 2.10);
});

test('the shared restore-trust factories are imported from game-state.js (hostile cultivation/player repair yields their output)', () => {
  // Locks in the 2026-08-13 slice-factory consolidation: LuckSystem must use
  // the shared factories from js/core/game-state.js for its repair path
  // (never a local copy), so a hostile cultivation/player slice is repaired
  // to EXACTLY the canonical game-state.js factory output — including the
  // luck slots and the player.luck display name.
  const state = structuredClone(GameState);
  state.cultivation = null;
  state.player = 'junk';

  const { luck } = makeSystem({ state }); // must not throw

  assert.deepEqual(state.cultivation, freshCultivationSlice());
  assert.deepEqual(state.player, freshPlayerSlice());
  assert.equal(state.cultivation.luckCraftingMultiplier, 1);
  assert.equal(state.cultivation.luckDropMultiplier, 1);
  assert.equal(state.player.luck, 'Average');
  assert.deepEqual(luck.getCurrent(), AVERAGE_LUCK);
});

test('luck.js imports the shared restore-trust factories from game-state.js (no local copies)', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../js/systems/luck.js', import.meta.url), 'utf8')
  );
  // The module must import the shared factories from ../core/game-state.js.
  assert.match(
    source,
    /from\s+['"]\.\.\/core\/game-state\.js['"]/,
    'luck.js must import from ../core/game-state.js'
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
