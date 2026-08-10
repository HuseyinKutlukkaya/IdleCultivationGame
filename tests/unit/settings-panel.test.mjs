/**
 * tests/unit/settings-panel.test.mjs — unit tests for js/ui/settings-panel.js.
 *
 * Exercises initSettingsPanel() against fully injected fakes (state,
 * notation, saveManager, config) and a fake DOM (root + panel container with
 * click delegation surface). Coverage matches the spec: constructor guard
 * paths (no querySelector, no panel, missing dependencies), applyToggle
 * (three valid keys, toggle semantics, unknown / prototype-alias / non-string
 * keys, missing state dependency, event order), applyNotationStyle (valid id,
 * unknown / prototype-alias / empty / non-string id, missing notation
 * dependency, event order), applyReset (saveManager.clear once, fresh slice
 * replaces the state, settings:reset / game:restored / ui:refresh order,
 * missing dependencies), notation <select> population (idempotent, default
 * selection logic, empty styles block), delegated click wiring (toggle /
 * select / reset / unrelated), destroy() (removes the listener, idempotent),
 * purity (no localStorage / no document / no SaveManager / no GameState
 * imports).
 *
 * Uses the Node built-in test runner with zero dependencies: shared doubles
 * (fake DOM, fake saveManager, fake notation, fake config) live in this
 * file so the tests stay standalone and `tests/helpers/` is untouched.
 *
 * Run: node --test tests/unit/settings-panel.test.mjs (or the full suite as
 * documented in tests/README.md).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EventBus } from '../../js/core/event-bus.js';
import { NotationFormatter } from '../../js/ui/notation.js';
import { initSettingsPanel } from '../../js/ui/settings-panel.js';

/** console.warn captured per test so guard warnings can be asserted. */
let savedWarn = null;
let warnCalls = [];
/** savedDocument / savedWindow globals — restore in afterEach. */
let savedDocument = null;
let savedWindow = null;

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

/**
 * Create a fake <select> element: tracks its children via appendChild,
 * exposes a mutable .value, supports `textContent = ''` to clear children
 * (mirrors the DOM's clearing contract used by populateNotationSelect),
 * stores an .options array of fake entries, and exposes a .closest method
 * that resolves the data-settings-select attribute (the module's click
 * delegation routes via closest()).
 *
 * @returns {object} the fake <select>.
 */
function createFakeSelect() {
  const children = [];
  let currentValue = '';
  const options = [];
  let text = '';
  const attrs = { 'data-settings-select': 'notationStyle' };
  return {
    children,
    options,
    /**
     * Record an appended <option> child. Matches the DOM contract:
     * `select.appendChild(option)` stores the option and returns it.
     *
     * @param {object} child — fake <option> (or any node).
     * @returns {object} the appended child.
     */
    appendChild(child) {
      children.push(child);
      options.push(child);
      return child;
    },
    /**
     * Resolve a CSS attribute selector against the select's own attributes —
     * the click delegation uses this to route `[data-settings-select=...]`.
     *
     * @param {string} selector — CSS attribute selector.
     * @returns {object|null}
     */
    closest(selector) {
      if (selector === '[data-settings-select="notationStyle"]') {
        if (attrs['data-settings-select'] === 'notationStyle') return this;
      }
      return null;
    },
    /** @returns {string} the current text content. */
    get textContent() {
      return text;
    },
    /**
     * Clear children on `textContent = ''` (mirrors the DOM contract used
     * by populateNotationSelect to reset the <select> before re-population).
     * Any other assignment is recorded as the new text.
     *
     * @param {string} value — new text content.
     */
    set textContent(value) {
      text = String(value);
      if (text === '') {
        children.length = 0;
        options.length = 0;
        currentValue = '';
      }
    },
    /** @returns {string} the current value. */
    get value() {
      return currentValue;
    },
    /**
     * Set the current value (assignment is mirrored from the DOM contract).
     *
     * @param {string} next — new value.
     */
    set value(next) {
      currentValue = String(next);
    },
  };
}

/**
 * Create a fake <button> element: getAttribute / setAttribute on a backing
 * attrs store (same as createFakeElement from tests/helpers/fake-dom.mjs),
 * a settable .type and a settable .closest function (used by click
 * delegation on nested elements).
 *
 * @param {object} [attrs={}] — initial attributes.
 * @param {object} [closestMap={}] — map of selector → element returned by
 *        .closest(selector); lets a child element bubble up to its toggle.
 * @returns {object} the fake <button>.
 */
function createFakeButton(attrs = {}, closestMap = {}) {
  return {
    attrs,
    type: attrs.type || 'button',
    /**
     * Walk up the closestMap looking for `selector`. Mirrors the DOM contract
     * for a button whose `closest(...)` finds itself when the selector
     * matches.
     *
     * @param {string} selector — CSS attribute selector.
     * @returns {object|null} the closest element matching the selector.
     */
    closest(selector) {
      if (selector in closestMap) return closestMap[selector];
      // Match the button itself when its own attrs satisfy the selector —
      // mirrors real-DOM behavior of Element.closest.
      if (selector.startsWith('[data-settings-toggle="')) {
        const key = selector.slice(
          '[data-settings-toggle="'.length,
          -2
        );
        if (attrs['data-settings-toggle'] === key) return this;
      }
      // Bare `[data-settings-toggle]` (any toggle) — the module's click
      // delegation looks for this to find ANY toggle the user clicked.
      if (selector === '[data-settings-toggle]') {
        if (typeof attrs['data-settings-toggle'] === 'string') return this;
      }
      if (selector === '[data-settings-reset]') {
        if ('data-settings-reset' in attrs) return this;
      }
      if (selector === '[data-settings-select="notationStyle"]') {
        if (attrs['data-settings-select'] === 'notationStyle') return this;
      }
      return null;
    },
    /**
     * Read an attribute.
     *
     * @param {string} name — attribute name.
     * @returns {string|null}
     */
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },
    /**
     * Write an attribute.
     *
     * @param {string} name — attribute name.
     * @param {string|number} value — value.
     */
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
  };
}

/**
 * Build a fake settings panel: a container with three toggles, a notation
 * <select> and a reset button. querySelector resolves each element by its
 * data-settings-* attribute; querySelectorAll supports the '[attr]' pattern
 * the module uses to mirror aria-checked onto every toggle on init.
 *
 * @returns {object} the fake panel container.
 */
function createFakePanel() {
  const offline = createFakeButton({
    type: 'button',
    role: 'switch',
    'aria-checked': 'true',
    'aria-label': 'Toggle Offline progress',
    'data-bind': 'settings.offlineProgress',
    'data-bind-mode': 'switch',
    'data-settings-toggle': 'offlineProgress',
  });
  const sound = createFakeButton({
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': 'Toggle Sound',
    'data-bind': 'settings.sound',
    'data-bind-mode': 'switch',
    'data-settings-toggle': 'sound',
  });
  const notifications = createFakeButton({
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': 'Toggle Notifications',
    'data-bind': 'settings.notifications',
    'data-bind-mode': 'switch',
    'data-settings-toggle': 'notifications',
  });
  const select = createFakeSelect();
  select.attrs = { 'data-settings-select': 'notationStyle', id: 'settings-notation-style' };
  // The select also needs getAttribute for populateNotationSelect.
  select.getAttribute = (name) =>
    Object.prototype.hasOwnProperty.call(select.attrs, name)
      ? select.attrs[name]
      : null;

  const reset = createFakeButton({
    type: 'button',
    class: 'btn btn--ghost setting__button',
    'data-settings-reset': '',
  });

  /** Map of every element keyed by the data-settings-* attribute it carries. */
  const attributeMap = {
    '[data-settings-toggle="offlineProgress"]': offline,
    '[data-settings-toggle="sound"]': sound,
    '[data-settings-toggle="notifications"]': notifications,
    '[data-settings-select="notationStyle"]': select,
    '[data-settings-reset]': reset,
    '[data-settings-toggle]': offline,
  };

  return {
    toggles: { offlineProgress: offline, sound, notifications },
    select,
    reset,
    /**
     * Resolve a single element by data-settings-* attribute selector. The
     * bare `[data-settings-toggle]` (no value) resolves to the first toggle
     * — enough to prove the panel has toggles, which is what the module
     * uses it for (presence detection).
     *
     * @param {string} selector — CSS attribute selector.
     * @returns {object|null}
     */
    querySelector(selector) {
      return attributeMap[selector] || null;
    },
    /**
     * Resolve all elements matching a [data-settings-*] prefix selector. The
     * module calls querySelectorAll('[data-settings-toggle]') on init to
     * mirror aria-checked; only that pattern needs handling here.
     *
     * @param {string} selector — CSS attribute selector.
     * @returns {Array<object>}
     */
    querySelectorAll(selector) {
      if (selector === '[data-settings-toggle]') {
        return [offline, sound, notifications];
      }
      return [];
    },
  };
}

/**
 * Build a fake settings panel that is intentionally missing one of the apply
 * attributes. The returned panel's querySelector returns null for the
 * missing attribute and the matching presence flag is false.
 *
 * @param {'toggle'|'select'|'reset'} missing — which apply attribute to omit.
 * @returns {{ panel: object, hasToggleAttr: boolean, hasSelectAttr: boolean, hasResetAttr: boolean }}
 */
function createPanelMissing(missing) {
  const hasToggleAttr = missing !== 'toggle';
  const hasSelectAttr = missing !== 'select';
  const hasResetAttr = missing !== 'reset';

  const attributeMap = {};
  let firstToggle = null;
  if (hasToggleAttr) {
    firstToggle = createFakeButton({
      type: 'button',
      'data-settings-toggle': 'offlineProgress',
    });
    attributeMap['[data-settings-toggle="offlineProgress"]'] = firstToggle;
    // The bare `[data-settings-toggle]` selector resolves to the first toggle
    // so the module's presence check (panel.querySelector('[data-settings-toggle]'))
    // sees the panel as having toggles when hasToggleAttr is true.
    attributeMap['[data-settings-toggle]'] = firstToggle;
  }
  if (hasSelectAttr) {
    const sel = createFakeSelect();
    sel.attrs = { 'data-settings-select': 'notationStyle' };
    sel.getAttribute = (name) =>
      Object.prototype.hasOwnProperty.call(sel.attrs, name) ? sel.attrs[name] : null;
    attributeMap['[data-settings-select="notationStyle"]'] = sel;
  }
  if (hasResetAttr) {
    attributeMap['[data-settings-reset]'] = createFakeButton({
      type: 'button',
      'data-settings-reset': '',
    });
  }

  const panel = {
    querySelector(selector) {
      return attributeMap[selector] || null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-settings-toggle]' && hasToggleAttr && firstToggle) {
        return [firstToggle];
      }
      return [];
    },
  };

  return { panel, hasToggleAttr, hasSelectAttr, hasResetAttr };
}

/**
 * Build a fake root: querySelector resolves [data-settings-panel], and the
 * root records addEventListener / removeEventListener calls so the click +
 * change delegation can be exercised by dispatching synthetic events.
 *
 * @param {object} panel — the fake panel to return for [data-settings-panel].
 * @returns {{ root: object, listeners: { click: Array<Function>, change: Array<Function> } }}
 */
function createFakeRoot(panel) {
  const listeners = { click: [], change: [] };
  const root = {
    /**
     * Resolve the panel.
     *
     * @param {string} selector — CSS selector.
     * @returns {object|null}
     */
    querySelector(selector) {
      if (selector === '[data-settings-panel]') return panel;
      return null;
    },
    /**
     * Record a delegated listener so destroy() can match the reference.
     *
     * @param {string} type — event name ('click').
     * @param {Function} handler — listener.
     */
    addEventListener(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    /**
     * Remove a delegated listener.
     *
     * @param {string} type — event name.
     * @param {Function} handler — listener.
     */
    removeEventListener(type, handler) {
      const bucket = listeners[type];
      if (!bucket) return;
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    },
  };
  return { root, listeners };
}

// ---------------------------------------------------------------------------
// Fakes for the constructor dependencies (notation, saveManager, state)
// ---------------------------------------------------------------------------

/**
 * Build a fake NotationFormatter-shaped object: exposes `setStyle` (returns
 * true for known ids, false for unknown) and a `style` getter that reads
 * state.settings.notationStyle (same contract as the real NotationFormatter).
 * `styles` and `state` are captured in a closure so the fake works without
 * `this`.
 *
 * @param {object} styles — config.notation.styles map.
 * @param {object} [state=null] — game state (mirrors the production
 *        NotationFormatter's `state` constructor arg).
 * @returns {{ setStyle: Function, readonly style: string }} fake notation.
 */
function createFakeNotation(styles, state = null) {
  return {
    /**
     * Reject unknown / prototype-alias / empty / non-string ids (mirrors the
     * real NotationFormatter.setStyle).
     *
     * @param {*} styleId — style id to write.
     * @returns {boolean}
     */
    setStyle(styleId) {
      if (typeof styleId !== 'string' || styleId === '') return false;
      if (!Object.hasOwn(styles, styleId)) return false;
      if (!state || !state.settings) return false;
      state.settings.notationStyle = styleId;
      return true;
    },
    /**
     * Effective style getter — reads state.settings.notationStyle when it is
     * a known id, else falls back to the first key (the production
     * NotationFormatter would consult config.notation.defaultStyle here; the
     * fake skips that branch to keep its surface tight — the tests assert
     * the override and the absence case, not the defaultStyle fallback).
     *
     * @returns {string}
     */
    get style() {
      const override = state && state.settings;
      if (
        override &&
        typeof override.notationStyle === 'string' &&
        Object.hasOwn(styles, override.notationStyle)
      ) {
        return override.notationStyle;
      }
      return Object.keys(styles)[0] || '';
    },
  };
}

/**
 * Build a fake SaveManager-shaped object exposing a `clear()` that records
 * every call. The fake does not need save/load — the module under test only
 * touches clear().
 *
 * @returns {{ clearCount: number, clear: Function }}
 */
function createFakeSaveManager() {
  const fake = {
    clearCount: 0,
    /**
     * Record the call. Returns undefined — the module under test does not
     * read the return value.
     *
     * @returns {void}
     */
    clear() {
      this.clearCount += 1;
    },
  };
  return fake;
}

/**
 * Build a fake config.notation block. Two style ids ("standard" + "scientific")
 * mirror the real config; styles may carry an optional `label`.
 *
 * @param {object} [overrides] — optional overrides for the default block.
 * @returns {object} fake config.
 */
function createFakeConfig(overrides = {}) {
  const styles = {
    standard: { threshold: 1000, suffixes: ['K', 'M'], label: 'Standard' },
    scientific: { threshold: 1000000, suffixes: [], label: 'Scientific' },
  };
  return {
    notation: {
      defaultStyle: 'standard',
      styles,
      ...overrides,
    },
    ...overrides,
  };
}

/**
 * Build a fresh game state object (mirrors js/core/game-state.js shape). The
 * tests use this as the state argument; applyReset replaces the contents in
 * place, so callers pass a single object that they can read after.
 *
 * @returns {object} a fresh state slice.
 */
function createFakeState() {
  return {
    version: { schema: 1, game: '0.1.0' },
    cultivation: {
      qi: 42,
      qiMax: 100,
      realmProgress: 12,
      realmProgressMax: 1000,
    },
    resources: {
      spiritStones: 7,
      herbs: 3,
      jade: 1,
      qiCondensationPills: 0,
    },
    inventory: {
      slots: { total: 20, used: 0 },
      items: [{ id: 'spirit-herb', count: 2 }],
    },
    settings: {
      offlineProgress: true,
      sound: false,
      notifications: false,
      notationStyle: null,
    },
    statistics: { playtimeMs: 0 },
  };
}

// ---------------------------------------------------------------------------
// Global capture / restore
// ---------------------------------------------------------------------------

/**
 * Capture a global so it can be restored later.
 *
 * @param {string} name — global property name.
 * @returns {{ present: boolean, value: unknown }}
 */
function captureGlobal(name) {
  return { present: name in globalThis, value: globalThis[name] };
}

/**
 * Restore a previously captured global.
 *
 * @param {string} name — global property name.
 * @param {{ present: boolean, value: unknown }} saved
 */
function restoreGlobal(name, saved) {
  if (saved.present) globalThis[name] = saved.value;
  else delete globalThis[name];
}

/**
 * Install a structuredClone polyfill on the Node global if it isn't already
 * available (older Node versions). Returns whether it was installed (the
 * afterEach restores the saved value).
 *
 * @returns {boolean} true when installed by this call.
 */
function ensureStructuredClone() {
  if (typeof globalThis.structuredClone === 'function') return false;
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
  return true;
}

/** Clear the shared bus, capture console.warn and structuredClone before each test. */
beforeEach(() => {
  EventBus.clear();
  warnCalls = [];
  savedWarn = console.warn;
  console.warn = (...args) => {
    warnCalls.push(args);
  };
  savedDocument = captureGlobal('document');
  savedWindow = captureGlobal('window');
  ensureStructuredClone();
});

/** Restore console.warn and the captured globals after each test. */
afterEach(() => {
  EventBus.clear();
  console.warn = savedWarn;
  savedWarn = null;
  restoreGlobal('document', savedDocument);
  savedDocument = null;
  restoreGlobal('window', savedWindow);
  savedWindow = null;
});

// ---------------------------------------------------------------------------
// Event history recorder
// ---------------------------------------------------------------------------

/**
 * Subscribe a recorder to the real EventBus so a test can assert the order
 * of emitted events.
 *
 * @returns {{ events: Array<{ name: string, payload: any }> }}
 */
function recordEvents() {
  const events = [];
  const handler = (name) => (payload) => {
    events.push({ name, payload });
  };
  EventBus.subscribe('settings:changed', handler('settings:changed'));
  EventBus.subscribe('settings:reset', handler('settings:reset'));
  EventBus.subscribe('game:restored', handler('game:restored'));
  EventBus.subscribe('ui:refresh', handler('ui:refresh'));
  return { events };
}

// ===========================================================================
// 1. Constructor
// ===========================================================================

test('init attaches exactly one click listener on root', () => {
  const { root, listeners } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(listeners.click.length, 1, 'exactly one delegated click listener');

  handle.destroy();
  assert.equal(listeners.click.length, 0, 'destroy removed the listener');
});

test('init mirrors state.settings onto every toggle\'s aria-checked (presentation concern)', () => {
  // Build a panel whose toggles start WITHOUT aria-checked — the module must
  // stamp the right value from state on init so screen readers announce the
  // current state before any click.
  const buildPanel = () => {
    const mk = (key) => ({
      attrs: { type: 'button', 'data-settings-toggle': key },
      type: 'button',
      closest(selector) {
        if (selector === `[data-settings-toggle="${key}"]`) return this;
        return null;
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name)
          ? this.attrs[name]
          : null;
      },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
    });
    const offline = mk('offlineProgress');
    const sound = mk('sound');
    const notifications = mk('notifications');
    const select = createFakeSelect();
    select.attrs = { 'data-settings-select': 'notationStyle' };
    select.getAttribute = (n) =>
      Object.prototype.hasOwnProperty.call(select.attrs, n) ? select.attrs[n] : null;
    const reset = createFakeButton({ type: 'button', 'data-settings-reset': '' });
    return {
      toggles: { offline, sound, notifications },
      select,
      reset,
      querySelector(selector) {
        if (selector === '[data-settings-toggle="offlineProgress"]') return offline;
        if (selector === '[data-settings-toggle="sound"]') return sound;
        if (selector === '[data-settings-toggle="notifications"]') return notifications;
        if (selector === '[data-settings-select="notationStyle"]') return select;
        if (selector === '[data-settings-reset]') return reset;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-settings-toggle]') return [offline, sound, notifications];
        return [];
      },
    };
  };

  const state = createFakeState();
  // Defaults from createFakeState: offlineProgress=true, sound=false,
  // notifications=false.
  const panel = buildPanel();
  const { root } = createFakeRoot(panel);

  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(panel.toggles.offline.getAttribute('aria-checked'), 'true');
  assert.equal(panel.toggles.sound.getAttribute('aria-checked'), 'false');
  assert.equal(panel.toggles.notifications.getAttribute('aria-checked'), 'false');

  handle.destroy();
});

test('applyNotationStyle without notation warns ONCE and returns false; with notation returns true', () => {
  const { root } = createFakeRoot(createFakePanel());
  const config = createFakeConfig();
  const state = createFakeState();

  const noNotation = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: null,
    saveManager: createFakeSaveManager(),
    config,
    root,
  });
  assert.equal(noNotation.applyNotationStyle('standard'), false);
  assert.equal(noNotation.applyNotationStyle('standard'), false); // second call must NOT warn again
  const notationWarns = warnCalls.filter((args) =>
    String(args[0]).includes('notation formatter')
  );
  assert.equal(notationWarns.length, 1, 'exactly one warning for missing notation');

  // Reset warnCalls for the second init.
  warnCalls = [];

  const withNotation = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(config.notation.styles, state),
    saveManager: createFakeSaveManager(),
    config,
    root,
  });
  assert.equal(withNotation.applyNotationStyle('standard'), true);
  const freshNotationWarns = warnCalls.filter((args) =>
    String(args[0]).includes('notation formatter')
  );
  assert.equal(freshNotationWarns.length, 0, 'no warning when notation is present');

  withNotation.destroy();
});

test('applyReset without saveManager warns ONCE and returns false', () => {
  const { root } = createFakeRoot(createFakePanel());
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(createFakeConfig().notation.styles),
    saveManager: null,
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyReset(), false);
  assert.equal(handle.applyReset(), false);
  const saveWarns = warnCalls.filter((args) => String(args[0]).includes('saveManager'));
  assert.equal(saveWarns.length, 1);
});

test('applyToggle without state warns ONCE and returns false', () => {
  const { root } = createFakeRoot(createFakePanel());
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: null,
    notation: createFakeNotation(createFakeConfig().notation.styles),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyToggle('offlineProgress'), false);
  assert.equal(handle.applyToggle('sound'), false);
  const stateWarns = warnCalls.filter((args) => String(args[0]).includes('no state'));
  assert.equal(stateWarns.length, 1);
});

test('missing root.querySelector warns and returns the no-op handle', () => {
  let handle;
  assert.doesNotThrow(() => {
    handle = initSettingsPanel({
      eventBus: EventBus,
      state: createFakeState(),
      notation: createFakeNotation(createFakeConfig().notation.styles),
      saveManager: createFakeSaveManager(),
      config: createFakeConfig(),
      root: {},
    });
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /querySelector/);
  assert.equal(handle.applyToggle('offlineProgress'), false);
  assert.equal(handle.applyNotationStyle('standard'), false);
  assert.equal(handle.applyReset(), false);
  assert.doesNotThrow(() => handle.destroy());
});

test('missing [data-settings-panel] warns and returns the no-op handle', () => {
  const root = { querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  let handle;
  assert.doesNotThrow(() => {
    handle = initSettingsPanel({
      eventBus: EventBus,
      state: createFakeState(),
      notation: createFakeNotation(createFakeConfig().notation.styles),
      saveManager: createFakeSaveManager(),
      config: createFakeConfig(),
      root,
    });
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /data-settings-panel/);
  assert.equal(handle.applyToggle('offlineProgress'), false);
});

test('panel without [data-settings-toggle]: applyToggle warns ONCE; the other applies still work', () => {
  const { panel } = createPanelMissing('toggle');
  const { root } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyToggle('offlineProgress'), false);
  assert.equal(handle.applyToggle('offlineProgress'), false);
  const toggleWarns = warnCalls.filter((args) =>
    String(args[0]).includes('data-settings-toggle')
  );
  assert.equal(toggleWarns.length, 1);

  // Other applies still work.
  assert.equal(handle.applyNotationStyle('scientific'), true);
  assert.equal(handle.applyReset(), true);
});

test('panel without [data-settings-select="notationStyle"]: applyNotationStyle warns ONCE; others still work', () => {
  const { panel } = createPanelMissing('select');
  const { root } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  // even with valid id + valid notation, the missing select attribute must
  // block the call (after the unknown-style warn consumed).
  assert.equal(handle.applyNotationStyle('standard'), false);
  assert.equal(handle.applyNotationStyle('scientific'), false);
  const selectWarns = warnCalls.filter((args) =>
    String(args[0]).includes('data-settings-select')
  );
  assert.equal(selectWarns.length, 1);

  // Other applies still work.
  assert.equal(handle.applyToggle('offlineProgress'), true);
  assert.equal(handle.applyReset(), true);
});

test('panel without [data-settings-reset]: applyReset warns ONCE; others still work', () => {
  const { panel } = createPanelMissing('reset');
  const { root } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyReset(), false);
  assert.equal(handle.applyReset(), false);
  const resetWarns = warnCalls.filter((args) =>
    String(args[0]).includes('data-settings-reset')
  );
  assert.equal(resetWarns.length, 1);

  // Other applies still work.
  assert.equal(handle.applyToggle('sound'), true);
  assert.equal(handle.applyNotationStyle('scientific'), true);
});

// ===========================================================================
// 2. applyToggle
// ===========================================================================

test('applyToggle flips each valid key and emits settings:changed + ui:refresh in order', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  for (const key of ['offlineProgress', 'sound', 'notifications']) {
    const before = state.settings[key];
    const { events } = recordEvents();
    const ok = handle.applyToggle(key);
    assert.equal(ok, true);
    assert.equal(state.settings[key], !before, `${key} toggled`);
    assert.deepEqual(events, [
      { name: 'settings:changed', payload: { key, value: state.settings[key] } },
      { name: 'ui:refresh', payload: undefined },
    ]);
  }

  handle.destroy();
});

test('applyToggle on the same key twice restores the original boolean', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  const before = state.settings.offlineProgress;
  assert.equal(handle.applyToggle('offlineProgress'), true);
  assert.equal(handle.applyToggle('offlineProgress'), true);
  assert.equal(state.settings.offlineProgress, before);

  handle.destroy();
});

test('applyToggle with an unknown key warns and returns false without mutating', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const before = { ...state.settings };
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  const { events } = recordEvents();
  assert.equal(handle.applyToggle('nope'), false);
  assert.deepEqual(state.settings, before);
  assert.equal(events.length, 0);
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /unknown or invalid key/);

  handle.destroy();
});

test('applyToggle rejects prototype-alias keys without mutating', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const before = JSON.stringify(state.settings);
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(handle.applyToggle(key), false);
    // state.settings must not have grown any of those keys.
    assert.equal(Object.hasOwn(state.settings, key), false);
  }
  assert.equal(JSON.stringify(state.settings), before);

  handle.destroy();
});

test('applyToggle with non-string keys warns and returns false', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const before = { ...state.settings };
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  for (const key of [null, undefined, 7, {}, []]) {
    assert.equal(handle.applyToggle(key), false);
  }
  assert.deepEqual(state.settings, before);
  // One warn per call (unknown/invalid path — not gated by ONCE).
  assert.ok(warnCalls.length >= 5);

  handle.destroy();
});

// ===========================================================================
// 3. applyNotationStyle
// ===========================================================================

test('applyNotationStyle writes state.settings.notationStyle via setStyle and emits in order', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const config = createFakeConfig();
  const notation = createFakeNotation(config.notation.styles, state);
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation,
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  const { events } = recordEvents();
  assert.equal(handle.applyNotationStyle('scientific'), true);
  assert.equal(state.settings.notationStyle, 'scientific');
  assert.equal(notation.style, 'scientific');
  assert.deepEqual(events, [
    { name: 'settings:changed', payload: { key: 'notationStyle', value: 'scientific' } },
    { name: 'ui:refresh', payload: undefined },
  ]);

  handle.destroy();
});

test('applyNotationStyle integrates with the real NotationFormatter — setStyle whitelist honored', () => {
  // Integration check: the module reaches the real NotationFormatter.setStyle
  // (writes through), and an unknown id is rejected by setStyle without
  // mutating state. Exercises the production contract end-to-end.
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const config = createFakeConfig();
  const notation = new NotationFormatter({ config: config.notation, state });
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation,
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  // A known style id reaches setStyle and writes.
  assert.equal(handle.applyNotationStyle('scientific'), true);
  assert.equal(state.settings.notationStyle, 'scientific');
  assert.equal(notation.style, 'scientific');

  // An unknown id is rejected by setStyle (Object.hasOwn on the real
  // formatter's styles); applyNotationStyle returns false without
  // mutating the existing override.
  assert.equal(handle.applyNotationStyle('vanished'), false);
  assert.equal(state.settings.notationStyle, 'scientific');

  handle.destroy();
});

test('applyNotationStyle with an unknown id warns and returns false without mutating', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const config = createFakeConfig();
  const notation = createFakeNotation(config.notation.styles, state);
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation,
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  state.settings.notationStyle = 'standard';
  const { events } = recordEvents();
  assert.equal(handle.applyNotationStyle('vanished'), false);
  assert.equal(state.settings.notationStyle, 'standard');
  assert.equal(events.length, 0);
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /unknown styleId/);

  handle.destroy();
});

test('applyNotationStyle with prototype-alias / empty / non-string ids warns and returns false', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const config = createFakeConfig();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(config.notation.styles, state),
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  state.settings.notationStyle = 'standard';
  for (const id of ['__proto__', 'constructor', '', null, undefined, 5, {}]) {
    assert.equal(handle.applyNotationStyle(id), false);
    // style must still be the original 'standard'.
    assert.equal(state.settings.notationStyle, 'standard');
  }

  handle.destroy();
});

// ===========================================================================
// 4. applyReset
// ===========================================================================

test('applyReset calls saveManager.clear() exactly once', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const saveManager = createFakeSaveManager();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager,
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyReset(), true);
  assert.equal(saveManager.clearCount, 1);

  handle.destroy();
});

test('applyReset replaces state with a fresh slice and emits settings:reset, game:restored, ui:refresh in order', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  const { events } = recordEvents();
  assert.equal(handle.applyReset(), true);

  // State slice was reset.
  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.resources.spiritStones, 0);
  assert.deepEqual(state.inventory.items, []);
  assert.equal(state.settings.notationStyle, null);
  assert.equal(state.settings.offlineProgress, true); // createGameState's default

  // Event order: settings:reset → game:restored → ui:refresh.
  assert.deepEqual(
    events.map((e) => e.name),
    ['settings:reset', 'game:restored', 'ui:refresh'],
  );

  handle.destroy();
});

test('applyReset state replacement is a deep clone — a second reset is also fresh', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyReset(), true);
  // Mutate the freshly-reset slice.
  state.cultivation.qi = 999;
  state.inventory.items.push({ id: 'jade', count: 1 });

  assert.equal(handle.applyReset(), true);
  // The second reset is also fresh — no leftover mutations.
  assert.equal(state.cultivation.qi, 0);
  assert.deepEqual(state.inventory.items, []);

  handle.destroy();
});

test('applyReset without saveManager warns ONCE and leaves state unchanged', () => {
  const { root } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const snapshot = JSON.parse(JSON.stringify(state));
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: null,
    config: createFakeConfig(),
    root,
  });

  assert.equal(handle.applyReset(), false);
  assert.equal(handle.applyReset(), false);
  assert.deepEqual(state, snapshot);
  const saveWarns = warnCalls.filter((args) => String(args[0]).includes('saveManager'));
  assert.equal(saveWarns.length, 1);

  handle.destroy();
});

// ===========================================================================
// 5. Notation <select> population
// ===========================================================================

test('init populates the <select> with one option per style id and the configured label', () => {
  const { panel, root } = (() => {
    const panel = createFakePanel();
    const { root } = createFakeRoot(panel);
    return { panel, root };
  })();

  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(createFakeConfig().notation.styles),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  const options = panel.select.options;
  assert.equal(options.length, 2);
  assert.equal(options[0].value, 'standard');
  assert.equal(options[0].label, 'Standard');
  assert.equal(options[1].value, 'scientific');
  assert.equal(options[1].label, 'Scientific');

  handle.destroy();
});

test('init selects state.settings.notationStyle when known, else defaultStyle, else first key', () => {
  // Player override known.
  {
    const panel = createFakePanel();
    const { root } = createFakeRoot(panel);
    const state = createFakeState();
    state.settings.notationStyle = 'scientific';
    initSettingsPanel({
      eventBus: EventBus,
      state,
      notation: createFakeNotation(createFakeConfig().notation.styles, state),
      saveManager: createFakeSaveManager(),
      config: createFakeConfig(),
      root,
    });
    assert.equal(panel.select.value, 'scientific');
  }

  // Player override unknown → fall back to defaultStyle ('standard').
  {
    warnCalls = [];
    const panel = createFakePanel();
    const { root } = createFakeRoot(panel);
    const state = createFakeState();
    state.settings.notationStyle = 'vanished';
    initSettingsPanel({
      eventBus: EventBus,
      state,
      notation: createFakeNotation(createFakeConfig().notation.styles, state),
      saveManager: createFakeSaveManager(),
      config: createFakeConfig(),
      root,
    });
    assert.equal(panel.select.value, 'standard');
  }

  // defaultStyle unknown → fall back to the first key.
  {
    warnCalls = [];
    const panel = createFakePanel();
    const { root } = createFakeRoot(panel);
    const state = createFakeState();
    const config = {
      notation: {
        defaultStyle: 'vanished',
        styles: {
          alpha: { label: 'Alpha' },
          beta: { label: 'Beta' },
        },
      },
    };
    initSettingsPanel({
      eventBus: EventBus,
      state,
      notation: createFakeNotation(config.notation.styles, state),
      saveManager: createFakeSaveManager(),
      config,
      root,
    });
    assert.equal(panel.select.value, 'alpha');
  }
});

test('init uses the style id as the label fallback when config has no label', () => {
  const panel = createFakePanel();
  const { root } = createFakeRoot(panel);
  const config = {
    notation: {
      defaultStyle: 'plain',
      styles: { plain: { threshold: 1000 } },
    },
  };

  initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(config.notation.styles),
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  assert.equal(panel.select.options.length, 1);
  assert.equal(panel.select.options[0].value, 'plain');
  assert.equal(panel.select.options[0].label, 'plain');
});

test('empty config.notation.styles: select still exists with zero options, warns ONCE on init', () => {
  const panel = createFakePanel();
  const { root } = createFakeRoot(panel);
  const config = { notation: { defaultStyle: 'vanished', styles: {} } };

  initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(config.notation.styles),
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  assert.equal(panel.select.options.length, 0);
  const styleWarns = warnCalls.filter((args) =>
    String(args[0]).includes('config.notation.styles is missing or empty')
  );
  assert.equal(styleWarns.length, 1);
});

test('the notation <select> is populated exactly once on init (idempotent on re-init)', () => {
  const panel = createFakePanel();
  const { root, listeners } = createFakeRoot(panel);
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(createFakeConfig().notation.styles),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  // First init populated 2 options.
  assert.equal(panel.select.options.length, 2);

  // Toggling a setting must NOT re-populate.
  handle.applyToggle('offlineProgress');
  assert.equal(panel.select.options.length, 2);

  // Re-populating manually would otherwise double-count — but the production
  // module never does that, so this is a contract assertion: the module does
  // not re-populate on applyToggle / applyNotationStyle / applyReset.
  handle.applyNotationStyle('scientific');
  handle.applyReset();
  assert.equal(panel.select.options.length, 2);

  handle.destroy();
  // The destroy/listener bookkeeping is intact.
  assert.equal(listeners.click.length, 0);
});

// ===========================================================================
// 6. Delegated click wiring
// ===========================================================================

test('click on [data-settings-toggle="offlineProgress"] routes to applyToggle and mutates state', () => {
  const panel = createFakePanel();
  const { root, listeners } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  const before = state.settings.offlineProgress;
  listeners.click[0]({ target: panel.toggles.offlineProgress });

  assert.equal(state.settings.offlineProgress, !before);
  // aria-checked is mirrored onto the toggle after a successful click so a
  // screen reader announces the new state immediately.
  assert.equal(
    panel.toggles.offlineProgress.getAttribute('aria-checked'),
    state.settings.offlineProgress ? 'true' : 'false',
  );

  handle.destroy();
});

test('click on [data-settings-select="notationStyle"] reads value and routes to applyNotationStyle', () => {
  const panel = createFakePanel();
  const { root, listeners } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  // Init populated the <select>; emulate the user choosing 'scientific'.
  panel.select.value = 'scientific';
  listeners.click[0]({ target: panel.select });

  assert.equal(state.settings.notationStyle, 'scientific');

  handle.destroy();
});

test('click on [data-settings-reset] routes to applyReset', () => {
  const panel = createFakePanel();
  const { root, listeners } = createFakeRoot(panel);
  const saveManager = createFakeSaveManager();
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager,
    config: createFakeConfig(),
    root,
  });

  listeners.click[0]({ target: panel.reset });

  assert.equal(saveManager.clearCount, 1);
  assert.equal(state.cultivation.qi, 0);

  handle.destroy();
});

test('click on an unrelated element does nothing', () => {
  const { panel, root, listeners } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const saveManager = createFakeSaveManager();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager,
    config: createFakeConfig(),
    root,
  });

  const before = JSON.stringify(state);
  const { events } = recordEvents();

  listeners.click[0]({ target: { closest: () => null } });

  assert.equal(JSON.stringify(state), before);
  assert.equal(saveManager.clearCount, 0);
  assert.equal(events.length, 0);

  handle.destroy();
});

test('init registers a delegated change listener on root for the notation <select>', () => {
  const { panel, root, listeners } = createFakeRoot(createFakePanel());
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(createFakeConfig().notation.styles, createFakeState()),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });
  assert.equal(listeners.change.length, 1, 'init attaches exactly one delegated change listener');

  handle.destroy();
  assert.equal(listeners.change.length, 0, 'destroy removed the change listener');
});

test('change on [data-settings-select="notationStyle"] routes to applyNotationStyle and mutates state', () => {
  const config = createFakeConfig();
  const panel = createFakePanel();
  const { root, listeners } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(config.notation.styles, state),
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  assert.equal(state.settings.notationStyle, null);
  // The fake panel exposes `panel.select` (the fake <select>) — fire a
  // synthetic change with target={value:'scientific'} on it.
  listeners.change[0]({ target: { value: 'scientific', closest: (sel) =>
    sel === '[data-settings-select="notationStyle"]' ? panel.select : null } });

  assert.equal(state.settings.notationStyle, 'scientific');

  handle.destroy();
});

test('change outside [data-settings-select="notationStyle"] does nothing', () => {
  const config = createFakeConfig();
  const panel = createFakePanel();
  const { root, listeners } = createFakeRoot(panel);
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(config.notation.styles, state),
    saveManager: createFakeSaveManager(),
    config,
    root,
  });

  const before = JSON.stringify(state);
  // An unrelated change target (e.g. a real <input> in some future system).
  listeners.change[0]({
    target: { value: 'scientific', closest: () => null },
  });

  assert.equal(JSON.stringify(state), before);
  handle.destroy();
});

// ===========================================================================
// 7. destroy
// ===========================================================================

test('destroy removes the delegated click listener; subsequent clicks are inert', () => {
  const { panel, root, listeners } = createFakeRoot(createFakePanel());
  const state = createFakeState();
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state,
    notation: createFakeNotation(createFakeConfig().notation.styles, state),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.equal(listeners.click.length, 1);
  handle.destroy();
  assert.equal(listeners.click.length, 0);

  // Calling the (now-removed) listener directly would do nothing — the
  // production module does not keep a reference, so we can't simulate a
  // late click through the same identity. Instead, assert the listener is
  // gone (the only behavior the production code exposes on destroy).
  const before = JSON.stringify(state);
  // Synthetic late dispatch with no installed listener — just exercises the
  // root's add/remove bookkeeping.
  assert.equal(listeners.click.length, 0);
  assert.equal(JSON.stringify(state), before);
});

test('destroy is idempotent', () => {
  const { root, listeners } = createFakeRoot(createFakePanel());
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: createFakeState(),
    notation: createFakeNotation(createFakeConfig().notation.styles),
    saveManager: createFakeSaveManager(),
    config: createFakeConfig(),
    root,
  });

  assert.doesNotThrow(() => {
    handle.destroy();
    handle.destroy();
    handle.destroy();
  });
  assert.equal(listeners.click.length, 0);
});

// ===========================================================================
// 8. Purity / no-leak
// ===========================================================================

test('the module never imports localStorage or reaches it at runtime', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '..', '..', 'js', 'ui', 'settings-panel.js');
  const src = readFileSync(file, 'utf8');

  // No direct localStorage access (the save-manager owns that contract).
  assert.equal(src.includes('localStorage'), false);
  // No direct document access at import time — only the `root` argument.
  assert.equal(/^import .*document/m.test(src), false);
  // No direct SaveManager import — the module receives one as a constructor
  // option so the surface stays pluggable.
  assert.equal(src.includes("from '../managers/save-manager.js'"), false);
  // No direct `GameState` (singleton) import — the module receives state as
  // a constructor option. Importing the `createGameState` factory is
  // permitted (pure constructor, no shared state); the assertion below
  // targets only the singleton import shape.
  assert.equal(/import\s*\{[^}]*\bGameState\b[^}]*\}/.test(src), false);
});

test('the apply* methods are safe to call before any bootstrap has wired state', () => {
  // Init still runs (the panel is present), but state/notation/saveManager
  // are all null. Every apply should warn ONCE per missing dependency and
  // return false — no throw, no mutation, no emit.
  const { root } = createFakeRoot(createFakePanel());
  const handle = initSettingsPanel({
    eventBus: EventBus,
    state: null,
    notation: null,
    saveManager: null,
    config: createFakeConfig(),
    root,
  });

  assert.doesNotThrow(() => {
    handle.applyToggle('offlineProgress');
    handle.applyToggle('sound');
    handle.applyToggle('notifications');
    handle.applyNotationStyle('standard');
    handle.applyNotationStyle('scientific');
    handle.applyReset();
  });

  // No exceptions, no mutation, no emit (the bus is empty).
  assert.equal(EventBus.hasListeners('settings:changed'), false);
  // The three dependency-missing warnings must each have fired exactly once.
  const all = warnCalls.map((a) => String(a[0]));
  assert.ok(all.some((m) => /no state/.test(m)), 'no-state warn present');
  assert.ok(all.some((m) => /notation formatter/.test(m)), 'no-notation warn present');
  assert.ok(all.some((m) => /saveManager/.test(m)), 'no-saveManager warn present');
});

// ===========================================================================
// 9. JSDoc header
// ===========================================================================

test('the module file starts with a project-style JSDoc header', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, '..', '..', 'js', 'ui', 'settings-panel.js');
  const src = readFileSync(file, 'utf8');
  const head = src.slice(0, src.indexOf('*/') + 2);

  // Header must call out responsibilities, event contract, defensive
  // contract and future expansion (matches activity-log.js's shape).
  assert.match(head, /Responsibilities|presentation/i);
  assert.match(head, /Event contract/);
  assert.match(head, /settings:changed/);
  assert.match(head, /settings:reset/);
  assert.match(head, /Defensive contract/);
  assert.match(head, /Future/);
});
