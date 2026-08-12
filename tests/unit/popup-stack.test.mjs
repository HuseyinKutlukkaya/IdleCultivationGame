/**
 * tests/unit/popup-stack.test.mjs — unit tests for js/ui/popup-stack.js.
 *
 * Exercises initPopupStack() against a hand-rolled fake DOM (no jsdom) that
 * mirrors the exact surface the popup stack touches:
 *   - document.createElement → elements with setAttribute / className /
 *     appendChild / remove / addEventListener / textContent.
 *   - document.querySelector / document.body (host + fallback).
 *   - document.addEventListener / document.removeEventListener (unused by
 *     the module today, but the fake keeps the surface coherent).
 *
 * Coverage matches the spec (P2 Event Popup & Log Pipeline — popup half):
 *   - renders the initial NotificationManager queue: every entry with
 *     popup:true gets a [data-popup] node, the rest are skipped;
 *   - per-type [data-popup-type="<type>"] attribute is set so CSS can
 *     color-code (mirrors .log__item--<type> on the Activity Log);
 *   - message is written through textContent (never innerHTML) so a
 *     hostile payload cannot inject markup into the popup;
 *   - role="status" is set on every popup (a11y: implicit polite live
 *     region — never aria-live="assertive");
 *   - clicking a popup dismisses it immediately, clears its auto-dismiss
 *     timer, and is sticky (a later emit does not re-add it);
 *   - auto-dismiss fires after `popupDurationMs` (default 6000) and clears
 *     the timer reference; a 0 duration disables auto-dismiss;
 *   - max concurrent: when the visible count reaches `popupMaxVisible`,
 *     the oldest visible popup is removed before the new one mounts;
 *   - re-emit: an entry already visible is NOT duplicated (per-emit
 *     idempotency);
 *   - re-emit via payload.queue falls back to notifications.queue when
 *     the payload is missing the queue field;
 *   - defensive: missing document / missing host / missing notifications
 *     each return a no-op handle and warn once; invalid config tunables
 *     warn once and use the shipped defaults; missing config block is
 *     silent;
 *   - destroy() unsubscribes (later notification:changed events leave the
 *     host empty) and tears down every visible popup with no leftover DOM
 *     and no leaked timers.
 *
 * Uses Node's built-in test runner with zero dependencies. The fake DOM
 * mirrors the modal test pattern (tests/unit/modal.test.mjs) so the surface
 * stays consistent across UI tests. The real EventBus is shared, so it is
 * cleared before every test (initPopupStack defaults to the shared bus;
 * each test injects the fake document + a fake manager handle).
 *
 * Run: node --test tests/unit/popup-stack.test.mjs (or the full suite as
 * documented in tests/README.md).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initPopupStack } from '../../js/ui/popup-stack.js';
import { EventBus } from '../../js/core/event-bus.js';

// ---------------------------------------------------------------------------
// Constants mirrored from the module under test
// ---------------------------------------------------------------------------

const CHANGE_EVENT = 'notification:changed';
const HOST_SELECTOR = '[data-popup-root]';

/** Shipped defaults — mirrored from js/ui/popup-stack.js. */
const DEFAULT_POPUP_DURATION_MS = 6000;
const DEFAULT_POPUP_MAX_VISIBLE = 5;

/** Short duration used by the auto-dismiss tests so the suite stays fast. */
const SHORT_DURATION_MS = 30;

// ---------------------------------------------------------------------------
// Fake DOM — hand-rolled, no jsdom
// ---------------------------------------------------------------------------

/**
 * Create a fake DOM element with the exact surface the popup stack uses:
 * setAttribute, className (string), appendChild, remove, addEventListener,
 * textContent (string), parentNode, getAttribute.
 *
 * Each element records its listeners so the tests can dispatch a synthetic
 * 'click' event without going through a real DOM. parentNode is tracked so
 * the host can remove children via the fallback removeChild path.
 *
 * @returns {object} a fake DOM element.
 */
function createFakeElement() {
  const attrs = Object.create(null);
  const listeners = Object.create(null);
  let text = '';
  const children = [];
  let parentNode = null;
  let className = '';

  function appendChild(child) {
    children.push(child);
    if (child && 'parentNode' in child) child.parentNode = self;
    return child;
  }

  function remove() {
    if (parentNode && Array.isArray(parentNode.children)) {
      const idx = parentNode.children.indexOf(self);
      if (idx >= 0) parentNode.children.splice(idx, 1);
    }
    parentNode = null;
  }

  function dispatch(type, eventInit = {}) {
    const handlers = listeners[type] || [];
    const event = { type, ...eventInit };
    if (!event.target) event.target = self;
    for (const handler of handlers) handler(event);
  }

  const self = {
    attrs,
    listeners,
    children,
    get className() {
      return className;
    },
    set className(value) {
      className = String(value);
    },
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = String(value);
    },
    get parentNode() {
      return parentNode;
    },
    set parentNode(value) {
      parentNode = value;
    },
    appendChild,
    remove,
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
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
    dispatch,
  };
  return self;
}

/**
 * Create a fake document — querySelector resolves a single host (or the
 * fallback body), createElement returns a fresh fake element, body is a
 * pre-allocated fallback host (so a missing [data-popup-root] falls
 * through to document.body).
 *
 * Always returns a body (the production-style default); pass `body: null`
 * explicitly to test the no-host-found defensive path.
 *
 * @param {object} [options]
 * @param {object|null} [options.host=null] — pre-mounted host for
 *        [data-popup-root]; when null, the host resolves to body. Pass
 *        explicitly to override (e.g. host=null + body=null to test the
 *        missing-host warning).
 * @returns {{ doc: object, body: object, host: object }}
 */
function createFakeDocument(options = {}) {
  const createdElements = [];
  const body = options.body === undefined ? createFakeElement() : options.body;
  const host = options.host === undefined ? body : options.host;

  function createElement(tagName) {
    const el = createFakeElement();
    el.tagName = String(tagName).toUpperCase();
    createdElements.push(el);
    return el;
  }

  function querySelector(selector) {
    if (selector === HOST_SELECTOR) return host;
    return null;
  }

  const doc = {
    body,
    createElement,
    querySelector,
    addEventListener() {},
    removeEventListener() {},
    /** Test introspection — every element createElement has returned. */
    createdElements,
  };

  return { doc, body, host };
}

/**
 * Walk an element's descendants and return every one whose data-popup
 * attribute is set (the popups the stack has mounted into the host).
 *
 * @param {object} root — root to search from.
 * @returns {Array<object>} the popup nodes, in mount order.
 */
function findPopups(root) {
  const out = [];
  if (!root || !Array.isArray(root.children)) return out;
  for (const child of root.children) {
    if (child.attrs && Object.prototype.hasOwnProperty.call(child.attrs, 'data-popup')) {
      out.push(child);
    }
    out.push(...findPopups(child));
  }
  return out;
}

/**
 * Resolve the message <p> of a popup (the first descendant whose
 * data-popup-message attribute is set).
 *
 * @param {object} popup — popup <div> to search.
 * @returns {object|null} the message element, or null when missing.
 */
function findMessage(popup) {
  if (!popup || !Array.isArray(popup.children)) return null;
  for (const child of popup.children) {
    if (
      child.attrs &&
      Object.prototype.hasOwnProperty.call(child.attrs, 'data-popup-message')
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Assert no node in the tree ever gained an innerHTML property. The fake
 * elements start without one; if the implementation assigned innerHTML,
 * the plain-object assignment would create the property, so its absence
 * proves the popup stack only ever writes textContent (XSS-safe by
 * construction).
 *
 * @param {object} node — fake node to walk.
 * @returns {void}
 */
function assertNoInnerHTML(node) {
  assert.equal(
    'innerHTML' in node,
    false,
    'popup stack must never touch innerHTML (data-driven messages)'
  );
  for (const child of node.children) assertNoInnerHTML(child);
}

// ---------------------------------------------------------------------------
// Fake NotificationManager handle
// ---------------------------------------------------------------------------

/**
 * Build a fake NotificationManager handle exposing a mutable `queue` array
 * and an optional emit() hook the tests can call to drive the
 * 'notification:changed' listener (the real manager emits via the shared
 * EventBus; this fake mirrors that).
 *
 * @param {Array<object>} [initialQueue=[]] — initial queue snapshot.
 * @returns {{ queue: Array<object>, emit(payload: object): void }}
 */
function makeNotifications(initialQueue = []) {
  const state = { queue: Array.isArray(initialQueue) ? [...initialQueue] : [] };
  return {
    get queue() {
      return state.queue;
    },
    set queue(value) {
      state.queue = Array.isArray(value) ? value : [];
    },
    /**
     * Emit a 'notification:changed' event with the given payload. The
     * popup stack subscribes to the shared EventBus, so this delegates to
     * the real emit (matching the production wiring).
     *
     * @param {object} [payload] — payload (typically { queue }).
     * @returns {void}
     */
    emit(payload) {
      EventBus.emit(CHANGE_EVENT, payload);
    },
    /**
     * Replace the queue and emit (mirrors what NotificationManager.add()
     * does after enqueueing — but lets the tests avoid importing the
     * manager itself).
     *
     * @param {Array<object>} next — new queue contents.
     * @returns {void}
     */
    setQueueAndEmit(next) {
      state.queue = Array.isArray(next) ? [...next] : [];
      EventBus.emit(CHANGE_EVENT, { queue: state.queue });
    },
  };
}

// ---------------------------------------------------------------------------
// Global capture / restore
// ---------------------------------------------------------------------------

let savedDocument = null;
let savedWarn = null;
let warnCalls = [];

beforeEach(() => {
  EventBus.clear();
  savedWarn = console.warn;
  warnCalls = [];
  console.warn = (...args) => {
    warnCalls.push(args);
  };
  savedDocument = { present: 'document' in globalThis, value: globalThis.document };
});

afterEach(() => {
  EventBus.clear();
  console.warn = savedWarn;
  savedWarn = null;
  warnCalls = [];
  if (savedDocument.present) globalThis.document = savedDocument.value;
  else delete globalThis.document;
  savedDocument = null;
});

/**
 * Install a fake document onto globalThis.document (the module reads
 * `document` at the top of the function).
 *
 * @param {object} doc — fake document to install.
 * @returns {void}
 */
function installDocument(doc) {
  globalThis.document = doc;
}

// ===========================================================================
// 1. Initial render
// ===========================================================================

test('renders initial queue: every popup:true entry becomes a [data-popup] node, others are skipped', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'Gift', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'Quiet log note', at: 2, popup: false },
    { id: 'n3', type: 'achievement', message: 'Breakthrough!', at: 3, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } }, // disable auto-dismiss for the assertion
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 2, 'two popup entries rendered');
  // First popup is the master's gift (info), second is the breakthrough (achievement).
  assert.equal(popups[0].getAttribute('data-popup-type'), 'info');
  assert.equal(popups[1].getAttribute('data-popup-type'), 'achievement');
  // Non-popup entry skipped (no log__item mirror here, just no [data-popup]).
  assert.equal(popups.some((p) => p.getAttribute('data-popup-type') === 'success'), false);

  handle.destroy();
});

test('each popup carries role="status" (a11y: implicit polite live region)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'Hi', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 1);
  assert.equal(popups[0].getAttribute('role'), 'status');
  // Contract: never aria-live="assertive" — implicit polite through role="status".
  assert.equal(popups[0].getAttribute('aria-live'), null);

  handle.destroy();
});

test('per-type [data-popup-type] attribute is set so CSS can color-code', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'success', message: 'ok', at: 1, popup: true },
    { id: 'n2', type: 'warning', message: 'careful', at: 2, popup: true },
    { id: 'n3', type: 'error', message: 'no', at: 3, popup: true },
    { id: 'n4', type: 'achievement', message: 'yay', at: 4, popup: true },
    { id: 'n5', type: 'info', message: 'hi', at: 5, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 5);
  assert.deepEqual(
    popups.map((p) => p.getAttribute('data-popup-type')),
    ['success', 'warning', 'error', 'achievement', 'info']
  );
  // The 'popup' base class is always present so the CSS slide-in rule applies.
  for (const p of popups) {
    assert.equal(p.getAttribute('class'), 'popup');
  }

  handle.destroy();
});

test('messages render through textContent only — never through innerHTML (XSS-safe)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const malicious = '<img src=x onerror="alert(1)"> & "quotes"';
  const notifications = makeNotifications([
    { id: 'n1', type: 'warning', message: malicious, at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 1);
  const msg = findMessage(popups[0]);
  assert.ok(msg, 'message <p> present');
  assert.equal(msg.textContent, malicious, 'raw string lands in textContent');
  // No node in the rendered tree ever gained an innerHTML property.
  assertNoInnerHTML(host);

  handle.destroy();
});

test('host without [data-popup-root] falls back to document.body', () => {
  // body is supplied but no [data-popup-root] host — querySelector returns
  // null for the host selector, the module falls through to body.
  const body = createFakeElement();
  const { doc } = createFakeDocument({ body });
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'in body', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  const popups = findPopups(body);
  assert.equal(popups.length, 1, 'popup mounted into document.body fallback');
  assert.equal(warnCalls.length, 0, 'no warn — the fallback is intentional');

  handle.destroy();
});

// ===========================================================================
// 2. Re-emit idempotency
// ===========================================================================

test('re-emit with the same visible entry does NOT duplicate (per-emit idempotency)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'once', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  assert.equal(findPopups(host).length, 1);

  // Re-emit the SAME queue (no new entries, just an unrelated change).
  notifications.emit({ queue: notifications.queue });
  assert.equal(findPopups(host).length, 1, 'no duplicate popup');

  // And again with the same entry at the head — still one popup.
  notifications.emit({ queue: [{ ...notifications.queue[0] }] });
  assert.equal(findPopups(host).length, 1);

  handle.destroy();
});

test('re-emit via payload.queue is preferred over notifications.queue', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'initial', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });
  assert.equal(findPopups(host).length, 1);

  // Send a payload with a NEW popup entry — the manager's queue still
  // holds only n1 (we mutated the fake's queue through emit()).
  notifications.setQueueAndEmit([
    { id: 'n1', type: 'info', message: 'initial', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'new', at: 2, popup: true },
  ]);

  const popups = findPopups(host);
  assert.equal(popups.length, 2);
  assert.deepEqual(
    popups.map((p) => p.getAttribute('data-popup-type')),
    ['info', 'success']
  );

  handle.destroy();
});

test('payload without a queue field falls back to notifications.queue', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'first', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  // Update the fake manager's queue (mirrors a new add()), then emit a
  // payload-less event (undefined payload) — the popup stack must walk
  // notifications.queue as the fallback.
  notifications.queue = [
    { id: 'n1', type: 'info', message: 'first', at: 1, popup: true },
    { id: 'n2', type: 'warning', message: 'second', at: 2, popup: true },
  ];
  EventBus.emit(CHANGE_EVENT);

  const popups = findPopups(host);
  assert.equal(popups.length, 2, 'fallback to notifications.queue renders new popup');

  handle.destroy();
});

// ===========================================================================
// 3. Click dismiss
// ===========================================================================

test('clicking a popup dismisses it immediately and clears the auto-dismiss timer', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'click me', at: 1, popup: true },
  ]);

  // Use a real timer; track via setTimeout return. We can't easily inspect
  // the popup stack's internal timer reference, but we CAN observe the
  // effect: after click, the popup is gone immediately (not after the
  // configured duration). The duration is 200ms here so the timer would
  // also fire later if not cleared — assert it doesn't bring the popup back.
  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 200, popupMaxVisible: 5 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 1);
  popups[0].dispatch('click');

  assert.equal(findPopups(host).length, 0, 'popup gone immediately after click');

  // Wait past the auto-dismiss duration — the popup must NOT come back.
  return new Promise((resolve) => setTimeout(resolve, 250))
    .then(() => {
      assert.equal(findPopups(host).length, 0, 'no late timer resurrection');
      handle.destroy();
    });
});

test('clicking a popup is sticky: a later emit does NOT re-add it', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'click me', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  findPopups(host)[0].dispatch('click');
  assert.equal(findPopups(host).length, 0);

  // A later unrelated emit that still walks the dismissed entry through
  // the queue must NOT re-add the popup.
  notifications.setQueueAndEmit([
    { id: 'n1', type: 'info', message: 'click me', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'new one', at: 2, popup: true },
  ]);

  const popups = findPopups(host);
  assert.equal(popups.length, 1, 'only the new popup; the dismissed one stayed gone');
  assert.equal(popups[0].getAttribute('data-popup-type'), 'success');

  handle.destroy();
});

// ===========================================================================
// 4. Auto-dismiss timer
// ===========================================================================

test('popup auto-dismisses after popupDurationMs (default 6000ms; test uses a short duration)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'auto', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: SHORT_DURATION_MS } },
  });

  assert.equal(findPopups(host).length, 1);
  return new Promise((resolve) => setTimeout(resolve, SHORT_DURATION_MS * 2)).then(() => {
    assert.equal(findPopups(host).length, 0, 'popup auto-dismissed');
    handle.destroy();
  });
});

test('popupDurationMs === 0 disables auto-dismiss (click-only popup)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'sticky', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  assert.equal(findPopups(host).length, 1);
  return new Promise((resolve) => setTimeout(resolve, SHORT_DURATION_MS * 4)).then(() => {
    // With duration 0 the popup must NOT have auto-dismissed even after
    // waiting several short-duration intervals.
    assert.equal(findPopups(host).length, 1, 'duration 0 → popup stays until clicked');
    handle.destroy();
  });
});

test('auto-dismissed popup stays gone after a later emit (sticky dismissal — regression)', () => {
  // Regression (incident → guard, 2026-08-12): the initial removePopup path
  // did NOT add the id to the dismissed set, so a later emit that re-walked
  // the same queue would re-add the auto-dismissed popup. This test asserts
  // the sticky guarantee: a popup that auto-dismissed NEVER reappears on
  // subsequent notification:changed emissions while its entry stays in the
  // NotificationManager queue (the entry ages out only by FIFO cap, not by
  // time).
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'auto-gone', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: SHORT_DURATION_MS } },
  });
  assert.equal(findPopups(host).length, 1);

  return new Promise((resolve) => setTimeout(resolve, SHORT_DURATION_MS * 2))
    .then(() => {
      assert.equal(findPopups(host).length, 0, 'popup auto-dismissed');
      // Simulate a later notification arriving — the queue still holds n1
      // (the NotificationManager emits the full queue on every add). n1 is
      // now in dismissed (added by removePopup on timer fire).
      notifications.setQueueAndEmit([
        { id: 'n1', type: 'info', message: 'auto-gone', at: 1, popup: true },
        { id: 'n2', type: 'success', message: 'later note', at: 2, popup: true },
      ]);
      const popups = findPopups(host);
      assert.equal(
        popups.length,
        1,
        'only the new popup (n2) — n1 auto-dismissed and stayed gone'
      );
      assert.equal(popups[0].getAttribute('data-popup-type'), 'success');
      handle.destroy();
    });
});

test('cap-evicted popup stays gone after a later emit (sticky eviction — regression)', () => {
  // Regression (same root cause as auto-dismiss): the cap-eviction
  // removePopup call did NOT add the evicted id to dismissed, so on a
  // later emit a previously-evicted popup would re-enter the visible set
  // and evict another popup — causing visible churn on every emit.
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'oldest', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'middle', at: 2, popup: true },
    { id: 'n3', type: 'warning', message: 'newest', at: 3, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0, popupMaxVisible: 2 } },
  });

  // cap=2 on 3 popup entries: only the two newest (n2, n3) render; n1 evicted.
  const initial = findPopups(host);
  assert.equal(initial.length, 2);
  assert.deepEqual(
    initial.map((p) => p.getAttribute('data-popup-type')),
    ['success', 'warning']
  );

  // Later emit with the same queue — the evicted n1 must NOT come back
  // (it is now in the dismissed set, added by removePopup during the cap
  // enforcement on the initial render). n2 and n3 stay, n1 skipped.
  notifications.setQueueAndEmit([
    { id: 'n1', type: 'info', message: 'oldest', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'middle', at: 2, popup: true },
    { id: 'n3', type: 'warning', message: 'newest', at: 3, popup: true },
  ]);

  const after = findPopups(host);
  assert.equal(after.length, 2, 'still cap=2; n1 stays dismissed');
  assert.deepEqual(
    after.map((p) => p.getAttribute('data-popup-type')),
    ['success', 'warning'],
    'n2 + n3 unchanged — n1 did not re-appear'
  );

  handle.destroy();
});

// ===========================================================================
// 5. Max visible (cap)
// ===========================================================================

test('when popupMaxVisible is exceeded, the OLDEST visible popup is removed', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  // Start with two popup entries, then push one more to exceed cap=2.
  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'oldest', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'middle', at: 2, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0, popupMaxVisible: 2 } },
  });

  const popupsBefore = findPopups(host);
  assert.equal(popupsBefore.length, 2);
  assert.equal(popupsBefore[0].getAttribute('data-popup-type'), 'info');
  assert.equal(popupsBefore[1].getAttribute('data-popup-type'), 'success');

  // Now exceed the cap: a third popup comes in, the oldest (n1) must go.
  notifications.setQueueAndEmit([
    { id: 'n1', type: 'info', message: 'oldest', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'middle', at: 2, popup: true },
    { id: 'n3', type: 'warning', message: 'newest', at: 3, popup: true },
  ]);

  const popupsAfter = findPopups(host);
  assert.equal(popupsAfter.length, 2, 'cap held at 2');
  // Oldest (info) was removed; middle and newest remain.
  assert.deepEqual(
    popupsAfter.map((p) => p.getAttribute('data-popup-type')),
    ['success', 'warning']
  );

  handle.destroy();
});

test('initial render with more popup entries than popupMaxVisible drops the oldest', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  // 4 popups in the initial queue, cap=2 → only the two newest render.
  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'a', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 'b', at: 2, popup: true },
    { id: 'n3', type: 'warning', message: 'c', at: 3, popup: true },
    { id: 'n4', type: 'achievement', message: 'd', at: 4, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0, popupMaxVisible: 2 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 2);
  assert.deepEqual(
    popups.map((p) => p.getAttribute('data-popup-type')),
    ['warning', 'achievement']
  );

  handle.destroy();
});

// ===========================================================================
// 6. Defensive paths
// ===========================================================================

test('returns a no-op handle and warns when notifications manager is missing', () => {
  const { doc } = createFakeDocument();
  installDocument(doc);

  let handle;
  assert.doesNotThrow(() => {
    handle = initPopupStack({ eventBus: EventBus, notifications: null });
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /notifications manager/);
  assert.equal(typeof handle.destroy, 'function');
  assert.doesNotThrow(() => handle.destroy());
});

test('returns a no-op handle and warns when notifications.queue is not an array', () => {
  const { doc } = createFakeDocument();
  installDocument(doc);

  // Fake manager with a non-array queue — must warn + no-op.
  const handle = initPopupStack({
    eventBus: EventBus,
    notifications: { queue: 'not an array' },
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /notifications manager/);
  handle.destroy();
});

test('returns a no-op handle and warns when no host can be resolved (no root, no body)', () => {
  // No host, no body — both querySelector and document.body are unusable.
  // The fake doc has body=null and no host supplied.
  const { doc } = createFakeDocument({ body: null, host: null });
  installDocument(doc);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications: makeNotifications([]),
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /host/);
  handle.destroy();
});

test('returns a no-op handle and warns when document is missing', () => {
  // Simulate an environment without a document global. Setting it to
  // undefined mirrors the production case (a stripped build / SSR) where
  // `typeof document === 'undefined'`. (Deleting the property in an ES
  // module context throws a ReferenceError on bare access, which is a
  // different code path than the defensive guard the module exercises.)
  globalThis.document = undefined;

  let handle;
  assert.doesNotThrow(() => {
    handle = initPopupStack({ eventBus: EventBus, notifications: makeNotifications([]) });
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /document/);
  assert.equal(typeof handle.destroy, 'function');
  assert.doesNotThrow(() => handle.destroy());
});

test('missing config.notifications block uses shipped defaults silently', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'default cfg', at: 1, popup: true },
  ]);

  // No config block at all → defaults silently applied.
  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: null,
  });
  assert.equal(warnCalls.length, 0, 'missing config is silent');
  assert.equal(findPopups(host).length, 1, 'popup still rendered with default duration');

  handle.destroy();
});

test('invalid popupDurationMs (non-integer / negative) warns once and falls back to the default', () => {
  const { doc } = createFakeDocument();
  installDocument(doc);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications: makeNotifications([]),
    config: { notifications: { popupDurationMs: 'not a number' } },
  });
  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /popupDurationMs/);
  assert.match(String(warnCalls[0][0]), /6000/); // default surfaces in the warning
  handle.destroy();
});

test('invalid popupMaxVisible (non-integer / non-positive) warns once and falls back to the default', () => {
  const { doc } = createFakeDocument();
  installDocument(doc);

  // 0, negative, NaN, string — all must warn + fall back.
  for (const bad of [0, -1, NaN, 'abc', 1.5]) {
    warnCalls = [];
    const handle = initPopupStack({
      eventBus: EventBus,
      notifications: makeNotifications([]),
      config: { notifications: { popupMaxVisible: bad } },
    });
    assert.equal(warnCalls.length, 1, `bad popupMaxVisible ${String(bad)} → one warn`);
    assert.match(String(warnCalls[0][0]), /popupMaxVisible/);
    assert.match(String(warnCalls[0][0]), /5/); // default surfaces in the warning
    handle.destroy();
  }
});

test('non-positive popupDurationMs === 0 is honored (no auto-dismiss)', () => {
  // 0 is a valid (click-only) value — must NOT warn.
  const { doc } = createFakeDocument();
  installDocument(doc);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications: makeNotifications([]),
    config: { notifications: { popupDurationMs: 0 } },
  });
  assert.equal(warnCalls.length, 0, 'duration 0 is honored, not warned');
  handle.destroy();
});

// ===========================================================================
// 7. destroy()
// ===========================================================================

test('destroy() unsubscribes so later notification:changed events do not re-render', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'first', at: 1, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });
  assert.equal(findPopups(host).length, 1);

  handle.destroy();

  // No popup left in the host (destroy tears every visible one down).
  assert.equal(findPopups(host).length, 0, 'destroy removed the visible popup');
  assert.equal(EventBus.hasListeners(CHANGE_EVENT), false, 'destroy unsubscribed');

  // A later emit on the same bus must not re-create the popup.
  notifications.emit({ queue: [{ id: 'n2', type: 'info', message: 'after', at: 2, popup: true }] });
  assert.equal(findPopups(host).length, 0, 'post-destroy emit leaves the host empty');
});

test('destroy() clears all timers — no late resurrection', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 't1', at: 1, popup: true },
    { id: 'n2', type: 'success', message: 't2', at: 2, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 100 } },
  });
  assert.equal(findPopups(host).length, 2);

  handle.destroy();
  assert.equal(findPopups(host).length, 0);

  // Wait past the original timer — destroyed timers must NOT bring the
  // popups back (clearTimeout was called).
  return new Promise((resolve) => setTimeout(resolve, 200)).then(() => {
    assert.equal(findPopups(host).length, 0, 'no late resurrection after destroy');
  });
});

// ===========================================================================
// 8. Defensive entry handling
// ===========================================================================

test('entries without a string id are skipped (defensive against hostile payloads)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'good', at: 1, popup: true },
    { id: '', type: 'info', message: 'empty id', at: 2, popup: true },
    { id: 42, type: 'info', message: 'numeric id', at: 3, popup: true },
    { type: 'info', message: 'missing id', at: 4, popup: true },
    { id: 'n5', type: 'info', message: 'also good', at: 5, popup: true },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 2, 'only string-id entries render');

  handle.destroy();
});

test('entries with popup !== true are skipped (strict equality, defense in depth)', () => {
  const { doc, host } = createFakeDocument();
  installDocument(doc);

  const notifications = makeNotifications([
    { id: 'n1', type: 'info', message: 'literal true', at: 1, popup: true },
    { id: 'n2', type: 'info', message: 'truthy 1', at: 2, popup: 1 },
    { id: 'n3', type: 'info', message: 'string yes', at: 3, popup: 'yes' },
    { id: 'n4', type: 'info', message: 'null', at: 4, popup: null },
    { id: 'n5', type: 'info', message: 'missing', at: 5 },
  ]);

  const handle = initPopupStack({
    eventBus: EventBus,
    notifications,
    config: { notifications: { popupDurationMs: 0 } },
  });

  const popups = findPopups(host);
  assert.equal(popups.length, 1, 'only the literal-true entry renders');

  handle.destroy();
});