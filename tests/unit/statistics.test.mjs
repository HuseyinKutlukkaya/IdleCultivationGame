/**
 * tests/unit/statistics.test.mjs — unit tests for js/systems/statistics.js.
 *
 * Exercises the StatisticsSystem under its Phase-2 division of labor: it
 * owns ONLY state.statistics.playtimeMs (the others stay where their
 * owners write them — MeditationSystem.meditationsCompleted,
 * QiSystem.qiGenerated, future BreakthroughSystem.breakthroughsTotal) and
 * exposes the read-only query API (getAll / get) plus the
 * 'statistics:changed' compare-before-emit event. Covered: the
 * 'loop:update' deltaMs accumulator (single tick, multiple ticks,
 * malformed deltaMs coerced to 0), the finite-write guard (a counter at
 * the double limit drops the write, never emits), restore-trust slice
 * repair (null, primitive, array — on construction AND on every tick),
 * the public API (getAll stable shape, get unknown keys silently 0,
 * reads survive a corrupted slice), the compare-before-emit pattern
 * (identical snapshots stay silent; counter mirrors advance the
 * snapshot from a sibling writer), and destroy() unsubscription.
 *
 * Each test injects a fresh deep clone of GameState (so the shared
 * singleton stays pristine) and the shared EventBus (cleared in
 * beforeEach so event assertions start clean). No clock is needed —
 * StatisticsSystem derives everything from the 'loop:update' payload.
 *
 * Run: the full suite as documented in tests/README.md (`node --test`
 * with the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { StatisticsSystem } from '../../js/systems/statistics.js';

const TICK_MS = 1000;

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a StatisticsSystem instance with a fresh state clone (unless
 * overridden).
 *
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @returns {StatisticsSystem} the system instance.
 */
function makeSystem(state = structuredClone(GameState)) {
  return new StatisticsSystem({ state, eventBus: EventBus });
}

test('constructor subscribes to loop:update and emits no initial event', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);

  assert.equal(EventBus.hasListeners('loop:update'), true);
  // No construction-time event: the constructor only restores the slice.
  assert.equal(changed.length, 0);
  // Restored constructor did not mutate the fresh slice.
  assert.equal(state.statistics.playtimeMs, 0);
});

test('a single loop:update with deltaMs=1000 accrues 1000 ms of playtime', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.statistics.playtimeMs, TICK_MS);
  // A real change → exactly one emit carrying the new snapshot.
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].snapshot, {
    playtimeMs: TICK_MS,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });
});

test('multiple loop:update ticks accumulate playtimeMs correctly', () => {
  const state = structuredClone(GameState);

  makeSystem(state);
  // 4 ticks at 500 ms each → 2000 ms total.
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 500, tick: 1 });
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 1000, tick: 2 });
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 1500, tick: 3 });
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 2000, tick: 4 });

  assert.equal(state.statistics.playtimeMs, 2000);
});

test('malformed deltaMs (null, NaN, string, negative) is coerced to 0 and writes nothing', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);

  for (const bad of [null, NaN, 'banana', -1000, undefined]) {
    EventBus.emit('loop:update', { deltaMs: bad, elapsedMs: TICK_MS, tick: 1 });
  }

  // No malformed deltaMs may advance the counter.
  assert.equal(state.statistics.playtimeMs, 0);
  // ...but each tick still rebuilds the snapshot — and because nothing
  // changed, no event fires (compare-before-emit). The accumulator
  // never gets the chance to mis-fire.
  assert.equal(changed.length, 0);
});

test('missing payload still produces a safe no-op tick', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);
  // No payload argument at all; the handler must never throw.
  EventBus.emit('loop:update');
  EventBus.emit('loop:update', undefined);

  assert.equal(state.statistics.playtimeMs, 0);
  assert.equal(changed.length, 0);
});

test('the finite-write guard drops the write when currentPlaytimeMs + deltaMs overflows', () => {
  const state = structuredClone(GameState);
  // Pretend the counter is sitting at the double limit — any non-zero
  // deltaMs pushes the sum past Number.MAX_VALUE to Infinity, so the
  // write (and the event) must be dropped entirely.
  state.statistics.playtimeMs = Number.MAX_VALUE;
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  // Counter untouched (not Infinity, not bumped): the whole tick's write
  // is dropped.
  assert.equal(state.statistics.playtimeMs, Number.MAX_VALUE);
  assert.equal(changed.length, 0);
});

test('a restored null statistics slice is repaired on construction', () => {
  // Attacker-shaped save: statistics is null. The constructor must never
  // abort boot and the fresh slice must be the canonical shape.
  const state = structuredClone(GameState);
  state.statistics = null;

  makeSystem(state);

  assert.deepEqual(state.statistics, {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });
});

test('a restored primitive statistics slice is repaired on construction', () => {
  const state = structuredClone(GameState);
  state.statistics = 5; // a primitive top-level slice

  makeSystem(state);

  assert.deepEqual(state.statistics, {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });
});

test('a restored array statistics slice is repaired on construction', () => {
  const state = structuredClone(GameState);
  state.statistics = []; // an array — not a plain object

  makeSystem(state);

  assert.deepEqual(state.statistics, {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });
});

test('restore-trust on the tick repairs a slice that goes null mid-session', () => {
  // The tick handler runs the same _ensureSlice guard — a slice that
  // gets corrupted AFTER construction still accrues playtime normally
  // (the next tick repairs it before reading/writing).
  const state = structuredClone(GameState);
  state.statistics.playtimeMs = 100; // pretend some progress already happened

  makeSystem(state);

  // Corrupt mid-session.
  state.statistics = null;

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  // The tick repaired the slice to the canonical fresh shape, then
  // wrote 1000 into the FRESH playtimeMs slot (because the corrupted
  // slice was replaced wholesale — not a deep-merge).
  assert.equal(state.statistics.playtimeMs, TICK_MS);
  assert.deepEqual(state.statistics, {
    playtimeMs: TICK_MS,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });
});

test('restore-trust on the tick repairs a primitive slice mid-session', () => {
  const state = structuredClone(GameState);

  makeSystem(state);
  state.statistics = 'corrupted';

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(typeof state.statistics, 'object');
  assert.equal(Array.isArray(state.statistics), false);
  assert.equal(state.statistics.playtimeMs, TICK_MS);
});

test('getAll() returns a stable-shape snapshot with all four counters', () => {
  const state = structuredClone(GameState);
  // Simulate sibling writers having advanced every counter.
  state.statistics.playtimeMs = 42_000;
  state.statistics.meditationsCompleted = 3;
  state.statistics.breakthroughsTotal = 1;
  state.statistics.qiGenerated = 999;

  const system = makeSystem(state);

  const snap = system.getAll();
  assert.deepEqual(snap, {
    playtimeMs: 42_000,
    meditationsCompleted: 3,
    breakthroughsTotal: 1,
    qiGenerated: 999,
  });
  // Stable shape: every call returns the SAME shape (same keys, same
  // finite numbers). Mutating the returned object does not leak back
  // into state.
  const before = state.statistics.playtimeMs;
  snap.playtimeMs = 1_000_000;
  assert.equal(state.statistics.playtimeMs, before);
});

test('getAll() returns finite numbers (0) when the stored fields are corrupted', () => {
  const state = structuredClone(GameState);
  state.statistics.playtimeMs = 'NaN-ish';
  state.statistics.meditationsCompleted = null;
  state.statistics.breakthroughsTotal = [];
  state.statistics.qiGenerated = undefined;

  const system = makeSystem(state);

  // Every value coerces to a finite number, falling back to 0 — same
  // fail-safe contract as the writer side.
  assert.deepEqual(system.getAll(), {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });
});

test('get(key) returns the matching counter', () => {
  const state = structuredClone(GameState);
  state.statistics.playtimeMs = 500;
  state.statistics.meditationsCompleted = 2;
  state.statistics.breakthroughsTotal = 1;
  state.statistics.qiGenerated = 1234;

  const system = makeSystem(state);

  assert.equal(system.get('playtimeMs'), 500);
  assert.equal(system.get('meditationsCompleted'), 2);
  assert.equal(system.get('breakthroughsTotal'), 1);
  assert.equal(system.get('qiGenerated'), 1234);
});

test('get(key) returns 0 silently for unknown / malformed keys', () => {
  const state = structuredClone(GameState);

  const system = makeSystem(state);

  // Unknown counter names (the contract: never throw, never warn —
  // callers that guard on `get(...) > 0` must never blow up on a
  // future counter that does not exist yet).
  assert.equal(system.get('not.a.counter'), 0);
  assert.equal(system.get(''), 0);
  assert.equal(system.get(null), 0);
  assert.equal(system.get(undefined), 0);
  assert.equal(system.get(123), 0);
  // Sanity: known keys still work after the unknown-key hits.
  assert.equal(system.get('playtimeMs'), 0);
});

test('statistics:changed is emitted ONLY when the snapshot actually changes', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);

  // First tick: playtimeMs advances 0 → 1000 (change → 1 emit).
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 1000, tick: 1 });
  // Second tick: a no-op (no counter moves) must NOT re-emit.
  EventBus.emit('loop:update', { deltaMs: 0, elapsedMs: 1000, tick: 2 });
  // Third tick: playtimeMs advances 1000 → 2000 (change → +1 emit).
  EventBus.emit('loop:update', { deltaMs: 1000, elapsedMs: 2000, tick: 3 });

  assert.equal(changed.length, 2);
  assert.equal(changed[0].snapshot.playtimeMs, 1000);
  assert.equal(changed[1].snapshot.playtimeMs, 2000);
});

test('the emitted payload reflects the new playtimeMs (deltaMs accumulator ran)', () => {
  const state = structuredClone(GameState);
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);
  EventBus.emit('loop:update', { deltaMs: 2500, elapsedMs: 2500, tick: 1 });

  assert.equal(changed.length, 1);
  assert.equal(changed[0].snapshot.playtimeMs, 2500);
});

test('statistics:changed captures a sibling writer that advances a read-only counter', () => {
  // The system does NOT subscribe to meditation:stopped or qi:gained —
  // it watches the snapshot, so any writer advancing one of the three
  // non-owned counters on a subsequent tick shows up in the emit
  // (without the system holding a hard reference to its sibling).
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2; // set up to feed QiSystem
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);

  // Force a tick: nothing yet (qi cap is 100, room is 100, gains 2).
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  // The system advanced only its own counter; the snapshot reflects the
  // unchanged qiGenerated → still 0.
  assert.equal(changed.length, 1);
  assert.equal(changed[0].snapshot.qiGenerated, 0);

  // Now advance qiGenerated directly (simulating what QiSystem does at the
  // end of its tick). The next tick must emit the new snapshot.
  state.statistics.qiGenerated = 42;
  EventBus.emit('loop:update', { deltaMs: 0, elapsedMs: 2 * TICK_MS, tick: 2 });

  assert.equal(changed.length, 2);
  assert.equal(changed[1].snapshot.qiGenerated, 42);
  // playtimeMs must have advanced too (we passed deltaMs=0, so it
  // stays at 1000 — but the qiGenerated change is enough to trigger
  // emit on this tick).
  assert.equal(changed[1].snapshot.playtimeMs, TICK_MS);
});

test('destroy() unsubscribes — subsequent ticks no longer mutate state', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state);
  system.destroy();

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.statistics.playtimeMs, 0);
});

test('destroy() is idempotent — a second call does not throw', () => {
  const state = structuredClone(GameState);
  const system = makeSystem(state);

  system.destroy();
  assert.doesNotThrow(() => system.destroy());
});

test('the system survives a save with a healthy restored slice, no construction event', () => {
  // Sanity-check the canonical integration path: a restored save whose
  // statistics already have progress data; the constructor must NOT emit
  // (the snapshot is unchanged at the moment of construction).
  const state = structuredClone(GameState);
  state.statistics.playtimeMs = 60_000;
  const changed = [];
  EventBus.subscribe('statistics:changed', (payload) => changed.push(payload));

  makeSystem(state);

  assert.equal(state.statistics.playtimeMs, 60_000);
  assert.equal(changed.length, 0);
});
