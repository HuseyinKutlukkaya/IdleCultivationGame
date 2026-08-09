/**
 * tests/unit/save-manager.test.mjs — unit tests for js/managers/save-manager.js.
 *
 * Exercises the persistence service with fully injected fakes (storage,
 * eventBus, serialize, restore) so no real Storage singleton, EventBus or
 * DOM is touched. Coverage: the save envelope shape, save()/load()/importSave()
 * round-trips and failure paths, clear(), the autosave listener/interval
 * lifecycle against a stubbed `window`, the migration rejections and — most
 * importantly for this security-sensitive module — _parseEnvelope rejecting
 * state carrying prototype-alias keys (__proto__, constructor, prototype).
 *
 * The unsafe-key cases MUST build their envelopes with JSON.parse: the object
 * literal syntax (`{ __proto__: x }`) sets the prototype instead of creating
 * an own data key, which is exactly the attack shape this guard exists for.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SaveManager, SAVE_SCHEMA } from '../../js/managers/save-manager.js';

/** Fake low-level storage adapter recording everything it is asked to do. */
function createFakeStorage() {
  return {
    saved: null,
    loadValue: null,
    fail: false,
    clearCount: 0,
    save(data) {
      if (this.fail) return false;
      this.saved = data;
      return true;
    },
    load() {
      return this.loadValue;
    },
    clear() {
      this.clearCount += 1;
      this.saved = null;
    },
  };
}

/** Fake pub/sub bus recording every emit. */
function createFakeEventBus() {
  return {
    emitted: [],
    emit(name, payload) {
      this.emitted.push([name, payload]);
    },
    subscribe() {},
    unsubscribe() {},
  };
}

/** Fakes shared by every test; reassigned in beforeEach. */
let storage = null;
let eventBus = null;
let restoreCalls = null;

/**
 * Build a fully-wired SaveManager around the shared fakes.
 *
 * @param {object} [options] — extra constructor options (tuning, defaults).
 * @returns {SaveManager} the configured manager.
 */
function makeManager(options = {}) {
  return new SaveManager({
    storage,
    eventBus,
    serialize: () => ({ qi: 42 }),
    restore: (state) => restoreCalls.push(state),
    engineVersion: '0.1.0',
    contentVersion: 3,
    ...options,
  });
}

/** Create fresh fakes before every test. */
beforeEach(() => {
  storage = createFakeStorage();
  eventBus = createFakeEventBus();
  restoreCalls = [];
});

/** Remove any window stub installed by a test. */
afterEach(() => {
  delete globalThis.window;
});

test('_buildEnvelope produces a fully-populated save envelope', () => {
  const manager = makeManager();

  const envelope = manager._buildEnvelope();

  assert.equal(envelope.schema, SAVE_SCHEMA);
  assert.equal(envelope.saveVersion, 1);
  assert.equal(envelope.engineVersion, '0.1.0');
  assert.equal(envelope.contentVersion, 3);
  assert.equal(envelope.migrationVersion, 1);
  assert.equal(typeof envelope.savedAt, 'number');
  assert.ok(envelope.savedAt > 0);
  assert.deepEqual(envelope.state, { qi: 42 });
});

test('save() persists the envelope, emits game:saved and updates lastSavedAt', () => {
  const manager = makeManager();

  const ok = manager.save();

  assert.equal(ok, true);
  assert.ok(storage.saved !== null);
  assert.deepEqual(storage.saved.state, { qi: 42 });
  assert.equal(manager.lastSavedAt, storage.saved.savedAt);
  assert.deepEqual(eventBus.emitted, [['game:saved', { savedAt: storage.saved.savedAt }]]);
});

test('save() returns false and stays silent when the storage write fails', () => {
  const manager = makeManager();
  storage.fail = true;

  const ok = manager.save();

  assert.equal(ok, false);
  assert.equal(storage.saved, null);
  assert.equal(manager.lastSavedAt, 0);
  assert.deepEqual(eventBus.emitted, []);
});

test('load() returns false when there is no stored save', () => {
  const manager = makeManager();
  storage.loadValue = null;

  const ok = manager.load();

  assert.equal(ok, false);
  assert.deepEqual(restoreCalls, []);
  assert.deepEqual(eventBus.emitted, []);
});

test('load() returns false for a stored value that is not a game-save envelope', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  storage.loadValue = { not: 'a save' };

  const ok = manager.load();

  assert.equal(ok, false);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(restoreCalls, []);
});

test('load() restores a valid save and emits game:restored', () => {
  const manager = makeManager();
  storage.loadValue = {
    schema: SAVE_SCHEMA,
    saveVersion: 1,
    savedAt: 123,
    state: { qi: 42 },
  };

  const ok = manager.load();

  assert.equal(ok, true);
  assert.deepEqual(restoreCalls, [{ qi: 42 }]);
  assert.equal(manager.lastSavedAt, 123);
  assert.deepEqual(eventBus.emitted, [['game:restored', { savedAt: 123 }]]);
});

test('load() returns true without emitting when no restore callback is configured', () => {
  const manager = makeManager({ restore: undefined });
  storage.loadValue = {
    schema: SAVE_SCHEMA,
    saveVersion: 1,
    savedAt: 123,
    state: { qi: 42 },
  };

  const ok = manager.load();

  assert.equal(ok, true);
  assert.deepEqual(eventBus.emitted, []);
});

test('load() rejects a save whose version has no migration path', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  storage.loadValue = {
    schema: SAVE_SCHEMA,
    saveVersion: 0, // older than the first real schema, no MIGRATIONS entry
    savedAt: 123,
    state: { qi: 42 },
  };

  const ok = manager.load();

  assert.equal(ok, false);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(restoreCalls, []);
});

test('importSave() rejects a non-string or empty save string', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();

  assert.equal(manager.importSave(''), false);
  assert.equal(manager.importSave(null), false);
  assert.equal(manager.importSave(42), false);
  assert.equal(warn.mock.callCount(), 3);
});

test('importSave() rejects invalid JSON', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();

  const ok = manager.importSave('{ not valid json');

  assert.equal(ok, false);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(storage.saved, null);
});

test('importSave() applies a valid export end-to-end (persist + restore + both events)', () => {
  const manager = makeManager();
  const exported = JSON.stringify({
    schema: SAVE_SCHEMA,
    saveVersion: 1,
    savedAt: 456,
    state: { qi: 7 },
  });

  const ok = manager.importSave(exported);

  assert.equal(ok, true);
  // The imported save was persisted as the new active save...
  assert.deepEqual(storage.saved.state, { qi: 7 });
  assert.equal(storage.saved.saveVersion, 1);
  assert.equal(storage.saved.migrationVersion, 1);
  // ...the state was restored...
  assert.deepEqual(restoreCalls, [{ qi: 7 }]);
  assert.equal(manager.lastSavedAt, 456);
  // ...and both lifecycle events were emitted, restored before saved.
  assert.deepEqual(eventBus.emitted, [
    ['game:restored', { savedAt: 456 }],
    ['game:saved', { savedAt: 456 }],
  ]);
});

test('importSave() contains a pathologically-nested payload (RangeError → false)', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();

  // JSON.parse (native) tolerates far deeper nesting than the JS-recursive
  // _hasUnsafeStateKey walk, so a payload deep enough to overflow the walk
  // still parses cleanly first and only blows up during envelope validation.
  // N = 100000 was verified on this Node build (v24) to make the recursive
  // state walk throw RangeError while JSON.parse still succeeds; the nesting
  // lives inside the envelope's `state`, which is exactly what the walk
  // inspects. If a future build changes the stack limits the depth may need
  // tuning — the contract under test is that importSave() never throws and
  // never persists.
  const N = 100000;
  const nestedState = '{"a":'.repeat(N) + '1' + '}'.repeat(N);
  const payload = `{"schema":"${SAVE_SCHEMA}","saveVersion":1,"state":${nestedState}}`;

  const ok = manager.importSave(payload);

  // The containment path converts the stack overflow into a logged false...
  assert.equal(ok, false);
  // ...the pathological payload never reaches storage or the event bus...
  assert.equal(storage.saved, null);
  assert.deepEqual(eventBus.emitted, []);
  // ...and exactly one warning is logged (the unreadable-save containment).
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(warn.mock.calls[0].arguments[0], 'SaveManager: import failed — unreadable save.');
});

test('importSave() rejects a poisoned envelope (own __proto__ key) through the public surface', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  // JSON.parse materializes "__proto__" as an own data key (the object
  // literal syntax would set the prototype instead); JSON.stringify
  // round-trips it, so this is the exact export→import attack shape.
  const state = JSON.parse('{"__proto__":{"polluted":true}}');
  const poisoned = JSON.stringify({
    schema: SAVE_SCHEMA,
    saveVersion: 1,
    savedAt: 1,
    state,
  });

  const ok = manager.importSave(poisoned);

  assert.equal(ok, false);
  // The poisoned envelope never reaches storage...
  assert.equal(storage.saved, null);
  // ...and neither lifecycle event is emitted.
  assert.deepEqual(eventBus.emitted, []);
  // Rejected with exactly the unsafe-keys warning.
  assert.equal(warn.mock.callCount(), 1);
  // No prototype pollution escaped the process.
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('clear() wipes the stored save and resets lastSavedAt', () => {
  const manager = makeManager();
  manager.save();
  assert.notEqual(manager.lastSavedAt, 0);

  manager.clear();

  assert.equal(storage.clearCount, 1);
  assert.equal(storage.saved, null);
  assert.equal(manager.lastSavedAt, 0);
});

test('start()/stop() manage the unload listener and autosave interval idempotently', () => {
  const listeners = [];
  const intervals = [];
  const cleared = [];
  globalThis.window = {
    addEventListener(name, fn) {
      listeners.push({ type: 'add', name, fn });
    },
    removeEventListener(name, fn) {
      listeners.push({ type: 'remove', name, fn });
    },
    setInterval(fn, ms) {
      const handle = intervals.length + 1;
      intervals.push({ handle, fn, ms });
      return handle;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
  };

  const manager = makeManager({ autosaveIntervalMs: 1000, saveOnUnload: true });
  manager.start();
  manager.start(); // idempotent

  assert.equal(manager.isActive, true);
  assert.equal(
    listeners.filter((entry) => entry.type === 'add' && entry.name === 'beforeunload').length,
    1
  );
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 1000);

  manager.stop();
  manager.stop(); // idempotent

  assert.equal(manager.isActive, false);
  assert.equal(
    listeners.filter((entry) => entry.type === 'remove' && entry.name === 'beforeunload')
      .length,
    1
  );
  assert.deepEqual(cleared, [intervals[0].handle]);
});

test('start() registers nothing when autosave and unload-save are both disabled', () => {
  const listeners = [];
  globalThis.window = {
    addEventListener(name, fn) {
      listeners.push([name, fn]);
    },
    removeEventListener() {},
    setInterval() {
      throw new Error('interval must not be scheduled');
    },
    clearInterval() {},
  };

  const manager = makeManager({ autosaveIntervalMs: 0, saveOnUnload: false });
  manager.start();

  assert.equal(manager.isActive, true);
  assert.deepEqual(listeners, []);
});

test('_migrate rejects a save from a newer version than this build', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  const envelope = {
    schema: SAVE_SCHEMA,
    saveVersion: 2, // > SAVE_VERSION (1) — must never be relabeled as current
    savedAt: 1,
    state: { qi: 1 },
  };

  const migrated = manager._migrate(envelope);

  assert.equal(migrated, null);
  assert.equal(warn.mock.callCount(), 1);
});

test('_migrate rejects a save version with no migration path', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  const envelope = {
    schema: SAVE_SCHEMA,
    saveVersion: 0,
    savedAt: 1,
    state: { qi: 1 },
  };

  const migrated = manager._migrate(envelope);

  assert.equal(migrated, null);
  assert.equal(warn.mock.callCount(), 1);
});

test('_parseEnvelope rejects a state carrying an own "__proto__" key', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  // JSON.parse is required: the literal syntax would set the prototype
  // instead of creating the own key the guard must detect.
  const poisoned = JSON.parse(
    `{"schema":"${SAVE_SCHEMA}","saveVersion":1,"state":{"__proto__":{"polluted":true}}}`
  );

  const envelope = manager._parseEnvelope(poisoned);

  assert.equal(envelope, null);
  assert.equal(warn.mock.callCount(), 1);
});

test('_parseEnvelope rejects state carrying "constructor" or "prototype" keys', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();

  const withConstructor = JSON.parse(
    `{"schema":"${SAVE_SCHEMA}","saveVersion":1,"state":{"constructor":{"x":1}}}`
  );
  const withPrototype = JSON.parse(
    `{"schema":"${SAVE_SCHEMA}","saveVersion":1,"state":{"prototype":{"y":2}}}`
  );

  assert.equal(manager._parseEnvelope(withConstructor), null);
  assert.equal(manager._parseEnvelope(withPrototype), null);
  assert.equal(warn.mock.callCount(), 2);
});

test('_parseEnvelope rejects unsafe keys nested anywhere in the state subtree', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  const nested = JSON.parse(
    `{"schema":"${SAVE_SCHEMA}","saveVersion":1,"state":{"player":{"title":"safe","prototype":{"z":3}}}}`
  );

  const envelope = manager._parseEnvelope(nested);

  assert.equal(envelope, null);
  assert.equal(warn.mock.callCount(), 1);
});

test('_parseEnvelope rejects null, arrays and unknown-schema values', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();

  // null (no save present) returns null silently — a fresh boot is not an error.
  assert.equal(manager._parseEnvelope(null), null);
  assert.equal(warn.mock.callCount(), 0);

  assert.equal(manager._parseEnvelope([]), null);
  assert.equal(manager._parseEnvelope({ schema: 'some-other-app/save', saveVersion: 1 }), null);
  assert.equal(manager._parseEnvelope({ schema: SAVE_SCHEMA }), null); // no saveVersion
  assert.equal(warn.mock.callCount(), 3);
});

test('_parseEnvelope accepts a well-formed envelope unchanged', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const manager = makeManager();
  const good = {
    schema: SAVE_SCHEMA,
    saveVersion: 1,
    savedAt: 123,
    state: { qi: 42 },
  };

  const envelope = manager._parseEnvelope(good);

  assert.strictEqual(envelope, good);
  assert.equal(warn.mock.callCount(), 0);
});
