/**
 * tests/unit/tabs.test.mjs — unit tests for js/ui/tabs.js.
 *
 * Exercises the tab controller under a hand-rolled fake DOM (no jsdom):
 *   - Clicking a tab hides others and shows the correct panel.
 *   - The initial tab is visible, all others hidden.
 *   - aria-selected toggles between tabs.
 *   - .tab--active class follows the selected tab.
 *   - selectTab() does nothing for unknown tab ids.
 *   - destroy() removes the delegated click listener (idempotent).
 *   - Defensive no-ops: missing root.querySelector, no tabs, no panels.
 *
 * Uses Node's built-in test runner with zero dependencies. Run:
 * node --test tests/unit/tabs.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initTabs } from '../../js/ui/tabs.js';
import { EventBus } from '../../js/core/event-bus.js';

/** Reset the shared EventBus before every test. */
beforeEach(() => {
  EventBus.clear();
});

// ---------------------------------------------------------------------------
// Fake DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal fake element that supports setAttribute, getAttribute,
 * removeAttribute, classList (add/remove/contains), and closest().
 *
 * @param {string} tagName — ignored, exists for parity with createElement.
 * @returns {object} a fake DOM element.
 */
function createFakeElement(tagName) {
  const _attrs = Object.create(null);
  const _classNames = new Set();
  const _children = [];
  let _parent = null;

  const el = {
    get children() {
      return _children;
    },
    get parentNode() {
      return _parent;
    },
    set parentNode(v) {
      _parent = v;
    },
    setAttribute(name, value) {
      _attrs[name] = value;
    },
    getAttribute(name) {
      return name in _attrs ? _attrs[name] : null;
    },
    removeAttribute(name) {
      delete _attrs[name];
    },
    hasAttribute(name) {
      return name in _attrs;
    },
    classList: {
      add(cls) { _classNames.add(cls); },
      remove(cls) { _classNames.delete(cls); },
      contains(cls) { return _classNames.has(cls); },
    },
    appendChild(child) {
      _children.push(child);
      if (child && typeof child === 'object') child.parentNode = el;
      return child;
    },
    closest(selector) {
      let node = el;
      while (node) {
        if (selector === '[data-tab]' && node.hasAttribute('data-tab')) return node;
        if (typeof node.matches === 'function' && node.matches(selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    matches(selector) {
      if (selector === '[data-tab]' && el.hasAttribute('data-tab')) return true;
      return false;
    },
  };
  return el;
}

/**
 * Build a fake root with tab buttons and panels for the tests.
 *
 * @param {string[]} tabIds — list of tab ids to create.
 * @param {string} [initialTab='cultivation'] — the initial tab to pre-select.
 * @returns {{ root: object, tabs: Map<string, object>, panels: Map<string, object>,
 *            listeners: object }}
 */
function createFakeTabRoot(tabIds = ['cultivation', 'techniques', 'inventory', 'log', 'settings']) {
  const listeners = {};
  const tabs = new Map();
  const panels = new Map();

  for (const id of tabIds) {
    const tabBtn = createFakeElement('button');
    tabBtn.setAttribute('data-tab', id);
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.setAttribute('aria-controls', `tab-${id}`);
    tabs.set(id, tabBtn);

    const panel = createFakeElement('div');
    panel.setAttribute('data-tab-panel', id);
    panel.setAttribute('id', `tab-${id}`);
    panel.setAttribute('role', 'tabpanel');
    panels.set(id, panel);
  }

  const root = {
    querySelector(selector) {
      // Return the first matching element (for defensive checks).
      for (const [, tab] of tabs) {
        if (selector === '[data-tab]') return tab;
      }
      for (const [, panel] of panels) {
        if (selector === '[data-tab-panel]') return panel;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return Array.from(tabs.values());
      if (selector === '[data-tab-panel]') return Array.from(panels.values());
      return [];
    },
    addEventListener(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = listeners[type];
      if (!bucket) return;
      const idx = bucket.indexOf(handler);
      if (idx >= 0) bucket.splice(idx, 1);
    },
  };

  // Wire parent relationships for closest().
  for (const [, tab] of tabs) {
    tab.parentNode = root;
  }

  return { root, tabs, panels, listeners };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('initial tab is visible and others are hidden', () => {
  const { root, tabs, panels } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  // Cultivation tab should be visible (no hidden attribute).
  assert.equal(panels.get('cultivation').hasAttribute('hidden'), false);

  // Every other tab should be hidden.
  for (const [id, panel] of panels) {
    if (id === 'cultivation') continue;
    assert.equal(panel.hasAttribute('hidden'), true, `Panel "${id}" should be hidden`);
  }

  // Cultivation tab button has aria-selected="true".
  assert.equal(tabs.get('cultivation').getAttribute('aria-selected'), 'true');
  assert.equal(tabs.get('cultivation').classList.contains('tab--active'), true);

  // Other tab buttons have aria-selected="false".
  for (const [id, tab] of tabs) {
    if (id === 'cultivation') continue;
    assert.equal(tab.getAttribute('aria-selected'), 'false');
    assert.equal(tab.classList.contains('tab--active'), false);
  }

  handle.destroy();
});

test('clicking a tab hides others and shows the correct panel', () => {
  const { root, tabs, panels, listeners } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  // Simulate a click on the Inventory tab button.
  const invTab = tabs.get('inventory');
  assert.ok(listeners.click, 'Delegated click listener should be registered');
  assert.ok(listeners.click.length > 0);

  // Fire the delegated click handler with the inventory tab as target.
  listeners.click[0]({ target: invTab });

  // Only inventory panel should be visible.
  for (const [id, panel] of panels) {
    if (id === 'inventory') {
      assert.equal(panel.hasAttribute('hidden'), false, `Panel "${id}" should be visible`);
    } else {
      assert.equal(panel.hasAttribute('hidden'), true, `Panel "${id}" should be hidden`);
    }
  }

  // Inventory tab button is selected.
  assert.equal(invTab.getAttribute('aria-selected'), 'true');
  assert.equal(invTab.classList.contains('tab--active'), true);

  // Cultivation tab button is deselected.
  assert.equal(tabs.get('cultivation').getAttribute('aria-selected'), 'false');
  assert.equal(tabs.get('cultivation').classList.contains('tab--active'), false);

  handle.destroy();
});

test('clicking through closest() — delegated click on a child of tab button', () => {
  const { root, tabs, panels, listeners } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  // Create an inner span inside the techniques tab button.
  const techTab = tabs.get('techniques');
  const innerSpan = createFakeElement('span');
  innerSpan.parentNode = techTab;
  techTab.appendChild(innerSpan);

  // Fire click on the inner span — closest('[data-tab]') should find the button.
  listeners.click[0]({ target: innerSpan });

  // Techniques panel should be visible.
  assert.equal(panels.get('techniques').hasAttribute('hidden'), false);
  assert.equal(panels.get('cultivation').hasAttribute('hidden'), true);
  assert.equal(techTab.getAttribute('aria-selected'), 'true');
  assert.equal(techTab.classList.contains('tab--active'), true);

  handle.destroy();
});

test('clicking outside any tab button is a no-op', () => {
  const { root, tabs, panels, listeners } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  // Create a click target that has no [data-tab] ancestor.
  const unrelated = createFakeElement('div');
  // closest should return null (no parent chain to [data-tab]).
  // Fire click — should not change any panel visibility.
  listeners.click[0]({ target: unrelated });

  // Cultivation should still be the visible tab.
  assert.equal(panels.get('cultivation').hasAttribute('hidden'), false);
  for (const [id, panel] of panels) {
    if (id === 'cultivation') continue;
    assert.equal(panel.hasAttribute('hidden'), true);
  }

  handle.destroy();
});

test('selectTab() selects the requested tab programmatically', () => {
  const { root, tabs, panels } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  handle.selectTab('settings');

  // Only settings panel should be visible.
  assert.equal(panels.get('settings').hasAttribute('hidden'), false);
  assert.equal(panels.get('cultivation').hasAttribute('hidden'), true);
  assert.equal(tabs.get('settings').getAttribute('aria-selected'), 'true');
  assert.equal(tabs.get('settings').classList.contains('tab--active'), true);

  handle.destroy();
});

test('selectTab() with unknown id is a no-op', () => {
  const { root, tabs, panels } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  // Should not throw, should not change visible panel.
  handle.selectTab('nonexistent');

  // Cultivation should still be visible.
  assert.equal(panels.get('cultivation').hasAttribute('hidden'), false);
  for (const [id, panel] of panels) {
    if (id === 'cultivation') continue;
    assert.equal(panel.hasAttribute('hidden'), true);
  }

  handle.destroy();
});

test('destroy() removes the delegated click listener', () => {
  const { root, listeners } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  assert.ok(listeners.click && listeners.click.length > 0, 'Click listener should exist');
  const countBefore = listeners.click.length;

  handle.destroy();

  // After destroy, the click listener should be removed.
  assert.equal(listeners.click.length, countBefore - 1);
});

test('destroy() is idempotent', () => {
  const { root, listeners } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'cultivation' });

  const countBefore = listeners.click.length;

  handle.destroy();
  // Second destroy should not throw.
  handle.destroy();

  // Listener count should have decreased by exactly 1.
  assert.equal(listeners.click.length, countBefore - 1);
});

// ---------------------------------------------------------------------------
// Defensive no-ops
// ---------------------------------------------------------------------------

test('missing root.querySelector returns no-op handle', () => {
  const handle = initTabs({ root: {} });
  assert.ok(typeof handle.selectTab === 'function');
  assert.ok(typeof handle.destroy === 'function');
  handle.selectTab('any'); // no-op
  handle.destroy(); // no-op
});

test('no [data-tab] buttons returns no-op handle', () => {
  const root = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return [];
      if (selector === '[data-tab-panel]') return [createFakeElement('div')];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const handle = initTabs({ root });
  assert.ok(typeof handle.selectTab === 'function');
  handle.selectTab('any');
  handle.destroy();
});

test('no [data-tab-panel] panels returns no-op handle', () => {
  const btn = createFakeElement('button');
  btn.setAttribute('data-tab', 'cultivation');
  const root = {
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return [btn];
      if (selector === '[data-tab-panel]') return [];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const handle = initTabs({ root });
  assert.ok(typeof handle.selectTab === 'function');
  handle.selectTab('cultivation');
  handle.destroy();
});

test('custom initialTab id is respected', () => {
  const { root, tabs, panels } = createFakeTabRoot();
  const handle = initTabs({ root, initialTab: 'log' });

  assert.equal(panels.get('log').hasAttribute('hidden'), false);
  assert.equal(panels.get('cultivation').hasAttribute('hidden'), true);
  assert.equal(tabs.get('log').getAttribute('aria-selected'), 'true');
  assert.equal(tabs.get('log').classList.contains('tab--active'), true);

  handle.destroy();
});
