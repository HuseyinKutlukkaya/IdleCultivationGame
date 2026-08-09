/**
 * tests/integration/bootstrap.test.mjs — integration tests for js/main.js.
 *
 * Exercises the application entry point end-to-end: main.js registers a
 * DOMContentLoaded listener and runs the async bootstrap that loads the
 * config and content collections, wires Game/SaveManager/Renderer, starts
 * the loop and reports boot status. The success path and the config-load
 * failure path are both covered.
 *
 * main.js touches `document` at IMPORT time (registering its listener), so
 * the module is loaded with a dynamic import AFTER a minimal document stub
 * is installed. The captured bootstrap function is then invoked against a
 * fully-stubbed environment (document, window with localStorage, fetch,
 * requestAnimationFrame, performance). Every global stub is restored in
 * afterEach.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { Game } from '../../js/core/game.js';
import { DataManager } from '../../js/core/data-manager.js';
import { SaveManager } from '../../js/managers/save-manager.js';
import { SAVE_KEY } from '../../js/core/storage.js';
import { Renderer } from '../../js/ui/renderer.js';
import { createFakeElement } from '../helpers/fake-dom.mjs';
import { createRevealTarget } from '../helpers/intersection-observer-stub.mjs';
import { installRafStub, uninstallRafStub } from '../helpers/raf-stub.mjs';

/** The bootstrap function main.js registers for DOMContentLoaded. */
let domContentLoaded = null;

/** One hour in milliseconds (used to seed an away-from-game gap). */
const HOUR_MS = 3600000;

/** Canned data files served by the stubbed fetch, keyed by URL. */
const DATA_FILES = {
  'data/game-config.json': {
    meta: { game: 'Idle Cultivation Game', version: '0.1.0' },
    loop: { tickRateMs: 1000, uiRefreshRateMs: 100, maxFrameDeltaMs: 250 },
    save: { autosaveIntervalMs: 30000, saveOnUnload: true },
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
    },
  },
  'data/manifest.json': {
    version: 1,
    meta: {},
    collections: [
      {
        id: 'realms',
        files: ['data/realms/realms.json'],
        validation: { requiredFields: ['id', 'name'], uniqueField: 'id' },
      },
    ],
  },
  'data/realms/realms.json': {
    meta: {},
    definitions: [
      { id: 'mortal', name: 'Mortal', tier: 0 },
      { id: 'qi-gathering', name: 'Qi Gathering', tier: 1 },
    ],
  },
};

/** Pristine global captures, taken in before() and restored in afterEach. */
let savedGlobals = null;

/**
 * Capture a global so it can be restored later.
 *
 * @param {string} name — global property name.
 * @returns {{ present: boolean, value: unknown }} presence flag + saved value.
 */
function captureGlobal(name) {
  return { present: name in globalThis, value: globalThis[name] };
}

/**
 * Restore a previously captured global.
 *
 * @param {string} name — global property name.
 * @param {{ present: boolean, value: unknown }} saved — captureGlobal result.
 * @returns {void}
 */
function restoreGlobal(name, saved) {
  if (saved.present) globalThis[name] = saved.value;
  else delete globalThis[name];
}

/**
 * Install the fake document: the status element, a footer year element, an
 * empty [data-bind] scan scope and the reveal targets.
 *
 * @param {object} opts — wiring options.
 * @param {object} opts.statusElement — fake element for '#status-text'.
 * @returns {void}
 */
function installDocument({ statusElement }) {
  const yearElement = createFakeElement();
  globalThis.document = {
    documentElement: createRevealTarget(),
    getElementById(id) {
      if (id === 'status-text') return statusElement;
      if (id === 'year') return yearElement;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
  };
}

/**
 * Install the fake window: localStorage (Map-backed, optionally pre-seeded),
 * autosave listeners and interval recorders for SaveManager.start(), plus the
 * debug-global surface bootstrap writes __game/__dataManager/__saveManager/
 * __renderer/__offlineProgress onto.
 *
 * @param {Map<string, string>} [initialStore] — pre-seeded localStorage
 *        contents (e.g. a saved game written before the boot).
 * @returns {{ listeners: Array, intervals: Array<{handle: number, ms: number}> }}
 *          the recorded listeners and intervals.
 */
function installWindow(initialStore = new Map()) {
  const store = initialStore;
  const listeners = [];
  const intervals = [];
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
    addEventListener(name, fn) {
      listeners.push([name, fn]);
    },
    removeEventListener() {},
    setInterval(fn, ms) {
      const handle = intervals.length + 1;
      intervals.push({ handle, fn, ms });
      return handle;
    },
    clearInterval() {},
  };
  return { listeners, intervals };
}

/**
 * Normalize a fetch argument to the relative data-file key used by
 * DATA_FILES. config.js resolves the config URL against the project root
 * (an absolute URL/URL object), while DataManager fetches relative strings —
 * both end with the relative key, so matching by suffix keeps the mock and
 * the recorded call list stable.
 *
 * @param {string|URL} url — the fetch argument.
 * @returns {string} the matching DATA_FILES key (or the raw string).
 */
function normalizeDataUrl(url) {
  const text = String(url);
  const known = Object.keys(DATA_FILES).find((key) => text.endsWith(key));
  return known || text;
}

/**
 * Install the stubbed global fetch serving the canned data files.
 *
 * @param {Object<string, 'reject'|true>} [overrides] — URL → failure mode:
 *        'reject' throws, true returns a non-ok response.
 * @returns {Array<string>} the normalized data-file keys the bootstrap
 *          requested, in order.
 */
function makeFetch(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const key = normalizeDataUrl(url);
    calls.push(key);
    const failure = overrides[key];
    if (failure === 'reject') {
      throw new Error(`network down for ${key}`);
    }
    if (failure) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    const body = DATA_FILES[key];
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  };
  return calls;
}

/**
 * Capture the pristine globals, install a minimal document so main.js can
 * register its DOMContentLoaded listener, then load the module. Runs once.
 */
before(async () => {
  savedGlobals = {
    document: captureGlobal('document'),
    window: captureGlobal('window'),
    fetch: captureGlobal('fetch'),
    requestAnimationFrame: captureGlobal('requestAnimationFrame'),
    cancelAnimationFrame: captureGlobal('cancelAnimationFrame'),
  };

  // main.js executes `document.addEventListener('DOMContentLoaded', bootstrap)`
  // at import time, so a document with a capturing addEventListener must
  // exist before the dynamic import.
  globalThis.document = {
    addEventListener(name, fn) {
      if (name === 'DOMContentLoaded') domContentLoaded = fn;
    },
  };
  await import('../../js/main.js');

  assert.ok(domContentLoaded, 'main.js registered its DOMContentLoaded listener');
});

/** Reset the bus and install the per-test stubs before every test. */
beforeEach(() => {
  EventBus.clear();
  installRafStub();
});

/** Restore every stubbed global after every test. */
afterEach(() => {
  uninstallRafStub();
  restoreGlobal('document', savedGlobals.document);
  restoreGlobal('window', savedGlobals.window);
  restoreGlobal('fetch', savedGlobals.fetch);
  restoreGlobal('requestAnimationFrame', savedGlobals.requestAnimationFrame);
  restoreGlobal('cancelAnimationFrame', savedGlobals.cancelAnimationFrame);
});

test('successful bootstrap wires the app globals and reports the definition count', async (t) => {
  const statusElement = createFakeElement();
  installDocument({ statusElement });
  const { intervals } = installWindow();
  const fetchCalls = makeFetch();
  const errorMock = t.mock.method(console, 'error', () => {});

  await domContentLoaded();

  assert.equal(errorMock.mock.callCount(), 0);
  assert.equal(
    statusElement.textContent,
    'Scaffold ready — 2 definitions loaded. Game loop running.'
  );
  // Debug globals exposed for the developer console.
  assert.ok(globalThis.window.__game instanceof Game);
  assert.ok(globalThis.window.__dataManager instanceof DataManager);
  assert.ok(globalThis.window.__saveManager instanceof SaveManager);
  assert.ok(globalThis.window.__renderer instanceof Renderer);
  // Config + manifest + every registered collection were fetched in order.
  assert.deepEqual(fetchCalls, [
    'data/game-config.json',
    'data/manifest.json',
    'data/realms/realms.json',
  ]);
  // Autosave interval comes from config.save.autosaveIntervalMs (30000).
  assert.deepEqual(
    intervals.map((interval) => interval.ms),
    [30000]
  );
});

test('bootstrap applies offline progress from a restored save and reports the gains', async (t) => {
  const statusElement = createFakeElement();
  installDocument({ statusElement });

  // Seed a save written ~2h ago: the qi producer in the canned config runs
  // at 2 qi/s against a 100,000 cap, so the boot must add ~14,400 qi and
  // report the gains in the status bar.
  const awayMs = 2 * HOUR_MS;
  const lastSeenAt = Date.now() - awayMs;
  const store = new Map([
    [
      SAVE_KEY,
      JSON.stringify({
        schema: 'idle-cultivation-game/save',
        saveVersion: 1,
        engineVersion: '0.1.0',
        contentVersion: 1,
        migrationVersion: 1,
        savedAt: lastSeenAt,
        state: {
          meta: { lastSeenAt },
          cultivation: { qi: 0, qiMax: 100000, qiPerSecond: 2 },
        },
      }),
    ],
  ]);
  installWindow(store);
  makeFetch();
  const errorMock = t.mock.method(console, 'error', () => {});

  await domContentLoaded();

  assert.equal(errorMock.mock.callCount(), 0);
  // The boot runs against the real clock, so the exact amount tolerates a
  // few seconds of boot latency: "2h" and +14400..+14409 qi at a 2/s rate.
  assert.match(
    statusElement.textContent,
    /Save restored\. Offline gains: 2h \(Qi: \+1440\d\)/,
    `unexpected status text: ${statusElement.textContent}`
  );
  // The offline system is exposed for debugging and ran enabled.
  assert.ok(globalThis.window.__offlineProgress.isEnabled);
  assert.equal(globalThis.window.__offlineProgress.producers.length, 1);
});

test('config-load failure sets the error status and logs to the console', async (t) => {
  const statusElement = createFakeElement();
  installDocument({ statusElement });
  installWindow();
  const fetchCalls = makeFetch({ 'data/game-config.json': 'reject' });
  const errorMock = t.mock.method(console, 'error', () => {});

  await domContentLoaded();

  assert.equal(
    statusElement.textContent,
    'Failed to load. See console for details.'
  );
  // loadConfig logs its own failure, then bootstrap logs "Bootstrap failed:".
  assert.equal(errorMock.mock.callCount(), 2);
  assert.equal(errorMock.mock.calls[1].arguments[0], 'Bootstrap failed:');
  // Nothing further was fetched and no debug globals were assigned.
  assert.deepEqual(fetchCalls, ['data/game-config.json']);
  assert.equal(globalThis.window.__game, undefined);
  assert.equal(globalThis.window.__saveManager, undefined);
});
