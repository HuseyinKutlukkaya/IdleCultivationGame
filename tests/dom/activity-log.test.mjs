/**
 * tests/dom/activity-log.test.mjs — DOM-level tests for js/ui/activity-log.js.
 *
 * Exercises initActivityLog() against fake DOM elements: the initial render
 * of the NotificationManager queue (message text, UTC HH:MM:SS timestamps,
 * log__item--<type> classes), re-rendering on the real EventBus's
 * 'notification:changed' event (payload queue with notifications.queue
 * fallback, empty queue → empty list), the no-op guards (missing container,
 * root without querySelector, null notifications) that warn once and never
 * throw, destroy() unsubscribing, and the text-only rendering rule (queue
 * messages are data-driven and must never be written through innerHTML).
 *
 * Uses the Node built-in test runner with zero dependencies. The fake DOM
 * surface initActivityLog touches lives in this file: a root with
 * querySelector, a container recording appended children, and a document
 * stub whose createElement returns fake li/span nodes (classList.add,
 * textContent, appendChild). The real EventBus is shared, so it is cleared
 * before every test.
 *
 * Run: node --test tests/dom/activity-log.test.mjs (or the full suite as
 * documented in tests/README.md).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initActivityLog } from '../../js/ui/activity-log.js';
import { EventBus } from '../../js/core/event-bus.js';

/** Event name the module under test subscribes to. */
const CHANGE_EVENT = 'notification:changed';
/** Selector the module under test resolves on the root. */
const LOG_SELECTOR = '#activity-log';

/** console.warn captured per test so guard warnings can be asserted. */
let savedWarn = null;
let warnCalls = [];
/** Saved pristine document global (footer.test.mjs pattern). */
let savedDocument = null;

/**
 * Create a fake log node (li/span) with the surface initActivityLog touches:
 * classList.add, appendChild (records children) and a textContent accessor
 * that, like the real DOM, replaces children when assigned.
 *
 * @param {string} tag — element tag name ('li' or 'span').
 * @returns {object} fake element recording classes/children/text.
 */
function createFakeLogNode(tag) {
  const classes = new Set();
  const children = [];
  let text = '';
  return {
    tag,
    /** @type {Set<string>} live class set (classList.add writes here). */
    classes,
    /** @type {Array<object>} appended children, in append order. */
    children,
    /** Fake classList implementing exactly the add() the renderer uses. */
    classList: {
      /**
       * Add every given class to the node.
       *
       * @param {...string} names — class names.
       * @returns {void}
       */
      add(...names) {
        for (const name of names) classes.add(name);
      },
    },
    /**
     * Record an appended child.
     *
     * @param {object} child — fake node to append.
     * @returns {object} the appended child (mirrors the DOM contract).
     */
    appendChild(child) {
      children.push(child);
      return child;
    },
    /** @returns {string} the node's text. */
    get textContent() {
      return text;
    },
    /**
     * Set the node's text; mirrors the DOM by replacing any children.
     *
     * @param {string} value — new text content.
     * @returns {void}
     */
    set textContent(value) {
      text = String(value);
      children.length = 0;
    },
  };
}

/**
 * Create the fake #activity-log container (a fake ul element).
 *
 * @returns {object} fake container that records appended children.
 */
function createFakeLogContainer() {
  return createFakeLogNode('ul');
}

/**
 * Create a fake root whose querySelector resolves #activity-log.
 *
 * @param {object} container — the fake log container to return.
 * @returns {object} scope with querySelector.
 */
function createFakeRoot(container) {
  return {
    /**
     * Resolve the log container.
     *
     * @param {string} selector — CSS selector.
     * @returns {object|null} the container for #activity-log, else null.
     */
    querySelector(selector) {
      return selector === LOG_SELECTOR ? container : null;
    },
  };
}

/**
 * Build a fake NotificationManager handle exposing a queue.
 *
 * @param {Array<object>} queue — initial queue entries.
 * @returns {{ queue: Array<object> }} fake manager handle.
 */
function makeNotifications(queue) {
  return { queue };
}

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
 * Install a fake document global whose createElement returns fake log nodes
 * (li/span). initActivityLog renders through document.createElement.
 *
 * @returns {void}
 */
function installDocumentStub() {
  globalThis.document = {
    /**
     * @param {string} tag — element tag name.
     * @returns {object} a fake log node.
     */
    createElement(tag) {
      return createFakeLogNode(tag);
    },
  };
}

/**
 * Assert no node in the tree ever gained an innerHTML property. The fake
 * nodes start without one; if the implementation assigned innerHTML, the
 * plain-object assignment would create the property, so its absence proves
 * the renderer only ever writes textContent.
 *
 * @param {object} node — fake node to walk.
 * @returns {void}
 */
function assertNoInnerHTML(node) {
  assert.equal(
    'innerHTML' in node,
    false,
    'renderer must never touch innerHTML (data-driven messages)',
  );
  for (const child of node.children) assertNoInnerHTML(child);
}

/** Clear the shared bus, capture console.warn and stub the document. */
beforeEach(() => {
  EventBus.clear();
  warnCalls = [];
  savedWarn = console.warn;
  console.warn = (...args) => {
    warnCalls.push(args);
  };
  savedDocument = captureGlobal('document');
  installDocumentStub();
});

/** Restore console.warn and the pristine document global after each test. */
afterEach(() => {
  EventBus.clear();
  console.warn = savedWarn;
  savedWarn = null;
  restoreGlobal('document', savedDocument);
  savedDocument = null;
});

test('init renders the initial queue with message, UTC time and type classes', () => {
  const container = createFakeLogContainer();
  const notifications = makeNotifications([
    {
      id: 'n1',
      type: 'success',
      message: 'Qi reached the cap.',
      // Fixed UTC instant — deterministic regardless of host locale/TZ.
      at: Date.UTC(2026, 0, 1, 12, 34, 56),
    },
    {
      id: 'n2',
      type: 'achievement',
      message: 'First breakthrough!',
      at: '2026-08-10T03:04:05Z',
    },
  ]);

  const handle = initActivityLog({
    eventBus: EventBus,
    notifications,
    root: createFakeRoot(container),
  });

  assert.equal(container.children.length, 2);

  const first = container.children[0];
  assert.deepEqual([...first.classes], ['log__item', 'log__item--success']);
  assert.equal(first.children.length, 2);
  assert.deepEqual([...first.children[0].classes], ['log__time']);
  assert.equal(first.children[0].textContent, '12:34:56');
  assert.equal(first.children[1].textContent, 'Qi reached the cap.');

  const second = container.children[1];
  assert.deepEqual([...second.classes], ['log__item', 'log__item--achievement']);
  assert.equal(second.children[0].textContent, '03:04:05');
  assert.equal(second.children[1].textContent, 'First breakthrough!');

  assert.equal(warnCalls.length, 0);
  handle.destroy();
});

test('notification:changed re-renders from the payload queue; empty queue clears', () => {
  const container = createFakeLogContainer();
  const notifications = makeNotifications([
    {
      id: 'n1',
      type: 'info',
      message: 'Welcome to the sect.',
      at: Date.UTC(2026, 0, 1, 1, 2, 3),
    },
  ]);

  const handle = initActivityLog({
    eventBus: EventBus,
    notifications,
    root: createFakeRoot(container),
  });
  assert.equal(container.children.length, 1);

  // Add an entry through the event payload.
  EventBus.emit(CHANGE_EVENT, {
    queue: [
      {
        id: 'n1',
        type: 'info',
        message: 'Welcome to the sect.',
        at: Date.UTC(2026, 0, 1, 1, 2, 3),
      },
      {
        id: 'n2',
        type: 'error',
        message: 'Tribulation failed.',
        at: Date.UTC(2026, 0, 1, 2, 3, 4),
      },
    ],
  });

  assert.equal(container.children.length, 2);
  assert.deepEqual(
    [...container.children[1].classes],
    ['log__item', 'log__item--error'],
  );
  assert.equal(container.children[1].children[0].textContent, '02:03:04');
  assert.equal(container.children[1].children[1].textContent, 'Tribulation failed.');

  // Remove entries: an empty payload queue renders an empty list.
  EventBus.emit(CHANGE_EVENT, { queue: [] });
  assert.equal(container.children.length, 0);

  handle.destroy();
});

test('payload without a queue falls back to the notifications queue', () => {
  const container = createFakeLogContainer();
  const notifications = makeNotifications([
    {
      id: 'n1',
      type: 'info',
      message: 'Initial.',
      at: Date.UTC(2026, 0, 1, 0, 0, 0),
    },
  ]);

  const handle = initActivityLog({
    eventBus: EventBus,
    notifications,
    root: createFakeRoot(container),
  });

  // The manager's queue is the fallback when the payload carries none.
  notifications.queue = [
    {
      id: 'n3',
      type: 'warning',
      message: 'Qi is low.',
      at: Date.UTC(2026, 0, 1, 4, 5, 6),
    },
  ];
  EventBus.emit(CHANGE_EVENT, {});

  assert.equal(container.children.length, 1);
  assert.deepEqual(
    [...container.children[0].classes],
    ['log__item', 'log__item--warning'],
  );
  assert.equal(container.children[0].children[0].textContent, '04:05:06');
  assert.equal(container.children[0].children[1].textContent, 'Qi is low.');

  // Even a payload-less emit (undefined payload) falls back.
  EventBus.emit(CHANGE_EVENT);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children[1].textContent, 'Qi is low.');

  handle.destroy();
});

test('returns a no-op handle and warns when the container is missing', () => {
  const root = { querySelector: () => null };
  const notifications = makeNotifications([]);

  let handle;
  assert.doesNotThrow(() => {
    handle = initActivityLog({ eventBus: EventBus, notifications, root });
  });

  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /#activity-log/);
  assert.equal(typeof handle.destroy, 'function');
  assert.doesNotThrow(() => handle.destroy());
});

test('returns a no-op handle and warns when root has no querySelector', () => {
  const notifications = makeNotifications([]);

  let handle;
  assert.doesNotThrow(() => {
    handle = initActivityLog({ eventBus: EventBus, notifications, root: {} });
  });

  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /querySelector/);
  assert.equal(typeof handle.destroy, 'function');
  assert.doesNotThrow(() => handle.destroy());
});

test('returns a no-op handle and warns when notifications is null', () => {
  const container = createFakeLogContainer();

  let handle;
  assert.doesNotThrow(() => {
    handle = initActivityLog({
      eventBus: EventBus,
      notifications: null,
      root: createFakeRoot(container),
    });
  });

  assert.equal(warnCalls.length, 1);
  assert.match(String(warnCalls[0][0]), /notifications manager/);
  assert.equal(typeof handle.destroy, 'function');
  assert.doesNotThrow(() => handle.destroy());
});

test('destroy unsubscribes so later notification:changed events do not re-render', () => {
  const container = createFakeLogContainer();
  const notifications = makeNotifications([
    {
      id: 'n1',
      type: 'info',
      message: 'First.',
      at: Date.UTC(2026, 0, 1, 0, 0, 0),
    },
  ]);

  const handle = initActivityLog({
    eventBus: EventBus,
    notifications,
    root: createFakeRoot(container),
  });
  assert.equal(EventBus.hasListeners(CHANGE_EVENT), true);

  handle.destroy();

  assert.equal(EventBus.hasListeners(CHANGE_EVENT), false);

  // A later event must leave the rendered list untouched.
  EventBus.emit(CHANGE_EVENT, {
    queue: [
      {
        id: 'n9',
        type: 'error',
        message: 'Should never render.',
        at: Date.UTC(2026, 0, 1, 9, 9, 9),
      },
    ],
  });
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children[1].textContent, 'First.');
});

test('messages render as text only — never through innerHTML', () => {
  const container = createFakeLogContainer();
  // Data-driven content that would be dangerous if parsed as markup.
  const malicious = '<img src=x onerror="alert(1)"> & "quotes"';
  const notifications = makeNotifications([
    {
      id: 'n1',
      type: 'warning',
      message: malicious,
      at: Date.UTC(2026, 0, 1, 0, 0, 0),
    },
  ]);

  const handle = initActivityLog({
    eventBus: EventBus,
    notifications,
    root: createFakeRoot(container),
  });

  // The message span holds the raw string, unparsed and unescaped.
  assert.equal(container.children[0].children[1].textContent, malicious);
  // No node in the rendered tree ever gained an innerHTML property.
  assertNoInnerHTML(container);
  // Only textContent is exposed — there is no innerHTML surface to assert on.
  assert.equal('innerHTML' in container.children[0], false);

  handle.destroy();
});
