/**
 * tests/unit/meditation.test.mjs — unit tests for js/systems/meditation.js.
 *
 * Exercises the MeditationSystem: the config-driven base rate (missing block
 * silent, invalid value warns and falls back to 0), the constructor's
 * per-second rate sync from the (possibly restored) active flag, the
 * start/stop/toggle session API (idempotency, clock-driven durations, events),
 * the 'loop:update' tick production (rate × deltaMs, qi cap, statistics,
 * 'qi:gained' events, zero-gain silence), restore compatibility (an inactive
 * restored state does not produce until start(); an active one produces
 * immediately) and destroy() unsubscription.
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine), an injected `now` clock for deterministic session
 * durations and the shared EventBus (cleared in beforeEach so event
 * assertions start clean).
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { MeditationSystem } from '../../js/systems/meditation.js';

const TICK_MS = 1000;
/** Fixed wall-clock reference so every test's math is deterministic. */
const NOW = 1_700_000_000_000;

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a standard config with a meditation block (mirrors the real
 * data/game-config.json block) plus optional overrides.
 *
 * @param {object} [overrides] — key/values merged over the meditation block.
 * @returns {object} a config object.
 */
function makeConfig(overrides = {}) {
  return {
    meditation: {
      baseQiPerSecond: 2,
      ...overrides,
    },
  };
}

/**
 * Build a MeditationSystem instance with a fresh state clone and the fixed
 * clock (unless overridden).
 *
 * @param {object} [config] — config to inject (defaults to makeConfig()).
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @param {() => number} [now] — clock (defaults to the fixed NOW).
 * @returns {MeditationSystem} the system instance.
 */
function makeSystem(config = makeConfig(), state = structuredClone(GameState), now = () => NOW) {
  return new MeditationSystem({ config, state, eventBus: EventBus, now });
}

test('a missing meditation config block is silent and yields a zero rate', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState); // fresh state: active by default

  const system = makeSystem({}, state);

  // No warning for the missing block, and the zero base rate shows in the
  // constructor sync (fresh active state → qiPerSecond stays 0).
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(state.cultivation.qiPerSecond, 0);

  // The system still works: ticks produce nothing and never crash.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 0);
  assert.equal(system.isActive, true);
});

test('an invalid baseQiPerSecond warns once and falls back to 0', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem(makeConfig({ baseQiPerSecond: -5 }), state);

  assert.equal(warn.mock.callCount(), 1);
  // Fresh active state synced against the fallback rate: 0.
  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(system.isActive, true);

  // A tick at the fallback rate produces nothing.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 0);
});

test('a fresh active state syncs cultivation.qiPerSecond to the configured rate', () => {
  const state = structuredClone(GameState); // meditation.active === true

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 2);
});

test('an inactive state syncs cultivation.qiPerSecond to 0 on construction', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 0);
});

test('start() activates, records startedAt, syncs the rate and emits meditation:started', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  const started = [];
  EventBus.subscribe('meditation:started', (payload) => started.push(payload));
  const system = makeSystem(makeConfig(), state, () => NOW);

  assert.equal(system.start(), true);
  assert.equal(system.isActive, true);
  assert.equal(state.meditation.active, true);
  assert.equal(state.meditation.startedAt, NOW);
  assert.equal(state.cultivation.qiPerSecond, 2);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], { startedAt: NOW, mode: 'basic' });

  // Idempotent: a second start is a no-op and emits nothing.
  assert.equal(system.start(), false);
  assert.equal(started.length, 1);
});

test('stop() deactivates, counts the meditation and emits meditation:stopped', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  const stopped = [];
  EventBus.subscribe('meditation:stopped', (payload) => stopped.push(payload));
  let clock = NOW;
  const system = makeSystem(makeConfig(), state, () => clock);

  system.start(); // startedAt = NOW
  clock = NOW + 5000;

  assert.equal(system.stop(), true);
  assert.equal(system.isActive, false);
  assert.equal(state.meditation.active, false);
  assert.equal(state.meditation.startedAt, 0);
  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(state.statistics.meditationsCompleted, 1);
  assert.equal(stopped.length, 1);
  assert.deepEqual(stopped[0], {
    durationMs: 5000,
    qiGained: 0,
    meditationsCompleted: 1,
  });

  // Idempotent: a second stop is a no-op and emits nothing.
  assert.equal(system.stop(), false);
  assert.equal(stopped.length, 1);
});

test('toggle() flips the active state', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  const system = makeSystem(makeConfig(), state, () => NOW);

  assert.equal(system.toggle(), true);
  assert.equal(system.isActive, true);

  assert.equal(system.toggle(), true);
  assert.equal(system.isActive, false);

  assert.equal(system.toggle(), true);
  assert.equal(system.isActive, true);
});

test('a tick while active gains qi at rate × deltaMs/1000 and emits qi:gained', () => {
  const state = structuredClone(GameState); // active: true, qi: 0, qiMax: 100
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  makeSystem(makeConfig(), state, () => NOW);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 2);
  assert.equal(state.cultivation.qiPerSecond, 2);
  assert.equal(state.statistics.qiGenerated, 2);
  assert.equal(gained.length, 1);
  assert.deepEqual(gained[0], { amount: 2, source: 'meditation', total: 2 });
});

test('the tick gain uses the payload deltaMs (no hardcoded 1000ms)', () => {
  const state = structuredClone(GameState);
  makeSystem(makeConfig(), state, () => NOW);

  // Half a tick at 2 qi/s → 1 qi.
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 500, tick: 1 });

  assert.equal(state.cultivation.qi, 1);
  assert.equal(state.statistics.qiGenerated, 1);
});

test('a tick while inactive changes nothing and emits no qi:gained', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  state.cultivation.qi = 10;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  makeSystem(makeConfig(), state, () => NOW);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 10);
  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(state.statistics.qiGenerated, 0);
  assert.equal(gained.length, 0);
});

test('qi never exceeds qiMax and zero-gain ticks emit nothing', () => {
  const state = structuredClone(GameState);
  state.cultivation.qi = 99; // qiMax defaults to 100
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  makeSystem(makeConfig(), state, () => NOW);

  // Raw gain 2, but only 1 fits below the cap.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 100);
  assert.equal(state.statistics.qiGenerated, 1);
  assert.equal(gained.length, 1);
  assert.deepEqual(gained[0], { amount: 1, source: 'meditation', total: 100 });

  // At the cap: no gain, no event (avoid zero-gain noise).
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.equal(state.cultivation.qi, 100);
  assert.equal(state.statistics.qiGenerated, 1);
  assert.equal(gained.length, 1);
});

test('restored inactive state does not produce until start()', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false; // e.g. a save where the player stopped
  const system = makeSystem(makeConfig(), state, () => NOW);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 0);

  assert.equal(system.start(), true);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.equal(state.cultivation.qi, 2);
});

test('restored active state produces without an explicit start()', () => {
  const state = structuredClone(GameState); // active: true by default
  makeSystem(makeConfig(), state, () => NOW);

  // The constructor synced the rate straight from the restored active flag.
  assert.equal(state.cultivation.qiPerSecond, 2);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 2);
});

test('stop() reports the session qi gained over its ticks', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  let clock = NOW;
  const system = makeSystem(makeConfig(), state, () => clock);
  const stopped = [];
  EventBus.subscribe('meditation:stopped', (payload) => stopped.push(payload));

  system.start(); // startedAt = NOW
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  clock = NOW + 10 * TICK_MS;
  system.stop();

  assert.equal(state.statistics.qiGenerated, 4);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].durationMs, 10 * TICK_MS);
  assert.equal(stopped[0].qiGained, 4);
  assert.equal(stopped[0].meditationsCompleted, 1);
});

test('stop() on the fresh-default session reports zero duration, not now - 0', () => {
  // Fresh GameState default: active: true, startedAt: 0 (no real session
  // start was recorded). This is exactly the path reachable via
  // window.__meditation.toggle() on a brand-new game.
  const state = structuredClone(GameState);
  const stopped = [];
  EventBus.subscribe('meditation:stopped', (payload) => stopped.push(payload));
  const system = makeSystem(makeConfig(), state, () => NOW);

  assert.equal(system.stop(), true);
  assert.equal(stopped.length, 1);
  // startedAt === 0 must yield 0, never the ~1.7e12 ms now() - 0 gap.
  assert.equal(stopped[0].durationMs, 0);
  assert.equal(stopped[0].meditationsCompleted, 1);
  assert.equal(state.statistics.meditationsCompleted, 1);
  assert.equal(state.meditation.active, false);
  assert.equal(state.meditation.startedAt, 0);
  assert.equal(state.cultivation.qiPerSecond, 0);
});

test('destroy() unsubscribes — ticks no longer mutate state', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(makeConfig(), state, () => NOW);

  system.destroy();
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.statistics.qiGenerated, 0);
});
