/**
 * tests/unit/milestones.test.mjs — unit tests for js/systems/milestones.js.
 *
 * Exercises the MilestoneSystem under its Phase-3 division of labor: it owns
 * state.milestones.reached[id] (the one-shot grant map, keyed by milestone id
 * with the epoch-ms reachedAt stamp) and evaluates every catalog milestone
 * against the 'statistics:changed' snapshot (the four lifetime counters —
 * it has NO loop:update subscription). Grants are paid through the injected
 * resourceSystem.add() (never a direct state.resources write). Every direct
 * dependency is injected — state, eventBus, dataManager, resourceSystem,
 * now — so the test is fully deterministic and never touches the global
 * EventBus singleton (cleared in beforeEach), the shared GameState, or the
 * real DataManager pipeline.
 *
 * Coverage:
 *   - Constructor: catalog loaded once; restore-trust repairs a malformed
 *     state.milestones slice (null, primitive, array, missing/array
 *     `reached`) on construction AND before reads; the single retroactive
 *     evaluation pass grants milestones whose counters already crossed
 *     thresholds — exactly once, never double-granted by the first
 *     'statistics:changed'.
 *   - Evaluation: a 'statistics:changed' crossing a threshold grants the
 *     milestone (reached map stamp via the injected clock, reward through the
 *     wallet spy, 'milestone:reached' payload with id/name/stat/threshold/
 *     reward/reachedAt). Reached-once semantics: a second event with a higher
 *     counter re-grants nothing and re-emits nothing.
 *   - Wallets: reward entries call add(id, amount) per resource; unknown
 *     resource ids degrade safely (add returns 0 — no throw, no abort of the
 *     grant); a missing resourceSystem still reaches + emits, just grants no
 *     reward.
 *   - Catalog hygiene: malformed definitions (missing/unsafe id/name/stat/
 *     threshold/reward, stat outside the four counters, non-finite/non-
 *     positive threshold, non-plain-object reward) are skipped with one
 *     console.warn each; an empty/missing catalog does not crash.
 *   - No loop subscription: the system never subscribes to 'loop:update'
 *     (a tick emits nothing); destroy() unsubscribes 'statistics:changed'
 *     idempotently.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { MilestoneSystem } from '../../js/systems/milestones.js';

/** A fixed clock so reachedAt stamps are deterministic. */
const NOW = 1_700_000_000_000;

/**
 * Small, safe milestone fixture: a deterministic dataManager lookalike that
 * returns a frozen catalog snapshot on demand (mirrors the real
 * DataManager.getAll deep-frozen contract).
 *
 * @param {Array<object>} definitions — the catalog.
 * @returns {{ getAll(collection: string): Array<object> }} the fake dataManager.
 */
function createFakeDataManager(definitions) {
  const catalog = Object.freeze(definitions.map((entry) => _deepFreeze(entry)));
  return {
    getAll(collection) {
      if (collection !== 'milestones') return [];
      return catalog;
    },
  };
}

/**
 * Tiny wallet lookalike — records add() calls (the spy the grant tests
 * assert against). `unknownIds` makes add() return 0 for unknown resource
 * ids, mirroring ResourceSystem.add's degrade-safe contract.
 *
 * @param {boolean} [unknownIds=false] — true when unknown ids return 0.
 * @returns {{
 *   calls: Array<{id: string, amount: number}>,
 *   add(id: string, amount: number): number
 * }} the fake resource system.
 */
function createFakeResourceSystem({ unknownIds = false } = {}) {
  return {
    calls: [],
    add(id, amount) {
      this.calls.push({ id, amount });
      return unknownIds ? 0 : amount;
    },
  };
}

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a MilestoneSystem instance with injected doubles.
 *
 * @param {object} [options] — overrides ({ state, definitions,
 *        resourceSystem, now, dataManager }).
 * @returns {MilestoneSystem} the system instance.
 */
function makeSystem(options = {}) {
  const definitions = options.definitions !== undefined ? options.definitions : [];
  const dataManager =
    options.dataManager !== undefined ? options.dataManager : createFakeDataManager(definitions);
  return new MilestoneSystem({
    state: options.state || structuredClone(GameState),
    eventBus: EventBus,
    dataManager,
    resourceSystem: options.resourceSystem === undefined ? createFakeResourceSystem() : options.resourceSystem,
    now: options.now === undefined ? () => NOW : options.now,
  });
}

/** A 4-entry catalog covering three of the four counters. */
const CATALOG = [
  {
    id: 'first-qi',
    name: 'First Qi Gathered',
    description: 'Gather 100 total qi.',
    stat: 'qiGenerated',
    threshold: 100,
    reward: { spiritStones: 5 },
  },
  {
    id: 'qi-generation-1000',
    name: 'A Thousand Qi',
    description: 'Gather 1,000 total qi.',
    stat: 'qiGenerated',
    threshold: 1000,
    reward: { spiritStones: 10 },
  },
  {
    id: 'first-breakthrough',
    name: 'First Breakthrough',
    description: 'Complete your first breakthrough.',
    stat: 'breakthroughsTotal',
    threshold: 1,
    reward: { spiritStones: 25 },
  },
  {
    id: 'playtime-hour',
    name: 'An Hour of Cultivation',
    description: 'Cultivate for one hour.',
    stat: 'playtimeMs',
    threshold: 3600000,
    reward: { herbs: 3 },
  },
];

/** Emit a statistics:changed event with the given counter snapshot. */
function emitSnapshot(overrides = {}) {
  EventBus.emit('statistics:changed', {
    snapshot: {
      playtimeMs: 0,
      meditationsCompleted: 0,
      breakthroughsTotal: 0,
      qiGenerated: 0,
      ...overrides,
    },
  });
}

/** Collect milestone:reached payloads into an array. */
function collectReached() {
  const events = [];
  EventBus.subscribe('milestone:reached', (payload) => events.push(payload));
  return events;
}

test('constructor loads the catalog and list() annotates reached status', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state, definitions: CATALOG });

  assert.equal(system.list().length, 4);
  const first = system.list().find((entry) => entry.id === 'first-qi');
  assert.equal(first.name, 'First Qi Gathered');
  assert.equal(first.reached, false);
  // list() returns copies — mutating them never leaks into the catalog.
  first.name = 'mutated';
  assert.equal(system.list().find((entry) => entry.id === 'first-qi').name, 'First Qi Gathered');
  // The fresh state was NOT mutated by the constructor (no crossed counters).
  assert.deepEqual(state.milestones, { reached: {} });
});

test('restore-trust repairs a null milestones slice on construction', () => {
  const state = structuredClone(GameState);
  state.milestones = null; // attacker-shaped save

  makeSystem({ state, definitions: CATALOG });

  assert.deepEqual(state.milestones, { reached: {} });
});

test('restore-trust repairs a primitive milestones slice on construction', () => {
  const state = structuredClone(GameState);
  state.milestones = 5; // a primitive top-level slice

  makeSystem({ state, definitions: CATALOG });

  assert.deepEqual(state.milestones, { reached: {} });
});

test('restore-trust repairs an array milestones slice on construction', () => {
  const state = structuredClone(GameState);
  state.milestones = []; // an array — not a plain object

  makeSystem({ state, definitions: CATALOG });

  assert.deepEqual(state.milestones, { reached: {} });
});

test('restore-trust repairs a slice whose reached map is not an object', () => {
  const state = structuredClone(GameState);
  state.milestones = { reached: null };

  makeSystem({ state, definitions: CATALOG });

  assert.deepEqual(state.milestones, { reached: {} });
});

test('restore-trust on a read repairs a slice corrupted mid-session', () => {
  const state = structuredClone(GameState);
  const system = makeSystem({ state, definitions: CATALOG });

  // Corrupt the slice AFTER construction, then evaluate via a real
  // statistics:changed emission: the read repairs the slice first, so the
  // crossing grant still lands in a canonical fresh slice.
  state.milestones = null;
  emitSnapshot({ qiGenerated: 500 });

  assert.deepEqual(state.milestones.reached['first-qi'], NOW);
  assert.equal(system.reached()['first-qi'], NOW);
});

test('the constructor retroactive pass grants already-crossed counters exactly once', () => {
  const state = structuredClone(GameState);
  // A restored save whose lifetime counters already crossed thresholds:
  // 5000 qi past first-qi AND qi-generation-1000, 1 breakthrough past
  // first-breakthrough, 30 min playtime NOT past playtime-hour (36e5).
  state.statistics.qiGenerated = 5000;
  state.statistics.breakthroughsTotal = 1;
  state.statistics.playtimeMs = 1800000;

  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();
  makeSystem({ state, definitions: CATALOG, resourceSystem });

  // Exactly the three crossed milestones granted — once each.
  assert.deepEqual(state.milestones.reached, {
    'first-qi': NOW,
    'qi-generation-1000': NOW,
    'first-breakthrough': NOW,
  });
  assert.deepEqual(
    resourceSystem.calls.map((call) => call.id),
    ['spiritStones', 'spiritStones', 'spiritStones']
  );
  assert.deepEqual(
    resourceSystem.calls.map((call) => call.amount),
    [5, 10, 25]
  );
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.id), [
    'first-qi',
    'qi-generation-1000',
    'first-breakthrough',
  ]);

  // The very first statistics:changed must NOT double-grant (reached map
  // guards): higher counters now → zero new events, zero new add() calls.
  emitSnapshot({ qiGenerated: 99999, breakthroughsTotal: 9, playtimeMs: 1800000 });
  assert.equal(events.length, 3);
  assert.equal(resourceSystem.calls.length, 3);
});

test('a statistics:changed crossing a threshold grants, pays and emits the payload', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();
  const system = makeSystem({ state, definitions: CATALOG, resourceSystem });

  emitSnapshot({ qiGenerated: 150 });

  // Reached map stamped with the injected clock.
  assert.equal(state.milestones.reached['first-qi'], NOW);
  assert.equal(system.isReached('first-qi'), true);
  assert.equal(system.isReached('unknown-id'), false);
  // The wallet received the reward through add(id, amount).
  assert.deepEqual(resourceSystem.calls, [{ id: 'spiritStones', amount: 5 }]);
  // Exactly one event carrying the full payload.
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: 'first-qi',
    name: 'First Qi Gathered',
    stat: 'qiGenerated',
    threshold: 100,
    reward: { spiritStones: 5 },
    reachedAt: NOW,
  });
  // reached() returns a defensive copy — mutating it never leaks into state.
  system.reached()['first-qi'] = 999;
  assert.equal(state.milestones.reached['first-qi'], NOW);
});

test('reached-once: a higher counter never re-grants or re-emits', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();
  makeSystem({ state, definitions: CATALOG, resourceSystem });

  emitSnapshot({ qiGenerated: 150 });
  assert.equal(events.length, 1);
  assert.equal(resourceSystem.calls.length, 1);

  // Same milestone, higher counter: nothing happens. The second value stays
  // BELOW the next qi milestone (qi-generation-1000 at 1000) so the
  // "no re-grant" assertion is not confused by a legitimate crossing of a
  // DIFFERENT milestone (that behavior is covered by its own test below).
  emitSnapshot({ qiGenerated: 200 });
  assert.equal(state.milestones.reached['first-qi'], NOW);
  assert.equal(state.milestones.reached['qi-generation-1000'], undefined);
  assert.equal(events.length, 1);
  assert.equal(resourceSystem.calls.length, 1);
});

test('a later event crosses a DIFFERENT milestone while reached ones stay silent', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();
  makeSystem({ state, definitions: CATALOG, resourceSystem });

  emitSnapshot({ qiGenerated: 150 });
  emitSnapshot({ qiGenerated: 1500 }); // crosses qi-generation-1000 (1000)
  emitSnapshot({ playtimeMs: 7200000 }); // crosses playtime-hour (36e5)

  assert.deepEqual(state.milestones.reached, {
    'first-qi': NOW,
    'qi-generation-1000': NOW,
    'playtime-hour': NOW,
  });
  assert.equal(events.length, 3);
  assert.deepEqual(resourceSystem.calls, [
    { id: 'spiritStones', amount: 5 },
    { id: 'spiritStones', amount: 10 },
    { id: 'herbs', amount: 3 },
  ]);
});

test('a malformed statistics:changed payload falls back to the state snapshot', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();
  makeSystem({ state, definitions: CATALOG, resourceSystem });

  // No snapshot / a garbage snapshot: the handler must not throw, and the
  // state counters (still 0) cross nothing.
  EventBus.emit('statistics:changed');
  EventBus.emit('statistics:changed', { snapshot: 'garbage' });

  assert.equal(events.length, 0);
  assert.equal(resourceSystem.calls.length, 0);

  // A later healthy snapshot still grants normally.
  emitSnapshot({ qiGenerated: 150 });
  assert.equal(events.length, 1);
});

test('unknown resource ids in a reward degrade safely (add returns 0, no throw)', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem({ unknownIds: true });
  const definitions = [
    {
      id: 'mystery-reward',
      name: 'Mystery Reward',
      description: 'A reward referencing an undeclared resource.',
      stat: 'qiGenerated',
      threshold: 10,
      reward: { mysteryStones: 5, spiritStones: 2 },
    },
  ];

  assert.doesNotThrow(() => {
    makeSystem({ state, definitions, resourceSystem });
  });
  emitSnapshot({ qiGenerated: 50 });

  // Both entries were attempted through the wallet; the unknown id returned
  // 0 (degrade-safe) while the known id was granted — and the milestone is
  // still reached + emitted once.
  assert.deepEqual(resourceSystem.calls, [
    { id: 'mysteryStones', amount: 5 },
    { id: 'spiritStones', amount: 2 },
  ]);
  assert.equal(state.milestones.reached['mystery-reward'], NOW);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].reward, { mysteryStones: 5, spiritStones: 2 });
});

test('a missing resourceSystem still reaches and emits — it just grants no reward', () => {
  const state = structuredClone(GameState);
  const events = collectReached();

  makeSystem({ state, definitions: CATALOG, resourceSystem: null });
  emitSnapshot({ qiGenerated: 150 });

  assert.equal(state.milestones.reached['first-qi'], NOW);
  assert.equal(events.length, 1);
});

test('malformed definitions are skipped with one warning each', (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  const definitions = [
    // Valid — must survive.
    {
      id: 'valid-one',
      name: 'Valid One',
      stat: 'qiGenerated',
      threshold: 10,
      reward: { spiritStones: 1 },
    },
    null,
    'not-an-object',
    { id: '', name: 'No Id', stat: 'qiGenerated', threshold: 10, reward: {} },
    { id: 'no-name', stat: 'qiGenerated', threshold: 10, reward: {} },
    { id: 'no-stat', name: 'No Stat', threshold: 10, reward: {} },
    { id: 'bad-stat', name: 'Bad Stat', stat: 'notACounter', threshold: 10, reward: {} },
    { id: 'bad-threshold', name: 'Bad Threshold', stat: 'qiGenerated', threshold: -5, reward: {} },
    { id: 'bad-threshold-2', name: 'Bad Threshold 2', stat: 'qiGenerated', threshold: Infinity, reward: {} },
    { id: 'bad-reward', name: 'Bad Reward', stat: 'qiGenerated', threshold: 10, reward: [] },
    { id: 'missing-reward', name: 'Missing Reward', stat: 'qiGenerated', threshold: 10 },
    { id: '__proto__', name: 'Unsafe Id', stat: 'qiGenerated', threshold: 10, reward: {} },
  ];

  const system = makeSystem({ definitions });

  // Eleven malformed entries → eleven warnings (one per skip), exactly.
  assert.equal(warnMock.mock.callCount(), 11);
  // Only the valid definition survives into the catalog.
  assert.equal(system.list().length, 1);
  assert.equal(system.list()[0].id, 'valid-one');
});

test('an empty catalog does not crash and grants nothing', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();

  assert.doesNotThrow(() => {
    const system = makeSystem({ state, definitions: [], resourceSystem });
    assert.equal(system.list().length, 0);
    emitSnapshot({ qiGenerated: 999999 });
    assert.equal(events.length, 0);
    assert.equal(resourceSystem.calls.length, 0);
    assert.deepEqual(state.milestones, { reached: {} });
  });
});

test('a missing dataManager does not crash and grants nothing', () => {
  const state = structuredClone(GameState);
  const events = collectReached();

  assert.doesNotThrow(() => {
    const system = new MilestoneSystem({
      state,
      eventBus: EventBus,
      dataManager: null,
      resourceSystem: createFakeResourceSystem(),
    });
    assert.equal(system.list().length, 0);
    emitSnapshot({ qiGenerated: 999999 });
    assert.equal(events.length, 0);
  });
});

test('the system never subscribes to loop:update — a tick emits nothing', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();

  makeSystem({ state, definitions: CATALOG, resourceSystem });

  // The only subscription is statistics:changed.
  assert.equal(EventBus.hasListeners('loop:update'), false);
  assert.equal(EventBus.hasListeners('statistics:changed'), true);

  // A loop:update tick — even one carrying a counter-like payload — must
  // never trigger a milestone grant.
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 2000, tick: 2 });

  assert.equal(events.length, 0);
  assert.equal(resourceSystem.calls.length, 0);
  assert.deepEqual(state.milestones.reached, {});
});

test('destroy() unsubscribes statistics:changed — later events grant nothing', () => {
  const state = structuredClone(GameState);
  const events = collectReached();
  const resourceSystem = createFakeResourceSystem();

  const system = makeSystem({ state, definitions: CATALOG, resourceSystem });
  system.destroy();

  assert.equal(EventBus.hasListeners('statistics:changed'), false);
  emitSnapshot({ qiGenerated: 5000 });

  assert.equal(events.length, 0);
  assert.equal(resourceSystem.calls.length, 0);
  assert.deepEqual(state.milestones.reached, {});
});

test('destroy() is idempotent — a second call does not throw', () => {
  const system = makeSystem({ definitions: CATALOG });

  system.destroy();
  assert.doesNotThrow(() => system.destroy());
});

/**
 * Recursively freeze a value (the fake dataManager mirrors the real
 * DataManager's deep-frozen catalog contract).
 *
 * @param {*} value — value to deep-freeze.
 * @returns {*} the frozen value.
 */
function _deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      _deepFreeze(value[key]);
    }
  }
  return value;
}