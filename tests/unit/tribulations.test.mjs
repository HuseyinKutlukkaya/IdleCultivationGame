/**
 * tests/unit/tribulations.test.mjs — unit tests for js/systems/tribulations.js.
 *
 * Exercises the TribulationSystem (single owner of the tribulation gate on
 * the current realm's breakthrough) against REAL RealmSystem /
 * ResourceSystem / InventorySystem / BreakthroughSystem instances wired to a
 * shared fake DataManager lookalike (the 'realms' ladder, the 'breakthroughs'
 * tables, the 'items' catalog and the 'tribulations' table) — the same
 * injection pattern the shipped bootstrap uses. Covered: construction
 * boot-sync (neutral gate at an ungated realm, open gate at a gated tier,
 * preserved survived gate on a reload), the 'realm:changed' subscription
 * (opens the gate + emits 'tribulation:started' on a gated realm, neutralizes
 * on an ungated one), the requirements()/canFace() read-only gate snapshot,
 * face() blocked reasons ('no-tribulation' / 'not-pending' — no mutation, no
 * event), the four canonical outcome paths (survived / barely-survived open
 * the gate with no progress loss; injured / near-death keep it pending and
 * apply progressLoss × realmProgressMax clamped at 0), the weighted roll
 * honoring an injected random source across all four buckets, the
 * no-dataManager neutral degradation (count 0, no writes, silent
 * realm:changed), hostile-definition coercion (non-whitelist type → ungated,
 * junk results → default table fallback, hostile progressLoss clamped 0..1),
 * restore-trust slice repair (malformed tribulations/cultivation slices never
 * abort boot and junk values never poison the reads), destroy() unsubscribing
 * 'realm:changed', and the cross-wiring with a real BreakthroughSystem (a
 * pending tribulation blocks attempt() with reason 'tribulation' until a
 * survived face opens the gate; a failed face keeps it closed).
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
import { RealmSystem } from '../../js/systems/realms.js';
import { ResourceSystem } from '../../js/systems/resources.js';
import { InventorySystem } from '../../js/systems/inventory.js';
import { BreakthroughSystem } from '../../js/systems/breakthroughs.js';
import { TribulationSystem } from '../../js/systems/tribulations.js';

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
 * The fixture realm ladder — the same contract shape as the shipped ladder
 * (id, name, tier, effect multipliers, lifespanYears, unlocks). core-formation
 * carries the first tribulation; beyond-heaven IS the top tier and carries
 * the second.
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
    unlocks: [],
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
    id: 'core-formation',
    name: 'Core Formation',
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
 * The fixture item catalog (the id the fixture breakthroughs bottleneck
 * references).
 */
const ITEMS = deepFreeze([
  { id: 'spirit-herb', name: 'Spirit Herb', stackSize: 99 },
]);

/**
 * The canonical fixture tribulation results table (weights total 100:
 * survived 65 / barely-survived 15 / injured 12 / near-death 8). Buckets for
 * roll = random() × 100: survived [0,65), barely-survived [65,80), injured
 * [80,92), near-death [92,100).
 */
const RESULTS = deepFreeze([
  { outcome: 'survived', weight: 65 },
  { outcome: 'barely-survived', weight: 15 },
  { outcome: 'injured', weight: 12, progressLoss: 0.5 },
  { outcome: 'near-death', weight: 8, progressLoss: 1 },
]);

/**
 * The fixture tribulation table: one entry per realm in tier order — the two
 * ungated realms (null type, empty results), core-formation (lightning) and
 * the top realm beyond-heaven (soul).
 */
const TRIBULATIONS = deepFreeze([
  { realmId: 'mortal', tribulationType: null, results: [] },
  { realmId: 'qi-gathering', tribulationType: null, results: [] },
  { realmId: 'core-formation', tribulationType: 'lightning', results: RESULTS },
  { realmId: 'beyond-heaven', tribulationType: 'soul', results: RESULTS },
]);

/**
 * The fixture breakthrough tables: one entry per realm (the cross-wiring
 * tests satisfy the core-formation gates: progress 2000, 400 stones, 2
 * spirit herbs). The roll table is a small canonical SUCCESS/FAILURE set.
 */
const BREAKTHROUGH_RESULTS = deepFreeze([
  { outcome: 'perfect', weight: 5 },
  { outcome: 'success', weight: 65 },
  { outcome: 'failure', weight: 30, progressLoss: 0 },
]);

const BREAKTHROUGHS = deepFreeze([
  {
    realmId: 'mortal',
    requiredProgress: 1000,
    cost: { spiritStones: 0 },
    bottleneck: [],
    results: BREAKTHROUGH_RESULTS,
  },
  {
    realmId: 'qi-gathering',
    requiredProgress: 1500,
    cost: { spiritStones: 50 },
    bottleneck: [],
    results: BREAKTHROUGH_RESULTS,
  },
  {
    realmId: 'core-formation',
    requiredProgress: 2000,
    cost: { spiritStones: 400 },
    bottleneck: [{ id: 'spirit-herb', count: 2 }],
    results: BREAKTHROUGH_RESULTS,
  },
  {
    realmId: 'beyond-heaven',
    requiredProgress: 5000,
    cost: { spiritStones: 1000 },
    bottleneck: [],
    results: BREAKTHROUGH_RESULTS,
  },
]);

/**
 * Build a fake DataManager lookalike serving the fixture collections: the
 * 'realms' ladder through getAll, the 'tribulations' table through getAll,
 * the 'breakthroughs' tables through getAll and the 'items' catalog through
 * get(collection, id) — the shape the real DataManager exposes to the shipped
 * systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.realms] — ladder (defaults to LADDER).
 * @param {Array<object>} [options.tribulations] — table (defaults to TRIBULATIONS).
 * @param {Array<object>} [options.breakthroughs] — tables (defaults to BREAKTHROUGHS).
 * @param {Array<object>} [options.items] — item catalog (defaults to ITEMS).
 * @returns {{ getAll: Function, get: Function }} the lookalike.
 */
function makeDataManager({
  realms = LADDER,
  tribulations = TRIBULATIONS,
  breakthroughs = BREAKTHROUGHS,
  items = ITEMS,
} = {}) {
  return {
    getAll(collection) {
      if (collection === 'realms') return [...realms];
      if (collection === 'tribulations') return [...tribulations];
      if (collection === 'breakthroughs') return [...breakthroughs];
      return [];
    },
    get(collection, id) {
      if (collection === 'items') return items.find((item) => item.id === id);
      return undefined;
    },
  };
}

/**
 * Build the REAL RealmSystem / ResourceSystem / InventorySystem /
 * BreakthroughSystem / TribulationSystem, all sharing one state clone and one
 * dataManager lookalike — the same wiring main.js performs (systems
 * communicate via the EventBus and injected dependencies, never direct
 * imports; the tribulation gate flows through the SHARED state.tribulations
 * slice).
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike).
 * @param {object} [options.tribulationDataManager] — dataManager for the
 *        TribulationSystem only (defaults to options.dataManager — pass null
 *        to exercise the no-dataManager neutral degradation).
 * @param {object} [options.config] — config to inject (defaults to
 *        { breakthroughs: { progressRate: 1 } }).
 * @param {() => number} [options.random] — shared random source for both the
 *        breakthrough and the tribulation roll (defaults to () => 0 — a
 *        deterministic success).
 * @param {() => number} [options.tribulationRandom] — random source for the
 *        tribulation roll only (overrides options.random).
 * @param {() => number} [options.breakthroughRandom] — random source for the
 *        breakthrough roll only (overrides options.random).
 * @returns {{ state: object, realms: object, resources: object, inventory: object,
 *            breakthroughs: BreakthroughSystem, tribulations: TribulationSystem,
 *            dataManager: object }} the wired systems.
 */
function makeSystems(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();
  const tribulationDataManager =
    options.tribulationDataManager !== undefined
      ? options.tribulationDataManager
      : dataManager;

  const realms =
    options.realmSystem ||
    new RealmSystem({ state, eventBus: EventBus, dataManager });
  const resources = new ResourceSystem({
    state,
    eventBus: EventBus,
    config: { resources: { items: [{ id: 'spiritStones', label: 'Spirit Stones' }] } },
  });
  const inventory = new InventorySystem({
    state,
    eventBus: EventBus,
    config: { inventory: { slots: { total: 20 } } },
    dataManager,
  });
  const breakthroughs = new BreakthroughSystem({
    state,
    eventBus: EventBus,
    config: options.config || { breakthroughs: { progressRate: 1 } },
    realmSystem: realms,
    resourceSystem: resources,
    inventorySystem: inventory,
    dataManager,
    random: options.breakthroughRandom || options.random || (() => 0),
  });
  const tribulations = new TribulationSystem({
    state,
    eventBus: EventBus,
    realmSystem: realms,
    dataManager: tribulationDataManager,
    random: options.tribulationRandom || options.random || (() => 0),
  });

  return { state, realms, resources, inventory, breakthroughs, tribulations, dataManager };
}

test('construction boot-syncs the neutral gate at an ungated realm', () => {
  const state = structuredClone(GameState);
  const { tribulations } = makeSystems({ state });

  assert.equal(tribulations.count, 4);
  assert.deepEqual(tribulations.byRealm('mortal'), {
    realmId: 'mortal',
    tribulationType: null,
    results: [],
  });
  assert.equal(tribulations.byRealm('qi-gathering').tribulationType, null);
  assert.equal(tribulations.byRealm('core-formation').tribulationType, 'lightning');
  assert.equal(tribulations.byRealm('missing'), null);

  // Mortal is ungated → the boot sync lands the neutral gate.
  assert.deepEqual(state.tribulations, { type: null, pending: false, survived: false });
});

test('construction with the current realm at a gated tier opens the gate', () => {
  const state = structuredClone(GameState);
  state.cultivation.realm = 'Core Formation';
  state.cultivation.realmTier = 2;
  const { tribulations } = makeSystems({ state });

  assert.equal(state.cultivation.realmTier, 2);
  assert.deepEqual(state.tribulations, { type: 'lightning', pending: true, survived: false });
  assert.equal(tribulations.requirements().type, 'lightning');
  assert.equal(tribulations.requirements().pending, true);
  assert.equal(tribulations.canFace(), true);
});

test('boot preserves a restored survived gate (a reload mid-stay keeps the open gate)', () => {
  const state = structuredClone(GameState);
  state.cultivation.realm = 'Core Formation';
  state.cultivation.realmTier = 2;
  state.tribulations = { type: 'lightning', pending: false, survived: true };
  const { tribulations } = makeSystems({ state });

  assert.deepEqual(state.tribulations, { type: 'lightning', pending: false, survived: true });
  assert.equal(tribulations.requirements().survived, true);
  assert.equal(tribulations.requirements().pending, false);
  assert.equal(tribulations.requirements().canFace, false);
});

test("'realm:changed' opens the gate on a gated realm and neutralizes on an ungated one", () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state });
  const started = [];
  EventBus.subscribe('tribulation:started', (payload) => started.push(payload));

  // Into a gated realm → the gate opens + the exact started payload.
  assert.equal(realms.setRealm('core-formation'), true);
  assert.deepEqual(state.tribulations, { type: 'lightning', pending: true, survived: false });
  assert.deepEqual(started, [
    { realmId: 'core-formation', realmName: 'Core Formation', tier: 2, type: 'lightning' },
  ]);

  // Into an ungated realm → the neutral gate and no started event.
  assert.equal(realms.setRealm('qi-gathering'), true);
  assert.deepEqual(state.tribulations, { type: null, pending: false, survived: false });
  assert.deepEqual(started, [
    { realmId: 'core-formation', realmName: 'Core Formation', tier: 2, type: 'lightning' },
  ]);
});

test('requirements()/canFace() is a read-only snapshot across ungated / gated-pending / gated-survived', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state });

  // Ungated.
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'mortal',
    type: null,
    pending: false,
    survived: false,
    canFace: false,
  });
  assert.equal(tribulations.canFace(), false);

  // Gated + pending (a realm change opened the gate).
  realms.setRealm('core-formation');
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'core-formation',
    type: 'lightning',
    pending: true,
    survived: false,
    canFace: true,
  });
  assert.equal(tribulations.canFace(), true);

  // Gated + survived (a successful face opened the gate).
  tribulations.face(); // default random → survived
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'core-formation',
    type: 'lightning',
    pending: false,
    survived: true,
    canFace: false,
  });

  // Read-only: mutating the returned copies never leaks into the system.
  const snapshot = tribulations.requirements();
  snapshot.type = 'junk';
  snapshot.pending = true;
  snapshot.survived = false;
  assert.equal(tribulations.requirements().type, 'lightning');
  assert.equal(tribulations.requirements().pending, false);
  assert.equal(tribulations.requirements().survived, true);
});

test('face() is blocked with no-tribulation / not-pending and no mutation, no event', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state });
  const events = [];
  EventBus.subscribe('tribulation:finished', (payload) => events.push(payload));

  // Ungated realm → no-tribulation, nothing mutated, nothing emitted.
  const before = structuredClone(state);
  assert.deepEqual(tribulations.face(), {
    outcome: null,
    survived: false,
    reason: 'no-tribulation',
  });
  assert.deepEqual(state, before);
  assert.equal(events.length, 0);

  // Gated realm with the gate already opened → not-pending.
  realms.setRealm('core-formation');
  tribulations.face(); // survived → gate opens (emits once)
  assert.equal(events.length, 1);
  const beforeNotPending = structuredClone(state);
  assert.deepEqual(tribulations.face(), {
    outcome: null,
    survived: false,
    reason: 'not-pending',
  });
  assert.deepEqual(state, beforeNotPending);
  assert.equal(events.length, 1); // the blocked face emitted nothing
});

test('face() survived opens the gate, never touches realmProgress and emits the exact finished payload', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state, tribulationRandom: () => 0 });
  realms.setRealm('core-formation');
  state.cultivation.realmProgress = 2000;
  const before = state.cultivation.realmProgress;
  const events = [];
  EventBus.subscribe('tribulation:finished', (payload) => events.push(payload));

  assert.deepEqual(tribulations.face(), { outcome: 'survived', survived: true });
  assert.equal(state.tribulations.survived, true);
  assert.equal(state.tribulations.pending, false);
  assert.equal(state.cultivation.realmProgress, before); // no progress loss

  assert.deepEqual(events, [
    {
      realmId: 'core-formation',
      realmName: 'Core Formation',
      tier: 2,
      type: 'lightning',
      outcome: 'survived',
      survived: true,
    },
  ]);
});

test('face() barely-survived also opens the gate', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state, tribulationRandom: () => 0.7 });
  realms.setRealm('core-formation');

  assert.deepEqual(tribulations.face(), { outcome: 'barely-survived', survived: true });
  assert.equal(state.tribulations.survived, true);
  assert.equal(state.tribulations.pending, false);
});

test('face() injured loses progressLoss × realmProgressMax and stays pending', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state, tribulationRandom: () => 0.85 });
  realms.setRealm('core-formation');
  state.cultivation.realmProgress = 2000;
  state.cultivation.realmProgressMax = 2000;
  const events = [];
  EventBus.subscribe('tribulation:finished', (payload) => events.push(payload));

  assert.deepEqual(tribulations.face(), { outcome: 'injured', survived: false });
  // 0.5 × 2000 → 1000.
  assert.equal(state.cultivation.realmProgress, 1000);
  assert.equal(state.tribulations.survived, false);
  assert.equal(state.tribulations.pending, true); // the gate stays closed
  // The gate stays closed → the player can face again.
  assert.equal(tribulations.canFace(), true);

  assert.deepEqual(events, [
    {
      realmId: 'core-formation',
      realmName: 'Core Formation',
      tier: 2,
      type: 'lightning',
      outcome: 'injured',
      survived: false,
    },
  ]);
});

test('face() near-death wipes progress, stays pending; a hostile realmProgressMax falls back', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state, tribulationRandom: () => 0.99 });
  realms.setRealm('core-formation');
  state.cultivation.realmProgress = 2000;
  state.cultivation.realmProgressMax = 2000;

  // 1 × 2000 → progress wiped to 0 (clamped, never negative).
  assert.deepEqual(tribulations.face(), { outcome: 'near-death', survived: false });
  assert.equal(state.cultivation.realmProgress, 0);
  assert.equal(state.tribulations.pending, true);
  assert.equal(state.tribulations.survived, false);

  // A hostile realmProgressMax (-5) falls back to 1000 — the loss can never
  // GAIN progress (2000 - 1 × -5 would be 2005).
  state.cultivation.realmProgress = 2000;
  state.cultivation.realmProgressMax = -5;
  assert.deepEqual(tribulations.face(), { outcome: 'near-death', survived: false });
  assert.equal(state.cultivation.realmProgress, 1000);
});

test('the weighted outcome roll honors the injected random across all four buckets', () => {
  // Buckets for roll = random() × 100: survived [0,65), barely-survived
  // [65,80), injured [80,92), near-death [92,100).
  const cases = [
    [() => 0, 'survived'],
    [() => 0.5, 'survived'],
    [() => 0.65, 'barely-survived'],
    [() => 0.79, 'barely-survived'],
    [() => 0.8, 'injured'],
    [() => 0.91, 'injured'],
    [() => 0.92, 'near-death'],
    [() => 0.99, 'near-death'],
  ];
  for (const [random, outcome] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { realms, tribulations } = makeSystems({ state, tribulationRandom: random });
    realms.setRealm('core-formation');

    const result = tribulations.face();
    assert.equal(result.outcome, outcome, `random() -> ${outcome}`);
  }
});

test('without a dataManager the system degrades neutrally: count 0, no writes, face rejects', () => {
  const state = structuredClone(GameState);
  const dataManager = makeDataManager({ tribulations: [] });
  const { realms, tribulations } = makeSystems({
    state,
    dataManager,
    tribulationDataManager: null,
  });
  const started = [];
  EventBus.subscribe('tribulation:started', (payload) => started.push(payload));
  const beforeTribulations = structuredClone(state.tribulations);
  const beforeCultivation = structuredClone(state.cultivation);

  assert.equal(tribulations.count, 0);
  assert.equal(tribulations.byRealm('mortal'), null);
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'mortal',
    type: null,
    pending: false,
    survived: false,
    canFace: false,
  });
  assert.deepEqual(tribulations.face(), {
    outcome: null,
    survived: false,
    reason: 'no-tribulation',
  });
  // No state writes: the blocked face left every slice untouched.
  assert.deepEqual(state.tribulations, beforeTribulations);
  assert.deepEqual(state.cultivation, beforeCultivation);

  // 'realm:changed' is a silent no-op (empty table — no state writes, no
  // event), even into a realm the real table would gate.
  realms.setRealm('core-formation');
  assert.deepEqual(state.tribulations, { type: null, pending: false, survived: false });
  assert.deepEqual(started, []);
});

test('hostile tribulation definitions coerce to safe defaults', () => {
  const hostile = deepFreeze([
    // A non-whitelist type ('fire') reads as ungated.
    { realmId: 'mortal', tribulationType: 'fire', results: [] },
    // A canonical type with unusable results → DEFAULT_RESULTS fallback.
    {
      realmId: 'qi-gathering',
      tribulationType: 'lightning',
      results: [
        { outcome: 'death', weight: 5, progressLoss: 1 },
        { outcome: 'survived', weight: -3 },
      ],
    },
    // A canonical type with a hostile progressLoss → clamps into 0..1.
    {
      realmId: 'core-formation',
      tribulationType: 'karma',
      results: [
        { outcome: 'survived', weight: 50 },
        { outcome: 'injured', weight: 50, progressLoss: 2 },
      ],
    },
  ]);
  const state = structuredClone(GameState);
  const dataManager = makeDataManager({ tribulations: hostile });
  let roll = 0;
  const random = () => roll;
  const { realms, tribulations } = makeSystems({
    state,
    dataManager,
    tribulationRandom: random,
    breakthroughRandom: random,
  });

  // Boot at mortal: 'fire' is not canonical → ungated neutral gate.
  assert.deepEqual(state.tribulations, { type: null, pending: false, survived: false });

  // qi-gathering: the junk results fall back to the default table (survived
  // 70 / injured 30) — roll 0 lands in the first bucket.
  realms.setRealm('qi-gathering');
  assert.equal(state.tribulations.type, 'lightning');
  assert.deepEqual(tribulations.face(), { outcome: 'survived', survived: true });

  // core-formation: 'karma' IS canonical; progressLoss 2 clamps to 1 → the
  // loss can never exceed 100% of the progress cap.
  realms.setRealm('core-formation');
  assert.equal(state.tribulations.type, 'karma');
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmProgressMax = 1000;
  roll = 0.99; // injured bucket [50,100)
  assert.deepEqual(tribulations.face(), { outcome: 'injured', survived: false });
  assert.equal(state.cultivation.realmProgress, 0); // 1000 - 1 × 1000
  assert.equal(state.tribulations.pending, true);
});

test('restore-trust: malformed tribulations/cultivation slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.tribulations = malformed;
    state.cultivation = malformed;

    const { tribulations } = makeSystems({ state }); // must not throw

    // Both slices were repaired to their canonical fresh shapes and the boot
    // sync resolved the (ungated) current realm → neutral gate.
    assert.deepEqual(state.tribulations, { type: null, pending: false, survived: false });
    assert.equal(state.cultivation.realmProgress, 0);
    assert.equal(state.cultivation.realmProgressMax, 1000);
    assert.equal(tribulations.count, 4); // the table still loaded
    assert.deepEqual(tribulations.requirements(), {
      realmId: 'mortal',
      type: null,
      pending: false,
      survived: false,
      canFace: false,
    });
    assert.deepEqual(tribulations.face(), {
      outcome: null,
      survived: false,
      reason: 'no-tribulation',
    });
  }
});

test('malformed tribulations values never poison requirements()/face()', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state });

  // Junk values inside an otherwise-object slice are coerced on read — the
  // ungated realm forces type null and reads pending/survived as booleans.
  state.tribulations = { type: 123, pending: 'yes', survived: 'no' };
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'mortal',
    type: null,
    pending: false,
    survived: false,
    canFace: false,
  });
  assert.deepEqual(tribulations.face(), {
    outcome: null,
    survived: false,
    reason: 'no-tribulation',
  });

  // At a gated realm a junk pending flag reads as not-pending — the blocked
  // face mutates nothing.
  realms.setRealm('core-formation');
  state.tribulations = { type: 'lightning', pending: 'yes', survived: 'no' };
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'core-formation',
    type: 'lightning',
    pending: false, // 'yes' is not === true
    survived: false,
    canFace: false,
  });
  assert.deepEqual(tribulations.face(), {
    outcome: null,
    survived: false,
    reason: 'not-pending',
  });
  assert.deepEqual(state.tribulations, {
    type: 'lightning',
    pending: 'yes',
    survived: 'no',
  });
});

test('destroy() unsubscribes realm:changed so later realm changes no longer mutate the gate', () => {
  const state = structuredClone(GameState);
  const { realms, tribulations } = makeSystems({ state });

  tribulations.destroy();
  assert.equal(realms.setRealm('core-formation'), true);
  // The realm changed but the (destroyed) system wrote nothing.
  assert.deepEqual(state.tribulations, { type: null, pending: false, survived: false });
});

test('cross-wiring: a pending tribulation blocks the breakthrough until it is survived', () => {
  const state = structuredClone(GameState);
  const { realms, resources, inventory, breakthroughs, tribulations } = makeSystems({
    state,
    random: () => 0, // breakthrough roll → 'perfect'
    tribulationRandom: () => 0, // tribulation roll → 'survived'
  });
  realms.setRealm('core-formation');
  state.cultivation.realmProgress = 2000;
  state.cultivation.realmProgressMax = 2000;
  resources.add('spiritStones', 400);
  inventory.add('spirit-herb', 2);

  // Every non-tribulation gate is satisfied — the tribulation gate blocks.
  const blockedRequirements = breakthroughs.requirements();
  assert.equal(blockedRequirements.progressMet, true);
  assert.equal(blockedRequirements.costMet, true);
  assert.equal(blockedRequirements.bottleneckMet, true);
  assert.equal(blockedRequirements.tribulationRequired, true);
  assert.equal(blockedRequirements.tribulationMet, false);
  assert.equal(blockedRequirements.layer, 1); // realmLayer was reset to 1 by setRealm
  assert.equal(blockedRequirements.layerMet, false);
  assert.equal(blockedRequirements.canAttempt, false);
  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'tribulation',
  });
  assert.equal(state.cultivation.realm, 'Core Formation'); // realm unchanged
  assert.equal(state.statistics.breakthroughsTotal, 0);
  // Nothing was spent or removed by the blocked attempt.
  assert.equal(resources.get('spiritStones'), 450);
  assert.equal(inventory.count('spirit-herb'), 2);

  // Face and survive → the gate opens and the same attempt proceeds: random
  // 0 → 'perfect' → advances to beyond-heaven (the fixture top realm), and
  // the realm change opens the new realm's soul tribulation.
  assert.deepEqual(tribulations.face(), { outcome: 'survived', survived: true });
  assert.equal(breakthroughs.requirements().tribulationMet, true);
  state.cultivation.realmLayer = 9; // P4: must be at final layer to attempt
  const result = breakthroughs.attempt();
  assert.deepEqual(result, { outcome: 'perfect', advanced: true });
  assert.equal(state.cultivation.realm, 'Beyond Heaven');
  assert.equal(state.cultivation.realmTier, 3);
  assert.equal(state.statistics.breakthroughsTotal, 1);
  // The post-success realm change re-opened the gate for the new realm.
  assert.deepEqual(state.tribulations, { type: 'soul', pending: true, survived: false });
  assert.deepEqual(tribulations.requirements(), {
    realmId: 'beyond-heaven',
    type: 'soul',
    pending: true,
    survived: false,
    canFace: true,
  });

  // A failed face keeps the gate closed: a fresh setup with a near-death
  // roll — even after the progress is restored, the attempt stays blocked.
  EventBus.clear();
  const state2 = structuredClone(GameState);
  const setup2 = makeSystems({
    state: state2,
    random: () => 0,
    tribulationRandom: () => 0.99,
  });
  setup2.realms.setRealm('core-formation');
  state2.cultivation.realmProgress = 2000;
  state2.cultivation.realmProgressMax = 2000;
  setup2.resources.add('spiritStones', 400);
  setup2.inventory.add('spirit-herb', 2);

  assert.deepEqual(setup2.tribulations.face(), { outcome: 'near-death', survived: false });
  assert.equal(state2.tribulations.pending, true);
  assert.equal(state2.tribulations.survived, false);
  state2.cultivation.realmProgress = 2000; // the player re-cultivates
  assert.deepEqual(setup2.breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'tribulation',
  });
  assert.equal(state2.statistics.breakthroughsTotal, 0);
});
