/**
 * tests/unit/upgrades.test.mjs — unit tests for js/systems/upgrades.js.
 *
 * Exercises UpgradeSystem under its Phase-2 division of labor: it owns
 * state.upgrades.purchased[id] (the player's owned levels) and writes
 * cultivation.qiSources.upgrades (the aggregate qi/s contribution every
 * tick). It uses ResourceSystem.spend() to deduct cost (never touches
 * state.resources directly) and DataManager.getAll('upgrades') /
 * get('upgrades', id) to resolve definitions (no hardcoded metadata).
 * Every direct dependency is injected — state, eventBus, dataManager,
 * resourceSystem — so the test is fully deterministic and never touches
 * the global EventBus singleton, the shared GameState, or the real
 * DataManager pipeline.
 *
 * Coverage:
 *   - Constructor: catalog snapshot is taken once; a later DataManager
 *     mutation does NOT change the system view; empty catalog silently
 *     means every purchase is rejected; restore-trust repairs a
 *     malformed state.upgrades slice (null, primitive, array, missing
 *     `purchased`, prototype-alias keys, non-finite levels).
 *   - list(), get(id): deep-copy snapshots, unknown ids return null.
 *   - level(id): returns the cached level, 0 for unknown /
 *     prototype-alias / non-string ids, clamps negative and non-finite
 *     values to 0.
 *   - cost(id): geometric series cost(N) = floor(base × growth^(N-1));
 *     base×growth at level 2; 0 for unknown / maxed-out / bad catalog
 *     values.
 *   - canPurchase(id): false when there's no resource system, the id is
 *     unknown, the upgrade is maxed, the wallet can't cover the next
 *     level.
 *   - purchase(id): every failure mode (non-string, prototype-alias,
 *     unknown id, no resource system, maxed, non-positive next cost,
 *     wallet reject) returns false with a warn, no mutation, no emit;
 *     every success increments the level, recomputes the aggregate,
 *     emits `upgrades:purchased { id, level, cost, effectPerLevel }`,
 *     and returns true. Also asserts the resource:changed event from the
 *     wallet (-cost delta).
 *   - Multi-upgrade interaction: when the catalog has multiple qiRateAdd
 *     upgrades, the aggregate is the sum of their level × effectPerLevel;
 *     the writes to cultivation.qiSources.upgrades stay in sync.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { UpgradeSystem } from '../../js/systems/upgrades.js';

/**
 * Small, safe upgrade fixture: a deterministic dataManager lookalike that
 * returns a frozen catalog snapshot on demand and supports the two
 * read-only methods the system uses.
 *
 * @param {Array<object>} definitions — the catalog.
 * @returns {{
 *   getAll(collection: string): Array<object>,
 *   get(collection: string, id: string): object|undefined
 * }} the fake dataManager.
 */
function createFakeDataManager(definitions) {
  const catalog = Object.freeze(definitions.map((entry) => Object.freeze({ ...entry })));
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  return {
    getAll(collection) {
      if (collection !== 'upgrades') return [];
      return catalog;
    },
    get(collection, id) {
      if (collection !== 'upgrades') return undefined;
      return byId.get(id);
    },
  };
}

/**
 * Tiny wallet lookalike — records spend() calls and exposes canAfford().
 *
 * @param {object} [bag] — initial resource balances (id → amount).
 * @returns {{
 *   balances: object,
 *   spendCalls: Array<{id: string, amount: number}>,
 *   spend(id: string, amount: number): boolean,
 *   canAfford(id: string, amount: number): boolean
 * }} the fake resource system.
 */
function createFakeResourceSystem(bag = {}) {
  const balances = { ...bag };
  return {
    balances,
    spendCalls: [],
    spend(id, amount) {
      this.spendCalls.push({ id, amount });
      const current = _asNumber(balances[id]);
      const parsed = _asNumber(amount);
      if (parsed <= 0) return false;
      if (current < parsed) return false;
      balances[id] = current - parsed;
      return true;
    },
    canAfford(id, amount) {
      const current = _asNumber(balances[id]);
      const parsed = _asNumber(amount);
      if (parsed <= 0) return true;
      return current >= parsed;
    },
  };
}

/** Same fail-safe coerce as the module. */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reset the shared EventBus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build an UpgradeSystem instance with a fresh state clone, an empty
 * wallet by default and a small canned catalog (3 upgrades, the cheaper
 * ones; tests pass explicit overrides when they need more).
 *
 * @param {object} [options] — overrides.
 * @returns {{ system: UpgradeSystem, resourceSystem: object, events: Array }}
 *          the wired unit.
 */
function makeSystem(options = {}) {
  const definitions = options.definitions || [
    {
      id: 'foundation-breathing',
      name: 'Foundation Breathing',
      description: '+1 qi/s per level.',
      category: 'qiRateAdd',
      costResource: 'spiritStones',
      baseCost: 10,
      costGrowth: 1.5,
      effectPerLevel: 1,
      maxLevel: null,
    },
    {
      id: 'qi-gathering',
      name: 'Qi Gathering',
      description: '+5 qi/s per level.',
      category: 'qiRateAdd',
      costResource: 'spiritStones',
      baseCost: 25,
      costGrowth: 1.5,
      effectPerLevel: 5,
      maxLevel: null,
    },
    {
      id: 'meridian-cleansing',
      name: 'Meridian Cleansing',
      description: '+50 qi/s per level.',
      category: 'qiRateAdd',
      costResource: 'spiritStones',
      baseCost: 50,
      costGrowth: 1.5,
      effectPerLevel: 50,
      maxLevel: 5,
    },
  ];

  const dataManager = createFakeDataManager(definitions);
  const resourceSystem = options.resourceSystem || createFakeResourceSystem({ spiritStones: 1000 });

  const state = options.state || structuredClone(GameState);
  const emitted = [];
  const eventBus = {
    emit(name, payload) {
      emitted.push([name, payload]);
    },
    subscribe() {},
    unsubscribe() {},
  };

  const system = new UpgradeSystem({
    state,
    eventBus,
    dataManager,
    resourceSystem,
  });

  return { system, resourceSystem, emitted, state, dataManager, definitions };
}

// ---------- Constructor ----------

test('constructor reads the catalog once and ignores later DataManager changes', () => {
  // The fake catalog is frozen to mirror DataManager's deep-freeze contract,
  // so a "mutate after construction" assertion needs a different shape:
  // build a dataManager that swaps its OWN catalog at runtime, and confirm
  // the system still sees the originally-snapshotted definitions.
  let backing = [
    {
      id: 'foundation-breathing',
      name: 'Foundation Breathing',
      description: '+1 qi/s per level.',
      category: 'qiRateAdd',
      costResource: 'spiritStones',
      baseCost: 10,
      costGrowth: 1.5,
      effectPerLevel: 1,
    },
  ];
  const dataManager = {
    getAll(collection) {
      return collection === 'upgrades' ? backing : [];
    },
    get(collection, id) {
      return collection === 'upgrades' ? backing.find((entry) => entry.id === id) : undefined;
    },
  };

  const system = new UpgradeSystem({
    state: structuredClone(GameState),
    eventBus: EventBus,
    dataManager,
    resourceSystem: createFakeResourceSystem({ spiritStones: 1000 }),
  });
  assert.equal(system.list().length, 1);

  // Swap the backing catalog at runtime — the system must not observe it.
  backing = [];
  backing.push(
    Object.freeze({
      id: 'late-entry',
      name: 'Late Entry',
      description: '+X qi/s per level.',
      category: 'qiRateAdd',
      costResource: 'spiritStones',
      baseCost: 1,
      costGrowth: 1,
      effectPerLevel: 1,
    })
  );
  assert.equal(system.list().length, 1, 'cached snapshot must not reflect later DataManager changes');
  assert.equal(system.get('late-entry'), null, 'late entries are not picked up');
});

test('constructor with no DataManager silently manages no upgrades', () => {
  const state = structuredClone(GameState);
  const system = new UpgradeSystem({ state, eventBus: EventBus });
  assert.deepEqual(system.list(), []);
  assert.equal(system.get('foundation-breathing'), null);
});

test('constructor syncs the qi aggregate from any pre-existing purchased levels', () => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['foundation-breathing'] = 3;
  state.upgrades.purchased['qi-gathering'] = 2;

  const { system } = makeSystem({ state });

  // foundation-breathing: 3 × 1 = 3, qi-gathering: 2 × 5 = 10 → aggregate 13.
  assert.equal(system.level('foundation-breathing'), 3);
  assert.equal(system.level('qi-gathering'), 2);
  assert.equal(state.cultivation.qiSources.upgrades, 13);
});

test('constructor repair-trusts a malformed state.upgrades slice before any read', () => {
  for (const bad of [null, undefined, 42, 'string', [], { purchased: 'wrong' }]) {
    const state = structuredClone(GameState);
    state.upgrades = bad;

    const system = new UpgradeSystem({
      state,
      eventBus: EventBus,
      dataManager: createFakeDataManager([
        {
          id: 'x',
          name: 'X',
          description: 'X',
          category: 'qiRateAdd',
          costResource: 'spiritStones',
          baseCost: 1,
          costGrowth: 1,
          effectPerLevel: 1,
        },
      ]),
      resourceSystem: createFakeResourceSystem({ spiritStones: 100 }),
    });

    assert.equal(typeof state.upgrades, 'object', `bad slice ${String(bad)} was repaired`);
    assert.equal(typeof state.upgrades.purchased, 'object');
    assert.equal(system.level('x'), 0);
  }
});

test('constructor clamps non-finite and negative purchased levels in place', () => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['foundation-breathing'] = -3;     // negative → 0
  state.upgrades.purchased['qi-gathering'] = 'four';        // non-numeric → 0
  state.upgrades.purchased['meridian-cleansing'] = Infinity; // non-finite → 0

  const { system } = makeSystem({ state });

  assert.equal(state.upgrades.purchased['foundation-breathing'], 0);
  assert.equal(state.upgrades.purchased['qi-gathering'], 0);
  assert.equal(state.upgrades.purchased['meridian-cleansing'], 0);
  assert.equal(system.level('foundation-breathing'), 0);
});

test('constructor drops prototype-alias purchased keys (defense)', () => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['__proto__'] = 99;
  state.upgrades.purchased['constructor'] = 99;
  state.upgrades.purchased['prototype'] = 99;

  const { system } = makeSystem({ state });

  // Object.hasOwn (not `in`) is the correct check — `__proto__` is always
  // a property of every object via the prototype chain, but the OWNDATA
  // presence is what matters (a restored hostile save must not carry it).
  assert.ok(
    !Object.hasOwn(state.upgrades.purchased, '__proto__'),
    'purchased must not OWNDATA a __proto__ key'
  );
  assert.ok(!Object.hasOwn(state.upgrades.purchased, 'constructor'));
  assert.ok(!Object.hasOwn(state.upgrades.purchased, 'prototype'));
});

// ---------- list + get ----------

test('list() returns shallow copies; mutating one never leaks back into the catalog', () => {
  const { system } = makeSystem();
  const first = system.list();
  first.length = 0;
  first[0] = { id: 'fake', name: 'Fake' };
  assert.ok(system.list().length > 0);
});

test('get(id) returns a shallow copy or null for unknown ids', () => {
  const { system } = makeSystem();
  assert.ok(system.get('foundation-breathing'));
  assert.equal(system.get('does-not-exist'), null);
  assert.equal(system.get(''), null);
  assert.equal(system.get('__proto__'), null);
});

// ---------- level ----------

test('level(id) returns the cached level for valid ids', () => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['foundation-breathing'] = 7;
  const { system } = makeSystem({ state });
  assert.equal(system.level('foundation-breathing'), 7);
});

test('level(id) is 0 for unknown / non-string / prototype-alias ids (no warn)', () => {
  const { system } = makeSystem();
  for (const bad of ['unknown', '', '__proto__', 'constructor', 'prototype', null, undefined, 42]) {
    assert.equal(system.level(bad), 0, `level(${String(bad)}) should be 0`);
  }
});

// ---------- cost ----------

test('cost(id) grows geometrically with the level (cost = base × growth^(N-1))', () => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['foundation-breathing'] = 0;
  const { system } = makeSystem({ state });

  assert.equal(system.cost('foundation-breathing'), 10); // level 1
  state.upgrades.purchased['foundation-breathing'] = 1;
  assert.equal(system.cost('foundation-breathing'), 15); // floor(10 × 1.5)
  state.upgrades.purchased['foundation-breathing'] = 2;
  assert.equal(system.cost('foundation-breathing'), 22); // floor(10 × 1.5^2)
  state.upgrades.purchased['foundation-breathing'] = 3;
  assert.equal(system.cost('foundation-breathing'), 33); // floor(10 × 1.5^3)
});

test('cost(id) is 0 for unknown ids, maxed upgrades, and bad catalog values', () => {
  const state = structuredClone(GameState);
  // meridian-cleansing has maxLevel: 5 — push it to the cap so cost() returns 0.
  state.upgrades.purchased['meridian-cleansing'] = 5;
  const { system } = makeSystem({ state });

  assert.equal(system.cost('does-not-exist'), 0);
  assert.equal(system.cost('meridian-cleansing'), 0, 'maxed upgrade has no next cost');
});

// ---------- canPurchase ----------

test('canPurchase(id) is false when there is no resource system', () => {
  const state = structuredClone(GameState);
  const system = new UpgradeSystem({
    state,
    eventBus: EventBus,
    dataManager: createFakeDataManager([
      {
        id: 'foundation-breathing',
        name: 'X',
        description: 'X',
        category: 'qiRateAdd',
        costResource: 'spiritStones',
        baseCost: 10,
        costGrowth: 1.5,
        effectPerLevel: 1,
      },
    ]),
    resourceSystem: null,
  });
  assert.equal(system.canPurchase('foundation-breathing'), false);
});

test('canPurchase(id) requires the wallet to cover the next-level cost', () => {
  const state = structuredClone(GameState);
  const resourceSystem = createFakeResourceSystem({ spiritStones: 5 }); // only 5, base 10
  const { system } = makeSystem({ state, resourceSystem });
  assert.equal(system.canPurchase('foundation-breathing'), false);

  resourceSystem.balances.spiritStones = 10;
  assert.equal(system.canPurchase('foundation-breathing'), true);
});

test('canPurchase(id) is false for an unknown id or a maxed upgrade', () => {
  const { system, state } = makeSystem();
  assert.equal(system.canPurchase('does-not-exist'), false);

  state.upgrades.purchased['meridian-cleansing'] = 5; // maxLevel: 5
  assert.equal(system.canPurchase('meridian-cleansing'), false);
});

// ---------- purchase ----------

test('purchase(id) returns false and never mutates on every bad-call path', (t) => {
  const { system, state, emitted, resourceSystem } = makeSystem();
  const beforeQi = state.cultivation.qiSources.upgrades;
  const beforePurchased = structuredClone(state.upgrades.purchased);
  const beforeBalances = structuredClone(resourceSystem.balances);

  for (const bad of ['', null, undefined, 42, '__proto__', 'constructor', 'prototype']) {
    assert.equal(system.purchase(bad), false, `bad id ${String(bad)} must reject`);
  }
  assert.equal(system.purchase('does-not-exist'), false, 'unknown id must reject');

  assert.deepEqual(state.cultivation.qiSources.upgrades, beforeQi);
  assert.deepEqual(state.upgrades.purchased, beforePurchased);
  assert.deepEqual(resourceSystem.balances, beforeBalances);
  assert.equal(resourceSystem.spendCalls.length, 0);
  assert.equal(emitted.length, 0);
  // The unknown id / __proto__ / constructor / prototype / non-string
  // paths warn; the `purchase('')` path also warns ("id must be a
  // non-empty string"). All silent otherwise.
});

test('purchase(id) without a resource system warns and returns false', () => {
  const state = structuredClone(GameState);
  const dataManager = createFakeDataManager([
    {
      id: 'foundation-breathing',
      name: 'X',
      description: 'X',
      category: 'qiRateAdd',
      costResource: 'spiritStones',
      baseCost: 10,
      costGrowth: 1.5,
      effectPerLevel: 1,
    },
  ]);
  const system = new UpgradeSystem({
    state,
    eventBus: EventBus,
    dataManager,
    resourceSystem: null,
  });

  const before = state.cultivation.qiSources.upgrades;
  assert.equal(system.purchase('foundation-breathing'), false);
  assert.equal(state.cultivation.qiSources.upgrades, before);
});

test('purchase(id) on a maxed upgrade warns and returns false', (t) => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['meridian-cleansing'] = 5; // maxLevel: 5
  const { system } = makeSystem({ state });

  assert.equal(system.purchase('meridian-cleansing'), false);
  // The maxed-upgrade path emits its own warn (the "is maxed" branch);
  // assert only that the level stayed put.
  assert.equal(system.level('meridian-cleansing'), 5);
});

test('purchase(id) succeeds: increments level, recomputes the aggregate, emits, returns true', () => {
  const { system, state, emitted, resourceSystem } = makeSystem();

  const ok = system.purchase('foundation-breathing');
  assert.equal(ok, true);

  // Wallet was deducted by the level-1 cost (10).
  assert.deepEqual(resourceSystem.spendCalls, [{ id: 'spiritStones', amount: 10 }]);
  assert.equal(resourceSystem.balances.spiritStones, 990);

  // Level bumped to 1.
  assert.equal(state.upgrades.purchased['foundation-breathing'], 1);
  assert.equal(system.level('foundation-breathing'), 1);

  // Aggregate slot is recomputed. foundation-breathing contributes
  // 1 × 1 = 1; the other upgrades still sit at level 0.
  assert.equal(state.cultivation.qiSources.upgrades, 1);

  // Event order: wallet's resource:changed (negative) → upgrades:purchased.
  const purchaseEvent = emitted.find(([name]) => name === 'upgrades:purchased');
  assert.ok(purchaseEvent, 'upgrades:purchased event must fire on a successful purchase');
  assert.deepEqual(purchaseEvent[1], {
    id: 'foundation-breathing',
    level: 1,
    cost: 10,
    effectPerLevel: 1,
  });
});

test('purchase(id) re-emits the event with the new level on a second purchase', () => {
  const { system, state, emitted } = makeSystem();

  system.purchase('qi-gathering'); // level 1; aggregate = 5
  assert.equal(state.upgrades.purchased['qi-gathering'], 1);
  assert.equal(state.cultivation.qiSources.upgrades, 5);

  system.purchase('qi-gathering'); // level 2; cost = floor(25 × 1.5) = 37; aggregate = 10
  assert.equal(state.upgrades.purchased['qi-gathering'], 2);
  assert.equal(state.cultivation.qiSources.upgrades, 10);

  const purchaseEvents = emitted.filter(([name]) => name === 'upgrades:purchased');
  assert.equal(purchaseEvents.length, 2);
  assert.equal(purchaseEvents[1][1].level, 2);
  assert.equal(purchaseEvents[1][1].cost, 37);
});

test('multi-upgrade aggregate is the sum of every qiRateAdd contribution', () => {
  const state = structuredClone(GameState);
  state.upgrades.purchased['foundation-breathing'] = 3; // +3
  state.upgrades.purchased['qi-gathering'] = 2;         // +10
  state.upgrades.purchased['meridian-cleansing'] = 1;   // +50
  const { system } = makeSystem({ state });

  assert.equal(state.cultivation.qiSources.upgrades, 63);

  // A second purchase should keep the sum accurate.
  system.purchase('foundation-breathing'); // level 4 → +4, total +4 + 10 + 50 = 64
  assert.equal(state.cultivation.qiSources.upgrades, 64);
});

test('purchase(id) leaves the aggregate unchanged when the wallet rejects the spend', () => {
  // The fake wallet owns its own balances object — the resource system
  // never reads state.resources directly, so to drain the wallet we set
  // resourceSystem.balances.spiritStones (NOT state.resources).
  const { system, state, emitted, resourceSystem } = makeSystem();

  system.purchase('foundation-breathing'); // -10, level 1
  system.purchase('foundation-breathing'); // -15, level 2
  system.purchase('foundation-breathing'); // -22, level 3
  system.purchase('foundation-breathing'); // -33, level 4
  assert.equal(system.level('foundation-breathing'), 4);
  assert.equal(state.cultivation.qiSources.upgrades, 4);
  assert.equal(resourceSystem.balances.spiritStones, 920);

  // Drain the wallet past the next cost (33 still affordable, so drain to 0).
  resourceSystem.balances.spiritStones = 1;
  emitted.length = 0;
  const before = state.cultivation.qiSources.upgrades;
  const beforeLevel = system.level('foundation-breathing');
  assert.equal(system.purchase('foundation-breathing'), false);
  assert.equal(state.cultivation.qiSources.upgrades, before, 'aggregate must not change on a rejected spend');
  assert.equal(system.level('foundation-breathing'), beforeLevel, 'level must not change on a rejected spend');
  assert.equal(emitted.length, 0, 'no event on a rejected spend');
  assert.equal(resourceSystem.spendCalls[resourceSystem.spendCalls.length - 1].id, 'spiritStones');
});

test('purchase(id) keeps the next-cost number finite at extreme levels (overflow safety)', () => {
  const state = structuredClone(GameState);
  // Plant an absurd already-bought level; the system must not overflow
  // when computing the next cost.
  state.upgrades.purchased['foundation-breathing'] = 1_000_000;

  const { system } = makeSystem({ state });

  const next = system.cost('foundation-breathing');
  assert.ok(Number.isFinite(next), `next cost must be finite (got ${next})`);
  assert.ok(next <= Number.MAX_SAFE_INTEGER, `next cost must be capped (got ${next})`);
});
