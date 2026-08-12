/**
 * tests/unit/breakthroughs.test.mjs — unit tests for js/systems/breakthroughs.js.
 *
 * Exercises the BreakthroughSystem (single owner of realm breakthroughs:
 * requirements, results, bottlenecks) against REAL RealmSystem /
 * ResourceSystem / InventorySystem instances wired to a shared fake
 * DataManager lookalike (the 'realms' ladder, the 'breakthroughs' tables and
 * the 'items' catalog) — the same injection pattern the shipped bootstrap
 * uses. Covered: construction boot-sync (realmProgressMax / breakthroughCost
 * from the current realm's entry), the requirements() gate snapshot
 * (progress / cost / bottleneck / tribulation / max-realm / no-definition —
 * read-only), attempt() blocked reasons (no mutation, no spend, no event),
 * the tribulation gate (a pending tribulation blocks attempt() with reason
 * 'tribulation' until survived; a malformed state.tribulations slice
 * degrades to gate-open), a successful
 * attempt (realm advances via RealmSystem, progress resets, max/cost re-sync
 * to the new realm, statistics.breakthroughsTotal increments, exact
 * 'realm:breakthrough' payload, RealmSystem's own 'realm:changed' still
 * fires), failed attempts (progressLoss applied, realm unchanged), an
 * accepted attempt does NOT consume cost or bottleneck items (P1 —
 * informational only), the weighted roll honoring an
 * injected random source, deterministic progress accrual via fake
 * 'loop:update' emissions (rate × delta, clamp, top-realm skip, zero-rate
 * skip, destroy()), the no-dataManager neutral degradation (count 0, no
 * state writes, attempt rejects 'no-definition' with a warn-once latch),
 * hostile-definition coercion (requiredProgress/cost/bottleneck/results
 * repair + the default results fallback) and restore-trust slice repair
 * (malformed cultivation/statistics slices never abort boot, malformed
 * values never poison the math).
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
 * (id, name, tier, effect multipliers, lifespanYears, unlocks). Note
 * 'foundation-establishment' carries NO breakthrough entry in the fixture
 * (the no-definition path) and 'beyond-heaven' IS the top tier.
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
 * The fixture item catalog (the ids the fixture bottlenecks reference).
 */
const ITEMS = deepFreeze([
  { id: 'qi-condensation-pill', name: 'Qi Condensation Pill', stackSize: 99 },
  { id: 'spirit-herb', name: 'Spirit Herb', stackSize: 99 },
]);

/**
 * The canonical fixture results table (weights total 100: success 80 /
 * failure 20). Buckets for roll = random() × 100: perfect [0,5),
 * great-success [5,15), success [15,70), barely-successful [70,80),
 * failure [80,92), heavy-failure [92,97), qi-deviation [97,100).
 */
const RESULTS = deepFreeze([
  { outcome: 'perfect', weight: 5 },
  { outcome: 'great-success', weight: 10 },
  { outcome: 'success', weight: 55 },
  { outcome: 'barely-successful', weight: 10 },
  { outcome: 'failure', weight: 12, progressLoss: 0 },
  { outcome: 'heavy-failure', weight: 5, progressLoss: 0.5 },
  { outcome: 'qi-deviation', weight: 3, progressLoss: 1 },
]);

/**
 * The fixture breakthrough tables: one entry for mortal (zero cost, no
 * bottleneck), one for qi-gathering (50 stones + 1 pill bottleneck), one for
 * the top realm beyond-heaven — and NONE for foundation-establishment (the
 * no-definition path).
 */
const BREAKTHROUGHS = deepFreeze([
  {
    realmId: 'mortal',
    requiredProgress: 1000,
    cost: { spiritStones: 0 },
    bottleneck: [],
    results: RESULTS,
  },
  {
    realmId: 'qi-gathering',
    requiredProgress: 1500,
    cost: { spiritStones: 50 },
    bottleneck: [{ id: 'qi-condensation-pill', count: 1 }],
    results: RESULTS,
  },
  {
    realmId: 'beyond-heaven',
    requiredProgress: 5000,
    cost: { spiritStones: 1000 },
    bottleneck: [],
    results: RESULTS,
  },
]);

/**
 * Build a fake DataManager lookalike serving the fixture collections: the
 * 'realms' ladder through getAll, the 'breakthroughs' tables through
 * getAll, and the 'items' catalog through get(collection, id) — the shape
 * the real DataManager exposes to the shipped systems.
 *
 * @param {object} [options] — collection overrides.
 * @param {Array<object>} [options.realms] — ladder (defaults to LADDER).
 * @param {Array<object>} [options.breakthroughs] — tables (defaults to BREAKTHROUGHS).
 * @param {Array<object>} [options.items] — item catalog (defaults to ITEMS).
 * @returns {{ getAll: Function, get: Function }} the lookalike.
 */
function makeDataManager({
  realms = LADDER,
  breakthroughs = BREAKTHROUGHS,
  items = ITEMS,
} = {}) {
  return {
    getAll(collection) {
      if (collection === 'realms') return [...realms];
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
 * Build the REAL RealmSystem / ResourceSystem / InventorySystem / the system
 * under test, all sharing one state clone and one dataManager lookalike —
 * the same wiring main.js performs (systems communicate via the EventBus and
 * injected dependencies, never direct imports).
 *
 * @param {object} [options] — wiring overrides.
 * @param {object} [options.state] — state to inject (defaults to a fresh
 *        GameState clone).
 * @param {object} [options.dataManager] — dataManager to inject (defaults to
 *        the fixture lookalike).
 * @param {object} [options.config] — config to inject (defaults to
 *        { breakthroughs: { progressRate: 1 } }).
 * @param {object} [options.realmSystem] — override the RealmSystem.
 * @param {object} [options.resourceSystem] — override the ResourceSystem.
 * @param {object} [options.inventorySystem] — override the InventorySystem.
 * @param {() => number} [options.random] — random source for the roll
 *        (defaults to () => 0 — a deterministic success).
 * @returns {{ state: object, realms: object, resources: object, inventory: object,
 *            breakthroughs: BreakthroughSystem, dataManager: object }}
 *          the wired systems.
 */
function makeSystems(options = {}) {
  const state = options.state || structuredClone(GameState);
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : makeDataManager();

  const realms =
    options.realmSystem ||
    new RealmSystem({ state, eventBus: EventBus, dataManager });
  const resources =
    options.resourceSystem ||
    new ResourceSystem({
      state,
      eventBus: EventBus,
      config: { resources: { items: [{ id: 'spiritStones', label: 'Spirit Stones' }] } },
    });
  const inventory =
    options.inventorySystem ||
    new InventorySystem({
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
    random: options.random || (() => 0),
  });

  return { state, realms, resources, inventory, breakthroughs, dataManager };
}

test('construction snapshots the tables and syncs max/cost from the current realm entry', () => {
  const state = structuredClone(GameState);
  state.cultivation.realmProgressMax = 9999; // a stale value boot must overwrite
  state.cultivation.breakthroughCost = 42;
  const { breakthroughs } = makeSystems({ state });

  assert.equal(breakthroughs.count, 3);
  assert.deepEqual(breakthroughs.byRealm('mortal').realmId, 'mortal');
  assert.equal(breakthroughs.byRealm('foundation-establishment'), null);
  assert.equal(breakthroughs.byRealm('nope'), null);

  // Boot sync wrote the mortal entry (cost 0 — a number, not the fresh null).
  assert.equal(state.cultivation.realmProgressMax, 1000);
  assert.equal(state.cultivation.breakthroughCost, 0);
});

test('requirements() reports the current realm gates as a read-only snapshot', () => {
  const state = structuredClone(GameState);
  const { breakthroughs } = makeSystems({ state });

  const requirements = breakthroughs.requirements();
  assert.deepEqual(requirements, {
    realmId: 'mortal',
    requiredProgress: 1000,
    progress: 0,
    progressMet: false,
    cost: { spiritStones: 0 },
    costMet: true,
    bottleneck: [],
    bottleneckMet: true,
    tribulationRequired: false,
    tribulationMet: true,
    layer: 1,
    layerMax: 9,
    layerMet: false,
    canAttempt: false,
  });

  // Read-only: mutating the returned copies never leaks into the system.
  requirements.cost.spiritStones = 999;
  requirements.bottleneck.push({ id: 'phantom', count: 1 });
  requirements.progress = 1000;
  assert.deepEqual(breakthroughs.requirements().cost, { spiritStones: 0 });
  assert.deepEqual(breakthroughs.requirements().bottleneck, []);
  assert.equal(breakthroughs.requirements().progress, 0);

  // canAttempt() mirrors the gate snapshot without consuming anything.
  assert.equal(breakthroughs.canAttempt(), false);
});

test('attempt() is blocked before the requirement gates with a deterministic reason and no mutation', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const { breakthroughs } = makeSystems({ state });
  const events = [];
  EventBus.subscribe('realm:breakthrough', (payload) => events.push(payload));
  const before = structuredClone(state.cultivation);

  // Fresh state: progress 0 < 1000.
  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'progress',
  });
  assert.deepEqual(state.cultivation, before);
  assert.deepEqual(events, []);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(state.statistics.breakthroughsTotal, 0);
});

test('a successful attempt advances the realm, resets progress, syncs the new cost/max and emits realm:breakthrough', () => {
  const state = structuredClone(GameState);
  const { breakthroughs } = makeSystems({ state, random: () => 0 });
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmLayer = 9; // must be at final layer to attempt

  const breakthroughEvents = [];
  const realmChanged = [];
  EventBus.subscribe('realm:breakthrough', (payload) => breakthroughEvents.push(payload));
  EventBus.subscribe('realm:changed', (payload) => realmChanged.push(payload));

  const result = breakthroughs.attempt();

  assert.deepEqual(result, { outcome: 'perfect', advanced: true });
  // The ladder advanced through RealmSystem (identity + effects written).
  assert.equal(state.cultivation.realm, 'Qi Gathering');
  assert.equal(state.cultivation.realmTier, 1);
  assert.equal(state.cultivation.nextRealm, 'Foundation Establishment');
  assert.equal(state.cultivation.realmProgress, 0);
  // The post-success sync pulled the NEW realm's entry (1500 / 50 stones).
  assert.equal(state.cultivation.realmProgressMax, 1500);
  assert.equal(state.cultivation.breakthroughCost, 50);
  // The lifetime counter incremented (StatisticsSystem picks it up per tick).
  assert.equal(state.statistics.breakthroughsTotal, 1);

  assert.deepEqual(breakthroughEvents, [
    {
      realmId: 'qi-gathering',
      realmName: 'Qi Gathering',
      tier: 1,
      outcome: 'perfect',
      advanced: true,
      nextRealm: 'foundation-establishment',
    },
  ]);
  // RealmSystem's own event fires too — never suppressed or duplicated.
  assert.equal(realmChanged.length, 1);
  assert.equal(realmChanged[0].realmId, 'qi-gathering');
});

test('a failed attempt applies the outcome progressLoss and keeps the realm', () => {
  const state = structuredClone(GameState);
  // random 0.99 → roll 99 → qi-deviation (loss 1 → progress wiped).
  const { breakthroughs } = makeSystems({ state, random: () => 0.99 });
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmLayer = 9;

  const events = [];
  EventBus.subscribe('realm:breakthrough', (payload) => events.push(payload));
  const realmChanged = [];
  EventBus.subscribe('realm:changed', (payload) => realmChanged.push(payload));

  const result = breakthroughs.attempt();

  assert.deepEqual(result, { outcome: 'qi-deviation', advanced: false });
  assert.equal(state.cultivation.realm, 'Mortal');
  assert.equal(state.cultivation.realmTier, 0);
  assert.equal(state.cultivation.realmProgress, 0); // 1000 - 1 × 1000
  assert.equal(state.statistics.breakthroughsTotal, 0);
  // No realm change → no realm:changed event (never suppressed, never fake).
  assert.deepEqual(realmChanged, []);
  assert.deepEqual(events, [
    {
      realmId: 'mortal',
      realmName: 'Mortal',
      tier: 0,
      outcome: 'qi-deviation',
      advanced: false,
      nextRealm: 'qi-gathering',
    },
  ]);
});

test('a heavy failure loses half the progress and can never drop below zero', () => {
  const state = structuredClone(GameState);
  // random 0.95 → roll 95 → heavy-failure (loss 0.5).
  const { breakthroughs } = makeSystems({ state, random: () => 0.95 });
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmLayer = 9;

  const result = breakthroughs.attempt();

  assert.deepEqual(result, { outcome: 'heavy-failure', advanced: false });
  // 1000 - 0.5 × 1000 (loss = progressLoss × realmProgressMax) → 500.
  assert.equal(state.cultivation.realmProgress, 500);

  // A hostile realmProgressMax ABOVE the synced entry value (2000 vs the
  // mortal entry's 1000) must still floor the loss at 0 — progress can
  // never go negative: 1000 - 0.5 × 2000 would be 0, not -0 or below.
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmProgressMax = 2000;
  const second = breakthroughs.attempt();
  assert.deepEqual(second, { outcome: 'heavy-failure', advanced: false });
  assert.equal(state.cultivation.realmProgress, 0);
});

test('attempt() does NOT block on unaffordable cost or unsatisfied bottleneck items (informational only, P1)', () => {
  const state = structuredClone(GameState);
  const { breakthroughs, realms, resources, inventory } = makeSystems({ state });
  realms.setRealm('qi-gathering');
  state.cultivation.realmProgress = 1500;
  state.cultivation.realmLayer = 9;

  // No stones (drain the fresh 50) and no pill — cost/items used to block
  // but are now INFORMATIONAL ONLY (P1 playtest fix). With default
  // random () => 0 the roll lands on 'perfect'.
  resources.spend('spiritStones', 50);
  const result = breakthroughs.attempt();

  // The attempt proceeded to the roll (no 'cost' / 'items' block).
  assert.equal(result.reason, undefined);
  assert.equal(result.outcome, 'perfect');
  assert.equal(result.advanced, true);

  // Nothing was spent or consumed: stones still 0, pill still 0,
  // statistics counter unchanged (this single attempt advanced the ladder,
  // so the counter is 1 — but the wallet/inventory stayed put).
  assert.equal(resources.get('spiritStones'), 0);
  assert.equal(inventory.count('qi-condensation-pill'), 0);
  assert.equal(state.statistics.breakthroughsTotal, 1);
  assert.equal(state.cultivation.realm, 'Foundation Establishment');
});

test('an accepted attempt does NOT consume cost or bottleneck items (informational only)', () => {
  const state = structuredClone(GameState);
  const { breakthroughs, realms, resources, inventory } = makeSystems({
    state,
    random: () => 0.99, // qi-deviation — a failure, so the realm stays put
  });
  realms.setRealm('qi-gathering');
  state.cultivation.realmProgress = 1500;
  state.cultivation.realmLayer = 9;
  state.cultivation.realmProgressMax = 1500; // the post-success sync value
  inventory.add('qi-condensation-pill', 1);

  const result = breakthroughs.attempt();

  assert.deepEqual(result, { outcome: 'qi-deviation', advanced: false });
  // Cost + bottleneck are INFORMATIONAL ONLY (P1 playtest fix) — the wallet
  // still holds the fresh 50-stone endowment, the pill stack is untouched.
  assert.equal(resources.get('spiritStones'), 50);
  assert.equal(inventory.count('qi-condensation-pill'), 1);
  // Loss = 1 × realmProgressMax (1500) → progress wiped.
  assert.equal(state.cultivation.realmProgress, 0);
  assert.equal(state.cultivation.realm, 'Qi Gathering');
});

test('attempt() rejects at the top realm (max-realm)', () => {
  const state = structuredClone(GameState);
  const { breakthroughs, realms } = makeSystems({ state });
  realms.setRealm('beyond-heaven');
  state.cultivation.realmProgress = 5000;

  const events = [];
  EventBus.subscribe('realm:breakthrough', (payload) => events.push(payload));

  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'max-realm',
  });
  assert.equal(state.cultivation.realm, 'Beyond Heaven');
  assert.equal(state.cultivation.realmProgress, 5000); // untouched
  assert.equal(state.statistics.breakthroughsTotal, 0);
  assert.deepEqual(events, []);
});

test('attempt() is blocked by a pending tribulation gate (no mutation, no spend, no event)', () => {
  const state = structuredClone(GameState);
  // random 0.99 → a failure roll — but the tribulation gate blocks first.
  const { breakthroughs } = makeSystems({ state, random: () => 0.99 });
  state.tribulations = { type: 'lightning', pending: true, survived: false };
  state.cultivation.realmProgress = 1000; // the mortal entry's required progress

  const events = [];
  EventBus.subscribe('realm:breakthrough', (payload) => events.push(payload));
  const before = structuredClone(state);

  // requirements() reports the closed gate.
  const requirements = breakthroughs.requirements();
  assert.equal(requirements.tribulationRequired, true);
  assert.equal(requirements.tribulationMet, false);
  assert.equal(requirements.canAttempt, false);

  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'tribulation',
  });
  assert.deepEqual(state, before); // no mutation of any kind
  assert.deepEqual(events, []);
  assert.equal(state.statistics.breakthroughsTotal, 0);
  // There is no cost gate (P1 — informational only); the wallet still holds
  // the fresh 50-stone endowment.
  assert.equal(state.resources.spiritStones, 50);
});

test('the tribulation gate opens once survived (or when nothing is pending)', () => {
  const state = structuredClone(GameState);
  // random 0.99 → qi-deviation — a failure, so the realm stays put and the
  // roll itself proves the gate let the attempt through.
  const { breakthroughs } = makeSystems({ state, random: () => 0.99 });
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmLayer = 9;

  // survived=true → gate open → the attempt proceeds to the roll.
  state.tribulations = { type: 'lightning', pending: true, survived: true };
  let result = breakthroughs.attempt();
  assert.equal(result.reason, undefined);
  assert.equal(result.outcome, 'qi-deviation');
  assert.equal(result.advanced, false);

  // pending=false → gate open too.
  state.cultivation.realmProgress = 1000; // the failure wiped it
  state.tribulations = { type: 'lightning', pending: false, survived: false };
  result = breakthroughs.attempt();
  assert.equal(result.reason, undefined);
  assert.equal(result.outcome, 'qi-deviation');
  assert.equal(result.advanced, false);
});

test('a malformed state.tribulations degrades to an open gate (never throws)', () => {
  for (const malformed of [null, 5, [], {}]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.tribulations = malformed;
    state.cultivation.realmProgress = 1000;
    const { breakthroughs } = makeSystems({ state, random: () => 0.99 });
    state.cultivation.realmLayer = 9; // after RealmSystem boot; must be at layer max

    // The gate reads as open and the attempt proceeds to the roll — an old
    // save without the slice (or a hostile one) never blocks a breakthrough.
    assert.equal(breakthroughs.requirements().tribulationRequired, false);
    assert.equal(breakthroughs.requirements().tribulationMet, true);
    const result = breakthroughs.attempt();
    assert.equal(result.reason, undefined);
    assert.equal(result.outcome, 'qi-deviation');
  }
});

test('attempt() rejects with no-definition for a realm without an entry (warn once)', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  const { breakthroughs, realms } = makeSystems({ state });
  realms.setRealm('foundation-establishment');
  state.cultivation.realmProgress = 9999;

  // requirements() reports the neutral fallback gate (canAttempt false).
  assert.equal(breakthroughs.requirements().realmId, 'foundation-establishment');
  assert.equal(breakthroughs.requirements().requiredProgress, 1000);
  assert.equal(breakthroughs.requirements().canAttempt, false);

  // First attempt warns, second stays silent (the warn-once latch).
  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'no-definition',
  });
  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'no-definition',
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(state.cultivation.realm, 'Foundation Establishment');
  assert.equal(state.statistics.breakthroughsTotal, 0);
});

test('the weighted outcome roll honors the injected random source', () => {
  // Buckets for roll = random() × totalWeight(100): perfect [0,5),
  // great-success [5,15), success [15,70), barely-successful [70,80),
  // failure [80,92), heavy-failure [92,97), qi-deviation [97,100).
  const cases = [
    [() => 0, 'perfect'],
    [() => 0.05, 'great-success'],
    [() => 0.5, 'success'],
    [() => 0.75, 'barely-successful'],
    [() => 0.85, 'failure'],
    [() => 0.95, 'heavy-failure'],
    [() => 0.99, 'qi-deviation'],
  ];
  for (const [random, outcome] of cases) {
    EventBus.clear();
    const state = structuredClone(GameState);
    const { breakthroughs } = makeSystems({ state, random });
    state.cultivation.realmProgress = 1000;
    state.cultivation.realmLayer = 9;

    const result = breakthroughs.attempt();
    assert.equal(result.outcome, outcome, `random() -> ${outcome}`);
  }
});

test('realm progress accrues deterministically from qiPerSecond on loop:update', () => {
  const state = structuredClone(GameState);
  const { breakthroughs } = makeSystems({ state });

  // qiPerSecond 0 → no accrual.
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  assert.equal(state.cultivation.realmProgress, 0);

  // 2 qi/s × rate 1 × 1s → +2.
  state.cultivation.qiPerSecond = 2;
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 2 });
  assert.equal(state.cultivation.realmProgress, 2);

  // 2 qi/s × rate 1 × 2s → +4.
  EventBus.emit('loop:update', { deltaMs: 2000, elapsedMs: 3000, tick: 3 });
  assert.equal(state.cultivation.realmProgress, 6);

  // A huge delta clamps at the current realm's realmProgressMax (1000).
  state.cultivation.qiPerSecond = 100;
  EventBus.emit('loop:update', { deltaMs: 60000, elapsedMs: 60000, tick: 4 });
  assert.equal(state.cultivation.realmProgress, 1000);

  // A malformed payload delta is ignored (never a bogus gain).
  EventBus.emit('loop:update', { deltaMs: 'nope', elapsedMs: 0, tick: 5 });
  assert.equal(state.cultivation.realmProgress, 1000);
});

test('the configured progressRate multiplies the accrual', () => {
  const state = structuredClone(GameState);
  const { breakthroughs } = makeSystems({
    state,
    config: { breakthroughs: { progressRate: 2 } },
  });
  state.cultivation.qiPerSecond = 2;

  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  assert.equal(state.cultivation.realmProgress, 4); // 2 × 2 × 1s
});

test('realm progress stops accruing at the top realm and after destroy()', () => {
  const state = structuredClone(GameState);
  const { breakthroughs, realms } = makeSystems({ state });
  state.cultivation.qiPerSecond = 2;

  realms.setRealm('beyond-heaven');
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  assert.equal(state.cultivation.realmProgress, 0);

  // destroy() unsubscribes — later ticks no longer mutate state.
  const state2 = structuredClone(GameState);
  const { breakthroughs: system2 } = makeSystems({ state: state2 });
  state2.cultivation.qiPerSecond = 2;
  system2.destroy();
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  assert.equal(state2.cultivation.realmProgress, 0);
});

test('without a dataManager the system degrades neutrally: count 0, no writes, attempt rejects', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);
  state.cultivation.realmProgress = 500;
  state.cultivation.realmProgressMax = 777;
  state.cultivation.breakthroughCost = 42;
  const before = structuredClone(state.cultivation);

  const system = new BreakthroughSystem({
    state,
    eventBus: EventBus,
    config: { breakthroughs: { progressRate: 1 } },
  });

  assert.equal(system.count, 0);
  assert.equal(system.byRealm('mortal'), null);
  assert.equal(system.canAttempt(), false);
  // No state writes: the restored breakthrough fields stay untouched.
  assert.equal(state.cultivation.realmProgress, 500);
  assert.equal(state.cultivation.realmProgressMax, 777);
  assert.equal(state.cultivation.breakthroughCost, 42);
  assert.deepEqual(state.cultivation, before);

  assert.deepEqual(system.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'no-definition',
  });
  assert.equal(warn.mock.callCount(), 1);
  // requirements() is a neutral read: fallback gates, canAttempt false.
  assert.deepEqual(system.requirements(), {
    realmId: null,
    requiredProgress: 1000,
    progress: 500,
    progressMet: false,
    cost: { spiritStones: 0 },
    costMet: true,
    bottleneck: [],
    bottleneckMet: true,
    tribulationRequired: false,
    tribulationMet: true,
    layer: 1,
    layerMax: 9,
    layerMet: false,
    canAttempt: false,
  });
  assert.deepEqual(state.cultivation, before);
});

test('hostile breakthrough definitions coerce to safe defaults', () => {
  // requiredProgress -5 → 1000; cost -3 → 0; bottleneck keeps only the
  // usable entry ('' / 0 dropped, '2' coerced to 2); results drop the
  // non-canonical outcome and the non-positive weight → default table.
  const hostile = deepFreeze([
    {
      realmId: 'mortal',
      requiredProgress: -5,
      cost: { spiritStones: -3 },
      bottleneck: [
        { id: '', count: 0 },
        { id: 'spirit-herb', count: '2' },
      ],
      results: [
        { outcome: 'death', weight: 5, progressLoss: 1 },
        { outcome: 'success', weight: -3 },
      ],
    },
  ]);
  const state = structuredClone(GameState);
  const dataManager = makeDataManager({ breakthroughs: hostile });
  const { breakthroughs, inventory } = makeSystems({ state, dataManager });

  // Boot sync coerces: requiredProgress fallback 1000, spiritStones 0.
  assert.equal(state.cultivation.realmProgressMax, 1000);
  assert.equal(state.cultivation.breakthroughCost, 0);

  // The coerced bottleneck demands 2 spirit-herbs (not the junk entries).
  assert.deepEqual(breakthroughs.requirements().bottleneck, [
    { id: 'spirit-herb', count: 2 },
  ]);
  assert.deepEqual(breakthroughs.requirements().cost, { spiritStones: 0 });
  assert.equal(breakthroughs.requirements().bottleneckMet, false);

  // Without the herbs the attempt is NOT blocked — cost/bottleneck are
  // INFORMATIONAL ONLY (P1 playtest fix). With default random () => 0 the
  // roll lands on 'success' and advances to qi-gathering (the no-herbs
  // success path covers what the old "with herbs" re-attempt tested, so
  // the re-attempt is no longer needed and would now hit 'no-definition'
  // for the post-advance realm — this hostile dataManager has no
  // qi-gathering entry by design).
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmLayer = 9;
  const result = breakthroughs.attempt();
  assert.equal(result.reason, undefined);
  assert.equal(result.advanced, true);
  assert.equal(state.cultivation.realm, 'Qi Gathering');
  assert.equal(state.statistics.breakthroughsTotal, 1);
});

test('an out-of-range progressLoss clamps into 0..1 (never gains progress)', () => {
  const hostile = deepFreeze([
    {
      realmId: 'mortal',
      requiredProgress: 1000,
      cost: { spiritStones: 0 },
      bottleneck: [],
      results: [{ outcome: 'failure', weight: 100, progressLoss: 2 }],
    },
  ]);
  const state = structuredClone(GameState);
  const dataManager = makeDataManager({ breakthroughs: hostile });
  const { breakthroughs } = makeSystems({ state, dataManager, random: () => 0 });
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmLayer = 9;

  // progressLoss 2 clamps to 1 → progress 1000 - 1000 → floored at 0, and
  // the realm never advanced (a clamped failure can never be a success).
  const result = breakthroughs.attempt();
  assert.deepEqual(result, { outcome: 'failure', advanced: false });
  assert.equal(state.cultivation.realmProgress, 0);
});

test('restore-trust: malformed cultivation/statistics slices are repaired and never abort boot', () => {
  for (const malformed of [null, 5, []]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    state.cultivation = malformed;
    state.statistics = malformed;

    const { breakthroughs } = makeSystems({ state }); // must not throw

    assert.equal(state.cultivation.realmProgress, 0);
    assert.equal(state.cultivation.realmProgressMax, 1000);
    assert.equal(state.cultivation.breakthroughCost, 0);
    assert.equal(state.statistics.breakthroughsTotal, 0);
    assert.equal(breakthroughs.canAttempt(), false);
  }
});

test('restore-trust: malformed progress values never poison the gates', () => {
  const state = structuredClone(GameState);
  state.cultivation.realmProgress = 'junk';
  const { breakthroughs } = makeSystems({ state });

  // A non-numeric progress reads as 0 → the progress gate blocks.
  assert.equal(breakthroughs.requirements().progress, 0);
  assert.deepEqual(breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'progress',
  });

  // A negative progress reads as 0 too.
  state.cultivation.realmProgress = -50;
  assert.equal(breakthroughs.requirements().progress, 0);

  // A hostile realmProgressMax (overwritten by boot sync to 1000, then set
  // hostile again) falls back to 1000 for the failure-loss math — a
  // negative max must never make a failure GAIN progress.
  state.cultivation.realmProgress = 1000;
  state.cultivation.realmProgressMax = -5;
  const hostileMax = makeSystems({ state, random: () => 0.95 }).breakthroughs;
  state.cultivation.realmLayer = 9; // after RealmSystem boot; must be at layer max
  const result = hostileMax.attempt(); // heavy-failure, loss 0.5
  assert.deepEqual(result, { outcome: 'heavy-failure', advanced: false });
  // loss = 0.5 × fallback 1000 (not 0.5 × -5) → progress 500, not 1002.5.
  assert.equal(state.cultivation.realmProgress, 500);
});
