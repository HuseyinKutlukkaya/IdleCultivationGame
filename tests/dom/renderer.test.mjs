/**
 * tests/dom/renderer.test.mjs — DOM-level tests for js/ui/renderer.js.
 *
 * Exercises the declarative binding renderer against fake DOM elements:
 * the full binding DSL (text, format templates, progress, switch,
 * remaining), partial refresh (only changed bindings are written), the
 * requestAnimationFrame batching (coalesced flushes), progress clamping,
 * and the event contract (loop:uiRefresh / ui:refresh / game:restored)
 * wired through the real EventBus — plus destroy() unsubscribing them.
 *
 * Uses the Node built-in test runner with zero dependencies: the fake DOM and
 * rAF stubs live in tests/helpers/, and the module under test is imported for
 * real. Test files run in isolated child processes, so the GameState singleton
 * is private to this file.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with the
 * quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../../js/ui/renderer.js';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { NotationFormatter } from '../../js/ui/notation.js';
import { createFakeElement, createFakeRoot } from '../helpers/fake-dom.mjs';
import { installRafStub, uninstallRafStub } from '../helpers/raf-stub.mjs';

/** Live renderer under test; reassigned by each test so afterEach can destroy it. */
let renderer = null;
/** Live rAF stub handle; reassigned by beforeEach. */
let raf = null;

/**
 * Build a plain state object mirroring the shape the bindings read.
 * Mirrors GameState's cultivation/resources/inventory/settings slices.
 *
 * @returns {object} fresh state with all values the tests exercise.
 */
function makeState() {
  return {
    cultivation: {
      realm: 'Mortal',
      realmProgress: 0,
      realmProgressMax: 1000,
      breakthroughCost: null,
      nextRealm: 'Qi Condensation',
      qi: 0,
      qiMax: 100,
      qiPerSecond: 0,
    },
    resources: {
      spiritStones: 0,
      herbs: 0,
      jade: 0,
      qiCondensationPills: 0,
    },
    inventory: {
      slots: { total: 20, used: 0 },
      items: [],
    },
    settings: {
      offlineProgress: true,
      sound: false,
      notifications: false,
    },
    statistics: {
      meditationsCompleted: 0,
    },
  };
}

/** Reset the shared bus and install the rAF stub before every test. */
beforeEach(() => {
  EventBus.clear();
  raf = installRafStub();
});

/** Tear down any live renderer and remove the rAF stub after every test. */
afterEach(() => {
  if (renderer) renderer.destroy();
  renderer = null;
  uninstallRafStub();
});

test('initial render writes every binding from the scanned root', () => {
  const qi = createFakeElement({ 'data-bind': 'cultivation.qi' });
  const realm = createFakeElement({
    'data-bind': 'cultivation.realm',
    'data-bind-format': '{0} Realm',
  });
  const realmProgressText = createFakeElement({
    'data-bind': 'cultivation.realmProgress|cultivation.realmProgressMax',
    'data-bind-format': '{0} / {1}',
  });
  const realmBar = createFakeElement(
    {
      'data-bind': 'cultivation.realmProgress',
      'data-bind-mode': 'progress',
      'data-bind-max': 'cultivation.realmProgressMax',
    },
    true,
  );
  const breakthroughCost = createFakeElement({
    'data-bind': 'cultivation.breakthroughCost',
  });
  const qiRatio = createFakeElement({
    'data-bind': 'cultivation.qi|cultivation.qiMax',
    'data-bind-format': '{0} / {1}',
  });
  const qiPerSecond = createFakeElement({
    'data-bind': 'cultivation.qiPerSecond',
    'data-bind-decimals': '1',
  });
  const pillCount = createFakeElement({
    'data-bind': 'resources.qiCondensationPills',
    'data-bind-format': '× {0}',
  });
  const freeSlots = createFakeElement({
    'data-bind': 'inventory.slots.used',
    'data-bind-mode': 'remaining',
    'data-bind-max': 'inventory.slots.total',
  });
  const offlineToggle = createFakeElement({
    'data-bind': 'settings.offlineProgress',
    'data-bind-mode': 'switch',
  });
  const soundToggle = createFakeElement({
    'data-bind': 'settings.sound',
    'data-bind-mode': 'switch',
  });

  renderer = new Renderer({
    state: makeState(),
    root: createFakeRoot([
      qi,
      realm,
      realmProgressText,
      realmBar,
      breakthroughCost,
      qiRatio,
      qiPerSecond,
      pillCount,
      freeSlots,
      offlineToggle,
      soundToggle,
    ]),
  });
  renderer.init();

  // Text mode, no format.
  assert.equal(qi.textContent, '0');
  // Text mode, single-value template.
  assert.equal(realm.textContent, 'Mortal Realm');
  // Text mode, multi-value template with thousands separators. The renderer
  // formats via Intl.NumberFormat (host locale), so group separators vary by
  // machine (1,000 vs 1.000); assert against a locale-tolerant pattern.
  assert.match(realmProgressText.textContent, /^0 \/ 1[.,\s]000$/);
  // Progress mode: ARIA now/max and the fill width.
  assert.equal(realmBar.getAttribute('aria-valuenow'), '0');
  assert.equal(realmBar.getAttribute('aria-valuemax'), '1000');
  assert.equal(realmBar.style.width, '0%');
  // Null bound value renders the em dash.
  assert.equal(breakthroughCost.textContent, '—');
  assert.equal(qiRatio.textContent, '0 / 100');
  // Decimals apply to numeric formatting. Decimal separator is host-locale
  // dependent (0.0 vs 0,0) — match either.
  assert.match(qiPerSecond.textContent, /^0[.,]0$/);
  assert.equal(pillCount.textContent, '× 0');
  // Remaining mode: max − value.
  assert.equal(freeSlots.textContent, '20');
  // Switch mode: on for truthy, off for falsy.
  assert.equal(offlineToggle.classes.has('switch--on'), true);
  assert.equal(soundToggle.classes.has('switch--on'), false);
  // Every [data-bind] node was scanned and cached exactly once.
  assert.equal(renderer._bindings.length, 11);
});

test('partial refresh updates only the changed binding', () => {
  const qi = createFakeElement({ 'data-bind': 'cultivation.qi' });
  const realm = createFakeElement({
    'data-bind': 'cultivation.realm',
    'data-bind-format': '{0} Realm',
  });
  const state = makeState();

  renderer = new Renderer({
    state,
    root: createFakeRoot([qi, realm]),
  });
  renderer.init();
  assert.equal(qi.textContent, '0');
  assert.equal(realm.textContent, 'Mortal Realm');

  state.cultivation.qi = 5;
  renderer.refresh();

  assert.equal(qi.textContent, '5');
  assert.equal(realm.textContent, 'Mortal Realm');
});

test('inventory stacks-held binding renders the real stack count', () => {
  const stacksHeld = createFakeElement({
    'data-bind': 'inventory.items.length',
  });
  const state = makeState();

  renderer = new Renderer({
    state,
    root: createFakeRoot([stacksHeld]),
  });
  renderer.init();

  // Empty items array renders zero stacks.
  assert.equal(stacksHeld.textContent, '0');

  // Two distinct stacks render as "2" (array length, not item count).
  state.inventory.items = [
    { id: 'spirit-herb', count: 5 },
    { id: 'iron-ore', count: 3 },
  ];
  renderer.refresh();
  assert.equal(stacksHeld.textContent, '2');

  // Stacking onto an existing stack does not open a new slot.
  state.inventory.items[0].count = 9;
  renderer.refresh();
  assert.equal(stacksHeld.textContent, '2');
});

test('requestRefresh coalesces multiple calls into one flush', () => {
  const qi = createFakeElement({ 'data-bind': 'cultivation.qi' });
  const state = makeState();

  renderer = new Renderer({
    state,
    root: createFakeRoot([qi]),
  });
  renderer.init();

  state.cultivation.qi = 7;
  renderer.requestRefresh();
  renderer.requestRefresh();

  // Both requests coalesce into a single pending frame callback.
  assert.equal(raf.calls.length, 1);
  raf.flush();
  assert.equal(qi.textContent, '7');
});

test('progress width is clamped to 100% while aria-valuenow stays true', () => {
  const qiBar = createFakeElement(
    {
      'data-bind': 'cultivation.qi',
      'data-bind-mode': 'progress',
      'data-bind-max': 'cultivation.qiMax',
    },
    true,
  );
  const state = makeState();

  renderer = new Renderer({
    state,
    root: createFakeRoot([qiBar]),
  });
  renderer.init();

  state.cultivation.qi = 250;
  renderer.refresh();

  assert.equal(qiBar.style.width, '100%');
  assert.equal(qiBar.getAttribute('aria-valuenow'), '250');
});

test('remaining mode with a missing max path renders the em dash', () => {
  const freeSlots = createFakeElement({
    'data-bind': 'inventory.slots.used',
    'data-bind-mode': 'remaining',
    'data-bind-max': 'missing.max',
  });

  renderer = new Renderer({
    state: makeState(),
    root: createFakeRoot([freeSlots]),
  });
  renderer.init();

  assert.equal(freeSlots.textContent, '—');
});

test('game:restored triggers a synchronous refresh of the real GameState', () => {
  const qi = createFakeElement({ 'data-bind': 'cultivation.qi' });

  renderer = new Renderer({ root: createFakeRoot([qi]) });
  renderer.init();

  GameState.cultivation.qi = 42;
  EventBus.emit('game:restored', { savedAt: 1 });

  assert.equal(qi.textContent, '42');

  GameState.cultivation.qi = 0;
});

test('ui:refresh triggers a synchronous refresh of the real GameState', () => {
  const qi = createFakeElement({ 'data-bind': 'cultivation.qi' });

  renderer = new Renderer({ root: createFakeRoot([qi]) });
  renderer.init();

  GameState.cultivation.qi = 43;
  EventBus.emit('ui:refresh');

  assert.equal(qi.textContent, '43');

  GameState.cultivation.qi = 0;
});

test('loop:uiRefresh schedules a batched flush that updates the DOM', () => {
  const qi = createFakeElement({ 'data-bind': 'cultivation.qi' });

  renderer = new Renderer({ root: createFakeRoot([qi]) });
  renderer.init();

  GameState.cultivation.qi = 44;
  EventBus.emit('loop:uiRefresh');

  assert.equal(raf.calls.length, 1);
  raf.flush();
  assert.equal(qi.textContent, '44');

  GameState.cultivation.qi = 0;
});

test('destroy unsubscribes every refresh event', () => {
  renderer = new Renderer({ root: createFakeRoot([]) });
  renderer.init();

  assert.equal(EventBus.hasListeners('loop:uiRefresh'), true);
  assert.equal(EventBus.hasListeners('game:restored'), true);

  renderer.destroy();

  assert.equal(EventBus.hasListeners('loop:uiRefresh'), false);
  assert.equal(EventBus.hasListeners('game:restored'), false);
});

test('an injected notation formatter shortens numbers through the binding DSL', () => {
  const spiritStones = createFakeElement({
    'data-bind': 'resources.spiritStones',
    'data-bind-decimals': '0',
  });
  const state = makeState();
  state.resources.spiritStones = 1500;

  renderer = new Renderer({
    state,
    root: createFakeRoot([spiritStones]),
    notation: new NotationFormatter({
      config: {
        defaultStyle: 'standard',
        styles: {
          standard: { threshold: 1000, suffixes: ['K', 'M'] },
        },
      },
    }),
  });
  renderer.init();

  // The abbreviated path is locale-independent: "1.50" → trimmed "1.5" + "K".
  assert.equal(spiritStones.textContent, '1.5K');
});

test('without notation the legacy Intl formatting is unchanged', () => {
  const qiPerSecond = createFakeElement({
    'data-bind': 'cultivation.qiPerSecond',
    'data-bind-decimals': '2',
  });
  const state = makeState();
  state.cultivation.qiPerSecond = 999.5;

  renderer = new Renderer({
    state,
    root: createFakeRoot([qiPerSecond]),
  });
  renderer.init();

  // Locale-safe: below the grouping threshold only the decimal separator
  // varies between locales ("999.50" vs "999,50").
  assert.match(qiPerSecond.textContent, /^999[.,]50$/);
});

test('_formatNumber delegates to the notation formatter when injected', () => {
  const notation = new NotationFormatter({
    config: {
      defaultStyle: 'standard',
      styles: {
        standard: { threshold: 1000, suffixes: ['K', 'M'] },
      },
    },
  });

  renderer = new Renderer({
    state: makeState(),
    root: createFakeRoot([]),
    notation,
  });

  assert.equal(renderer._formatNumber(1500, 0), '1.5K');
});

test('_formatNumber keeps the Intl path when no notation is injected', () => {
  renderer = new Renderer({ state: makeState(), root: createFakeRoot([]) });

  // Compare against the same Intl.NumberFormat the renderer would build, so
  // the assertion stays locale-independent.
  const expected = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(1500);

  assert.equal(renderer._formatNumber(1500, 0), expected);
});
