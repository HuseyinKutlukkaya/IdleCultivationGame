/**
 * tests/unit/storage.test.mjs — unit tests for js/core/storage.js.
 *
 * Exercises the low-level localStorage save adapter. Storage reads
 * `window.localStorage` at CALL time (not import time), so each test
 * installs a fresh fake localStorage (backed by a Map) on a stubbed
 * `window` global and deletes it in afterEach.
 *
 * Coverage: load() with no stored value, save()/load() round-trip, the JSON
 * write and its return value, the write-failure path (returns false and logs
 * exactly once until the next successful write), corrupt-JSON reads and
 * clear(). console.error is mocked with `t.mock.method` where asserted.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Storage, SAVE_KEY } from '../../js/core/storage.js';

/**
 * Create a fake localStorage backed by a Map. `fail` toggles setItem
 * rejection so tests can drive the write-failure path.
 *
 * @returns {object} fake localStorage exposing store, fail, getItem,
 *          setItem and removeItem.
 */
function createFakeLocalStorage() {
  const store = new Map();
  return {
    store,
    fail: false,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (this.fail) throw new Error('QuotaExceededError');
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

/** Install the fake window/localStorage pair before every test. */
beforeEach(() => {
  globalThis.window = { localStorage: createFakeLocalStorage() };
});

/** Remove the stubbed window after every test. */
afterEach(() => {
  delete globalThis.window;
});

test('load() returns null when nothing is stored', () => {
  assert.equal(Storage.load(), null);
});

test('save()/load() round-trips the saved object', () => {
  const data = { state: { qi: 7 }, savedAt: 123 };

  const ok = Storage.save(data);

  assert.equal(ok, true);
  assert.deepEqual(Storage.load(), data);
});

test('save() returns true and stores JSON under the save key', () => {
  const data = { a: 1 };
  const { localStorage } = globalThis.window;

  const ok = Storage.save(data);

  assert.equal(ok, true);
  assert.equal(localStorage.store.has(SAVE_KEY), true);
  assert.deepEqual(JSON.parse(localStorage.store.get(SAVE_KEY)), data);
});

test('save() failure returns false and logs once, then stays quiet until a success', (t) => {
  const errorMock = t.mock.method(console, 'error', () => {});
  const { localStorage } = globalThis.window;

  // Start with a successful write so the module-level failure flag is
  // guaranteed clean regardless of the order this test runs in (a
  // successful save resets the "log once" flag).
  localStorage.fail = false;
  assert.equal(Storage.save({ a: 1 }), true);
  assert.equal(errorMock.mock.callCount(), 0);

  localStorage.fail = true;
  assert.equal(Storage.save({ a: 1 }), false);
  assert.equal(errorMock.mock.callCount(), 1);

  // Repeated failures stay quiet (autosave ticks every few seconds — the
  // error is logged once, not every tick).
  assert.equal(Storage.save({ a: 1 }), false);
  assert.equal(errorMock.mock.callCount(), 1);

  // The first successful write clears the failure flag...
  localStorage.fail = false;
  assert.equal(Storage.save({ a: 1 }), true);

  // ...so a later failure logs again.
  localStorage.fail = true;
  assert.equal(Storage.save({ a: 1 }), false);
  assert.equal(errorMock.mock.callCount(), 2);
});

test('load() returns null on corrupt JSON and logs the error', (t) => {
  const errorMock = t.mock.method(console, 'error', () => {});
  globalThis.window.localStorage.store.set(SAVE_KEY, '{ this is not json');

  assert.equal(Storage.load(), null);
  assert.equal(errorMock.mock.callCount(), 1);
});

test('clear() removes the save key', () => {
  Storage.save({ a: 1 });
  assert.notEqual(Storage.load(), null);

  Storage.clear();

  assert.equal(Storage.load(), null);
  assert.equal(globalThis.window.localStorage.store.has(SAVE_KEY), false);
});
