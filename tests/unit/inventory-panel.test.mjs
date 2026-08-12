/**
 * tests/unit/inventory-panel.test.mjs — unit tests for js/ui/inventory-panel.js.
 *
 * Exercises the inventory panel initializer under a hand-rolled fake DOM
 * (no jsdom), a fake EventBus, a fake InventorySystem, and a fake DataManager.
 * Coverage:
 *   - Renders item cards from stacks, each card shows name, count, category,
 *     grade.
 *   - Pagination renders when stack count > pageSize: Prev/Next buttons and
 *     "Page X of Y" info, Prev disabled on page 1, Next disabled on last page.
 *   - Clicking Next advances the page and re-renders; clicking Prev goes back.
 *   - Empty inventory shows "No items in inventory" placeholder.
 *   - Unknown item id renders a degraded "Unknown item (id)" card.
 *   - Re-render on 'inventory:changed' and 'ui:refresh' events.
 *   - destroy() unsubscribes all event listeners (idempotent).
 *   - Defensive no-ops: missing root.querySelector, missing panel, missing
 *     inventory system, missing DataManager.
 *
 * Uses Node's built-in test runner with zero dependencies. Run:
 * node --test tests/unit/inventory-panel.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { initInventoryPanel } from '../../js/ui/inventory-panel.js';

/** CSS selectors used by the module. */
const PANEL_SELECTOR = '[data-inventory-panel]';
const BODY_SELECTOR = '[data-inventory-body]';

/** Reset the shared EventBus before every test. */
beforeEach(() => {
  EventBus.clear();
});

// ---------------------------------------------------------------------------
// Fake DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal fake DOM element.
 *
 * @param {string} tagName — element tag name.
 * @returns {object} a fake DOM element.
 */
function createFakeElement(tagName) {
  const _attrs = Object.create(null);
  const _children = [];
  let _text = '';
  let _parent = null;
  const _listeners = Object.create(null);

  const el = {
    tagName: tagName.toUpperCase(),
    get children() { return _children; },
    get firstChild() { return _children[0] || null; },
    get parentNode() { return _parent; },
    set parentNode(v) { _parent = v; },
    setAttribute(name, value) { _attrs[name] = value; },
    getAttribute(name) { return name in _attrs ? _attrs[name] : null; },
    hasAttribute(name) { return name in _attrs; },
    removeAttribute(name) { delete _attrs[name]; },
    set textContent(value) { _text = String(value); },
    get textContent() { return _text; },
    set className(value) { this.setAttribute('class', value); },
    get className() { return this.getAttribute('class') || ''; },
    set disabled(value) {
      if (value) this.setAttribute('disabled', '');
      else this.removeAttribute('disabled');
    },
    get disabled() { return this.hasAttribute('disabled'); },
    set type(value) { this.setAttribute('type', value); },
    get type() { return this.getAttribute('type') || ''; },
    appendChild(child) {
      _children.push(child);
      if (child && typeof child === 'object') child.parentNode = el;
      return child;
    },
    removeChild(child) {
      const idx = _children.indexOf(child);
      if (idx >= 0) {
        _children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    querySelector(selector) {
      // Recursive search through children for an element whose tagName or
      // attribute matches the selector.
      if (selector === '[data-inventory-body]') {
        for (const child of _children) {
          if (child.getAttribute && child.getAttribute('data-inventory-body') !== null) return child;
          if (child.querySelector) {
            const found = child.querySelector(selector);
            if (found) return found;
          }
        }
      }
      return null;
    },
    addEventListener(type, handler) {
      if (!_listeners[type]) _listeners[type] = [];
      _listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = _listeners[type];
      if (!bucket) return;
      const idx = bucket.indexOf(handler);
      if (idx >= 0) bucket.splice(idx, 1);
    },
    dispatchEvent(type) {
      const bucket = _listeners[type];
      if (!bucket) return;
      for (const h of bucket) h();
    },
    /** @returns {Array} listeners for a given type (test helper). */
    _listenersFor(type) {
      return _listeners[type] || [];
    },
  };
  return el;
}

/**
 * Build a fake root with an inventory panel and body, plus a fake
 * document.createElement that returns fake elements.
 *
 * @returns {{ root: object, panel: object, body: object }}
 */
function createFakeRoot() {
  const body = createFakeElement('div');
  body.setAttribute('data-inventory-body', '');

  const panel = createFakeElement('article');
  panel.setAttribute('data-inventory-panel', '');
  panel.appendChild(body);

  const root = {
    querySelector(selector) {
      if (selector === PANEL_SELECTOR) return panel;
      if (selector === BODY_SELECTOR) return body;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };

  // Override document.createElement (module uses the global document).
  // Since the module uses `document.createElement`, we need to mock it.
  // The production path goes through the real `document`. In tests we stub it.
  return { root, panel, body };
}

// ---------------------------------------------------------------------------
// Fake systems
// ---------------------------------------------------------------------------

/**
 * Fake InventorySystem with a mutable stacks array.
 */
class FakeInventorySystem {
  constructor(stacks = []) {
    this.stacks = [...stacks];
  }

  get inventory() {
    return this.stacks.map((s) => ({ ...s }));
  }
}

/**
 * Fake DataManager with a map of item definitions.
 */
class FakeDataManager {
  constructor(defs = {}) {
    this._defs = defs;
  }

  get(collection, id) {
    if (collection !== 'items') return undefined;
    return this._defs[id] || undefined;
  }
}

// ---------------------------------------------------------------------------
// Stub document.createElement for tests
// ---------------------------------------------------------------------------

/** @type {Function|null} saved real createElement. */
let _realCreateElement = null;

/**
 * Install a stubbed document.createElement that returns fake elements.
 * Must be called before initInventoryPanel() in tests that need to inspect
 * the rendered DOM children.
 */
function stubCreateElement() {
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = {};
  }
  _realCreateElement = globalThis.document.createElement;
  globalThis.document.createElement = (tagName) => createFakeElement(tagName);
}

/**
 * Restore the real document.createElement.
 */
function restoreCreateElement() {
  if (_realCreateElement) {
    globalThis.document.createElement = _realCreateElement;
    _realCreateElement = null;
  }
}

// ---------------------------------------------------------------------------
// Helper to collect text from rendered children
// ---------------------------------------------------------------------------

/**
 * Collect all textContent values from a fake element's children (recursive).
 *
 * @param {object} el — fake element.
 * @returns {string} all text joined.
 */
function collectText(el) {
  const parts = [];
  if (el.textContent) parts.push(el.textContent);
  for (const child of el.children || []) {
    parts.push(collectText(child));
  }
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('renders item cards from stacks', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const inventory = new FakeInventorySystem([
      { id: 'qi-condensation-pill', count: 5 },
      { id: 'spirit-herb', count: 3 },
    ]);
    const dataManager = new FakeDataManager({
      'qi-condensation-pill': { name: 'Qi Condensation Pill', category: 'pill', grade: 'Mortal' },
      'spirit-herb': { name: 'Spirit Herb', category: 'herb', grade: 'Mortal' },
    });

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, dataManager, eventBus: EventBus, pageSize: 12,
    });

    // Body should have a .inventory-grid child.
    const grid = body.children[0];
    assert.ok(grid, 'Grid should be present');
    assert.equal(grid.getAttribute('class'), 'inventory-grid');

    // Two item cards.
    assert.equal(grid.children.length, 2);

    // First card — Qi Condensation Pill.
    const card1 = grid.children[0];
    assert.equal(card1.getAttribute('data-item-id'), 'qi-condensation-pill');
    assert.equal(card1.getAttribute('data-item-category'), 'pill');
    assert.equal(card1.getAttribute('data-item-grade'), 'Mortal');
    const name1 = card1.children[0];
    assert.equal(name1.textContent, 'Qi Condensation Pill');
    const count1 = card1.children[1];
    assert.equal(count1.textContent, '\u00d75');
    const cat1 = card1.children[2];
    assert.equal(cat1.textContent, 'pill');
    const grade1 = card1.children[3];
    assert.equal(grade1.textContent, 'Mortal');

    // Second card — Spirit Herb.
    const card2 = grid.children[1];
    assert.equal(card2.getAttribute('data-item-id'), 'spirit-herb');

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('empty inventory shows placeholder', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const inventory = new FakeInventorySystem([]);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, eventBus: EventBus,
    });

    // Body should have a placeholder paragraph.
    assert.equal(body.children.length, 1);
    const placeholder = body.children[0];
    assert.equal(placeholder.getAttribute('class'), 'inventory-placeholder');
    assert.ok(placeholder.textContent.includes('No items in inventory'));

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('unknown item id renders degraded card', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const inventory = new FakeInventorySystem([{ id: 'unknown-artifact', count: 2 }]);
    const dataManager = new FakeDataManager({});

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, dataManager, eventBus: EventBus,
    });

    const grid = body.children[0];
    const card = grid.children[0];
    assert.equal(card.getAttribute('data-item-id'), 'unknown-artifact');

    const name = card.children[0];
    assert.ok(name.textContent.includes('Unknown item'));
    assert.ok(name.textContent.includes('unknown-artifact'));

    // Category and grade are blank/dash.
    const cat = card.children[2];
    assert.equal(cat.textContent, '\u2014');
    const grade = card.children[3];
    assert.equal(grade.textContent, '');

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('pagination is shown when stacks exceed pageSize', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    // 5 items, pageSize=2 → 3 pages.
    const stacks = [
      { id: 'a', count: 1 }, { id: 'b', count: 2 },
      { id: 'c', count: 3 }, { id: 'd', count: 4 },
      { id: 'e', count: 5 },
    ];
    const inventory = new FakeInventorySystem(stacks);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, eventBus: EventBus, pageSize: 2,
    });

    // Grid should have 2 items (first page).
    const grid = body.children[0];
    assert.equal(grid.children.length, 2);

    // Pagination container should be present.
    const pagination = body.children[1];
    assert.ok(pagination, 'Pagination should be present');
    assert.equal(pagination.getAttribute('class'), 'inventory-pagination');

    // Three children: Prev button, info span, Next button.
    assert.equal(pagination.children.length, 3);

    const prevBtn = pagination.children[0];
    assert.equal(prevBtn.textContent, 'Prev');
    assert.equal(prevBtn.getAttribute('data-inventory-prev'), '');
    // First page → Prev disabled.
    assert.equal(prevBtn.disabled, true);

    const info = pagination.children[1];
    assert.equal(info.textContent, 'Page 1 of 3');
    assert.equal(info.getAttribute('data-inventory-page-info'), '');

    const nextBtn = pagination.children[2];
    assert.equal(nextBtn.textContent, 'Next');
    assert.equal(nextBtn.getAttribute('data-inventory-next'), '');
    assert.equal(nextBtn.disabled, false);

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('clicking Next advances page and re-renders', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const stacks = [
      { id: 'a', count: 1 }, { id: 'b', count: 2 },
      { id: 'c', count: 3 }, { id: 'd', count: 4 },
    ];
    const inventory = new FakeInventorySystem(stacks);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, eventBus: EventBus, pageSize: 2,
    });

    // First page: items 'a' and 'b'.
    let grid = body.children[0];
    assert.equal(grid.children.length, 2);
    assert.equal(grid.children[0].getAttribute('data-item-id'), 'a');

    // Click Next.
    const pagination = body.children[1];
    const nextBtn = pagination.children[2];
    nextBtn.dispatchEvent('click');

    // Second page: items 'c' and 'd'.
    grid = body.children[0];
    assert.equal(grid.children.length, 2);
    assert.equal(grid.children[0].getAttribute('data-item-id'), 'c');

    // Page info updated.
    const info = body.children[1].children[1];
    assert.equal(info.textContent, 'Page 2 of 2');

    // Next is now disabled (last page).
    const nextBtn2 = body.children[1].children[2];
    assert.equal(nextBtn2.disabled, true);

    // Prev is now enabled.
    const prevBtn2 = body.children[1].children[0];
    assert.equal(prevBtn2.disabled, false);

    // Click Prev to go back.
    prevBtn2.dispatchEvent('click');
    grid = body.children[0];
    assert.equal(grid.children[0].getAttribute('data-item-id'), 'a');
    assert.equal(body.children[1].children[1].textContent, 'Page 1 of 2');

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('no pagination when stacks fit on one page', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const stacks = [{ id: 'a', count: 1 }];
    const inventory = new FakeInventorySystem(stacks);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, eventBus: EventBus, pageSize: 12,
    });

    // Only grid, no pagination.
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].getAttribute('class'), 'inventory-grid');

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('re-renders on inventory:changed event', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const inventory = new FakeInventorySystem([{ id: 'a', count: 1 }]);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, eventBus: EventBus,
    });

    // Initial render: 1 item.
    assert.equal(body.children[0].children.length, 1);

    // Mutate the inventory system's stacks.
    inventory.stacks.push({ id: 'b', count: 2 });

    // Emit inventory:changed.
    EventBus.emit('inventory:changed', { id: 'b', delta: 2, count: 2 });

    // Should re-render with 2 items.
    assert.equal(body.children[0].children.length, 2);

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('re-renders on ui:refresh event', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const inventory = new FakeInventorySystem([{ id: 'a', count: 1 }]);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, eventBus: EventBus,
    });

    assert.equal(body.children[0].children.length, 1);

    inventory.stacks.push({ id: 'b', count: 2 });

    // Emit ui:refresh (not inventory:changed — the ui:refresh subscription
    // should still trigger render).
    EventBus.emit('ui:refresh');

    assert.equal(body.children[0].children.length, 2);

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('destroy() unsubscribes all event listeners', () => {
  const { root } = createFakeRoot();
  const inventory = new FakeInventorySystem([{ id: 'a', count: 1 }]);

  const handle = initInventoryPanel({
    root, inventorySystem: inventory, eventBus: EventBus,
  });

  // Both events should have listeners.
  assert.equal(EventBus.hasListeners('inventory:changed'), true);
  assert.equal(EventBus.hasListeners('ui:refresh'), true);

  handle.destroy();

  // After destroy, listeners are gone.
  assert.equal(EventBus.hasListeners('inventory:changed'), false);
  assert.equal(EventBus.hasListeners('ui:refresh'), false);
});

test('destroy() is idempotent', () => {
  const { root } = createFakeRoot();
  const inventory = new FakeInventorySystem([{ id: 'a', count: 1 }]);

  const handle = initInventoryPanel({
    root, inventorySystem: inventory, eventBus: EventBus,
  });

  handle.destroy();
  // Second destroy should not throw.
  handle.destroy();

  assert.equal(EventBus.hasListeners('inventory:changed'), false);
});

// ---------------------------------------------------------------------------
// Defensive no-ops
// ---------------------------------------------------------------------------

test('missing root.querySelector returns no-op handle', () => {
  const handle = initInventoryPanel({ root: {} });
  assert.ok(typeof handle.render === 'function');
  assert.ok(typeof handle.destroy === 'function');
  handle.render(); // no-op
  handle.destroy(); // no-op
});

test('no [data-inventory-panel] returns no-op handle', () => {
  const root = {
    querySelector(selector) {
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  const handle = initInventoryPanel({ root });
  assert.ok(typeof handle.render === 'function');
  handle.render();
  handle.destroy();
});

test('missing inventory system renders empty placeholder', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();

    const handle = initInventoryPanel({
      root, inventorySystem: null, eventBus: EventBus,
    });

    assert.equal(body.children.length, 1);
    assert.ok(body.children[0].textContent.includes('No items in inventory'));

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('missing DataManager degrades all items to Unknown', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    const inventory = new FakeInventorySystem([{ id: 'some-item', count: 1 }]);

    const handle = initInventoryPanel({
      root, inventorySystem: inventory, dataManager: null, eventBus: EventBus,
    });

    const grid = body.children[0];
    const card = grid.children[0];
    const name = card.children[0];
    assert.ok(name.textContent.includes('Unknown item'));
    assert.ok(name.textContent.includes('some-item'));

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});

test('inventory system with no inventory getter renders empty', () => {
  stubCreateElement();
  try {
    const { root, body } = createFakeRoot();
    // Empty object with no inventory property.
    const badSystem = {};

    const handle = initInventoryPanel({
      root, inventorySystem: badSystem, eventBus: EventBus,
    });

    assert.ok(body.children[0].textContent.includes('No items in inventory'));

    handle.destroy();
  } finally {
    restoreCreateElement();
  }
});
