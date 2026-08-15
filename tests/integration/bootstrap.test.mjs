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
import { GameState } from '../../js/core/game-state.js';
import { DataManager } from '../../js/core/data-manager.js';
import { SaveManager } from '../../js/managers/save-manager.js';
import { NotificationManager } from '../../js/managers/notification-manager.js';
import { SAVE_KEY } from '../../js/core/storage.js';
import { MeditationSystem } from '../../js/systems/meditation.js';
import { MilestoneSystem } from '../../js/systems/milestones.js';
import { QiSystem } from '../../js/systems/qi.js';
import { RealmSystem } from '../../js/systems/realms.js';
import { ResourceSystem } from '../../js/systems/resources.js';
import { InventorySystem } from '../../js/systems/inventory.js';
import { UpgradeSystem } from '../../js/systems/upgrades.js';
import { BreakthroughSystem } from '../../js/systems/breakthroughs.js';
import { TribulationSystem } from '../../js/systems/tribulations.js';
import { SpiritRootSystem } from '../../js/systems/spirit-roots.js';
import { DantianSystem } from '../../js/systems/dantian.js';
import { BloodlineSystem } from '../../js/systems/bloodlines.js';
import { SoulSystem } from '../../js/systems/soul.js';
import { TalentSystem } from '../../js/systems/talents.js';
import { ComprehensionSystem } from '../../js/systems/comprehension.js';
import { DestinySystem } from '../../js/systems/destiny.js';
import { LuckSystem } from '../../js/systems/luck.js';
import { NotationFormatter } from '../../js/ui/notation.js';
import { Renderer } from '../../js/ui/renderer.js';
import { initActivityLog } from '../../js/ui/activity-log.js';
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
    meditation: {
      baseQiPerSecond: 2,
    },
    qi: {
      baseMaxQi: 100,
      sources: [
        { id: 'meditation', label: 'Meditation', ratePath: 'cultivation.qiSources.meditation' },
        { id: 'upgrades', label: 'Upgrades', ratePath: 'cultivation.qiSources.upgrades' },
      ],
    },
    resources: {
      items: [
        { id: 'spiritStones', label: 'Spirit Stones' },
        { id: 'herbs', label: 'Herbs' },
        { id: 'jade', label: 'Jade' },
        { id: 'qiCondensationPills', label: 'Qi Condensation Pills' },
      ],
    },
    breakthroughs: {
      progressRate: 1,
    },
    notifications: {
      maxQueueSize: 50,
      types: ['info', 'success', 'warning', 'error', 'achievement'],
    },
    notation: {
      defaultStyle: 'standard',
      styles: {
        standard: { threshold: 1000, suffixes: ['K', 'M', 'B', 'T'] },
        scientific: { threshold: 1000000, suffixes: [] },
      },
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
      {
        id: 'items',
        files: ['data/items/items.json'],
        validation: { requiredFields: ['id', 'name', 'stackSize'], uniqueField: 'id' },
      },
      {
        id: 'upgrades',
        files: ['data/upgrades/upgrades.json'],
        validation: {
          requiredFields: [
            'id',
            'name',
            'category',
            'costResource',
            'baseCost',
            'costGrowth',
            'effectPerLevel',
          ],
          uniqueField: 'id',
        },
      },
      {
        id: 'breakthroughs',
        files: ['data/breakthroughs/breakthroughs.json'],
        validation: {
          requiredFields: ['realmId', 'requiredProgress', 'cost', 'bottleneck', 'results'],
          uniqueField: 'realmId',
        },
      },
      {
        id: 'tribulations',
        files: ['data/tribulations/tribulations.json'],
        validation: {
          requiredFields: ['realmId', 'tribulationType', 'results'],
          uniqueField: 'realmId',
        },
      },
      {
        id: 'spirit-roots',
        files: ['data/spirit-roots/spirit-roots.json'],
        validation: {
          requiredFields: ['id', 'name', 'tier', 'elements', 'attributes', 'speedMultiplier', 'weight'],
          uniqueField: 'id',
        },
      },
      {
        id: 'dantian',
        files: ['data/dantian/dantian.json'],
        validation: {
          requiredFields: ['id', 'name', 'capacityMultiplier', 'densityMultiplier', 'purityMultiplier', 'efficiencyMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'bloodlines',
        files: ['data/bloodlines/bloodlines.json'],
        validation: {
          requiredFields: ['id', 'name', 'cultivationSpeedMultiplier', 'qiMaxMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'soul',
        files: ['data/soul/soul.json'],
        validation: {
          requiredFields: ['id', 'name', 'stabilityMultiplier', 'purityMultiplier', 'willpowerMultiplier', 'comprehensionMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'talents',
        files: ['data/talents/talents.json'],
        validation: {
          requiredFields: ['id', 'name', 'learningSpeedMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'comprehension',
        files: ['data/comprehension/comprehension.json'],
        validation: {
          requiredFields: ['id', 'name', 'daoProgressMultiplier', 'techniqueEfficiencyMultiplier', 'breakthroughEfficiencyMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'destiny',
        files: ['data/destiny/destiny.json'],
        validation: {
          requiredFields: ['id', 'name', 'fortuneMultiplier', 'calamityMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'luck',
        files: ['data/luck/luck.json'],
        validation: {
          requiredFields: ['id', 'name', 'craftingMultiplier', 'dropMultiplier'],
          uniqueField: 'id',
        },
      },
      {
        id: 'milestones',
        files: ['data/milestones/milestones.json'],
        validation: {
          requiredFields: ['id', 'name', 'stat', 'threshold', 'reward'],
          uniqueField: 'id',
        },
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
  'data/items/items.json': {
    meta: {},
    definitions: [
      { id: 'spirit-herb', name: 'Spirit Herb', stackSize: 99, category: 'herb', grade: 'Mortal', quality: 'Normal', value: 5, tags: ['herb'], icon: '' },
    ],
  },
  'data/upgrades/upgrades.json': {
    meta: {},
    definitions: [
      {
        id: 'foundation-breathing',
        name: 'Foundation Breathing',
        description: '+1 qi/s per level.',
        category: 'qiRateAdd',
        costResource: 'spiritStones',
        baseCost: 10,
        costGrowth: 1.5,
        effectPerLevel: 1,
        maxLevel: null,
      },
    ],
  },
  'data/breakthroughs/breakthroughs.json': {
    meta: {},
    definitions: [
      {
        realmId: 'mortal',
        requiredProgress: 1000,
        cost: { spiritStones: 0 },
        bottleneck: [],
        results: [
          { outcome: 'success', weight: 100 },
          { outcome: 'failure', weight: 0, progressLoss: 0 },
        ],
      },
      {
        realmId: 'qi-gathering',
        requiredProgress: 1500,
        cost: { spiritStones: 50 },
        bottleneck: [{ id: 'spirit-herb', count: 1 }],
        results: [
          { outcome: 'success', weight: 100 },
          { outcome: 'failure', weight: 0, progressLoss: 0 },
        ],
      },
    ],
  },
  'data/tribulations/tribulations.json': {
    meta: {},
    definitions: [
      {
        realmId: 'mortal',
        tribulationType: null,
        results: [],
      },
      {
        realmId: 'qi-gathering',
        tribulationType: 'lightning',
        results: [
          { outcome: 'survived', weight: 65 },
          { outcome: 'barely-survived', weight: 15 },
          { outcome: 'injured', weight: 12, progressLoss: 0.5 },
          { outcome: 'near-death', weight: 8, progressLoss: 1 },
        ],
      },
    ],
  },
    'data/spirit-roots/spirit-roots.json': {
    meta: {},
    definitions: [
      {
        id: 'no-root',
        name: 'No Root',
        tier: 0,
        elements: [],
        attributes: { purity: 0, stability: 0.05, growth: 0, mutation: 0, compatibility: 0.1 },
        speedMultiplier: 0.85,
        weight: 100,
      },
      {
        id: 'chaos',
        name: 'Chaos',
        tier: 9,
        elements: ['time'],
        attributes: { purity: 1, stability: 0.95, growth: 1, mutation: 1, compatibility: 1 },
        speedMultiplier: 2.7,
        weight: 1,
      },
    ],
  },
  'data/dantian/dantian.json': {
    meta: {},
    definitions: [
      { id: 'cracked', name: 'Cracked Dantian', description: 'A fractured dantian that barely holds qi.', capacityMultiplier: 0.60, densityMultiplier: 0.60, purityMultiplier: 0.60, efficiencyMultiplier: 0.60 },
      { id: 'normal', name: 'Normal Dantian', description: 'A standard-sized dantian — a solid foundation.', capacityMultiplier: 1.00, densityMultiplier: 1.00, purityMultiplier: 1.00, efficiencyMultiplier: 1.00 },
    ],
  },
  'data/bloodlines/bloodlines.json': {
    meta: {},
    definitions: [
      { id: 'ancient-human', name: 'Ancient Human', description: 'The baseline bloodline of every mortal — no innate edge, no weakness.', cultivationSpeedMultiplier: 1.00, qiMaxMultiplier: 1.00 },
      { id: 'dragon', name: 'Dragon Bloodline', description: 'A sovereign bloodline whose might hastens cultivation and expands the sea of qi.', cultivationSpeedMultiplier: 1.85, qiMaxMultiplier: 1.70 },
    ],
  },
  'data/soul/soul.json': {
    meta: {},
    definitions: [
      { id: 'stable', name: 'Stable Soul', description: 'A balanced soul — the steady foundation every cultivator builds upon.', stabilityMultiplier: 1.00, purityMultiplier: 1.00, willpowerMultiplier: 1.00, comprehensionMultiplier: 1.00 },
      { id: 'chaos-soul', name: 'Chaos Soul', description: 'A primordial, all-consuming soul that bends the very laws of spirit.', stabilityMultiplier: 2.00, purityMultiplier: 1.70, willpowerMultiplier: 2.50, comprehensionMultiplier: 1.70 },
    ],
  },
  'data/talents/talents.json': {
    meta: {},
    definitions: [
      { id: 'ordinary', name: 'Ordinary', description: 'The baseline talent every mortal is born with — no innate edge, no weakness.', learningSpeedMultiplier: 1.0 },
    ],
  },
  'data/comprehension/comprehension.json': {
    meta: {},
    definitions: [
      { id: 'standard', name: 'Standard', description: 'The baseline comprehension every mortal is born with — a steady, unremarkable mind.', daoProgressMultiplier: 1.0, techniqueEfficiencyMultiplier: 1.0, breakthroughEfficiencyMultiplier: 1.0 },
    ],
  },
  'data/destiny/destiny.json': {
    meta: {},
    definitions: [
      { id: 'mundane', name: 'Mundane', description: 'A common lot shared by most cultivators — no special favor, no unusual curse, just the long road ahead.', fortuneMultiplier: 1.00, calamityMultiplier: 1.00 },
      { id: 'son-of-heaven', name: 'Son of Heaven', description: 'A destiny as vast as the sky — the heavens themselves conspire on their behalf, and calamity dare not touch them.', fortuneMultiplier: 2.50, calamityMultiplier: 2.10 },
    ],
  },
  'data/luck/luck.json': {
    meta: {},
    definitions: [
      { id: 'average', name: 'Average', description: 'No more and no less fortunate than the next cultivator — the ordinary odds of an ordinary life.', craftingMultiplier: 1.00, dropMultiplier: 1.00 },
      { id: 'fortunes-darling', name: 'Fortune\'s Darling', description: 'Fortune itself dotes on them like a favored child — the extraordinary becomes their everyday norm.', craftingMultiplier: 2.10, dropMultiplier: 2.50 },
    ],
  },
  'data/milestones/milestones.json': {
    meta: {},
    definitions: [
      { id: 'first-qi', name: 'First Qi Gathered', description: 'Gather 100 total qi.', stat: 'qiGenerated', threshold: 100, reward: { spiritStones: 5 } },
      { id: 'first-breakthrough', name: 'First Breakthrough', description: 'Complete your first breakthrough.', stat: 'breakthroughsTotal', threshold: 1, reward: { spiritStones: 25 } },
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
    'Scaffold ready — 24 definitions loaded. Game loop running.'
  );
  // Debug globals exposed for the developer console.
  assert.ok(globalThis.window.__game instanceof Game);
  assert.ok(globalThis.window.__dataManager instanceof DataManager);
  assert.ok(globalThis.window.__saveManager instanceof SaveManager);
  assert.ok(globalThis.window.__renderer instanceof Renderer);
  assert.ok(globalThis.window.__meditation instanceof MeditationSystem);
  assert.ok(globalThis.window.__qi instanceof QiSystem);
  assert.ok(globalThis.window.__resources instanceof ResourceSystem);
  // The realm system is wired from the canned realms fixture (two
  // definitions, no effect fields): the fresh 'Mortal' state resolves to
  // the mortal definition, the canonical identity + neutral effect defaults
  // land in the cultivation slice (multipliers 1, lifespan 0 — the fixture
  // carries no effect fields, so the defensive coercion kicks in).
  assert.ok(globalThis.window.__realms instanceof RealmSystem);
  assert.equal(globalThis.window.__realms.count, 2);
  assert.equal(globalThis.window.__realms.current().id, 'mortal');
  assert.equal(globalThis.window.__realms.current().name, 'Mortal');
  assert.equal(globalThis.window.__realms.next().id, 'qi-gathering');
  assert.equal(GameState.cultivation.realm, 'Mortal');
  assert.equal(GameState.cultivation.realmTier, 0);
  assert.equal(GameState.cultivation.nextRealm, 'Qi Gathering');
  assert.equal(GameState.cultivation.realmEffects.qiMaxMultiplier, 1);
  assert.equal(GameState.cultivation.realmEffects.cultivationSpeedMultiplier, 1);
  assert.equal(GameState.cultivation.realmEffects.powerMultiplier, 1);
  assert.equal(GameState.cultivation.realmEffects.lifespanYears, 0);
  // The resource wallet is wired from config.resources: all four resources
  // are managed and their balances start at the fresh-state zeros.
  assert.equal(globalThis.window.__resources.resources.length, 4);
  // Master's parting gift: a fresh boot lands 50 spirit stones (the only
  // Phase-2 spirit-stone source until Sects land in Phase 5). The matching
  // narrative is in the notification queue (verified below).
  assert.equal(globalThis.window.__resources.get('spiritStones'), 50);
  // The inventory system is wired with the DataManager: the canonical fresh
  // inventory slice is active (20 slots, empty). With the canned items
  // collection present, a known item id is added (5 of 'spirit-herb');
  // the next assertion confirms a stack shows up in state.
  assert.ok(globalThis.window.__inventory instanceof InventorySystem);
  assert.equal(globalThis.window.__inventory.totalSlots, 20);
  assert.equal(globalThis.window.__inventory.usedSlots, 0);
  assert.equal(globalThis.window.__inventory.add('spirit-herb', 5), 5);
  assert.equal(GameState.inventory.slots.used, 1);
  assert.deepEqual(GameState.inventory.items, [{ id: 'spirit-herb', count: 5 }]);
  // Drain the stack so the rest of the test sees the canonical fresh
  // inventory shape (the assertion is otherwise unchanged).
  globalThis.window.__inventory.remove('spirit-herb', 5);
  assert.equal(GameState.inventory.slots.used, 0);
  assert.deepEqual(GameState.inventory.items, []);
  // The Upgrades system is wired: the catalog comes from the loaded
  // 'upgrades' collection (size 1 in this canned fixture), every upgrade
  // starts at level 0, and the qi aggregate slot lands at 0 until a level
  // is bought. The master's-parting-gift endowment covers the cheapest
  // upgrade on first boot, so the very first purchase succeeds.
  assert.ok(globalThis.window.__upgrades instanceof UpgradeSystem);
  assert.equal(globalThis.window.__upgrades.list().length, 1);
  assert.equal(globalThis.window.__upgrades.level('foundation-breathing'), 0);
  assert.equal(globalThis.window.__upgrades.cost('foundation-breathing'), 10);
  assert.equal(GameState.cultivation.qiSources.upgrades, 0);
  assert.equal(globalThis.window.__resources.get('spiritStones'), 50);
  assert.equal(
    globalThis.window.__upgrades.purchase('foundation-breathing'),
    true
  );
  assert.equal(globalThis.window.__upgrades.level('foundation-breathing'), 1);
  assert.equal(globalThis.window.__resources.get('spiritStones'), 40);
  assert.equal(GameState.cultivation.qiSources.upgrades, 1);
  // The Breakthrough system is wired with the DataManager: the breakthrough
  // tables come from the loaded 'breakthroughs' collection (2 canned entries
  // for the two canned realms). The constructor boot-syncs the current
  // realm's gates into the cultivation slice — the mortal entry (required
  // progress 1000, cost 0) is active from the first tick (no save present
  // to override it). Attempts gate on the canonical requirements: progress
  // 0 < 1000 → 'progress' reason, zero mutation, no event.
  assert.ok(globalThis.window.__breakthroughs instanceof BreakthroughSystem);
  assert.equal(globalThis.window.__breakthroughs.count, 2);
  assert.equal(globalThis.window.__breakthroughs.byRealm('mortal').requiredProgress, 1000);
  assert.equal(globalThis.window.__breakthroughs.byRealm('qi-gathering').requiredProgress, 1500);
  assert.equal(globalThis.window.__breakthroughs.byRealm('missing'), null);
  assert.equal(GameState.cultivation.realmProgressMax, 1000);
  assert.equal(GameState.cultivation.breakthroughCost, 0);
  assert.equal(GameState.cultivation.realmProgress, 0);
  assert.deepEqual(globalThis.window.__breakthroughs.attempt(), {
    outcome: null,
    advanced: false,
    reason: 'progress',
  });
  // requirements() mirrors the same read-only gate snapshot: canAttempt is
  // false while progress 0 < required 1000 (the attempt above also left the
  // slice untouched — progress stayed 0, cost stayed 0, stats stayed 0).
  assert.equal(globalThis.window.__breakthroughs.requirements().canAttempt, false);
  // The Tribulation system is wired with the DataManager: the tribulation
  // table comes from the loaded 'tribulations' collection (2 canned entries
  // for the two canned realms — mortal ungated, qi-gathering lightning).
  // The fresh boot at Mortal (ungated) lands the neutral gate and the
  // breakthrough gate stays open (tribulationRequired false — the pending
  // 'progress' reason above is unaffected). A realm change into a gated
  // realm opens the gate; a change back neutralizes it.
  assert.ok(globalThis.window.__tribulations instanceof TribulationSystem);
  assert.equal(globalThis.window.__tribulations.count, 2);
  assert.equal(
    globalThis.window.__tribulations.byRealm('mortal').tribulationType,
    null
  );
  assert.equal(
    globalThis.window.__tribulations.byRealm('qi-gathering').tribulationType,
    'lightning'
  );
  assert.equal(globalThis.window.__tribulations.byRealm('missing'), null);
  assert.deepEqual(GameState.tribulations, {
    type: null,
    pending: false,
    survived: false,
  });
  assert.equal(globalThis.window.__tribulations.requirements().canFace, false);
  // Enter the gated realm → the gate opens (pending true, canFace true);
  // back to Mortal → neutral again (setRealm fires no tick and the canned
  // realms carry no effect fields, so later assertions like qiPerSecond === 2
  // are unaffected).
  assert.equal(globalThis.window.__realms.setRealm('qi-gathering'), true);
  assert.deepEqual(GameState.tribulations, {
    type: 'lightning',
    pending: true,
    survived: false,
  });
  assert.equal(globalThis.window.__tribulations.requirements().canFace, true);
  assert.equal(globalThis.window.__realms.setRealm('mortal'), true);
  assert.deepEqual(GameState.tribulations, {
    type: null,
    pending: false,
    survived: false,
  });
  // The Spirit Roots system is wired with the DataManager: the ladder comes
  // from the loaded 'spirit-roots' collection (2 canned entries — no-root
  // and chaos). The boot leaves the canonical fresh neutral state: the
  // unawakened root (id 'unawakened', tier -1), the cultivation slot at the
  // neutral 1 (restored saves stay numerically identical to today) and the
  // player display name 'Unawakened' — no roll happens at boot.
  assert.ok(globalThis.window.__spiritRoots instanceof SpiritRootSystem);
  assert.equal(globalThis.window.__spiritRoots.count, 2);
  assert.equal(
    globalThis.window.__spiritRoots.byId('no-root').speedMultiplier,
    0.85
  );
  assert.equal(
    globalThis.window.__spiritRoots.byId('chaos').name,
    'Chaos'
  );
  assert.equal(globalThis.window.__spiritRoots.byId('missing'), null);
  assert.deepEqual(GameState.spiritRoot, {
    id: 'unawakened',
    name: 'Unawakened',
    tier: -1,
    elements: [],
    purity: 0,
    stability: 0,
    growth: 0,
    mutation: 0,
    compatibility: 0,
    speedMultiplier: 1,
  });
  assert.equal(GameState.cultivation.spiritRootMultiplier, 1);
  assert.equal(GameState.player.spiritRoot, 'Unawakened');
  // The Dantian system is wired with the DataManager: the ladder comes from
  // the loaded 'dantian' collection (2 canned entries — cracked and normal).
  // The boot leaves the canonical fresh neutral state: the normal dantian
  // (id 'normal', all 1.0× multipliers), the cultivation slots at 1 and the
  // player display name 'Normal Dantian' — no roll happens at boot.
  assert.ok(globalThis.window.__dantian instanceof DantianSystem);
  assert.equal(globalThis.window.__dantian.count, 2);
  assert.equal(
    globalThis.window.__dantian.byId('cracked').capacityMultiplier,
    0.60
  );
  assert.equal(
    globalThis.window.__dantian.byId('normal').name,
    'Normal Dantian'
  );
  assert.equal(globalThis.window.__dantian.byId('missing'), null);
  assert.deepEqual(GameState.dantian, {
    id: 'normal',
    name: 'Normal Dantian',
    capacityMultiplier: 1.0,
    densityMultiplier: 1.0,
    purityMultiplier: 1.0,
    efficiencyMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.dantianCapacityMultiplier, 1);
  assert.equal(GameState.cultivation.dantianDensityMultiplier, 1);
  assert.equal(GameState.cultivation.dantianPurityMultiplier, 1);
  assert.equal(GameState.cultivation.dantianEfficiencyMultiplier, 1);
  assert.equal(GameState.player.dantian, 'Normal Dantian');
  // The Bloodline system is wired with the DataManager: the ladder comes
  // from the loaded 'bloodlines' collection (2 canned entries — ancient-human
  // and dragon). The boot leaves the canonical fresh neutral state: the
  // ancient-human bloodline (all 1.0× multipliers), the cultivation slots at
  // 1 and the player display name 'Ancient Human' — no roll happens at boot.
  assert.ok(globalThis.window.__bloodlines instanceof BloodlineSystem);
  assert.equal(globalThis.window.__bloodlines.count, 2);
  assert.equal(
    globalThis.window.__bloodlines.byId('ancient-human').cultivationSpeedMultiplier,
    1.0
  );
  assert.equal(
    globalThis.window.__bloodlines.byId('dragon').name,
    'Dragon Bloodline'
  );
  assert.equal(globalThis.window.__bloodlines.byId('missing'), null);
  assert.deepEqual(GameState.bloodlines, {
    id: 'ancient-human',
    name: 'Ancient Human',
    cultivationSpeedMultiplier: 1.0,
    qiMaxMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.bloodlineSpeedMultiplier, 1);
  assert.equal(GameState.cultivation.bloodlineQiMaxMultiplier, 1);
  assert.equal(GameState.player.bloodline, 'Ancient Human');
  // The Soul system is wired with the DataManager: the ladder comes from the
  // loaded 'soul' collection (2 canned entries — stable and chaos-soul). The
  // boot leaves the canonical fresh neutral state: the stable soul (all 1.0×
  // multipliers), the four future-consumer cultivation slots at 1 and the
  // player display name 'Stable Soul' — no roll happens at boot.
  assert.ok(globalThis.window.__soul instanceof SoulSystem);
  assert.equal(globalThis.window.__soul.count, 2);
  assert.equal(
    globalThis.window.__soul.byId('stable').stabilityMultiplier,
    1.0
  );
  assert.equal(
    globalThis.window.__soul.byId('chaos-soul').name,
    'Chaos Soul'
  );
  assert.equal(globalThis.window.__soul.byId('missing'), null);
  assert.deepEqual(GameState.soul, {
    id: 'stable',
    name: 'Stable Soul',
    stabilityMultiplier: 1.0,
    purityMultiplier: 1.0,
    willpowerMultiplier: 1.0,
    comprehensionMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.soulStabilityMultiplier, 1);
  assert.equal(GameState.cultivation.soulPurityMultiplier, 1);
  assert.equal(GameState.cultivation.soulWillpowerMultiplier, 1);
  assert.equal(GameState.cultivation.soulComprehensionMultiplier, 1);
  assert.equal(GameState.player.soul, 'Stable Soul');
  // The Talent system is wired with the DataManager: the ladder comes from
  // the loaded 'talents' collection (1 canned entry — ordinary). The boot
  // leaves the canonical fresh neutral state: the ordinary talent (1.0×
  // learning speed), the future-consumer cultivation slot at 1 and the
  // player display name 'Ordinary' — no roll happens at boot.
  assert.ok(globalThis.window.__talents instanceof TalentSystem);
  assert.equal(globalThis.window.__talents.count, 1);
  assert.equal(
    globalThis.window.__talents.byId('ordinary').learningSpeedMultiplier,
    1.0
  );
  assert.equal(globalThis.window.__talents.byId('missing'), null);
  assert.deepEqual(GameState.talents, {
    id: 'ordinary',
    name: 'Ordinary',
    learningSpeedMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.talentLearningSpeedMultiplier, 1);
  assert.equal(GameState.player.talent, 'Ordinary');
  // The Comprehension system is wired with the DataManager: the ladder comes
  // from the loaded 'comprehension' collection (1 canned entry — standard).
  // The boot leaves the canonical fresh neutral state: the standard
  // comprehension (all 1.0× multipliers), the three future-consumer
  // cultivation slots at 1 and the player display name 'Standard' — no roll
  // happens at boot.
  assert.ok(globalThis.window.__comprehension instanceof ComprehensionSystem);
  assert.equal(globalThis.window.__comprehension.count, 1);
  assert.equal(
    globalThis.window.__comprehension.byId('standard').daoProgressMultiplier,
    1.0
  );
  assert.equal(globalThis.window.__comprehension.byId('missing'), null);
  assert.deepEqual(GameState.comprehension, {
    id: 'standard',
    name: 'Standard',
    daoProgressMultiplier: 1.0,
    techniqueEfficiencyMultiplier: 1.0,
    breakthroughEfficiencyMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.comprehensionDaoProgressMultiplier, 1);
  assert.equal(GameState.cultivation.comprehensionTechniqueEfficiencyMultiplier, 1);
  assert.equal(GameState.cultivation.comprehensionBreakthroughEfficiencyMultiplier, 1);
  assert.equal(GameState.player.comprehension, 'Standard');
  // The Destiny system is wired with the DataManager: the ladder comes from
  // the loaded 'destiny' collection (2 canned entries — mundane and
  // son-of-heaven). The boot leaves the canonical fresh neutral state: the
  // mundane destiny (all 1.0× multipliers), the two future-consumer
  // cultivation slots at 1 and the player display name 'Mundane' — no roll
  // happens at boot.
  assert.ok(globalThis.window.__destiny instanceof DestinySystem);
  assert.equal(globalThis.window.__destiny.count, 2);
  assert.equal(
    globalThis.window.__destiny.byId('mundane').fortuneMultiplier,
    1.0
  );
  assert.equal(
    globalThis.window.__destiny.byId('son-of-heaven').name,
    'Son of Heaven'
  );
  assert.equal(globalThis.window.__destiny.byId('missing'), null);
  assert.deepEqual(GameState.destiny, {
    id: 'mundane',
    name: 'Mundane',
    fortuneMultiplier: 1.0,
    calamityMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.destinyFortuneMultiplier, 1);
  assert.equal(GameState.cultivation.destinyCalamityMultiplier, 1);
  assert.equal(GameState.player.destiny, 'Mundane');
  // The Luck system is wired with the DataManager: the ladder comes from the
  // loaded 'luck' collection (2 canned entries — average and
  // fortunes-darling). The boot leaves the canonical fresh neutral state: the
  // average luck (all 1.0× multipliers), the two future-consumer cultivation
  // slots at 1 and the player display name 'Average' — no roll happens at
  // boot.
  assert.ok(globalThis.window.__luck instanceof LuckSystem);
  assert.equal(globalThis.window.__luck.count, 2);
  assert.equal(
    globalThis.window.__luck.byId('average').craftingMultiplier,
    1.0
  );
  assert.equal(
    globalThis.window.__luck.byId('fortunes-darling').name,
    'Fortune\'s Darling'
  );
  assert.equal(globalThis.window.__luck.byId('missing'), null);
  assert.deepEqual(GameState.luck, {
    id: 'average',
    name: 'Average',
    craftingMultiplier: 1.0,
    dropMultiplier: 1.0,
  });
  assert.equal(GameState.cultivation.luckCraftingMultiplier, 1);
  assert.equal(GameState.cultivation.luckDropMultiplier, 1);
  assert.equal(GameState.player.luck, 'Average');
  // The Milestone system is wired with the DataManager: the catalog comes
  // from the loaded 'milestones' collection (2 canned entries — first-qi
  // and first-breakthrough). A fresh boot's lifetime counters are all 0,
  // so no threshold has been crossed: the reached map stays empty, the
  // catalog entries all report reached=false and no milestone notification
  // fires (the master's-parting-gift queue count below is unchanged).
  assert.ok(globalThis.window.__milestones instanceof MilestoneSystem);
  assert.equal(globalThis.window.__milestones.list().length, 2);
  assert.deepEqual(globalThis.window.__milestones.reached(), {});
  assert.equal(globalThis.window.__milestones.isReached('first-qi'), false);
  assert.equal(globalThis.window.__milestones.isReached('first-breakthrough'), false);
  assert.deepEqual(GameState.milestones, { reached: {} });
  // The notification manager is wired: the queue is empty, the cap and the
  // type catalog come straight from config.notifications — no hardcoded
  // values. The initial queue is empty because the bootstrap has not yet
  // called add() (the first real emissions will arrive with future systems).
  assert.ok(globalThis.window.__notifications instanceof NotificationManager);
  assert.equal(globalThis.window.__notifications.maxQueueSize, 50);
  assert.deepEqual(globalThis.window.__notifications.types, [
    'info',
    'success',
    'warning',
    'error',
    'achievement',
  ]);
  // Master's parting gift: the very first notification on a fresh boot
  // frames the origin endowment (50 spirit stones, no save to restore).
  assert.equal(globalThis.window.__notifications.size(), 1);
  assert.equal(globalThis.window.__notifications.queue[0].type, 'info');
  assert.match(
    globalThis.window.__notifications.queue[0].message,
    /master|shifu|pouch/i
  );
  // The Settings panel handle is wired: in this fake DOM the panel is
  // absent (installDocument only provides #status-text + #year), so
  // initSettingsPanel's defensive guard returns the no-op shape (each
  // apply* returns false; destroy() is a no-op). The handle still exists
  // for the developer console. The real-browser e2e covers the panel +
  // every apply* path against a live DOM.
  const handle = globalThis.window.__settingsPanel;
  assert.ok(handle && typeof handle.destroy === 'function');
  assert.equal(handle.applyToggle('offlineProgress'), false);
  assert.equal(handle.applyNotationStyle('standard'), false);
  assert.equal(handle.applyReset(), false);
  assert.doesNotThrow(() => handle.destroy());
  // The number notation formatter is wired from config.notation: the renderer
  // delegates numeric formatting to it, so large values abbreviate ("1.5K"
  // instead of "1,500") with the config's default standard style active.
  assert.ok(globalThis.window.__notation instanceof NotationFormatter);
  assert.equal(globalThis.window.__notation.style, 'standard');
  assert.equal(globalThis.window.__notation.format(1500, 0), '1.5K');
  // The fresh state is active, so the MeditationSystem constructor wrote its
  // contribution slot immediately and the QiSystem constructor aggregated it
  // into the canonical per-second rate (no save present to override it).
  assert.equal(GameState.cultivation.qiPerSecond, 2);
  // Config + manifest + every registered collection were fetched in order.
  assert.deepEqual(fetchCalls, [
    'data/game-config.json',
    'data/manifest.json',
    'data/realms/realms.json',
    'data/items/items.json',
    'data/upgrades/upgrades.json',
    'data/breakthroughs/breakthroughs.json',
    'data/tribulations/tribulations.json',
    'data/spirit-roots/spirit-roots.json',
    'data/dantian/dantian.json',
    'data/bloodlines/bloodlines.json',
    'data/soul/soul.json',
    'data/talents/talents.json',
    'data/comprehension/comprehension.json',
    'data/destiny/destiny.json',
    'data/luck/luck.json',
    'data/milestones/milestones.json',
  ]);
  // Autosave interval comes from config.save.autosaveIntervalMs (30000).
  assert.deepEqual(
    intervals.map((interval) => interval.ms),
    [30000]
  );
});

test('spirit-root:changed fires on roll() with the exact rolled identity', async (t) => {
  const statusElement = createFakeElement();
  installDocument({ statusElement });
  installWindow();
  makeFetch();
  const errorMock = t.mock.method(console, 'error', () => {});

  await domContentLoaded();

  assert.equal(errorMock.mock.callCount(), 0);

  // Consumer contract: subscribe on the shared bus, roll through the
  // bootstrapped system, and the event arrives carrying the exact identity
  // the roll returned — the same payload main.js translates into the
  // awakening notification (mirrors the milestone:reached pipeline, which
  // is exercised end-to-end by the E2E spec).
  const events = [];
  EventBus.subscribe('spirit-root:changed', (payload) => events.push(payload));
  const rolled = globalThis.window.__spiritRoots.roll();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], rolled);
  // The payload is exactly the minimal rolled identity — nothing more.
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'id',
    'name',
    'speedMultiplier',
    'tier',
  ]);
});

test('bootstrap applies offline progress from a restored save and reports the gains', async (t) => {
  const statusElement = createFakeElement();
  installDocument({ statusElement });

  // Seed a save written ~2h ago: the qi producer in the canned config runs
  // at 2 qi/s against a 100 cap (the config-derived qiMax), so the boot must
  // add exactly 100 qi (raw ~14,400 clamped at the cap) and report the gains
  // in the status bar. The cap path is now guarded end-to-end: QiSystem owns
  // cultivation.qiMax and offline progress clamps against it.
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
          cultivation: { qi: 0, qiMax: 100, qiPerSecond: 2 },
        },
      }),
    ],
  ]);
  installWindow(store);
  makeFetch();
  const errorMock = t.mock.method(console, 'error', () => {});

  await domContentLoaded();

  assert.equal(errorMock.mock.callCount(), 0);
  // The cap dominates the boot-latency jitter, so the gain is exactly 100
  // regardless of the few seconds of test execution time.
  assert.match(
    statusElement.textContent,
    /Save restored\. Offline gains: 2h \(Qi: \+100\)/,
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
  assert.equal(globalThis.window.__meditation, undefined);
  assert.equal(globalThis.window.__qi, undefined);
  assert.equal(globalThis.window.__realms, undefined);
  assert.equal(globalThis.window.__resources, undefined);
  assert.equal(globalThis.window.__inventory, undefined);
  assert.equal(globalThis.window.__notation, undefined);
  assert.equal(globalThis.window.__notifications, undefined);
  assert.equal(globalThis.window.__upgrades, undefined);
  assert.equal(globalThis.window.__breakthroughs, undefined);
  assert.equal(globalThis.window.__tribulations, undefined);
  assert.equal(globalThis.window.__spiritRoots, undefined);
  assert.equal(globalThis.window.__dantian, undefined);
  assert.equal(globalThis.window.__bloodlines, undefined);
  assert.equal(globalThis.window.__soul, undefined);
  assert.equal(globalThis.window.__talents, undefined);
  assert.equal(globalThis.window.__comprehension, undefined);
  assert.equal(globalThis.window.__destiny, undefined);
  assert.equal(globalThis.window.__luck, undefined);
  assert.equal(globalThis.window.__milestones, undefined);
});
