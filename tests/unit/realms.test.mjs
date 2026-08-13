/**
 * tests/unit/realms.test.mjs — unit tests for js/systems/realms.js.
 *
 * Exercises the RealmSystem (single owner of the realm ladder): construction
 * from a fake dataManager ({ getAll: () => [...] } — ladder lookups
 * byId/byName/byTier/list/count, current()/next()/isMaxRealm, the effect
 * getters and unlocks), fresh-state resolution (realm 'Mortal' → tier 0,
 * nextRealm 'Qi Gathering', realmEffects written), legacy/alternate
 * resolution (stored id / display name / numeric tier all resolve to the
 * same definition), setRealm success (state identity + effects written,
 * exact 'realm:changed' payload, returns true), setRealm rejection (unknown
 * target → false + warn + no mutation + no event; already-current target →
 * false silently), unrecoverable stored realms (recover to tier 0 with a
 * warning), the empty-ladder degradation (no dataManager → neutral reads, no
 * state writes), restore-trust slice repair (malformed cultivation slices
 * never abort boot), top-realm next()/isMaxRealm, the defensive effect
 * coercion (missing/malformed multiplier fields → neutral defaults) and the
 * copy discipline (public lookups never leak into the deep-frozen
 * definitions). One test loads the REAL data/realms/realms.json through the
 * REAL DataManager (stubbed fetch, same pattern as tests/data/realms.test.mjs)
 * and asserts the current realm resolves to mortal with the real multipliers
 * (1, 1, 1, 100).
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
import { readFileSync } from 'node:fs';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState, freshCultivationSlice } from '../../js/core/game-state.js';
import { DataManager } from '../../js/core/data-manager.js';
import { RealmSystem } from '../../js/systems/realms.js';

/**
 * The canonical fresh cultivation slice — the single source of truth imported
 * from core/game-state.js (the same factory js/systems/realms.js now uses as
 * its restore-trust fallback). Used as the expected shape in the restore-trust
 * assertions; the factory's own canonical-ness (deep-equality with the state
 * construction) is guarded by tests/unit/slice-factories.test.mjs.
 *
 * @returns {object} the canonical cultivation slice.
 */
function freshCultivation() {
  return freshCultivationSlice();
}

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Recursively freeze a value (mirrors DataManager._deepFreeze) so the fake
 * ladder definitions behave like real cached definitions at runtime.
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
 * The fixture ladder — a compact stand-in for the data-driven ladder with
 * the same contract shape (id, name, tier, the three effect multipliers,
 * lifespanYears, unlocks). Deep-frozen to mirror the DataManager cache.
 */
const LADDER = deepFreeze([
  {
    id: 'mortal',
    name: 'Mortal',
    tier: 0,
    qiMaxMultiplier: 1,
    cultivationSpeedMultiplier: 1,
    lifespanYears: 100,
    powerMultiplier: 1,
    unlocks: ['walk'],
  },
  {
    id: 'qi-gathering',
    name: 'Qi Gathering',
    tier: 1,
    qiMaxMultiplier: 2,
    cultivationSpeedMultiplier: 1.5,
    lifespanYears: 200,
    powerMultiplier: 2,
    unlocks: [],
  },
  {
    id: 'foundation-establishment',
    name: 'Foundation Establishment',
    tier: 2,
    qiMaxMultiplier: 4,
    cultivationSpeedMultiplier: 2.2,
    lifespanYears: 400,
    powerMultiplier: 5,
    unlocks: [],
  },
  {
    id: 'beyond-heaven',
    name: 'Beyond Heaven',
    tier: 3,
    qiMaxMultiplier: 16384,
    cultivationSpeedMultiplier: 280,
    lifespanYears: 1000000,
    powerMultiplier: 50000,
    unlocks: [],
  },
]);

/**
 * Build a fake DataManager lookalike serving the given ladder through
 * getAll('realms') — fresh array, same frozen definition references (the
 * shape the real DataManager.getAll returns).
 *
 * @param {Array<object>} [definitions] — the ladder to serve.
 * @returns {{ getAll: () => object[] }} the lookalike.
 */
function makeDataManager(definitions = LADDER) {
  return { getAll: () => [...definitions] };
}

/**
 * Build a RealmSystem instance with a fresh state clone (unless overridden)
 * and the fixture ladder.
 *
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @param {object} [dataManager] — dataManager to inject (defaults to the
 *        fixture ladder lookalike).
 * @returns {RealmSystem} the system instance.
 */
function makeSystem(state = structuredClone(GameState), dataManager = makeDataManager(), config = undefined) {
  return new RealmSystem({ state, eventBus: EventBus, dataManager, config });
}

test('construction snapshots the ladder and exposes the lookup API', () => {
  const system = makeSystem();

  assert.equal(system.count, 4);
  assert.deepEqual(
    system.list().map((realm) => realm.id),
    ['mortal', 'qi-gathering', 'foundation-establishment', 'beyond-heaven']
  );

  // byId
  assert.equal(system.byId('mortal').name, 'Mortal');
  assert.equal(system.byId('nope'), null);
  // byName — exact, then case-insensitive.
  assert.equal(system.byName('Qi Gathering').tier, 1);
  assert.equal(system.byName('qi gathering').tier, 1);
  assert.equal(system.byName('MORTAL').tier, 0);
  assert.equal(system.byName('nope'), null);
  // byTier
  assert.equal(system.byTier(2).id, 'foundation-establishment');
  assert.equal(system.byTier(99), null);

  // current()/next()/isMaxRealm resolve from the fresh-state mortal realm.
  assert.equal(system.current().id, 'mortal');
  assert.equal(system.next().id, 'qi-gathering');
  assert.equal(system.isMaxRealm, false);

  // Effect getters mirror the current definition.
  assert.equal(system.qiMaxMultiplier, 1);
  assert.equal(system.cultivationSpeedMultiplier, 1);
  assert.equal(system.powerMultiplier, 1);
  assert.equal(system.lifespanYears, 100);

  // unlocks returns a copy of the current definition's unlocks array.
  assert.deepEqual(system.unlocks, ['walk']);
});

test('fresh-state resolution writes the canonical identity and effects', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state);

  assert.equal(system.current().id, 'mortal');
  assert.equal(state.cultivation.realm, 'Mortal');
  assert.equal(state.cultivation.realmTier, 0);
  assert.equal(state.cultivation.nextRealm, 'Qi Gathering');
  assert.deepEqual(state.cultivation.realmEffects, {
    qiMaxMultiplier: 1,
    cultivationSpeedMultiplier: 1,
    powerMultiplier: 1,
    lifespanYears: 100,
  });
});

test('legacy/alternate stored realms resolve to the same definition', () => {
  // Stored id ('mortal'), stored display name ('Mortal') and stored numeric
  // tier (0) all resolve to the canonical mortal definition and write the
  // same identity into state.
  for (const stored of ['mortal', 'Mortal', 0]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.cultivation.realm = stored;

    const system = makeSystem(state);

    assert.equal(system.current().id, 'mortal');
    assert.equal(system.current().name, 'Mortal');
    assert.equal(state.cultivation.realm, 'Mortal');
    assert.equal(state.cultivation.realmTier, 0);
    assert.equal(state.cultivation.nextRealm, 'Qi Gathering');
  }
});

test('setRealm success applies the definition, emits realm:changed and returns true', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state);
  const changed = [];
  EventBus.subscribe('realm:changed', (payload) => changed.push(payload));

  const result = system.setRealm('qi-gathering');

  assert.equal(result, true);
  assert.equal(state.cultivation.realm, 'Qi Gathering');
  assert.equal(state.cultivation.realmTier, 1);
  assert.equal(state.cultivation.nextRealm, 'Foundation Establishment');
  assert.deepEqual(state.cultivation.realmEffects, {
    qiMaxMultiplier: 2,
    cultivationSpeedMultiplier: 1.5,
    powerMultiplier: 2,
    lifespanYears: 200,
  });
  assert.deepEqual(changed, [
    {
      realmId: 'qi-gathering',
      realmName: 'Qi Gathering',
      tier: 1,
      effects: {
        qiMaxMultiplier: 2,
        cultivationSpeedMultiplier: 1.5,
        powerMultiplier: 2,
        lifespanYears: 200,
      },
    },
  ]);
});

test('setRealm accepts names and tiers too (id | name | tier)', () => {
  for (const target of ['foundation-establishment', 'Foundation Establishment', 2]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const system = makeSystem(state);
    const changed = [];
    EventBus.subscribe('realm:changed', (payload) => changed.push(payload));

    assert.equal(system.setRealm(target), true);
    assert.equal(state.cultivation.realm, 'Foundation Establishment');
    assert.equal(state.cultivation.realmTier, 2);
    assert.equal(state.cultivation.nextRealm, 'Beyond Heaven');
    assert.equal(changed.length, 1);
  }
});

test('setRealm with an unknown target rejects: false, no mutation, no event, one warn', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const system = makeSystem(state);
  const changed = [];
  EventBus.subscribe('realm:changed', (payload) => changed.push(payload));
  const before = structuredClone(state.cultivation);

  for (const target of ['bogus', 'MORTALS', 99]) {
    assert.equal(system.setRealm(target), false);
  }

  assert.equal(warn.mock.callCount(), 3);
  assert.deepEqual(state.cultivation, before);
  assert.deepEqual(changed, []);
});

test('setRealm to the already-current realm is a silent false (no event, no warn)', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const system = makeSystem(state);
  const changed = [];
  EventBus.subscribe('realm:changed', (payload) => changed.push(payload));

  // Fresh state resolves to mortal — id, name and tier forms all no-op.
  assert.equal(system.setRealm('mortal'), false);
  assert.equal(system.setRealm('Mortal'), false);
  assert.equal(system.setRealm(0), false);

  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(changed, []);
  assert.equal(state.cultivation.realm, 'Mortal');
  assert.equal(state.cultivation.realmTier, 0);
});

test('an unresolvable stored realm recovers to tier 0 with a warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  state.cultivation.realm = 'Bogus';

  const system = makeSystem(state);

  assert.equal(warn.mock.callCount(), 1);
  assert.equal(system.current().id, 'mortal');
  assert.equal(state.cultivation.realm, 'Mortal');
  assert.equal(state.cultivation.realmTier, 0);
  assert.equal(state.cultivation.nextRealm, 'Qi Gathering');
});

test('an empty ladder (no dataManager) degrades neutrally and never writes state', () => {
  const state = structuredClone(GameState);
  const before = structuredClone(state.cultivation);

  const system = new RealmSystem({ state, eventBus: EventBus }); // no dataManager

  assert.equal(system.count, 0);
  assert.deepEqual(system.list(), []);
  assert.equal(system.byId('mortal'), null);
  assert.equal(system.byName('Mortal'), null);
  assert.equal(system.byTier(0), null);
  assert.equal(system.current(), null);
  assert.equal(system.next(), null);
  assert.equal(system.isMaxRealm, false);
  assert.equal(system.qiMaxMultiplier, 1);
  assert.equal(system.cultivationSpeedMultiplier, 1);
  assert.equal(system.powerMultiplier, 1);
  assert.equal(system.lifespanYears, 0);
  assert.deepEqual(system.unlocks, []);
  // Neutral degradation: the restored cultivation slice is untouched.
  assert.deepEqual(state.cultivation, before);
});

test('setRealm on an empty ladder rejects with a warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const system = new RealmSystem({ state, eventBus: EventBus });
  const changed = [];
  EventBus.subscribe('realm:changed', (payload) => changed.push(payload));

  assert.equal(system.setRealm('mortal'), false);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(changed, []);
});

test('restore-trust: malformed cultivation slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.cultivation = malformed;

    const system = makeSystem(state); // must not throw

    assert.deepEqual(state.cultivation, freshCultivation());
    assert.equal(system.current().id, 'mortal');
  }
});

test('top-realm next() is null and isMaxRealm is true', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state);

  assert.equal(system.setRealm('beyond-heaven'), true);

  assert.equal(system.current().id, 'beyond-heaven');
  assert.equal(system.next(), null);
  assert.equal(system.isMaxRealm, true);
  assert.equal(state.cultivation.nextRealm, null);
});

test('public lookups return copies that never leak into the frozen definitions', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state);

  const byId = system.byId('mortal');
  byId.id = 'hacked';
  byId.qiMaxMultiplier = 999;
  assert.equal(system.byId('mortal').id, 'mortal');
  assert.equal(system.byId('mortal').qiMaxMultiplier, 1);

  const byName = system.byName('Mortal');
  byName.tier = 99;
  assert.equal(system.byTier(0).tier, 0);

  const listed = system.list();
  listed[0].name = 'hacked';
  assert.equal(system.list()[0].name, 'Mortal');

  const current = system.current();
  current.name = 'hacked';
  assert.equal(system.current().name, 'Mortal');

  // The internal definitions are still frozen (mirroring the DataManager).
  assert.equal(Object.isFrozen(LADDER[0]), true);
  assert.equal(Object.isFrozen(LADDER[0].unlocks), true);
});

test('definitions missing or carrying malformed effect fields coerce to neutral defaults', () => {
  const ladder = deepFreeze([
    { id: 'bare', name: 'Bare', tier: 0 }, // no effect fields at all
    {
      id: 'hostile',
      name: 'Hostile',
      tier: 1,
      qiMaxMultiplier: -5,
      cultivationSpeedMultiplier: 0,
      powerMultiplier: Infinity,
      lifespanYears: -100,
    },
  ]);
  const state = structuredClone(GameState);
  state.cultivation.realm = 'Bare';

  const system = makeSystem(state, makeDataManager(ladder));

  // Missing effect fields → neutral multipliers (1) and lifespan 0.
  assert.deepEqual(state.cultivation.realmEffects, {
    qiMaxMultiplier: 1,
    cultivationSpeedMultiplier: 1,
    powerMultiplier: 1,
    lifespanYears: 0,
  });
  assert.equal(system.qiMaxMultiplier, 1);
  assert.equal(system.cultivationSpeedMultiplier, 1);
  assert.equal(system.powerMultiplier, 1);
  assert.equal(system.lifespanYears, 0);

  // Malformed/hostile values coerce the same way (never zero a cap/rate,
  // never a negative lifespan).
  assert.equal(system.setRealm('hostile'), true);
  assert.deepEqual(state.cultivation.realmEffects, {
    qiMaxMultiplier: 1,
    cultivationSpeedMultiplier: 1,
    powerMultiplier: 1,
    lifespanYears: 0,
  });
});

test('the REAL ladder resolves through the REAL DataManager with the real mortal multipliers', async (t) => {
  const rawRealms = JSON.parse(
    readFileSync(new URL('../../data/realms/realms.json', import.meta.url), 'utf8')
  );
  const rawManifest = JSON.parse(
    readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
  );
  const DATA_FILES = {
    'data/manifest.json': rawManifest,
    'data/realms/realms.json': rawRealms,
  };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const text = String(url);
    const key = Object.keys(DATA_FILES).find((candidate) => text.endsWith(candidate));
    if (key === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(DATA_FILES[key]) };
  });

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('realms');

  const state = structuredClone(GameState);
  const system = new RealmSystem({ state, eventBus: EventBus, dataManager });

  assert.equal(system.count, 15);
  assert.equal(system.current().id, 'mortal');
  assert.equal(system.current().name, 'Mortal');
  assert.equal(system.current().tier, 0);
  assert.equal(system.qiMaxMultiplier, 1);
  assert.equal(system.cultivationSpeedMultiplier, 1);
  assert.equal(system.powerMultiplier, 1);
  assert.equal(system.lifespanYears, 100);
  assert.equal(state.cultivation.realm, 'Mortal');
  assert.equal(state.cultivation.realmTier, 0);
  assert.equal(state.cultivation.nextRealm, 'Qi Gathering');
  assert.deepEqual(state.cultivation.realmEffects, {
    qiMaxMultiplier: 1,
    cultivationSpeedMultiplier: 1,
    powerMultiplier: 1,
    lifespanYears: 100,
  });
});

// ---- P4: Nine sub-levels per realm ----

test('advanceLayer increments realmLayer and resets progress', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state, makeDataManager(), { cultivation: { layerFactor: 0.15, layerMax: 9 } });
  // Simulate a layer-1 realm with full progress.
  state.cultivation.realmProgress = 1000;

  const layerAdvanced = [];
  EventBus.subscribe('realm:layerAdvanced', (p) => layerAdvanced.push(p));

  // First advance: 1 → 2
  const ok = system.advanceLayer();
  assert.equal(ok, true);
  assert.equal(state.cultivation.realmLayer, 2);
  assert.equal(state.cultivation.realmProgress, 0);
  // Max scales: base 1000 × (1 + 0.15 × 1) = 1150
  assert.equal(state.cultivation.realmProgressMax, 1150);
  assert.deepEqual(layerAdvanced, [
    { layer: 2, realm: 'Mortal', realmId: 'mortal' },
  ]);
});

test('advanceLayer returns false at layer 9', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state, makeDataManager(), { cultivation: { layerFactor: 0.15, layerMax: 9 } });

  // Advance through layers 1..9
  for (let i = 1; i < 9; i++) {
    state.cultivation.realmProgress = state.cultivation.realmProgressMax;
    assert.equal(system.advanceLayer(), true, `advance to layer ${i + 1}`);
  }
  assert.equal(state.cultivation.realmLayer, 9);

  // At layer 9 advanceLayer returns false.
  const before = structuredClone(state.cultivation);
  assert.equal(system.advanceLayer(), false);
  assert.deepEqual(state.cultivation, before);
});

test('layer cost scales progressively: layer 5 = base × (1 + 0.15 × 4)', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state, makeDataManager(), { cultivation: { layerFactor: 0.15, layerMax: 9 } });
  // Base is 1000 (the mortal default realmProgressMax at layer 1).
  state.cultivation.realmProgressMax = 1000;

  // Advance to layer 5: 1→2→3→4→5
  for (let i = 1; i < 5; i++) {
    state.cultivation.realmProgress = state.cultivation.realmProgressMax;
    system.advanceLayer();
  }
  assert.equal(state.cultivation.realmLayer, 5);
  // layer 5 = 1000 × (1 + 0.15 × 4) = 1000 × 1.6 = 1600
  assert.equal(state.cultivation.realmProgressMax, 1600);
});

test('layer cost at layer 9 = base × 2.20 with layerFactor 0.15', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state, makeDataManager(), { cultivation: { layerFactor: 0.15, layerMax: 9 } });
  state.cultivation.realmProgressMax = 1000;

  for (let i = 1; i < 9; i++) {
    state.cultivation.realmProgress = state.cultivation.realmProgressMax;
    system.advanceLayer();
  }
  assert.equal(state.cultivation.realmLayer, 9);
  // layer 9 = 1000 × (1 + 0.15 × 8) = 1000 × 2.20 = 2200
  assert.equal(state.cultivation.realmProgressMax, 2200);
});

test('setRealm resets layer to 1', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state, makeDataManager(), { cultivation: { layerFactor: 0.15, layerMax: 9 } });

  // Advance to layer 3
  state.cultivation.realmProgress = 1000;
  system.advanceLayer();
  state.cultivation.realmProgress = state.cultivation.realmProgressMax;
  system.advanceLayer();
  assert.equal(state.cultivation.realmLayer, 3);

  // setRealm resets layer to 1.
  system.setRealm(1); // Qi Gathering
  assert.equal(state.cultivation.realmLayer, 1);
  assert.equal(state.cultivation.realm, 'Qi Gathering');
});

test('advanceLayer uses default layerFactor 0.15 and layerMax 9 when config is absent', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state, makeDataManager()); // no config

  state.cultivation.realmProgress = 1000;
  const ok = system.advanceLayer();
  assert.equal(ok, true);
  assert.equal(state.cultivation.realmLayer, 2);
  // base 1000 × (1 + 0.15 × 1) = 1150 (default layerFactor 0.15)
  assert.equal(state.cultivation.realmProgressMax, 1150);
});
