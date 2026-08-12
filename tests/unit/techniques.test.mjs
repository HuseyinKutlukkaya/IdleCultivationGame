/**
 * tests/unit/techniques.test.mjs — unit tests for js/systems/techniques.js.
 *
 * Exercises the TechniqueSystem under its P5 division of labor: it owns
 * state.techniques.owned[id] (level, proficiencyXp, lastActivationMs),
 * writes cultivation.qiSources.techniques (the aggregate qi/s rate), and
 * drives qi production on cooldown ticks. It uses ResourceSystem.spend() to
 * deduct cost. Every dependency is injected — state, eventBus, dataManager,
 * resourceSystem, nowFn — so the test is fully deterministic.
 *
 * Coverage:
 *   - Constructor: catalog snapshot, empty catalog gracefully, restore-trust
 *     repairs malformed state.techniques slice.
 *   - list(), get(id): read-only catalog lookups.
 *   - level(id), isOwned(id): level queries.
 *   - cost(id): geometric series cost(N) = floor(base × multiplier^N).
 *   - buy(id): first purchase, stone deduction, rejections.
 *   - upgrade(id): level increment, cost scaling.
 *   - getRevenue(id): base + perLevel × level, milestone stacking.
 *   - getCooldown(id): cooldown × milestone multipliers.
 *   - getProficiencyName(id): correct tier based on accumulated XP.
 *   - tick(): qi generation on cooldown, proficiency XP accrual, lastActivationMs.
 *   - Defensive: missing datamanager → no-op, hostile saves.
 *
 * Run: `node --test` with the suite glob as documented in tests/README.md.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { TechniqueSystem } from '../../js/systems/techniques.js';

/**
 * Small, safe technique fixture: a deterministic dataManager lookalike.
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
      if (collection !== 'techniques') return [];
      return catalog;
    },
    get(collection, id) {
      if (collection !== 'techniques') return undefined;
      return byId.get(id);
    },
  };
}

/**
 * Tiny wallet lookalike — records spend() calls.
 *
 * @param {object} [bag] — initial resource balances.
 * @returns {{
 *   balances: object,
 *   spendCalls: Array<{id: string, amount: number}>,
 *   spend(id: string, amount: number): boolean,
 *   canAfford(id: string, amount: number): boolean
 * }}
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

function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Reset the shared EventBus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a TechniqueSystem with a fresh state clone, a default wallet and
 * a small canned catalog.
 *
 * @param {object} [options] — overrides.
 * @returns {{ system: TechniqueSystem, resourceSystem: object, emitted: Array, state: object }}
 */
function makeSystem(options = {}) {
  const definitions = options.definitions || [
    {
      id: 'breath-control',
      name: 'Breath Control',
      description: 'Regulate breathing.',
      baseCost: 50,
      costMultiplier: 1.15,
      baseRevenue: 0.5,
      revenuePerLevel: 0.1,
      cooldownMs: 1000,
      milestones: {
        '5':  { type: 'cooldown', value: 0.90 },
        '10': { type: 'revenue',  value: 1.25 },
        '25': { type: 'cooldown', value: 0.80 },
        '50': { type: 'revenue',  value: 1.50 },
        '100':{ type: 'cooldown', value: 0.70 },
        '150':{ type: 'revenue',  value: 2.00 },
        '200':{ type: 'cooldown', value: 0.50 },
      },
      proficiency: {
        xpPerActivation: 1,
        ladder: [
          { name: 'Beginner',     threshold: 0 },
          { name: 'Minor',        threshold: 100 },
          { name: 'Greater',      threshold: 500 },
          { name: 'Complete',     threshold: 1500 },
          { name: 'Mastered',     threshold: 5000 },
          { name: 'Assimilated',  threshold: 15000 },
          { name: 'Transcendence',threshold: 50000 },
        ],
      },
    },
    {
      id: 'circulating-qi',
      name: 'Circulating Qi',
      description: 'Cycle qi.',
      baseCost: 200,
      costMultiplier: 1.20,
      baseRevenue: 1.5,
      revenuePerLevel: 0.3,
      cooldownMs: 1500,
      milestones: {
        '5':  { type: 'revenue',  value: 1.30 },
        '10': { type: 'cooldown', value: 0.85 },
      },
      proficiency: {
        xpPerActivation: 1,
        ladder: [
          { name: 'Beginner',     threshold: 0 },
          { name: 'Minor',        threshold: 150 },
          { name: 'Greater',      threshold: 750 },
          { name: 'Complete',     threshold: 2200 },
          { name: 'Mastered',     threshold: 7500 },
          { name: 'Assimilated',  threshold: 22000 },
          { name: 'Transcendence',threshold: 75000 },
        ],
      },
    },
  ];

  const dataManager = createFakeDataManager(definitions);
  const resourceSystem = options.resourceSystem || createFakeResourceSystem({ spiritStones: 10000 });

  const state = options.state || structuredClone(GameState);
  const emitted = [];
  const eventBus = {
    emit(name, payload) {
      emitted.push([name, payload]);
    },
    subscribe() {},
    unsubscribe() {},
    hasListeners() { return true; },
  };

  let clock = options.clock || 0;
  const nowFn = options.nowFn || (() => clock);

  const system = new TechniqueSystem({
    state,
    eventBus,
    dataManager,
    resourceSystem,
    nowFn,
  });

  return { system, resourceSystem, emitted, state, dataManager, definitions, clockFn: () => clock, setClock: (c) => { clock = c; } };
}

// ---------- Constructor ----------

test('constructor reads the catalog and returns empty list when no DataManager', () => {
  const state = structuredClone(GameState);
  const system = new TechniqueSystem({ state, eventBus: EventBus });
  assert.deepEqual(system.list(), []);
  assert.equal(system.get('breath-control'), null);
});

test('constructor syncs the qi aggregate from restored owned entries', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  // breath-control at level 1: revenue = 0.5 + 0.1*1 = 0.6, cooldown = 1000
  // qi/s = 0.6 / (1000/1000) = 0.6
  const { system } = makeSystem({ state });
  assert.equal(system.level('breath-control'), 1);
  assert.equal(state.cultivation.qiSources.techniques, 0.6);
});

test('constructor repair-trusts a malformed state.techniques slice', () => {
  for (const bad of [null, undefined, 42, 'string', [], { owned: null }, { owned: 'wrong' }]) {
    const state = structuredClone(GameState);
    state.techniques = bad;

    const { system } = makeSystem({ state });

    assert.equal(typeof state.techniques, 'object', `bad slice ${String(bad)} was repaired`);
    assert.equal(typeof state.techniques.owned, 'object');
    assert.equal(system.level('breath-control'), 0);
  }
});

test('constructor drops prototype-alias owned keys', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['__proto__'] = { level: 99, proficiencyXp: 0, lastActivationMs: 0 };
  state.techniques.owned['constructor'] = { level: 99, proficiencyXp: 0, lastActivationMs: 0 };

  makeSystem({ state });

  assert.ok(!Object.hasOwn(state.techniques.owned, '__proto__'));
  assert.ok(!Object.hasOwn(state.techniques.owned, 'constructor'));
});

test('constructor clamps non-finite owned values in place', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: -3, proficiencyXp: Infinity, lastActivationMs: NaN };

  const { system } = makeSystem({ state });

  const entry = state.techniques.owned['breath-control'];
  assert.equal(entry.level, 0);
  assert.equal(entry.proficiencyXp, 0);
  assert.equal(entry.lastActivationMs, 0);
});

// ---------- list + get ----------

test('list() returns shallow copies', () => {
  const { system } = makeSystem();
  const first = system.list();
  assert.ok(first.length >= 2);
  first.length = 0;
  assert.ok(system.list().length >= 2);
});

test('get(id) returns a shallow copy or null for unknown ids', () => {
  const { system } = makeSystem();
  assert.ok(system.get('breath-control'));
  assert.equal(system.get('does-not-exist'), null);
});

// ---------- level + isOwned ----------

test('level(id) returns 0 for unknown / non-string / prototype-alias ids', () => {
  const { system } = makeSystem();
  for (const bad of ['unknown', '', '__proto__', 'constructor', 'prototype', null, undefined, 42]) {
    assert.equal(system.level(bad), 0, `level(${String(bad)}) should be 0`);
  }
});

test('isOwned(id) returns true when level >= 1', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 3, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });
  assert.equal(system.isOwned('breath-control'), true);
  assert.equal(system.isOwned('circulating-qi'), false);
});

// ---------- cost ----------

test('cost(id) grows geometrically: cost(N) = floor(baseCost × multiplier^N)', () => {
  const { system } = makeSystem();
  // Level 0 (not owned): cost = baseCost = 50
  assert.equal(system.cost('breath-control'), 50);
  // Level 1: cost = floor(50 × 1.15^1) = floor(57.5) = 57
  // Level 2: cost = floor(50 × 1.15^2) = floor(66.125) = 66
  // Level 3: cost = floor(50 × 1.15^3) = floor(76.044) = 76
});

test('cost(id) is 0 for unknown ids', () => {
  const { system } = makeSystem();
  assert.equal(system.cost('does-not-exist'), 0);
});

// ---------- buy ----------

test('buy(id) purchases a technique: sets level 1, spends stones, emits event', () => {
  const { system, state, emitted, resourceSystem } = makeSystem();

  const result = system.buy('breath-control');
  assert.notEqual(result, null);
  assert.equal(result.id, 'breath-control');
  assert.equal(result.level, 1);

  // Wallet deducted.
  assert.ok(resourceSystem.spendCalls.length > 0);
  assert.equal(resourceSystem.spendCalls[0].id, 'spiritStones');
  assert.equal(resourceSystem.spendCalls[0].amount, 50);

  // State written.
  assert.equal(state.techniques.owned['breath-control'].level, 1);
  assert.equal(state.techniques.owned['breath-control'].proficiencyXp, 0);
  assert.equal(state.techniques.owned['breath-control'].lastActivationMs, 0);

  // Event emitted.
  const purchaseEvent = emitted.find(([name]) => name === 'technique:purchased');
  assert.ok(purchaseEvent);
  assert.deepEqual(purchaseEvent[1], { id: 'breath-control', level: 1 });
});

test('buy(id) rejects non-string / empty / prototype-alias ids', () => {
  const { system } = makeSystem();
  for (const bad of ['', null, undefined, 42, '__proto__', 'constructor', 'prototype']) {
    assert.equal(system.buy(bad), null, `buy(${String(bad)}) should reject`);
  }
});

test('buy(id) rejects unknown ids', () => {
  const { system } = makeSystem();
  assert.equal(system.buy('does-not-exist'), null);
});

test('buy(id) rejects already-owned techniques', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 5, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });
  assert.equal(system.buy('breath-control'), null);
});

test('buy(id) without resource system warns and returns null', () => {
  const state = structuredClone(GameState);
  const dm = createFakeDataManager([
    {
      id: 'breath-control',
      name: 'BC',
      description: 'BC',
      baseCost: 10,
      costMultiplier: 1.15,
      baseRevenue: 0.5,
      revenuePerLevel: 0.1,
      cooldownMs: 1000,
      milestones: {},
      proficiency: { xpPerActivation: 1, ladder: [{ name: 'Beginner', threshold: 0 }] },
    },
  ]);
  const emitted = [];
  const system = new TechniqueSystem({
    state,
    eventBus: { emit(n, p) { emitted.push([n, p]); }, subscribe() {}, unsubscribe() {}, hasListeners() { return true; } },
    dataManager: dm,
    resourceSystem: null,
    nowFn: () => 0,
  });

  assert.equal(system.buy('breath-control'), null);
});

test('buy(id) when wallet rejects the spend returns null', () => {
  const resourceSystem = createFakeResourceSystem({ spiritStones: 10 }); // only 10, need 50
  const { system } = makeSystem({ resourceSystem });
  assert.equal(system.buy('breath-control'), null);
});

// ---------- upgrade ----------

test('upgrade(id) increments level, spends scaled cost, emits event', () => {
  const { system, state, emitted, resourceSystem } = makeSystem();

  // Buy first.
  system.buy('breath-control');
  assert.equal(system.level('breath-control'), 1);

  // Upgrade.
  const result = system.upgrade('breath-control');
  assert.notEqual(result, null);
  assert.equal(result.level, 2);
  // Cost at level 1: floor(50 × 1.15^1) = 57
  assert.equal(result.cost, 57);

  const upgradeEvents = emitted.filter(([name]) => name === 'technique:upgraded');
  assert.equal(upgradeEvents.length, 1);
  assert.deepEqual(upgradeEvents[0][1], { id: 'breath-control', level: 2, cost: 57 });
});

test('upgrade(id) rejects non-owned techniques', () => {
  const { system } = makeSystem();
  assert.equal(system.upgrade('circulating-qi'), null);
});

test('upgrade(id) without resource system returns null', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  const dm = createFakeDataManager([
    {
      id: 'breath-control',
      name: 'BC',
      description: 'BC',
      baseCost: 10,
      costMultiplier: 1.15,
      baseRevenue: 0.5,
      revenuePerLevel: 0.1,
      cooldownMs: 1000,
      milestones: {},
      proficiency: { xpPerActivation: 1, ladder: [{ name: 'Beginner', threshold: 0 }] },
    },
  ]);
  const system = new TechniqueSystem({
    state,
    eventBus: EventBus,
    dataManager: dm,
    resourceSystem: null,
    nowFn: () => 0,
  });

  assert.equal(system.upgrade('breath-control'), null);
});

// ---------- getRevenue ----------

test('getRevenue(id) = (baseRevenue + revenuePerLevel × level) × milestone multipliers', () => {
  const state = structuredClone(GameState);
  // breath-control at level 10: baseRevenue=0.5, perLevel=0.1 → 0.5+1.0=1.5
  // Milestones: level 5 cooldown (no effect), level 10 revenue 1.25
  // revenue = 1.5 × 1.25 = 1.875
  state.techniques.owned['breath-control'] = { level: 10, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });

  const revenue = system.getRevenue('breath-control');
  assert.ok(Math.abs(revenue - 1.875) < 0.001, `expected ~1.875, got ${revenue}`);
});

test('getRevenue(id) at level 50 stacks both revenue milestones multiplicatively', () => {
  const state = structuredClone(GameState);
  // breath-control at level 50: base=0.5, perLevel=0.1 → 0.5+5.0=5.5
  // Revenue milestones: level 10 = 1.25, level 50 = 1.50
  // revenue = 5.5 × 1.25 × 1.50 = 10.3125
  state.techniques.owned['breath-control'] = { level: 50, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });

  const revenue = system.getRevenue('breath-control');
  assert.ok(Math.abs(revenue - 10.3125) < 0.001, `expected ~10.3125, got ${revenue}`);
});

// ---------- getCooldown ----------

test('getCooldown(id) = cooldownMs × milestone multipliers', () => {
  const state = structuredClone(GameState);
  // breath-control at level 10: cooldownMs=1000
  // Cooldown milestones: level 5 = 0.90 (level 25 not reached)
  // cooldown = 1000 × 0.90 = 900
  state.techniques.owned['breath-control'] = { level: 10, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });

  assert.equal(system.getCooldown('breath-control'), 900);
});

// ---------- getProficiencyName ----------

test('getProficiencyName(id) returns correct tier based on XP', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });

  assert.equal(system.getProficiencyName('breath-control'), 'Beginner');

  // Push XP to 100 → Minor
  state.techniques.owned['breath-control'].proficiencyXp = 100;
  assert.equal(system.getProficiencyName('breath-control'), 'Minor');

  // Push XP to 500 → Greater
  state.techniques.owned['breath-control'].proficiencyXp = 500;
  assert.equal(system.getProficiencyName('breath-control'), 'Greater');

  // Push XP to 50000 → Transcendence
  state.techniques.owned['breath-control'].proficiencyXp = 50000;
  assert.equal(system.getProficiencyName('breath-control'), 'Transcendence');
});

test('getProficiencyName(id) returns Unknown for unknown techniques', () => {
  const { system } = makeSystem();
  assert.equal(system.getProficiencyName('does-not-exist'), 'Unknown');
});

// ---------- getAll ----------

test('getAll() returns array of owned technique entries with metadata', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  const { system } = makeSystem({ state });

  const all = system.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'breath-control');
  assert.equal(all[0].level, 1);
  assert.equal(all[0].proficiencyName, 'Beginner');
  assert.ok(Number.isFinite(all[0].revenue));
  assert.ok(Number.isFinite(all[0].cooldownMs));
  assert.ok(Number.isFinite(all[0].cost));
});

// ---------- tick ----------

test('tick generates qi for ready techniques on cooldown', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  state.cultivation.qiMax = 1000;
  state.cultivation.qi = 0;

  const { system, emitted, setClock } = makeSystem({ state });

  // Set clock to 2000ms — the technique's cooldown (1000ms) has elapsed.
  setClock(2000);

  // Emit a loop:update-like payload to trigger the tick handler.
  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });

  // Qi should have been generated.
  // Level 1 breath-control: revenue = 0.5 + 0.1 = 0.6 qi per activation.
  assert.ok(state.cultivation.qi >= 0.6, `qi should be at least 0.6, got ${state.cultivation.qi}`);

  // Proficiency XP should have increased.
  assert.equal(state.techniques.owned['breath-control'].proficiencyXp, 1);
});

test('tick skips techniques still on cooldown', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 100 };
  state.cultivation.qiMax = 1000;
  state.cultivation.qi = 0;

  const { system, setClock } = makeSystem({ state });

  // Clock is at 500ms — cooldown (1000ms) has NOT elapsed since lastActivationMs=100.
  setClock(500);

  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });

  // Qi should NOT have changed.
  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.techniques.owned['breath-control'].proficiencyXp, 0);
});

test('tick generates qi for a technique whose cooldown has just elapsed', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  state.cultivation.qiMax = 1000;
  state.cultivation.qi = 0;

  const { system, setClock } = makeSystem({ state });

  // Clock at 1000ms — exactly at the cooldown threshold.
  setClock(1000);

  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });

  assert.ok(state.cultivation.qi >= 0.6);
  assert.equal(state.techniques.owned['breath-control'].lastActivationMs, 1000);
});

test('tick does not generate qi past the qi cap', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  state.cultivation.qiMax = 0.3; // Cap is lower than the activation revenue (0.6).
  state.cultivation.qi = 0;

  const { system, setClock } = makeSystem({ state });
  setClock(2000);

  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });

  // Should only add up to the cap (0.3).
  assert.equal(state.cultivation.qi, 0.3);
});

test('tick emits technique:activated event for each activated technique', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  state.cultivation.qiMax = 1000;
  state.cultivation.qi = 0;

  const { system, emitted, setClock } = makeSystem({ state });
  setClock(2000);

  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });

  const activationEvents = emitted.filter(([name]) => name === 'technique:activated');
  assert.equal(activationEvents.length, 1);
  assert.equal(activationEvents[0][1].id, 'breath-control');
  assert.ok(activationEvents[0][1].qiGenerated > 0);
});

test('tick syncs the qi aggregate after activation', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  state.cultivation.qiMax = 1000;

  const { system, setClock } = makeSystem({ state });
  setClock(2000);

  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });

  // breath-control at level 1: revenue=0.6, cooldown=1000 → qi/s = 0.6
  assert.ok(state.cultivation.qiSources.techniques > 0);
});

test('tick with no owned techniques does nothing', () => {
  const state = structuredClone(GameState);
  const { system, setClock } = makeSystem({ state });
  setClock(10000);

  const qiBefore = state.cultivation.qi;
  system._onUpdate({ deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  assert.equal(state.cultivation.qi, qiBefore);
});

// ---------- hostile save restoration ----------

test('hostile save with non-object entry in owned is dropped', () => {
  const state = structuredClone(GameState);
  state.techniques.owned['breath-control'] = 'not an object';
  state.techniques.owned['circulating-qi'] = 42;

  const { system } = makeSystem({ state });

  assert.equal(system.level('breath-control'), 0);
  assert.equal(system.level('circulating-qi'), 0);
});

test('multi-technique aggregate is the sum of both qi/s rates', () => {
  const state = structuredClone(GameState);
  // breath-control at level 1: revenue=0.6, cooldown=1000 → 0.6 qi/s
  state.techniques.owned['breath-control'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };
  // circulating-qi at level 1: revenue=1.5+0.3=1.8, cooldown=1500 → 1.2 qi/s
  state.techniques.owned['circulating-qi'] = { level: 1, proficiencyXp: 0, lastActivationMs: 0 };

  const { system } = makeSystem({ state });

  // aggregate = 0.6 + 1.2 = 1.8
  assert.ok(Math.abs(state.cultivation.qiSources.techniques - 1.8) < 0.01,
    `expected ~1.8, got ${state.cultivation.qiSources.techniques}`);
});
