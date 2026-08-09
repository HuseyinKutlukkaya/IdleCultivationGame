/**
 * tests/unit/game.test.mjs — unit tests for js/core/game.js.
 *
 * Exercises the core game object: building its GameLoop from config.loop
 * (with fallbacks for partial/missing config), idempotent start()/stop(),
 * serialize() producing a deep snapshot that is decoupled from GameState,
 * and restore() applying a snapshot via deepMerge while rejecting invalid
 * snapshots with a console warning.
 *
 * Game imports the shared EventBus and GameState singletons, so the bus is
 * cleared in beforeEach and GameState is deep-restored after every test
 * (the singleton is mutated in place by restore() and systems). The rAF
 * stub is installed because start() drives GameLoop.start().
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { Game } from '../../js/core/game.js';
import { installRafStub, uninstallRafStub } from '../helpers/raf-stub.mjs';

/** Pristine deep copy of GameState taken in beforeEach, restored after. */
let pristineState = null;

/** Reset the bus, snapshot the state and install the rAF stub. */
beforeEach(() => {
  EventBus.clear();
  pristineState = structuredClone(GameState);
  installRafStub();
});

/** Restore GameState to its pristine defaults and remove the rAF stub. */
afterEach(() => {
  uninstallRafStub();
  Object.keys(GameState).forEach((key) => delete GameState[key]);
  Object.assign(GameState, pristineState);
  pristineState = null;
});

test('constructor builds its GameLoop from config.loop and wires state', () => {
  const config = { loop: { tickRateMs: 500, uiRefreshRateMs: 50, maxFrameDeltaMs: 25 } };

  const game = new Game(config);

  assert.deepEqual(game.config, config);
  assert.strictEqual(game.state, GameState);
  assert.equal(game.isRunning, false);
  assert.equal(game.loop.tickRateMs, 500);
  assert.equal(game.loop.uiRefreshRateMs, 50);
  assert.equal(game.loop._maxFrameDeltaMs, 25);
});

test('partial or missing config falls back to GameLoop defaults', () => {
  const partial = new Game({ loop: { tickRateMs: 250 } });
  assert.equal(partial.loop.tickRateMs, 250);
  assert.equal(partial.loop.uiRefreshRateMs, 100);

  const full = new Game({});
  assert.equal(full.loop.tickRateMs, 1000);
  assert.equal(full.loop.uiRefreshRateMs, 100);

  const none = new Game();
  assert.equal(none.loop.tickRateMs, 1000);
  assert.equal(none.loop.uiRefreshRateMs, 100);

  const nullConfig = new Game(null);
  assert.equal(nullConfig.loop.tickRateMs, 1000);
  assert.equal(nullConfig.loop.uiRefreshRateMs, 100);
});

test('start() is idempotent and flips isRunning without double-starting the loop', () => {
  const started = [];
  EventBus.subscribe('loop:started', (payload) => started.push(payload));

  const game = new Game({});
  game.start();
  game.start(); // idempotent — must be a no-op

  assert.equal(game.isRunning, true);
  assert.equal(started.length, 1);
});

test('stop() is idempotent and flips isRunning without double-stopping the loop', () => {
  const stopped = [];
  EventBus.subscribe('loop:stopped', (payload) => stopped.push(payload));

  const game = new Game({});
  game.start();
  game.stop();
  game.stop(); // idempotent — must be a no-op

  assert.equal(game.isRunning, false);
  assert.equal(stopped.length, 1);
});

test('serialize() returns a deep copy — mutating it leaves GameState untouched', () => {
  const game = new Game({});

  const snapshot = game.serialize();
  snapshot.cultivation.qi = 999;
  snapshot.player.name = 'hacked';
  snapshot.resources.spiritStones = 12345;

  assert.equal(GameState.cultivation.qi, 0);
  assert.equal(GameState.player.name, 'Unnamed Cultivator');
  assert.equal(GameState.resources.spiritStones, 0);
});

test('restore() deep-merges a snapshot and keeps current defaults for missing keys', () => {
  const game = new Game({});

  game.restore({
    player: { name: 'Ren' },
    resources: { spiritStones: 42 },
  });

  // Applied values.
  assert.equal(GameState.player.name, 'Ren');
  assert.equal(GameState.resources.spiritStones, 42);
  // Missing keys keep the current defaults (old saves keep working).
  assert.equal(GameState.player.title, '');
  assert.equal(GameState.cultivation.qi, 0);
  assert.equal(GameState.settings.offlineProgress, true);
});

test('restore() ignores invalid snapshots with a console warning', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const before = structuredClone(GameState);

  const game = new Game({});
  game.restore(null);
  game.restore(42);
  game.restore('not an object');
  game.restore([1, 2, 3]);

  assert.equal(warn.mock.callCount(), 4);
  assert.deepEqual(GameState, before);
});
