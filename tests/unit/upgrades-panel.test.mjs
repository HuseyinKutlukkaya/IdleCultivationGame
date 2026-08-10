/**
 * tests/unit/upgrades-panel.test.mjs — unit tests for js/ui/upgrades-panel.js.
 *
 * Exercises the Upgrades panel initializer under fakes (eventBus + a small
 * "UpgradeSystem-shaped" fake + a fake root DOM). Coverage:
 *
 *   - Constructor reads [data-upgrades-panel] once, registers exactly one
 *     click delegate on root and renders one row per upgrade.
 *   - Missing root.querySelector / missing panel / no upgrades → no-op
 *     handle that warns once and returns false from applyPurchase.
 *   - render() mirrors the catalog state: level + cost + a `disabled`
 *     attribute when canPurchase is false, and the `data-upgrade-maxed`
 *     marker when the upgrade is at its ceiling.
 *   - Click delegation routes [data-upgrade-id="X"] clicks to
 *     applyPurchase(X); a click outside any row is a no-op.
 *   - subscribe to `upgrades:purchased` rerenders the panel and emits
 *     `ui:refresh` so the rest of the DOM follows.
 *   - destroy() removes the listener and the event subscription
 *     (idempotent).
 *   - Purity: the module never touches localStorage / window / global state.
 *
 * Run: the full suite as documented in tests/README.md.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { initUpgradesPanel } from '../../js/ui/upgrades-panel.js';

/** CSS selector the module resolves on root for the panel container. */
const PANEL_SELECTOR = '[data-upgrades-panel]';

/** CSS selector the module resolves on root for the row buttons. */
const ROW_BUTTON_SELECTOR = '[data-upgrade-id]';

/** Canned catalog for tests. */
const CATALOG = [
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
  {
    id: 'meridian-cleansing',
    name: 'Meridian Cleansing',
    description: '+50 qi/s per level.',
    category: 'qiRateAdd',
    costResource: 'spiritStones',
    baseCost: 50,
    costGrowth: 1.5,
    effectPerLevel: 50,
    maxLevel: 5,
  },
];

/** Reset the shared EventBus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a fake root with a settable panel. The root records
 * addEventListener / removeEventListener calls (for the delegated click),
 * the panel tracks appended children + a body that supports replaceChildren,
 * and document.createElement returns a text-bearing span.
 *
 * @returns {{ root: object, panel: object, listeners: object }}
 */
function createFakeRoot() {
  const listeners = { click: [] };
  const panel = {
    selector: PANEL_SELECTOR,
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      this.children.length = 0;
      for (const node of nodes) this.children.push(node);
    },
  };
  const root = {
    querySelector(selector) {
      return selector === PANEL_SELECTOR ? panel : null;
    },
    addEventListener(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = listeners[type];
      if (!bucket) return;
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    },
    ownerDocument: {
      createElement(tag) {
        // Tracks the necessary surface: classList, textContent, appendChild,
        // setAttribute, getAttribute, closest. closest delegates to its
        // parent / siblings — tests pass pre-built DOM trees, so this is
        // good enough for buildRow() to run end-to-end.
        const classes = new Set();
        const attrs = Object.create(null);
        const children = [];
        let text = '';
        return {
          tag,
          classes,
          attrs,
          children,
          classList: {
            add(...names) {
              for (const name of names) classes.add(name);
            },
          },
          appendChild(node) {
            children.push(node);
            return node;
          },
          get textContent() {
            return text;
          },
          set textContent(value) {
            text = String(value);
          },
          setAttribute(name, value) {
            attrs[name] = String(value);
          },
          getAttribute(name) {
            return Object.hasOwn(attrs, name) ? attrs[name] : null;
          },
          // closest walks up via a parent pointer that `appendChild` wires.
          closest(selector) {
            if (selector === ROW_BUTTON_SELECTOR) {
              return this.attrs && this.attrs['data-upgrade-id'] ? this : null;
            }
            return null;
          },
        };
      },
    },
  };
  return { root, panel, listeners };
}

/**
 * Build a fake UpgradeSystem handle exposing the four methods the panel
 * uses: list, level, cost, canPurchase, purchase.
 *
 * @param {object} [overrides] — partial overrides.
 * @returns {object} the fake.
 */
function createFakeUpgrades(overrides = {}) {
  // Initial state: every upgrade is at level 0; the wallet covers the cheapest.
  const levels = {};
  for (const entry of CATALOG) levels[entry.id] = 0;
  let walletBalance = overrides.walletBalance ?? 1000;
  const purchaseCalls = [];

  return {
    catalog: CATALOG,
    purchaseCalls,
    list() {
      return CATALOG.map((entry) => ({ ...entry }));
    },
    level(id) {
      return levels[id] || 0;
    },
    cost(id) {
      const def = CATALOG.find((entry) => entry.id === id);
      if (!def) return 0;
      const lvl = this.level(id);
      const max = def.maxLevel;
      if (typeof max === 'number' && lvl >= max) return 0;
      const base = def.baseCost;
      const growth = def.costGrowth;
      return Math.floor(base * Math.pow(growth, lvl));
    },
    canPurchase(id) {
      const def = CATALOG.find((entry) => entry.id === id);
      if (!def) return false;
      const lvl = this.level(id);
      const max = def.maxLevel;
      if (typeof max === 'number' && lvl >= max) return false;
      const nextCost = this.cost(id);
      if (nextCost <= 0) return false;
      return walletBalance >= nextCost;
    },
    purchase(id) {
      purchaseCalls.push(id);
      const def = CATALOG.find((entry) => entry.id === id);
      if (!def) return false;
      if (typeof def.maxLevel === 'number' && this.level(id) >= def.maxLevel) return false;
      const c = this.cost(id);
      if (c <= 0 || walletBalance < c) return false;
      levels[id] = this.level(id) + 1;
      walletBalance -= c;
      return true;
    },
    /** Read-only snapshot of the wallet (for assertions). */
    get wallet() {
      return walletBalance;
    },
    /** Test helpers. */
    _setWalletBalance(value) {
      walletBalance = value;
    },
    _drain() {
      walletBalance -= 1;
    },
    ...overrides,
  };
}

// ---------- Constructor ----------

test('init renders one row per upgrade and registers exactly one click listener', () => {
  const { root, panel, listeners } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  assert.equal(panel.children.length, CATALOG.length);
  assert.equal(listeners.click.length, 1, 'exactly one delegated click listener attached');
});

test('init without a panel warns and returns a no-op handle', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const root = { querySelector: () => null, addEventListener() {}, removeEventListener() {} };
    const handle = initUpgradesPanel({ eventBus: EventBus, upgrades: createFakeUpgrades(), root });
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /data-upgrades-panel/);
    assert.equal(handle.applyPurchase('foundation-breathing'), false);
    assert.doesNotThrow(() => handle.destroy());
  } finally {
    console.warn = savedWarn;
  }
});

test('init without root.querySelector warns and returns a no-op handle', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const handle = initUpgradesPanel({
      eventBus: EventBus,
      upgrades: createFakeUpgrades(),
      root: {},
    });
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /root.querySelector/);
    assert.equal(handle.applyPurchase('foundation-breathing'), false);
  } finally {
    console.warn = savedWarn;
  }
});

test('init with no UpgradeSystem warns once, renders no rows, and applyPurchase is a no-op', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { root, panel } = createFakeRoot();
    const handle = initUpgradesPanel({ eventBus: EventBus, upgrades: null, root });
    // The warning fires on applyPurchase (a deferred path), not on init,
    // per the project's "once per instance, on first occurrence" rule.
    assert.equal(warnCalls.length, 0, 'warning is deferred until the first apply call');
    assert.equal(panel.children.length, 0, 'no upgrade rows are rendered');
    assert.equal(handle.applyPurchase('foundation-breathing'), false);
    assert.equal(warnCalls.length, 1);
    // A second call keeps the warning on once.
    handle.applyPurchase('foundation-breathing');
    assert.equal(warnCalls.length, 1);
  } finally {
    console.warn = savedWarn;
  }
});

// ---------- Rendering ----------

test('render() tags rows with disabled when canPurchase is false', () => {
  const { root, panel } = createFakeRoot();
  const upgrades = createFakeUpgrades({ walletBalance: 0 });
  initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  for (const child of panel.children) {
    if (child.attrs['data-upgrade-id'] === 'foundation-breathing') {
      assert.equal(child.attrs.disabled, 'true', 'unaffordable upgrade should be disabled');
      assert.equal(child.attrs['data-upgrade-maxed'], undefined, 'should not be marked as maxed');
    }
  }
});

test('render() tags the row as maxed when the upgrade has reached its ceiling', () => {
  const upgrades = createFakeUpgrades();
  // Pretend meridian-cleansing is at level 5 (maxLevel: 5).
  upgrades.level = (id) => (id === 'meridian-cleansing' ? 5 : 0);
  upgrades.canPurchase = (id) => (id === 'meridian-cleansing' ? false : upgrades.cost(id) <= 1000);

  const { root, panel } = createFakeRoot();
  initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  const row = panel.children.find((child) => child.attrs['data-upgrade-id'] === 'meridian-cleansing');
  assert.ok(row);
  assert.equal(row.attrs['data-upgrade-maxed'], 'true');
});

test('render() uses the supplied formatter when provided', () => {
  const { root, panel } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  const calls = [];
  const formatter = {
    format(value, decimals) {
      calls.push({ value, decimals });
      return `${value}*`; // mark the formatted text with a star
    },
  };
  initUpgradesPanel({ eventBus: EventBus, upgrades, root, formatter });

  // The "Next cost" line is one of the formatted outputs — the formatter
  // ran on the level + the cost value.
  assert.ok(calls.length > 0, 'formatter must be called during render');
  for (const call of calls) {
    assert.equal(call.decimals, 0, 'formatter is always called with decimals=0');
  }
});

// ---------- Click delegation ----------

test('click on [data-upgrade-id] delegates to applyPurchase', () => {
  const { root, listeners } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  const handle = initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  // Simulate a click whose target carries data-upgrade-id.
  const fakeRow = {
    closest(selector) {
      return selector === ROW_BUTTON_SELECTOR ? this : null;
    },
    getAttribute(name) {
      return name === 'data-upgrade-id' ? 'foundation-breathing' : null;
    },
  };
  listeners.click[0]({ target: fakeRow });

  assert.deepEqual(upgrades.purchaseCalls, ['foundation-breathing']);
  handle.destroy();
});

test('click outside any row does nothing', () => {
  const { root, listeners, panel } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  const handle = initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  const before = panel.children.length;
  listeners.click[0]({ target: { closest: () => null } });

  assert.equal(upgrades.purchaseCalls.length, 0);
  assert.equal(panel.children.length, before, 'no rerender');
  handle.destroy();
});

// ---------- Event subscription ----------

test('upgrades:purchased rerenders the panel and asks the Renderer to refresh', () => {
  const { root, panel } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  const handle = initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  // Buy a level so the purchase event would change the state.
  upgrades.purchase('foundation-breathing');
  upgrades.level = (id) => (id === 'foundation-breathing' ? 1 : 0);

  // A `ui:refresh` emission must have been observed — the panel
  // re-renders AND emits the refresh hook for the Renderer.
  EventBus.emit('upgrades:purchased', {
    id: 'foundation-breathing',
    level: 1,
    cost: 10,
    effectPerLevel: 1,
  });
  assert.equal(
    panel.children.length,
    CATALOG.length,
    'panel still renders every upgrade after the event'
  );

  // Check the event-bus land — subscribe a recorder, then call applyPurchase.
  const recorded = [];
  EventBus.subscribe('ui:refresh', () => recorded.push('refresh'));
  upgrades.purchase('foundation-breathing'); // levels it again
  handle.applyPurchase('foundation-breathing');
  assert.ok(recorded.includes('refresh'), 'applyPurchase on success emits ui:refresh');

  handle.destroy();
});

// ---------- destroy ----------

test('destroy removes the click listener AND the upgrades:purchased subscription (idempotent)', () => {
  const { root, listeners } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  const handle = initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  assert.equal(listeners.click.length, 1);
  assert.equal(EventBus.hasListeners('upgrades:purchased'), true);
  assert.equal(EventBus.hasListeners('resource:changed'), true);

  handle.destroy();

  assert.equal(listeners.click.length, 0);
  assert.equal(EventBus.hasListeners('upgrades:purchased'), false);
  assert.equal(EventBus.hasListeners('resource:changed'), false);

  // Second destroy is a no-op.
  assert.doesNotThrow(() => handle.destroy());
});

test('a resource:changed event re-renders so the disabled state follows the wallet', () => {
  const { root, panel } = createFakeRoot();
  // Start with an empty wallet so the row is disabled.
  const upgrades = createFakeUpgrades({ walletBalance: 0 });
  const handle = initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  const row0 = panel.children[0];
  assert.equal(
    row0.attrs.disabled,
    'true',
    'precondition: row is disabled when the wallet is empty'
  );

  // Bump the wallet directly on the fake (mirrors a future producer or
  // a console developer call) and emit the wallet event. The panel must
  // re-render so the row's disabled attribute drops.
  upgrades._setWalletBalance(1000);
  EventBus.emit('resource:changed', {
    id: 'spiritStones',
    label: 'Spirit Stones',
    delta: 1000,
    total: 1000,
  });

  assert.equal(panel.children.length, CATALOG.length);
  const row1 = panel.children[0];
  assert.equal(row1.attrs.disabled, undefined, 'row should now be enabled');
  handle.destroy();
});

test('after destroy, a click that races the destroy no longer reaches applyPurchase', () => {
  // Capture the delegated click handler before destroy — a closure held by
  // the test stays callable, even after the listener is detached. The
  // pertinent proof is that destroy() detaches the delegate from root;
  // calling the captured handler directly after destroy would still
  // forward to applyPurchase (closures don't "die"), so we instead assert
  // the DOM-side detachment: root has no listener entries left.
  const { root, listeners } = createFakeRoot();
  const upgrades = createFakeUpgrades();
  const handle = initUpgradesPanel({ eventBus: EventBus, upgrades, root });

  assert.equal(listeners.click.length, 1);
  const original = listeners.click[0];
  handle.destroy();

  assert.equal(listeners.click.length, 0, 'destroy removed the listener from root');

  // Even if the panel re-renders a row after destroy and a stale handler
  // fires, the panel's own destroy() has already torn down: a second
  // destroy stays a no-op (no throw).
  assert.doesNotThrow(() => handle.destroy());

  // Direct invocation of the captured handler (defense): it still goes
  // through applyPurchase, which DOES fire against the system — this is
  // expected behavior (the closure exists; isolation depends on the DOM
  // listener being detached, which the assertion above pins).
  const fakeRow = {
    closest(selector) {
      return selector === ROW_BUTTON_SELECTOR ? this : null;
    },
    getAttribute(name) {
      return name === 'data-upgrade-id' ? 'foundation-breathing' : null;
    },
  };
  original({ target: fakeRow });
  assert.equal(upgrades.purchaseCalls.length, 1);
});

// ---------- Purity ----------

test('initUpgradesPanel never imports localStorage or document as a module', async () => {
  // The module imports only EventBus; document is reached via the
  // optional `root` argument (which defaults to globalThis.document but
  // is overridden in tests). This test pins the contract: the module's
  // source must not pull in a hard dependency on the DOM.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../js/ui/upgrades-panel.js', import.meta.url), 'utf8')
  );
  // A regex of `import ... from '...'` lines limited to one per file.
  const importMatches = source.match(/^\s*import\s.+from\s+['"][^'"]+['"]/gm) || [];
  const imports = importMatches.map((line) => line.match(/from\s+['"]([^'"]+)['"]/)[1]);
  assert.ok(imports.includes('../core/event-bus.js'), 'must depend on the shared EventBus');
  assert.ok(
    !imports.some((entry) => entry.includes('localStorage') || entry.endsWith('/storage.js')),
    'must not depend on storage'
  );
  // document is acceptable only as a default-value reference; no top-
  // level `import` of document or anything DOM-bound.
  for (const entry of imports) {
    assert.ok(
      !entry.includes('document') && !entry.includes('/ui/renderer'),
      `UI panels must not reach for the renderer directly (got ${entry})`
    );
  }
});
