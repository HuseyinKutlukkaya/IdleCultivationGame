/**
 * tests/unit/event-bus.test.mjs — unit tests for js/core/event-bus.js.
 *
 * Seeds the project's automated regression suite. Uses the Node built-in
 * test runner (node --test tests/) with zero dependencies and imports the
 * real module under test (no mocks of the bus itself).
 *
 * Module under test: `EventBus` — a module-level singleton pub/sub
 * implementation. Because `node --test` runs each test file in its own
 * child process the singleton is isolated per file; the beforeEach hook
 * additionally guarantees independence between tests within this file.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with the
 * quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';

/** Reset all subscriptions before each test so tests are independent. */
beforeEach(() => {
  EventBus.clear();
});

test('subscribe + emit invokes the callback with the payload', () => {
  const calls = [];
  EventBus.subscribe('resource.gained', (payload) => calls.push(payload));

  EventBus.emit('resource.gained', { type: 'qi', amount: 5 });

  assert.deepEqual(calls, [{ type: 'qi', amount: 5 }]);
});

test('unsubscribe removes the callback so emit afterwards is a no-op', () => {
  let calls = 0;
  const onEvent = () => {
    calls += 1;
  };
  EventBus.subscribe('event', onEvent);

  EventBus.unsubscribe('event', onEvent);
  EventBus.emit('event', 'payload');

  assert.equal(calls, 0);
});

test('duplicate (event, callback) subscribe is ignored (fires once)', () => {
  let calls = 0;
  const onEvent = () => {
    calls += 1;
  };
  EventBus.subscribe('event', onEvent);
  EventBus.subscribe('event', onEvent); // duplicate pair, must be ignored

  EventBus.emit('event');

  assert.equal(calls, 1);
});

test('hasListeners is true only while at least one callback is subscribed', () => {
  const onEvent = () => {};

  assert.equal(EventBus.hasListeners('event'), false);

  EventBus.subscribe('event', onEvent);
  assert.equal(EventBus.hasListeners('event'), true);

  EventBus.unsubscribe('event', onEvent);
  assert.equal(EventBus.hasListeners('event'), false);
});

test('a throwing callback does not stop the remaining callbacks from running', (t) => {
  const results = [];
  const onFirst = () => {
    results.push('first');
    throw new Error('boom');
  };
  const onSecond = () => results.push('second');
  EventBus.subscribe('event', onFirst);
  EventBus.subscribe('event', onSecond);

  // The bus logs the listener error to console.error and swallows it.
  const errorMock = t.mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => EventBus.emit('event'));

  assert.deepEqual(results, ['first', 'second']);
  assert.equal(errorMock.mock.callCount(), 1);
  const errorArg = errorMock.mock.calls[0].arguments[1];
  assert.equal(errorArg.message, 'boom');
});

test('subscribe throws a TypeError for a non-function callback', () => {
  assert.throws(
    () => EventBus.subscribe('event', 'not a function'),
    {
      name: 'TypeError',
      message: 'EventBus.subscribe: callback must be a function.',
    },
  );
});

test('clear removes every subscription for every event', () => {
  const onEventA = () => {};
  const onEventB = () => {};
  EventBus.subscribe('event.a', onEventA);
  EventBus.subscribe('event.b', onEventB);

  EventBus.clear();

  assert.equal(EventBus.hasListeners('event.a'), false);
  assert.equal(EventBus.hasListeners('event.b'), false);
});

test('emit for an event with no subscribers is a safe no-op', () => {
  assert.doesNotThrow(() => EventBus.emit('unknown.event', 'payload'));
});
