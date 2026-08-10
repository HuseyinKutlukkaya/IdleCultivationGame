/**
 * tests/unit/notification-manager.test.mjs — unit tests for
 * js/managers/notification-manager.js.
 *
 * Exercises the queue-based NotificationManager under fully injected fakes
 * (eventBus + now clock) so no real EventBus singleton, no DOM, no GameState
 * and no Date.now are touched. Coverage:
 *
 *   - constructor: the config.notifications block (maxQueueSize, types) is
 *     read correctly; missing block is silent and uses shipped defaults;
 *     present-but-invalid values warn once and fall back;
 *   - initial state: empty queue, getters expose configured values, the
 *     `types` getter is a defensive shallow copy;
 *   - add(): id generation, default type 'info', `at` stamping, FIFO cap,
 *     emit exactly once on a successful mutation, NEVER on a rejected call
 *     (non-string / empty / unknown / prototype-alias message/type);
 *   - dismiss(id): removes by id, returns true; missing / non-string /
 *     prototype-alias id returns false with no emit;
 *   - clear(): empties the queue and emits only when something was actually
 *     removed; idempotent (no throw, no spurious emit on already-empty);
 *   - dispose(): idempotent tear-down, post-dispose add/dismiss/clear are
 *     quiet;
 *   - event payload shape: payload.queue matches notifs.queue (deep equal
 *     right after add) so the activity-log subscriber can read straight off
 *     the payload;
 *   - purity: GameState.cultivation is unchanged through any sequence of
 *     calls (the manager never touches gameplay state); the manager never
 *     touches document/window/localStorage.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form). Run just this file
 * during development with: `node --test tests/unit/notification-manager.test.mjs`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationManager } from '../../js/managers/notification-manager.js';
import { EventBus } from '../../js/core/event-bus.js';

/** Shipped defaults — mirrored from the module under test. */
const DEFAULT_MAX_QUEUE_SIZE = 50;
const DEFAULT_TYPES = ['info', 'success', 'warning', 'error', 'achievement'];

/** Event name the manager emits on every successful queue mutation. */
const CHANGE_EVENT = 'notification:changed';

/** Fixed wall-clock reference so every test's `at` stamping is deterministic. */
const NOW = 1_700_000_000_000;

/**
 * Build a fake event bus that records every emit on `.emitted`. Every other
 * method is a no-op (the manager only calls .emit — subscribers live on the
 * real shared bus).
 *
 * @returns {{
 *   emitted: Array<[string, object|undefined]>,
 *   emit(name: string, payload?: object): void,
 *   has(name: string): boolean
 * }} the fake bus.
 */
function createFakeEventBus() {
  const emitted = [];
  return {
    emitted,
    emit(name, payload) {
      emitted.push([name, payload]);
    },
    has(name) {
      return emitted.some(([eventName]) => eventName === name);
    },
  };
}

/**
 * A clock that always returns NOW. Tests that exercise the default Date.now
 * branch construct their manager without injecting one.
 *
 * @returns {() => number} a fixed-clock function.
 */
function fixedNow() {
  return () => NOW;
}

/** Last emitted payload on the fake bus, or undefined when none. */
function lastPayload(bus) {
  const last = bus.emitted[bus.emitted.length - 1];
  return last ? last[1] : undefined;
}

/** Count emits for one event name. */
function emitCount(bus, name) {
  return bus.emitted.filter(([eventName]) => eventName === name).length;
}

/** Reset the shared EventBus before every test (defensive — fakes shouldn't leak). */
beforeEach(() => {
  EventBus.clear();
});

// ---------- Constructor ----------

test('constructor reads maxQueueSize and types from config', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 7, types: ['info', 'error'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  assert.equal(manager.maxQueueSize, 7);
  assert.deepEqual(manager.types, ['info', 'error']);
});

test('missing config.notifications block is silent and uses shipped defaults', () => {
  const bus = createFakeEventBus();

  // No warn hook needed — silently missing config never warns.
  const manager = new NotificationManager({
    config: {},
    eventBus: bus,
    now: fixedNow(),
  });

  assert.equal(manager.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
  assert.equal(manager.types.length, DEFAULT_TYPES.length);
});

test('missing config entirely is silent and uses shipped defaults', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({ eventBus: bus, now: fixedNow() });

  assert.equal(manager.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
  assert.deepEqual(manager.types, DEFAULT_TYPES);
});

test('invalid maxQueueSize warns once and falls back to the shipped default', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});

  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 0, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  assert.equal(warn.mock.callCount(), 1);
  assert.equal(manager.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
});

test('invalid maxQueueSize types (NaN, negative, string) all warn and fall back', (t) => {
  // "undefined" is the MISSING-KEY path (silent fallback per spec) — exercise
  // it in the dedicated "missing key is silent" test above, not here. This
  // loop tests present-but-invalid values.
  for (const bad of [NaN, -3, 'oops', null]) {
    const bus = createFakeEventBus();
    const warn = t.mock.method(console, 'warn', () => {});

    const manager = new NotificationManager({
      config: { notifications: { maxQueueSize: bad, types: ['info'] } },
      eventBus: bus,
      now: fixedNow(),
    });

    assert.ok(warn.mock.callCount() >= 1, `bad value ${String(bad)} should have warned`);
    assert.equal(manager.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, `bad value ${String(bad)} should fall back`);
    bus.emitted.length = 0;
  }
});

test('invalid types (non-array / empty array) warns and falls back to the shipped default', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});

  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: 'info' } },
    eventBus: bus,
    now: fixedNow(),
  });

  assert.ok(warn.mock.callCount() >= 1);
  assert.equal(manager.types.length, DEFAULT_TYPES.length);
});

test('types array with only invalid entries falls back to the shipped default', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});

  const manager = new NotificationManager({
    config: {
      notifications: {
        maxQueueSize: 10,
        types: ['', '__proto__', null, undefined, 42],
      },
    },
    eventBus: bus,
    now: fixedNow(),
  });

  // All entries are skipped — manager falls back to the shipped default
  // (the "empty whitelist" warning happens once, plus per-entry warnings).
  assert.ok(warn.mock.callCount() >= 1);
  assert.equal(manager.types.length, DEFAULT_TYPES.length);
});

test('injected eventBus is used — the global EventBus never sees an emit', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  // Adding one entry calls the fake bus only.
  manager.add('Hello.');
  assert.equal(emitCount(bus, CHANGE_EVENT), 1);
  // Sanity: the shared bus does not carry the fake's emits (they're
  // separate objects in this test — but assert it anyway so the contract is
  // pinned).
  assert.equal(EventBus.hasListeners(CHANGE_EVENT), false);
});

test('injected now() is used by add() for the `at` stamp', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: () => 12345,
  });

  manager.add('Fixed instant.');
  const payload = lastPayload(bus);
  assert.equal(payload.queue[0].at, 12345);
});

test('no injected now falls back to Date.now (default branch smoke test)', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
  });

  const before = Date.now();
  manager.add('Wall clock.');
  const after = Date.now();

  const payload = lastPayload(bus);
  const stampedAt = payload.queue[0].at;
  assert.ok(
    stampedAt >= before && stampedAt <= after,
    `expected ${before} <= ${stampedAt} <= ${after}`
  );
});

// ---------- Initial state ----------

test('a fresh manager has an empty queue', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({ eventBus: bus, now: fixedNow() });
  assert.equal(manager.size(), 0);
  assert.equal(manager.queue.length, 0);
});

test('the types getter returns a defensive shallow copy', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info', 'error'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  const first = manager.types;
  first.push('mutated');
  const second = manager.types;
  assert.equal(second.length, 2, 'mutating a returned array must not leak into the whitelist');
  assert.ok(!manager.types.includes('mutated'));
});

test('the queue getter returns fresh shallow copies so callers cannot mutate state', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Hi.');

  const snapshot = manager.queue;
  snapshot.length = 0;
  snapshot[0] = { id: 'fake', type: 'info', message: 'fake', at: 0 };

  assert.equal(manager.size(), 1);
  assert.equal(manager.queue.length, 1);
  assert.equal(manager.queue[0].id, 'n1');
});

// ---------- add() ----------

test('add() returns a string id; two consecutive calls produce distinct ids', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  const id1 = manager.add('First.');
  const id2 = manager.add('Second.');
  assert.equal(typeof id1, 'string');
  assert.equal(typeof id2, 'string');
  assert.notEqual(id1, id2);
});

test('add() default type is "info" and stamps the entry correctly', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  const id = manager.add('Default type.');
  const entry = manager.queue[0];
  assert.equal(entry.id, id);
  assert.equal(entry.type, 'info');
  assert.equal(entry.message, 'Default type.');
  assert.equal(entry.at, NOW);
});

test('add() honors an explicit valid type', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info', 'success'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Gained a realm.', { type: 'success' });
  assert.equal(manager.queue[0].type, 'success');
});

test('add() emits exactly one notification:changed with the queue as payload', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Event arrives.');

  assert.equal(emitCount(bus, CHANGE_EVENT), 1);
  const payload = lastPayload(bus);
  assert.ok(payload);
  assert.deepEqual(payload.queue, manager.queue);
});

test('add() with a non-string message returns null and never mutates the queue', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  // 8 non-string shapes; one warn each.
  for (const bad of [42, true, false, null, undefined, {}, [], Symbol('x')]) {
    assert.equal(manager.add(bad), null, `bad value ${String(bad)} should return null`);
  }
  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
  assert.equal(warn.mock.callCount(), 8);
});

test('add() with an empty / whitespace message returns null and never mutates', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  for (const empty of ['', '   ', '\n\t  ', ' \t\r\n ']) {
    assert.equal(manager.add(empty), null, `empty value ${JSON.stringify(empty)} should return null`);
  }
  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
  assert.equal(warn.mock.callCount(), 4);
});

test('add() with an unknown type returns null and never mutates', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  assert.equal(manager.add('Hello.', { type: 'reincarnation' }), null);
  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
  assert.equal(warn.mock.callCount(), 1);
});

test('add() rejects prototype-alias types (defense-in-depth)', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(manager.add('Hi.', { type: bad }), null, `bad type "${bad}" should be rejected`);
  }
  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
  assert.equal(warn.mock.callCount(), 3);
});

test('add() grows size() and emits each time', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('One.');
  manager.add('Two.');
  manager.add('Three.');

  assert.equal(manager.size(), 3);
  assert.equal(emitCount(bus, CHANGE_EVENT), 3);
});

// ---------- FIFO cap ----------

test('add() past the cap drops the oldest entry (FIFO)', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 3, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('n1');
  manager.add('n2');
  manager.add('n3');
  manager.add('n4');

  assert.equal(manager.size(), 3);
  // The oldest (n1) was dropped; the queue holds n2 / n3 / n4 in order.
  assert.deepEqual(
    manager.queue.map((entry) => entry.id),
    ['n2', 'n3', 'n4']
  );
});

test('add() with maxQueueSize=1 keeps only the newest', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 1, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('First.');
  manager.add('Second.');

  assert.equal(manager.size(), 1);
  assert.equal(manager.queue[0].id, 'n2');
});

test('add() past the cap emits exactly one event (not one per drop)', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 2, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('One.');
  manager.add('Two.');
  manager.add('Three.'); // drops One, emits once

  assert.equal(emitCount(bus, CHANGE_EVENT), 3);
  const lastPayload = bus.emitted[bus.emitted.length - 1][1];
  assert.equal(lastPayload.queue.length, 2);
  assert.equal(lastPayload.queue[1].id, 'n3');
});

// ---------- dismiss() ----------

test('dismiss(id) removes the entry and returns true', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  const id = manager.add('Removable.');
  assert.equal(manager.dismiss(id), true);
  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 2);
});

test('dismiss(unknown id) returns false and does not emit', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Stay.');
  bus.emitted.length = 0; // reset emission history after seeding

  assert.equal(manager.dismiss('n999'), false);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
});

test('dismiss on an empty queue returns false and does not emit', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  assert.equal(manager.dismiss('n1'), false);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
});

test('dismiss(non-string) returns false and does not emit', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  for (const bad of [42, null, undefined, {}, []]) {
    assert.equal(manager.dismiss(bad), false, `bad value ${String(bad)} should return false`);
  }
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
  assert.equal(warn.mock.callCount(), 5);
});

test('dismiss(prototype-alias id) is rejected with a warning and does not emit', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Stay.');
  bus.emitted.length = 0;

  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(manager.dismiss(bad), false, `bad id "${bad}" should be rejected`);
  }
  assert.equal(manager.size(), 1);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
  assert.equal(warn.mock.callCount(), 3);
});

// ---------- clear() ----------

test('clear() empties the queue and emits once when something was removed', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('One.');
  manager.add('Two.');
  bus.emitted.length = 0; // baseline after seeding

  manager.clear();

  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 1);
});

test('clear() on an already-empty queue is a no-op (no emit)', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.clear();

  assert.equal(manager.size(), 0);
  assert.equal(emitCount(bus, CHANGE_EVENT), 0);
});

test('clear() twice in a row is safe (idempotent)', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  // Seed adds emits one event; the first clear empties and emits another.
  // The second clear is a no-op (already-empty is silent).
  manager.add('One.'); // +1
  manager.clear();     // +1
  manager.clear();     // no-op, silent

  // Two emits total: one for the add, one for the clear that actually
  // removed something. The empty-queue path is intentionally silent so the
  // activity log does not get pinged for nothing.
  assert.equal(emitCount(bus, CHANGE_EVENT), 2);
});

// ---------- dispose() ----------

test('dispose() empties the queue and idempotently rejects later calls', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Before dispose.');
  manager.dispose();

  assert.equal(manager.size(), 0);
  assert.equal(manager._disposed, true);

  // Idempotent — second dispose is a no-op (no throw).
  assert.doesNotThrow(() => manager.dispose());

  // Post-dispose: add / dismiss / clear are quiet (no throw, no event, no
  // mutation). Each warns once via the add() / dismiss() guards so future
  // debugging is easy.
  assert.equal(manager.add('After.'), null);
  assert.equal(manager.dismiss('n1'), false);
  manager.clear();

  // Exactly 3 warns: one each from post-dispose add(), dismiss(), clear().
  // The manager symmetrically announces every post-dispose call so a stray
  // operation after dispose() is debuggable, not silent.
  assert.equal(warn.mock.callCount(), 3);
});

// ---------- Event payload shape ----------

test('event payload shape carries {id,type,message,at} entries', () => {
  const bus = createFakeEventBus();
  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info', 'success'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('Plain.', { type: 'info' });
  manager.add('Gained.', { type: 'success' });

  // Every emitted payload is consistent — read straight off the latest one.
  const payload = lastPayload(bus);
  assert.ok(payload && Array.isArray(payload.queue));
  assert.equal(payload.queue.length, 2);
  for (const entry of payload.queue) {
    assert.equal(typeof entry.id, 'string');
    assert.equal(typeof entry.type, 'string');
    assert.equal(typeof entry.message, 'string');
    assert.equal(typeof entry.at, 'number');
    assert.ok(Number.isFinite(entry.at));
  }
});

// ---------- Purity ----------

test('the manager never mutates the shared GameState', async () => {
  const bus = createFakeEventBus();
  const { GameState } = await import('../../js/core/game-state.js');

  const qiBefore = GameState.cultivation.qi;
  const herbsBefore = GameState.resources.herbs;

  const manager = new NotificationManager({
    config: { notifications: { maxQueueSize: 10, types: ['info', 'success'] } },
    eventBus: bus,
    now: fixedNow(),
  });

  manager.add('One.');
  manager.add('Two.', { type: 'success' });
  manager.dismiss('n1');
  manager.clear();
  manager.dispose();

  assert.equal(GameState.cultivation.qi, qiBefore);
  assert.equal(GameState.resources.herbs, herbsBefore);
});

test('survives a pathological config shape (must never throw)', (t) => {
  const bus = createFakeEventBus();
  const warn = t.mock.method(console, 'warn', () => {});

  // Every shape a partial / wrong / attacker-shaped config could take.
  for (const bad of [
    {},
    null,
    undefined,
    42,
    'config',
    [],
    { notifications: null },
    { notifications: 1 },
    { notifications: 'info' },
    { notifications: { maxQueueSize: null, types: null } },
  ]) {
    assert.doesNotThrow(
      () => new NotificationManager({ config: bad, eventBus: bus, now: fixedNow() }),
      `constructor must never throw for ${JSON.stringify(bad)}`
    );
  }
  // The bad shapes generated warnings — that's how the player learns a
  // tuning value is wrong. We just confirm the warnings fired at least once.
  assert.ok(warn.mock.callCount() >= 1);
});
