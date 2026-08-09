/**
 * tests/unit/game-loop.test.mjs — unit tests for js/core/game-loop.js.
 *
 * Exercises the fixed-timestep rAF-driven ticker: constructor tuning
 * defaults and the _positiveNumber guardrails, start()/stop() idempotency
 * and their events, the per-frame flow (paused freeze, delta clamping,
 * fixed-step 'loop:update' emissions, throttled 'loop:uiRefresh') and the
 * public getters.
 *
 * Two stubs make the loop deterministic in Node:
 *   - tests/helpers/raf-stub.mjs captures requestAnimationFrame callbacks so
 *     each frame is driven manually with a controlled `now` timestamp;
 *   - performance.now is mocked with `t.mock.method` (auto-restored when the
 *     test ends) and driven through a mutable `nowValue` variable.
 *
 * A fresh real EventBus instance is cleared in beforeEach and injected via
 * the `eventBus` constructor option (the shared singleton is imported).
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameLoop } from '../../js/core/game-loop.js';
import { installRafStub, uninstallRafStub } from '../helpers/raf-stub.mjs';

/** Live rAF stub handle; reassigned by beforeEach. */
let raf = null;

/** Reset the shared bus and install the rAF stub before every test. */
beforeEach(() => {
  EventBus.clear();
  raf = installRafStub();
});

/** Remove the rAF stub after every test (performance.now is auto-restored). */
afterEach(() => {
  uninstallRafStub();
});

/**
 * Run the next pending frame callback with a controlled timestamp, exactly
 * as the browser would deliver the rAF DOMHighResTimeStamp.
 *
 * @param {number} now — fake DOMHighResTimeStamp for this frame.
 * @returns {void}
 */
function drive(now) {
  const callback = raf.calls.shift();
  assert.equal(typeof callback, 'function', 'expected a pending frame callback');
  callback(now);
}

test('constructor exposes default tuning through the getters and starts idle', () => {
  const loop = new GameLoop({ eventBus: EventBus });

  assert.equal(loop.tickRateMs, 1000);
  assert.equal(loop.uiRefreshRateMs, 100);
  assert.equal(loop.isRunning, false);
  assert.equal(loop.isPaused, false);
  assert.equal(loop.elapsedMs, 0);
  assert.equal(loop.ticks, 0);
});

test('constructor honours custom tuning options', () => {
  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: 500,
    uiRefreshRateMs: 50,
    maxFrameDeltaMs: 100,
  });

  assert.equal(loop.tickRateMs, 500);
  assert.equal(loop.uiRefreshRateMs, 50);
  // maxFrameDeltaMs has no getter; peek the private field (unit-test scope).
  assert.equal(loop._maxFrameDeltaMs, 100);
});

test('invalid tickRateMs falls back to 1000 with a single warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const loop = new GameLoop({ eventBus: EventBus, tickRateMs: 0 });

  assert.equal(loop.tickRateMs, 1000);
  assert.equal(warn.mock.callCount(), 1);
});

test('each invalid tuning option warns once and falls back', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: -10,
    uiRefreshRateMs: 'fast',
    maxFrameDeltaMs: Number.NaN,
  });

  assert.equal(loop.tickRateMs, 1000);
  assert.equal(loop.uiRefreshRateMs, 100);
  assert.equal(loop._maxFrameDeltaMs, 250);
  // One warning per invalid option, exactly once each.
  assert.equal(warn.mock.callCount(), 3);
});

test('missing (undefined) tuning options fall back silently', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const loop = new GameLoop({ eventBus: EventBus });

  assert.equal(loop.tickRateMs, 1000);
  assert.equal(loop.uiRefreshRateMs, 100);
  assert.equal(warn.mock.callCount(), 0);
});

test('start() is idempotent, emits loop:started once and schedules one frame', (t) => {
  const started = [];
  EventBus.subscribe('loop:started', (payload) => started.push(payload));
  t.mock.method(performance, 'now', () => 1234);

  const loop = new GameLoop({ eventBus: EventBus });
  loop.start();
  loop.start(); // idempotent — must be a no-op

  assert.equal(started.length, 1);
  assert.deepEqual(started[0], { startedAt: 1234 });
  assert.equal(loop.isRunning, true);
  assert.equal(loop.isPaused, false);
  assert.equal(raf.calls.length, 1);
});

test('paused frames do not accumulate time or emit updates, and resume is clean', (t) => {
  const updates = [];
  const paused = [];
  const resumed = [];
  EventBus.subscribe('loop:update', (payload) => updates.push(payload));
  EventBus.subscribe('loop:paused', (payload) => paused.push(payload));
  EventBus.subscribe('loop:resumed', (payload) => resumed.push(payload));

  let nowValue = 0;
  t.mock.method(performance, 'now', () => nowValue);

  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: 100,
    uiRefreshRateMs: 1000,
    maxFrameDeltaMs: 1000,
  });
  loop.start(); // lastFrameAt = 0
  loop.pause();

  assert.equal(loop.isPaused, true);
  assert.equal(paused.length, 1);

  // Two large paused frames: rAF keeps rescheduling, time stands still.
  drive(500);
  drive(1500);
  assert.equal(loop.elapsedMs, 0);
  assert.equal(loop.ticks, 0);
  assert.equal(updates.length, 0);

  // Resume resets lastFrameAt to now, so the pause duration never leaks in.
  nowValue = 1500;
  loop.resume();
  assert.equal(loop.isPaused, false);
  assert.equal(resumed.length, 1);

  drive(1600); // delta 100 → one fixed tick
  assert.equal(loop.elapsedMs, 100);
  assert.equal(loop.ticks, 1);
  assert.equal(updates.length, 1);
});

test('per-frame deltas are clamped to maxFrameDeltaMs (negative deltas clamp to 0)', (t) => {
  t.mock.method(performance, 'now', () => 0);

  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: 1000,
    uiRefreshRateMs: 1000,
    maxFrameDeltaMs: 250,
  });
  loop.start(); // lastFrameAt = 0

  drive(250); // raw delta 250 passes the clamp boundary unchanged
  assert.equal(loop.elapsedMs, 250);

  drive(0); // raw delta 0 − 250 = −250 → clamped to 0, time does not run backwards
  assert.equal(loop.elapsedMs, 250);

  drive(10250); // +10250 again clamped to 250
  assert.equal(loop.elapsedMs, 500);
});

test('fixed steps emit loop:update with deltaMs === tickRateMs and a running tick count', (t) => {
  const updates = [];
  const frames = [];
  EventBus.subscribe('loop:update', (payload) => updates.push(payload));
  EventBus.subscribe('loop:frame', (payload) => frames.push(payload));
  t.mock.method(performance, 'now', () => 0);

  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: 100,
    uiRefreshRateMs: 100000,
    maxFrameDeltaMs: 1000,
  });
  loop.start();

  drive(100); // one tick
  drive(200); // one tick
  drive(250); // 50ms — partial, no tick

  assert.equal(loop.ticks, 2);
  assert.equal(loop.elapsedMs, 250);
  // Simulation code always sees a fixed deltaMs.
  assert.deepEqual(
    updates.map((update) => update.deltaMs),
    [100, 100]
  );
  assert.deepEqual(
    updates.map((update) => update.tick),
    [1, 2]
  );
  assert.deepEqual(
    updates.map((update) => update.elapsedMs),
    [100, 200]
  );
  // Raw frame feed reflects the real (variable) per-frame deltas.
  assert.deepEqual(
    frames.map((frame) => frame.deltaMs),
    [100, 100, 50]
  );
});

test('uiRefresh pulses are throttled to uiRefreshRateMs of simulation time', (t) => {
  const refreshes = [];
  EventBus.subscribe('loop:uiRefresh', (payload) => refreshes.push(payload));
  t.mock.method(performance, 'now', () => 0);

  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: 100000,
    uiRefreshRateMs: 200,
    maxFrameDeltaMs: 1000,
  });
  loop.start();

  drive(150); // below the throttle → no pulse
  drive(350); // cumulative 350 ≥ 200 → pulse once (leftover 150)
  drive(500); // +150 → 300 ≥ 200 → pulse again (leftover 100)

  assert.deepEqual(
    refreshes.map((refresh) => refresh.elapsedMs),
    [350, 500]
  );
});

test('stop() is idempotent, emits loop:stopped with session totals and cancels rAF', (t) => {
  const stopped = [];
  EventBus.subscribe('loop:stopped', (payload) => stopped.push(payload));
  t.mock.method(performance, 'now', () => 0);

  const loop = new GameLoop({
    eventBus: EventBus,
    tickRateMs: 100,
    uiRefreshRateMs: 100000,
    maxFrameDeltaMs: 1000,
  });
  loop.start();
  drive(300); // 3 ticks, 300ms elapsed

  loop.stop();
  loop.stop(); // idempotent — must not emit again

  assert.deepEqual(stopped, [{ elapsedMs: 300, ticks: 3 }]);
  assert.equal(loop.isRunning, false);
  assert.equal(loop.isPaused, false);
  // The pending frame was cancelled, leaving the rAF queue empty.
  assert.equal(raf.calls.length, 0);
});
