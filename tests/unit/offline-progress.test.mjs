/**
 * tests/unit/offline-progress.test.mjs — unit tests for js/core/offline-progress.js.
 *
 * Exercises the offline-progress simulation: the stored last-seen timestamp
 * (stamp()), the elapsed-time calculation, the time cap (maxOfflineMs), the
 * per-producer resource caps (capPath), the production math, the config and
 * player-setting gates, the 'offline:progress' event and the producer
 * validation warnings.
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine) and an injected `now` clock for deterministic wall-clock
 * math; apply()'s `now` option overrides the clock per call. The shared
 * EventBus is cleared in beforeEach so event assertions start clean.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { OfflineProgress } from '../../js/core/offline-progress.js';

const HOUR_MS = 3600000;
/** Fixed wall-clock reference so every test's math is deterministic. */
const NOW = 1_700_000_000_000;

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a standard config with a single qi producer (mirrors the real
 * data/game-config.json block) plus optional overrides.
 *
 * @param {object} [overrides] — key/values merged over the offline block.
 * @returns {object} a config object.
 */
function makeConfig(overrides = {}) {
  return {
    offline: {
      enabled: true,
      maxOfflineMs: 8 * HOUR_MS,
      producers: [
        {
          id: 'qi',
          label: 'Qi',
          path: 'cultivation.qi',
          ratePath: 'cultivation.qiPerSecond',
          capPath: 'cultivation.qiMax',
        },
      ],
      ...overrides,
    },
  };
}

/**
 * Build an OfflineProgress instance with a fresh state clone and the fixed
 * clock (unless overridden).
 *
 * @param {object} [config] — config to inject (defaults to makeConfig()).
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @param {() => number} [now] — clock (defaults to the fixed NOW).
 * @returns {OfflineProgress} the system instance.
 */
function makeSystem(config = makeConfig(), state = structuredClone(GameState), now = () => NOW) {
  return new OfflineProgress({ config, state, now, eventBus: EventBus });
}

test('a missing offline config block disables offline progress silently', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const system = makeSystem({});
  const summary = system.apply({ lastActiveAt: NOW - HOUR_MS, now: NOW });

  assert.equal(system.isEnabled, false);
  assert.equal(summary.applied, false);
  assert.equal(summary.enabled, false);
  // A config without the block is the default case, not an error.
  assert.equal(warn.mock.callCount(), 0);
});

test('a fresh game (no previous session) yields no offline progress', () => {
  const system = makeSystem();

  const summary = system.apply({ lastActiveAt: 0, now: NOW });

  assert.equal(summary.applied, false);
  assert.equal(summary.enabled, true);
  assert.equal(summary.elapsedMs, 0);
  assert.deepEqual(summary.producers, []);
});

test('apply reads the default reference point from state.meta.lastSeenAt', () => {
  const state = structuredClone(GameState);
  state.meta.lastSeenAt = NOW - 2 * HOUR_MS;
  state.cultivation.qiPerSecond = 2;
  state.cultivation.qiMax = 100000;

  const system = makeSystem(makeConfig(), state);
  const summary = system.apply({ now: NOW });

  assert.equal(summary.elapsedMs, 2 * HOUR_MS);
  assert.equal(summary.producers[0].amount, 2 * 7200);
  assert.equal(state.cultivation.qi, 2 * 7200);
});

test('elapsed time drives production (amount = floor(rate × seconds))', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 2;
  state.cultivation.qiMax = 100000;

  const summary = makeSystem(makeConfig(), state).apply({
    lastActiveAt: NOW - 2 * HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.applied, true);
  assert.equal(summary.enabled, true);
  assert.equal(summary.elapsedMs, 2 * HOUR_MS);
  assert.equal(summary.timeCapped, false);
  assert.equal(summary.effectiveMs, 2 * HOUR_MS);
  assert.deepEqual(summary.producers, [
    {
      id: 'qi',
      label: 'Qi',
      amount: 2 * 7200,
      rate: 2,
      cap: 100000,
      capped: false,
    },
  ]);
  assert.equal(state.cultivation.qi, 2 * 7200);
});

test('elapsed time is capped at maxOfflineMs and flagged as timeCapped', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1;
  state.cultivation.qiMax = 100000;

  const system = makeSystem(makeConfig({ maxOfflineMs: HOUR_MS }), state);
  const summary = system.apply({ lastActiveAt: NOW - 3 * HOUR_MS, now: NOW });

  assert.equal(summary.applied, true);
  assert.equal(summary.elapsedMs, 3 * HOUR_MS);
  assert.equal(summary.timeCapped, true);
  assert.equal(summary.effectiveMs, HOUR_MS);
  // Only one hour was simulated, not three.
  assert.equal(summary.producers[0].amount, 3600);
  assert.equal(state.cultivation.qi, 3600);
});

test('the per-producer resource cap clamps gains to the room below the cap', () => {
  const state = structuredClone(GameState);
  state.cultivation.qi = 90;
  state.cultivation.qiMax = 100;
  state.cultivation.qiPerSecond = 1;

  const summary = makeSystem(makeConfig(), state).apply({
    lastActiveAt: NOW - 2 * HOUR_MS,
    now: NOW,
  });

  // Raw production would be 7,200 but only 10 fit below the cap.
  assert.equal(summary.producers[0].amount, 10);
  assert.equal(summary.producers[0].capped, true);
  assert.equal(state.cultivation.qi, 100);
});

test('a resource without a capPath is unbounded while away', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1;

  const config = makeConfig({
    producers: [
      {
        id: 'qi',
        path: 'cultivation.qi',
        ratePath: 'cultivation.qiPerSecond',
      },
    ],
  });
  const summary = makeSystem(config, state).apply({
    lastActiveAt: NOW - 2 * HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.producers[0].cap, null);
  assert.equal(summary.producers[0].amount, 7200);
  assert.equal(summary.producers[0].capped, false);
  assert.equal(state.cultivation.qi, 7200);
});

test('a zero rate yields zero gains and leaves the state untouched', () => {
  const state = structuredClone(GameState); // qiPerSecond defaults to 0

  const summary = makeSystem(makeConfig(), state).apply({
    lastActiveAt: NOW - HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.applied, true);
  assert.deepEqual(summary.producers[0], {
    id: 'qi',
    label: 'Qi',
    amount: 0,
    rate: 0,
    cap: 100,
    capped: false,
  });
  assert.equal(state.cultivation.qi, 0);
});

test('the player setting (settings.offlineProgress) gates offline progress', () => {
  const state = structuredClone(GameState);
  state.settings.offlineProgress = false;

  const summary = makeSystem(makeConfig(), state).apply({
    lastActiveAt: NOW - HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.applied, false);
  assert.equal(summary.enabled, false);
  // The raw gap is still reported for the consumer's information.
  assert.equal(summary.elapsedMs, HOUR_MS);
  assert.deepEqual(summary.producers, []);
});

test('the config master switch (offline.enabled) gates offline progress', () => {
  const summary = makeSystem(makeConfig({ enabled: false })).apply({
    lastActiveAt: NOW - HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.applied, false);
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.producers, []);
});

test('apply emits offline:progress with the summary exactly when applied', () => {
  const emitted = [];
  EventBus.subscribe('offline:progress', (payload) => emitted.push(payload));

  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1;
  const system = makeSystem(makeConfig(), state);

  const summary = system.apply({ lastActiveAt: NOW - HOUR_MS, now: NOW });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], summary); // same object as the return value

  // A fresh game (no gap) must not emit.
  system.apply({ lastActiveAt: 0, now: NOW });
  assert.equal(emitted.length, 1);

  // A disabled session must not emit either.
  const disabled = makeSystem(makeConfig({ enabled: false }));
  disabled.apply({ lastActiveAt: NOW - HOUR_MS, now: NOW });
  assert.equal(emitted.length, 1);
});

test('stamp() records the injected clock as the last-seen timestamp', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(makeConfig(), state, () => NOW);

  system.stamp();

  assert.equal(state.meta.lastSeenAt, NOW);
});

test('stamp() survives a state whose meta slice is missing (old saves)', () => {
  const state = structuredClone(GameState);
  delete state.meta;

  const system = makeSystem(makeConfig(), state, () => NOW);
  system.stamp();

  assert.equal(state.meta.lastSeenAt, NOW);
});

test('apply()\'s now option overrides the injected clock', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(makeConfig(), state, () => 0);

  const summary = system.apply({ lastActiveAt: 1000, now: 2500 });

  assert.equal(summary.elapsedMs, 1500);
});

test('a backwards-moving clock yields zero elapsed time', () => {
  const summary = makeSystem().apply({ lastActiveAt: NOW + 1000, now: NOW });

  assert.equal(summary.applied, false);
  assert.equal(summary.elapsedMs, 0);
});

test('invalid producer entries are skipped with warnings, valid ones are kept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const config = makeConfig({
    producers: [
      null,
      { id: 'broken' }, // missing path and ratePath
      { id: 'empty', path: '', ratePath: 'cultivation.qiPerSecond' },
      { id: 'qi', path: 'cultivation.qi', ratePath: 'cultivation.qiPerSecond' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1;

  const system = makeSystem(config, state);
  const summary = system.apply({ lastActiveAt: NOW - HOUR_MS, now: NOW });

  // null + broken + empty are skipped (three warnings), qi is kept.
  assert.equal(warn.mock.callCount(), 3);
  assert.equal(system.producers.length, 1);
  assert.equal(system.producers[0].id, 'qi');
  // The kept producer's label falls back to its id.
  assert.equal(system.producers[0].label, 'qi');
  assert.equal(summary.producers.length, 1);
  assert.equal(summary.producers[0].amount, 3600);
});

test('missing or non-numeric rate paths are treated as zero without throwing', () => {
  const config = makeConfig({
    producers: [
      {
        id: 'ghost',
        path: 'resources.ghost',
        ratePath: 'cultivation.doesNotExist',
      },
    ],
  });

  const summary = makeSystem(config).apply({ lastActiveAt: NOW - HOUR_MS, now: NOW });

  assert.equal(summary.applied, true);
  assert.deepEqual(summary.producers[0], {
    id: 'ghost',
    label: 'ghost',
    amount: 0,
    rate: 0,
    cap: null,
    capped: false,
  });
});

test('a producer path crossing an existing non-object aborts instead of clobbering', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  // "cultivation.qi" is a number — a producer path through it must not
  // replace qi with an object; the gain is skipped with a warning.
  const config = makeConfig({
    producers: [
      {
        id: 'broken',
        path: 'cultivation.qi.foo',
        ratePath: 'cultivation.qiPerSecond',
      },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1;

  const summary = makeSystem(config, state).apply({
    lastActiveAt: NOW - HOUR_MS,
    now: NOW,
  });

  assert.equal(warn.mock.callCount(), 1);
  assert.equal(summary.producers[0].amount, 0);
  assert.equal(state.cultivation.qi, 0); // untouched, still a number
});

test('producer paths can never reach the prototype chain (defense in depth)', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const config = makeConfig({
    producers: [
      {
        id: 'polluter',
        path: '__proto__.polluted',
        ratePath: 'cultivation.qiPerSecond',
      },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1;

  const summary = makeSystem(config, state).apply({
    lastActiveAt: NOW - HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.producers[0].amount, 0);
  assert.equal({}.polluted, undefined); // Object.prototype is untouched
  assert.ok(warn.mock.callCount() >= 1);
});

test('an overflowing rate (uncapped producer) yields zero gains, never Infinity', () => {
  const config = makeConfig({
    producers: [
      {
        id: 'huge',
        path: 'resources.spiritStones',
        ratePath: 'cultivation.qiPerSecond', // no capPath — unbounded
      },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiPerSecond = 1e308; // rate × seconds overflows

  const summary = makeSystem(config, state).apply({
    lastActiveAt: NOW - 2 * HOUR_MS,
    now: NOW,
  });

  assert.equal(summary.producers[0].amount, 0);
  assert.equal(state.resources.spiritStones, 0); // never Infinity
  assert.equal(Number.isFinite(state.resources.spiritStones), true);
});

test('an invalid producers value (not an array) warns once and yields no producers', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const system = makeSystem(makeConfig({ producers: 'qi' }));

  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(system.producers, []);
});

test('invalid tuning values warn once and fall back to safe defaults', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const system = makeSystem(makeConfig({ enabled: 'yes', maxOfflineMs: -5 }));

  assert.equal(system.isEnabled, false);
  assert.equal(system.maxOfflineMs, 0);
  assert.equal(warn.mock.callCount(), 2);
});

test('producers getter returns defensive shallow copies', () => {
  const system = makeSystem();

  const copy = system.producers[0];
  copy.id = 'hacked';

  assert.equal(system.producers[0].id, 'qi');
});
