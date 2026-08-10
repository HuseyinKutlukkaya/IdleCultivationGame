/**
 * tests/unit/meditation.test.mjs — unit tests for js/systems/meditation.js.
 *
 * Exercises the MeditationSystem under its Phase-2 division of labor: it owns
 * the session (active flag, startedAt, mode) and its rate-contribution slot
 * cultivation.qiSources.meditation — the QiSystem aggregates the slot into
 * the actual qi gains, so meditation no longer writes qi/qiPerSecond/
 * statistics.qiGenerated and no longer emits 'qi:gained'. Covered: the
 * config-driven base rate (missing block silent, invalid value warns and
 * falls back to 0), the constructor's slot sync from the (possibly restored)
 * active flag, the start/stop/toggle session API (idempotency, clock-driven
 * durations, events), the 'loop:update' slot feed and session accounting
 * (contribution = rate × deltaMs, reported as qiGained on stop), restore
 * compatibility (the slot survives a missing qiSources container, and a
 * malformed cultivation slice is repaired on construction) and destroy()
 * unsubscription.
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
  // constructor slot sync (fresh active state → slot stays 0).
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(state.cultivation.qiSources.meditation, 0);

  // The system still works: ticks feed nothing and never crash.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qiSources.meditation, 0);
  assert.equal(system.isActive, true);
});

test('an invalid baseQiPerSecond warns once and falls back to 0', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem(makeConfig({ baseQiPerSecond: -5 }), state);

  assert.equal(warn.mock.callCount(), 1);
  // Fresh active state synced against the fallback rate: 0.
  assert.equal(state.cultivation.qiSources.meditation, 0);
  assert.equal(system.isActive, true);

  // A tick at the fallback rate feeds nothing into the slot.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qiSources.meditation, 0);
});

test('a fresh active state syncs the contribution slot to the configured rate', () => {
  const state = structuredClone(GameState); // meditation.active === true

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiSources.meditation, 2);
});

test('an inactive state syncs the contribution slot to 0 on construction', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiSources.meditation, 0);
});

test('start() activates, records startedAt, syncs the slot and emits meditation:started', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  const started = [];
  EventBus.subscribe('meditation:started', (payload) => started.push(payload));
  const system = makeSystem(makeConfig(), state, () => NOW);

  assert.equal(system.start(), true);
  assert.equal(system.isActive, true);
  assert.equal(state.meditation.active, true);
  assert.equal(state.meditation.startedAt, NOW);
  assert.equal(state.cultivation.qiSources.meditation, 2);
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
  assert.equal(state.cultivation.qiSources.meditation, 0);
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

test('a tick while active keeps the slot fed and tracks the session contribution', () => {
  const state = structuredClone(GameState); // active: true, qi: 0
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  makeSystem(makeConfig(), state, () => NOW);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  // The slot carries the effective rate; meditation itself no longer writes
  // qi, its per-second rate or its statistics, and never emits qi:gained.
  assert.equal(state.cultivation.qiSources.meditation, 2);
  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(state.statistics.qiGenerated, 0);
  assert.equal(gained.length, 0);
});

test('the session contribution uses the payload deltaMs (no hardcoded 1000ms)', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  const stopped = [];
  EventBus.subscribe('meditation:stopped', (payload) => stopped.push(payload));
  const system = makeSystem(makeConfig(), state, () => NOW);

  system.start();
  // Half a tick at 2 qi/s → 1 qi contributed to the session.
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 500, tick: 1 });
  system.stop();

  assert.equal(stopped[0].qiGained, 1);
});

test('a tick while inactive changes nothing and emits no events', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  state.cultivation.qi = 10;
  state.cultivation.qiSources.meditation = 2; // stale restored slot
  const started = [];
  const stopped = [];
  EventBus.subscribe('meditation:started', (payload) => started.push(payload));
  EventBus.subscribe('meditation:stopped', (payload) => stopped.push(payload));
  makeSystem(makeConfig(), state, () => NOW);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  // The stale slot is guaranteed to be zeroed; nothing else changes.
  assert.equal(state.cultivation.qiSources.meditation, 0);
  assert.equal(state.cultivation.qi, 10);
  assert.equal(started.length, 0);
  assert.equal(stopped.length, 0);
});

test('the session contribution is not clamped to the qi cap (QiSystem clamps gains)', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  state.cultivation.qi = 99; // near the 100 qiMax
  const stopped = [];
  EventBus.subscribe('meditation:stopped', (payload) => stopped.push(payload));
  const system = makeSystem(makeConfig(), state, () => NOW);

  system.start();
  // Raw contribution 2 at rate 2/s, even though only 1 would fit below the
  // cap — meditation reports what it fed into the pool; QiSystem clamps.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  system.stop();

  assert.equal(stopped[0].qiGained, 2);
  // Meditation no longer writes qi or the qi-generated statistic.
  assert.equal(state.cultivation.qi, 99);
  assert.equal(state.statistics.qiGenerated, 0);
});

test('restored inactive state does not produce until start()', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false; // e.g. a save where the player stopped
  const system = makeSystem(makeConfig(), state, () => NOW);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qiSources.meditation, 0);

  assert.equal(system.start(), true);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.equal(state.cultivation.qiSources.meditation, 2);
});

test('restored active state feeds the slot without an explicit start()', () => {
  const state = structuredClone(GameState); // active: true by default
  makeSystem(makeConfig(), state, () => NOW);

  // The constructor synced the slot straight from the restored active flag.
  assert.equal(state.cultivation.qiSources.meditation, 2);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qiSources.meditation, 2);
});

test('stop() reports the session contribution over its ticks', () => {
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

  // Session accounting: two active ticks at rate 2 → 4 contributed qi.
  assert.equal(state.statistics.qiGenerated, 0); // meditation never touches it
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
  assert.equal(state.cultivation.qiSources.meditation, 0);
});

test('a missing or non-object qiSources container is repaired on construction', () => {
  // Old/restored saves may predate the qiSources slice — the slot must be
  // created on first write, for both active and inactive restores.
  const active = structuredClone(GameState);
  delete active.cultivation.qiSources;
  makeSystem(makeConfig(), active);
  assert.equal(active.cultivation.qiSources.meditation, 2);

  const inactive = structuredClone(GameState);
  inactive.meditation.active = false;
  inactive.cultivation.qiSources = null; // malformed restored value
  makeSystem(makeConfig(), inactive);
  assert.equal(inactive.cultivation.qiSources.meditation, 0);
});

test('a restored malformed cultivation slice is repaired on construction', () => {
  // An attacker-shaped save with cultivation: null must never abort boot —
  // the constructor's slot sync reads and writes through the slice.
  const state = structuredClone(GameState);
  state.cultivation = null;

  const system = makeSystem(makeConfig(), state); // must not throw

  // Repaired to the canonical fresh cultivation slice; the constructor's slot
  // sync wrote the effective rate into it (fresh state is active at rate 2).
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
    qiSources: { meditation: 2 },
    breakthroughs: 0,
  });

  // Construct + one tick + the slot is written (the repaired slice survives).
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qiSources.meditation, 2);
});

test('destroy() unsubscribes — ticks no longer mutate the slot', () => {
  const state = structuredClone(GameState);
  state.meditation.active = false;
  const system = makeSystem(makeConfig(), state, () => NOW);

  system.destroy();
  // An external flip the handler would react to if it were still subscribed.
  state.meditation.active = true;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qiSources.meditation, 0); // no feed after destroy
});
