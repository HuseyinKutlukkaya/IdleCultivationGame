/**
 * tests/unit/qi.test.mjs — unit tests for js/systems/qi.js.
 *
 * Exercises the QiSystem (single owner of the qi resource): the config-driven
 * cap and sources (missing block silent, invalid baseMaxQi warns once and
 * leaves the cap untouched, malformed source entries skipped with warnings),
 * the constructor's immediate sync of qiMax and qiPerSecond, the
 * 'loop:update' tick aggregation (sum of source rates, gain = sum ×
 * deltaMs/1000, cap clamping, 'qi:gained' payload { amount, total, sources },
 * statistics.qiGenerated, zero-gain silence), safe ratePath resolution
 * (missing slices and prototype-chain paths never throw or pollute), the
 * write-only-when-changed qiPerSecond sync, restore compatibility, restore-
 * trust slice repair (malformed cultivation/statistics slices never abort
 * boot or the tick and gains flow normally after repair), the finite-write
 * guard (a restored value at the double limit never puts Infinity into
 * state), the cap-shrink clamp (a smaller cap brings the pool down with it)
 * and destroy() unsubscription.
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine) and the shared EventBus (cleared in beforeEach so event
 * assertions start clean). No clock is needed — QiSystem derives everything
 * from the 'loop:update' payload.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { QiSystem } from '../../js/systems/qi.js';

const TICK_MS = 1000;

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a standard config with a qi block (mirrors the real
 * data/game-config.json block) plus optional overrides.
 *
 * @param {object} [overrides] — key/values merged over the qi block.
 * @returns {object} a config object.
 */
function makeConfig(overrides = {}) {
  return {
    qi: {
      baseMaxQi: 100,
      sources: [
        { id: 'meditation', label: 'Meditation', ratePath: 'cultivation.qiSources.meditation' },
      ],
      ...overrides,
    },
  };
}

/**
 * Build a QiSystem instance with a fresh state clone (unless overridden).
 *
 * @param {object} [config] — config to inject (defaults to makeConfig()).
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @returns {QiSystem} the system instance.
 */
function makeSystem(config = makeConfig(), state = structuredClone(GameState)) {
  return new QiSystem({ config, state, eventBus: EventBus });
}

test('a missing config.qi block is silent and leaves everything untouched', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem({}, state);

  // No warning for the missing block; the cap stays at the state value and
  // there are no sources (aggregate rate 0).
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(system.baseMaxQi, null);
  assert.deepEqual(system.sources, []);
  assert.equal(state.cultivation.qiMax, 100);
  assert.equal(state.cultivation.qiPerSecond, 0);

  // A tick produces nothing and never crashes.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 0);
});

test('an invalid baseMaxQi warns once and leaves qiMax untouched', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem(makeConfig({ baseMaxQi: -5 }), state);

  assert.equal(warn.mock.callCount(), 1);
  assert.equal(system.baseMaxQi, null);
  // Unmanaged cap: the state value governs and is not overwritten.
  assert.equal(state.cultivation.qiMax, 100);
});

test('the constructor syncs qiMax from baseMaxQi', () => {
  // Fresh state placeholder 100 with a config 100 → stays 100.
  const same = structuredClone(GameState);
  makeSystem(makeConfig(), same);
  assert.equal(same.cultivation.qiMax, 100);

  // Config 250 → the derived cap overwrites the placeholder 100.
  const raised = structuredClone(GameState);
  makeSystem(makeConfig({ baseMaxQi: 250 }), raised);
  assert.equal(raised.cultivation.qiMax, 250);
});

test('the constructor syncs qiPerSecond from the current source rates', () => {
  // A restored state whose meditation slot is already 2 (active session)
  // shows the aggregate rate before the first tick.
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 2);
});

test('a tick aggregates multiple configured sources into rate, gain and event', () => {
  const config = makeConfig({
    sources: [
      { id: 'a', ratePath: 'cultivation.qiSources.a' },
      { id: 'b', label: 'B', ratePath: 'cultivation.qiSources.b' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiSources.a = 2;
  state.cultivation.qiSources.b = 3;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(config, state);

  // The kept source 'a' has no label — it falls back to its id.
  assert.equal(state.cultivation.qiPerSecond, 5);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qiPerSecond, 5);
  assert.equal(state.cultivation.qi, 5);
  assert.equal(state.statistics.qiGenerated, 5);
  assert.equal(gained.length, 1);
  assert.deepEqual(gained[0], { amount: 5, total: 5, sources: ['a', 'b'] });
});

test('the tick gain uses the payload deltaMs (no hardcoded 1000ms)', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  // Half a tick at 2 qi/s → 1 qi.
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 500, tick: 1 });

  assert.equal(state.cultivation.qi, 1);
  assert.equal(state.statistics.qiGenerated, 1);
});

test('qi never exceeds qiMax and zero-gain ticks emit nothing', () => {
  const state = structuredClone(GameState);
  state.cultivation.qi = 99; // qiMax defaults to 100
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(makeConfig(), state);

  // Raw gain 2, but only 1 fits below the cap.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 100);
  assert.equal(state.statistics.qiGenerated, 1);
  assert.equal(gained.length, 1);
  assert.deepEqual(gained[0], { amount: 1, total: 100, sources: ['meditation'] });

  // At the cap: no gain, no event (avoid zero-gain noise).
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.equal(state.cultivation.qi, 100);
  assert.equal(state.statistics.qiGenerated, 1);
  assert.equal(gained.length, 1);
});

test('a tick emits qi:gained with the exact payload shape', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(makeConfig(), state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(gained.length, 1);
  // Payload shape: { amount, total, sources } — the id of every source that
  // contributed a positive rate this tick.
  assert.deepEqual(gained[0], { amount: 2, total: 2, sources: ['meditation'] });
});

test('statistics.qiGenerated accrues across ticks', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });

  assert.equal(state.statistics.qiGenerated, 4);
});

test('zero-rate sources yield a zero aggregate rate, no gain and no event', () => {
  const state = structuredClone(GameState); // meditation slot defaults to 0
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 0);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.statistics.qiGenerated, 0);
  assert.equal(gained.length, 0);
});

test('a source ratePath resolving to undefined (missing slice) contributes 0', () => {
  const config = makeConfig({
    sources: [
      { id: 'ghost', ratePath: 'cultivation.ghost.missing' },
      { id: 'meditation', ratePath: 'cultivation.qiSources.meditation' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(config, state);

  // Only the meditation source contributes; the ghost path yields 0.
  assert.equal(state.cultivation.qiPerSecond, 2);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 2);
  assert.deepEqual(gained[0].sources, ['meditation']);
});

test('unsafe source ratePaths can never reach the prototype chain', () => {
  for (const ratePath of ['__proto__.x', 'constructor.prototype.x']) {
    EventBus.clear();
    const config = makeConfig({
      sources: [{ id: 'polluter', ratePath }],
    });
    const state = structuredClone(GameState);

    const system = makeSystem(config, state); // construction never throws

    assert.equal(state.cultivation.qiPerSecond, 0);
    EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
    assert.equal(state.cultivation.qi, 0);
    // Object.prototype is untouched, whatever the path looked like.
    assert.equal({}.x, undefined);
    assert.equal({}.hasOwnProperty('x'), false);
    assert.equal(system.sources[0].ratePath, ratePath);
  }
});

test('malformed source entries are skipped with warnings, valid ones are kept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const config = makeConfig({
    sources: [
      null,
      { id: 'broken' }, // missing ratePath
      { id: '', ratePath: 'cultivation.qiSources.meditation' }, // empty id
      { id: 'meditation', ratePath: 'cultivation.qiSources.meditation' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  const system = makeSystem(config, state);

  // null + broken + empty are skipped (three warnings), meditation is kept.
  assert.equal(warn.mock.callCount(), 3);
  assert.equal(system.sources.length, 1);
  assert.equal(system.sources[0].id, 'meditation');
  // The kept source's label falls back to its id when absent.
  assert.equal(system.sources[0].label, 'meditation');
  // The kept source still feeds the aggregate rate.
  assert.equal(state.cultivation.qiPerSecond, 2);
});

test('a non-array sources value warns once and yields no sources', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const system = makeSystem(makeConfig({ sources: 'meditation' }));

  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(system.sources, []);
});

test('qiPerSecond is only written when the aggregate rate changes', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);
  assert.equal(state.cultivation.qiPerSecond, 2);

  // Instrument the field to count subsequent writes.
  const writes = [];
  Object.defineProperty(state.cultivation, 'qiPerSecond', {
    configurable: true,
    get: () => 2,
    set: (value) => {
      writes.push(value);
    },
  });

  // A steady tick at the same aggregate rate must not write the field.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.deepEqual(writes, []);

  // A changed aggregate rate (the meditation slot moves to 3) writes once.
  state.cultivation.qiSources.meditation = 3;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.deepEqual(writes, [3]);
});

test('destroy() unsubscribes — ticks no longer mutate state', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  const system = makeSystem(makeConfig(), state);
  system.destroy();

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.statistics.qiGenerated, 0);
  assert.equal(gained.length, 0);
});

test('restore compatibility: a restored state with qi above 0 keeps producing on top', () => {
  // e.g. a restored save where qi was already partially filled.
  const state = structuredClone(GameState);
  state.cultivation.qi = 50;
  state.cultivation.qiMax = 100;
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 52);
  assert.equal(state.statistics.qiGenerated, 2);
});

test('a restored cultivation slice that is null is repaired and never aborts boot', () => {
  // An attacker-shaped save with cultivation: null must neither throw in the
  // constructor (the cap/rate sync writes through the slice) nor per-tick.
  const state = structuredClone(GameState);
  state.cultivation = null;

  const system = makeSystem(makeConfig(), state); // must not throw

  // Repaired to the canonical fresh cultivation slice (see core/game-state.js).
  assert.deepEqual(state.cultivation, {
    realm: 'Mortal',
    realmStage: 1,
    nextRealm: 'Qi Condensation',
    breakthroughCost: null,
    realmProgress: 0,
    realmProgressMax: 1000,
    qi: 0,
    qiMax: 100,
    qiPerSecond: 0,
    qiSources: { meditation: 0 },
    breakthroughs: 0,
  });

  // Gains flow normally after repair.
  state.cultivation.qiSources.meditation = 2;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 2);
  assert.equal(state.statistics.qiGenerated, 2);
});

test('restored primitive cultivation and null statistics slices are repaired', () => {
  const state = structuredClone(GameState);
  state.cultivation = 5; // a primitive top-level slice
  state.statistics = null;

  const system = makeSystem(makeConfig(), state); // must not throw

  // The cultivation slice is repaired on construction (the cap/rate sync
  // writes through it); the statistics slice is repaired on the first tick.
  assert.equal(typeof state.cultivation, 'object');
  assert.equal(Array.isArray(state.cultivation), false);
  assert.deepEqual(state.cultivation.qiSources, { meditation: 0 });
  assert.equal(state.statistics, null);

  // Gains flow normally after repair — the tick repairs statistics too.
  state.cultivation.qiSources.meditation = 3;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 3);
  assert.deepEqual(state.statistics, {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 3,
  });
});

test('the finite-write guard: a restored value at the double limit never overflows', () => {
  // Unmanaged cap (no baseMaxQi) so the room below the cap stays huge; the
  // huge finite rate yields a large gain that, added to a restored statistic
  // at Number.MAX_VALUE, would overflow to Infinity — the whole gain must be
  // skipped (no qi write, no statistics write, no event).
  const config = makeConfig({ baseMaxQi: undefined });
  const state = structuredClone(GameState);
  state.cultivation.qiMax = Number.MAX_VALUE;
  state.cultivation.qi = 1e308; // restored near the double limit
  state.cultivation.qiSources.meditation = 1e308; // huge but finite rate
  state.statistics.qiGenerated = Number.MAX_VALUE; // attacker-shaped value
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(config, state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 1e308);
  assert.equal(state.statistics.qiGenerated, Number.MAX_VALUE);
  assert.equal(gained.length, 0);
  // The rate field the system did sync stays finite too.
  assert.equal(Number.isFinite(state.cultivation.qiPerSecond), true);
});

test('the qi pool is clamped down when the derived cap shrinks', () => {
  const state = structuredClone(GameState);
  state.cultivation.qi = 80; // restored above the configured cap below
  state.cultivation.qiMax = 100;
  state.cultivation.qiSources.meditation = 2;

  // baseMaxQi 50 < restored qi 80 → the cap shrinks and the pool follows.
  makeSystem(makeConfig({ baseMaxQi: 50 }), state);

  assert.equal(state.cultivation.qiMax, 50);
  assert.equal(state.cultivation.qi, 50);

  // A growing cap never touches qi.
  const grown = structuredClone(GameState);
  grown.cultivation.qi = 50;
  grown.cultivation.qiMax = 100;
  makeSystem(makeConfig({ baseMaxQi: 250 }), grown);
  assert.equal(grown.cultivation.qiMax, 250);
  assert.equal(grown.cultivation.qi, 50);
});

test('getters expose the configured cap and defensive source copies', () => {
  const system = makeSystem();

  assert.equal(system.baseMaxQi, 100);
  assert.equal(system.sources[0].label, 'Meditation');

  // Shallow copies: mutating a returned source must not leak back.
  const copy = system.sources[0];
  copy.id = 'hacked';
  assert.equal(system.sources[0].id, 'meditation');
  assert.equal(system.baseMaxQi, 100);
});
