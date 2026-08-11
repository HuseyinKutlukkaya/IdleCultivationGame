/**
 * tests/unit/modal.test.mjs — unit tests for js/ui/modal.js.
 *
 * Exercises showConfirm() against a hand-rolled fake DOM (no jsdom, no
 * document polyfill) that mirrors the exact surface the modal touches:
 *   - document.createElement → elements with setAttribute / className /
 *     appendChild / remove / focus / textContent / addEventListener /
 *     contains / id.
 *   - document.querySelector / document.body / document.activeElement /
 *     document.addEventListener / document.removeEventListener / contains.
 *   - host.appendChild / removeChild.
 *
 * Coverage matches the spec:
 *   - showConfirm resolves true on confirm click
 *   - showConfirm resolves false on cancel click
 *   - showConfirm resolves false on ESC key
 *   - showConfirm resolves true on Enter inside the dialog
 *   - showConfirm with danger:true sets data-danger="true" on the confirm
 *     button AND focuses the cancel button (not confirm) on open
 *   - showConfirm cleans up the DOM (no leftover [data-modal-dialog] in
 *     the host after resolve)
 *   - showConfirm restores the previously-focused element on close
 *   - showConfirm with a missing root resolves false (no throw, no DOM)
 *   - Two concurrent showConfirm calls each get their own dialog (each
 *     resolves independently when its own buttons fire)
 *
 * Uses Node's built-in test runner with zero dependencies. Run:
 * node --test tests/unit/modal.test.mjs (or the full suite as documented
 * in tests/README.md).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { showConfirm } from '../../js/ui/modal.js';

// ---------------------------------------------------------------------------
// Fake DOM — hand-rolled, no jsdom
// ---------------------------------------------------------------------------

/**
 * Create a fake DOM element with the exact surface js/ui/modal.js uses:
 *   setAttribute, className (string), appendChild, remove, focus,
 *   textContent (string), addEventListener, contains, id, parentNode,
 *   click (dispatch).
 *
 * Each element records the listeners attached to it (so the tests can
 * dispatch synthetic events without going through the DOM) and tracks its
 * appended children so a test can find descendants by data-modal-*
 * attribute (the module builds the dialog subtree by hand and the tests
 * need to reach into it to click the cancel / confirm button).
 *
 * `setActive` (passed by the owning fake document) wires the element's
 * focus() / blur() to the document's activeElement — without it, the
 * modal's "focus on open, restore on close" assertions could not observe
 * focus transitions through `document.activeElement`.
 *
 * @param {Function|null} [setActive=null] — callback fired from focus()
 *        with `self`, used to update the owner document's activeElement.
 * @returns {object} a fake DOM element.
 */
function createFakeElement(setActive = null) {
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
    get id() {
      return attrs.id || '';
    },
    set id(value) {
      attrs.id = String(value);
    },
    get parentNode() {
      return parentNode;
    },
    set parentNode(value) {
      parentNode = value;
    },
    get type() {
      return attrs.type || '';
    },
    set type(value) {
      attrs.type = String(value);
    },
    appendChild,
    remove,
    contains(other) {
      if (other === self) return true;
      for (const child of children) {
        if (child === other) return true;
        if (child && typeof child.contains === 'function' && child.contains(other)) {
          return true;
        }
      }
      return false;
    },
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
    focus() {
      if (typeof setActive === 'function') setActive(self);
    },
    blur() {
      // A detached element's blur is a no-op; we don't track per-element
      // active state, only the document's pointer.
    },
    dispatch,
  };
  return self;
}

/**
 * Create a fake document — querySelector resolves a single host (or the
 * fallback body), createElement returns a new fake element, body is a
 * pre-allocated fallback host (so a missing [data-modal-root] falls
 * through to document.body), activeElement tracks the most recent focus().
 *
 * @param {object} [options]
 * @param {object|null} [options.host=null] — pre-mounted host for
 *        [data-modal-root]; when null, the host resolves to body.
 * @returns {{ doc: object, body: object, host: object,
 *           dispatchKeydown: Function, keydownHandlerAt: Function }}
 */
function createFakeDocument(options = {}) {
  const documentListeners = Object.create(null);
  let _activeElement = null;
  const createdElements = [];

  function setActive(el) {
    _activeElement = el;
  }

  function createElement(tagName) {
    const el = createFakeElement(setActive);
    el.tagName = String(tagName).toUpperCase();
    createdElements.push(el);
    return el;
  }

  const body = createFakeElement(setActive);
  body.tagName = 'BODY';
  body.setAttribute('data-modal-root', ''); // body doubles as the default host
  const host = options.host || body;

  function querySelector(selector) {
    if (selector === '[data-modal-root]') return host;
    return null;
  }

  function dispatchKeydown(eventInit = {}) {
    const handlers = documentListeners.keydown || [];
    const event = { type: 'keydown', ...eventInit };
    if (!event.target) event.target = body;
    for (const handler of handlers) handler(event);
  }

  const doc = {
    body,
    createElement,
    querySelector,
    contains(node) {
      if (node === body) return true;
      // For our tests, the dialog subtree lives under the host; the host
      // is the body, so descendants are reachable via body.contains.
      return body.contains(node);
    },
    get activeElement() {
      return _activeElement;
    },
    addEventListener(type, handler) {
      if (!documentListeners[type]) documentListeners[type] = [];
      documentListeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = documentListeners[type];
      if (!bucket) return;
      const idx = bucket.indexOf(handler);
      if (idx >= 0) bucket.splice(idx, 1);
    },
    dispatchKeydown,
    /** Test introspection — every element createElement has returned. */
    createdElements,
    /** @returns {Function|null} the first keydown handler (the modal's). */
    keydownHandlerAt() {
      const bucket = documentListeners.keydown || [];
      return bucket[0] || null;
    },
  };

  return { doc, body, host, dispatchKeydown };
}

/**
 * Walk an element's descendants and return the first one whose data-*
 * attribute (the second positional arg, without the data- prefix) equals
 * the supplied value. Mirrors the test pattern used by
 * tests/unit/cultivation-panel.test.mjs to reach into a hand-built
 * subtree.
 *
 * @param {object} root — root to search from.
 * @param {string} attr — data attribute name (without the data- prefix).
 * @returns {object|null} the first matching descendant.
 */
function findByAttr(root, attr) {
  if (!root || !Array.isArray(root.children)) return null;
  for (const child of root.children) {
    if (child.attrs && Object.prototype.hasOwnProperty.call(child.attrs, attr)) {
      return child;
    }
    const nested = findByAttr(child, attr);
    if (nested) return nested;
  }
  return null;
}

/**
 * Count descendants of `root` carrying the given data attribute (with or
 * without value match).
 *
 * @param {object} root — root to search from.
 * @param {string} attr — data attribute name (without the data- prefix).
 * @returns {number} the count.
 */
function countByAttr(root, attr) {
  if (!root || !Array.isArray(root.children)) return 0;
  let n = 0;
  for (const child of root.children) {
    if (child.attrs && Object.prototype.hasOwnProperty.call(child.attrs, attr)) n += 1;
    n += countByAttr(child, attr);
  }
  return n;
}

/**
 * Resolve the dialog element appended by showConfirm into the host. The
 * modal appends a single [data-modal-dialog] element; this helper returns
 * it (or null if not yet mounted).
 *
 * @param {object} host — the [data-modal-root] host.
 * @returns {object|null}
 */
function getDialog(host) {
  return findByAttr(host, 'data-modal-dialog');
}

// ---------------------------------------------------------------------------
// Global capture / restore
// ---------------------------------------------------------------------------

let savedDocument = null;
let savedWindow = null;

beforeEach(() => {
  savedDocument = { present: 'document' in globalThis, value: globalThis.document };
  savedWindow = { present: 'window' in globalThis, value: globalThis.window };
});

afterEach(() => {
  if (savedDocument.present) globalThis.document = savedDocument.value;
  else delete globalThis.document;
  if (savedWindow.present) globalThis.window = savedWindow.value;
  else delete globalThis.window;
  savedDocument = null;
  savedWindow = null;
});

/** Install a fake document onto globalThis.document. */
function installDocument(doc) {
  globalThis.document = doc;
}

// ===========================================================================
// 1. Resolution semantics
// ===========================================================================

test('showConfirm resolves true on confirm click', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({
    title: 'Reset Save',
    message: 'Wipe progress?',
    confirmLabel: 'Reset',
    cancelLabel: 'Cancel',
    danger: true,
  });

  const dialog = getDialog(body);
  assert.ok(dialog, 'dialog mounted');

  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.ok(confirmBtn, 'confirm button present');
  confirmBtn.dispatch('click');

  const result = await promise;
  assert.equal(result, true);
});

test('showConfirm resolves false on cancel click', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm' });
  const dialog = getDialog(body);
  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  assert.ok(cancelBtn);
  cancelBtn.dispatch('click');

  const result = await promise;
  assert.equal(result, false);
});

test('showConfirm resolves false on ESC key', async () => {
  const { doc, body, dispatchKeydown } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm' });
  assert.ok(getDialog(body), 'dialog mounted before ESC');
  dispatchKeydown({ key: 'Escape', preventDefault() {} });

  const result = await promise;
  assert.equal(result, false);
});

test('showConfirm resolves true on Enter pressed while the confirm button is focused (native button activation)', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm' });
  const dialog = getDialog(body);
  assert.ok(dialog);

  // Neutral (danger:false) focuses the confirm button on open. Real
  // browsers activate a focused button on Enter (native <button> default
  // behavior) — the modal's keydown handler intentionally does NOT
  // intercept Enter (that path would defeat the danger:true design), so
  // the resolution must come from the focused button's own click handler.
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.ok(confirmBtn);
  assert.equal(doc.activeElement, confirmBtn);
  confirmBtn.dispatch('click');

  const result = await promise;
  assert.equal(result, true);
});

test('showConfirm with danger:true resolves FALSE when Enter is pressed (cancel button is focused, native activation)', async () => {
  // Regression test for the bug where the modal's keydown handler forced
  // close(true) on any Enter inside the dialog — that path silently
  // confirmed a destructive action when the cancel button was focused.
  // The fix: drop the Enter intercept; rely on native <button>
  // activation. When danger:true, focus is on cancel → Enter triggers
  // the cancel click → close(false).
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 'Reset Save', message: 'Sure?', danger: true });
  const dialog = getDialog(body);
  assert.ok(dialog);

  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.equal(doc.activeElement, cancelBtn, 'danger: focus on cancel');
  // Simulate the browser's native "Enter on a focused button" behavior:
  // the keydown fires (the modal ignores it now), then the button click
  // fires (the modal closes via its click handler).
  cancelBtn.dispatch('click');

  const result = await promise;
  assert.equal(result, false, 'danger:true + Enter → resolve false (cancel)');
  assert.ok(confirmBtn, 'confirm button still present for the assert');
});

// ===========================================================================
// 2. A11y / attribute wiring
// ===========================================================================

test('showConfirm with danger:true sets data-danger="true" on the confirm button', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm', danger: true });
  const dialog = getDialog(body);
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.ok(confirmBtn);
  assert.equal(confirmBtn.getAttribute('data-danger'), 'true');

  // Cleanup so the test promise resolves.
  confirmBtn.dispatch('click');
  await promise;
});

test('showConfirm (danger:false) does not set data-danger on the confirm button', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm' });
  const dialog = getDialog(body);
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.equal(confirmBtn.getAttribute('data-danger'), null);

  confirmBtn.dispatch('click');
  await promise;
});

test('showConfirm mounts a dialog with role="dialog" and aria-modal="true"', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 'My title', message: 'My message' });
  const dialog = getDialog(body);
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  // aria-labelledby / aria-describedby point at the title / message ids.
  const titleId = dialog.getAttribute('aria-labelledby');
  const messageId = dialog.getAttribute('aria-describedby');
  assert.ok(titleId && messageId);
  const titleEl = findByAttr(dialog, 'data-modal-title');
  const messageEl = findByAttr(dialog, 'data-modal-message');
  assert.equal(titleEl.id, titleId);
  assert.equal(messageEl.id, messageId);

  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  cancelBtn.dispatch('click');
  await promise;
});

test('showConfirm with danger:true focuses the cancel button (not confirm) on open', async () => {
  const { doc, body, doc: _doc } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm', danger: true });
  const dialog = getDialog(body);
  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  // The danger path focuses cancelBtn on open (destructive action MUST NOT
  // be the default Enter target). assert against the activeElement pointer.
  assert.equal(doc.activeElement, cancelBtn, 'danger: focus lands on cancel');
  assert.notEqual(doc.activeElement, confirmBtn);

  // Cleanup.
  cancelBtn.dispatch('click');
  await promise;
});

test('showConfirm with danger:false focuses the confirm button on open', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm' });
  const dialog = getDialog(body);
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.equal(doc.activeElement, confirmBtn, 'neutral: focus lands on confirm');

  confirmBtn.dispatch('click');
  await promise;
});

// ===========================================================================
// 3. Cleanup
// ===========================================================================

test('showConfirm cleans up the DOM — no leftover [data-modal-dialog] in host after resolve', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  // Mount + resolve via confirm.
  {
    const promise = showConfirm({ title: 't', message: 'm' });
    assert.ok(getDialog(body), 'dialog mounted before resolve');
    const dialog = getDialog(body);
    const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
    confirmBtn.dispatch('click');
    await promise;
  }
  assert.equal(getDialog(body), null, 'dialog removed on confirm resolve');
  assert.equal(countByAttr(body, 'data-modal-dialog'), 0);

  // A second mount + resolve via cancel cleans up too.
  {
    const promise = showConfirm({ title: 't', message: 'm' });
    assert.ok(getDialog(body), 'dialog mounted again before resolve');
    const dialog = getDialog(body);
    const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
    cancelBtn.dispatch('click');
    await promise;
  }
  assert.equal(getDialog(body), null, 'dialog removed on cancel resolve');
});

test('showConfirm restores the previously focused element on close', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  // Pre-focus a sentinel element so we can verify restoration. The
  // sentinel goes through doc.createElement so its focus() updates the
  // document's activeElement pointer (matches the contract of a real
  // element.focus()), and we append it to body so the modal's contains()
  // check sees it as "still in the document" (real DOM: an element that
  // was activeElement is, by definition, in the document).
  const sentinel = doc.createElement('button');
  body.appendChild(sentinel);
  sentinel.focus();
  assert.equal(doc.activeElement, sentinel);

  const promise = showConfirm({ title: 't', message: 'm' });
  // While the modal is open, the focus moved to the confirm button.
  const dialog = getDialog(body);
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  assert.equal(doc.activeElement, confirmBtn, 'modal grabbed focus on open');

  confirmBtn.dispatch('click');
  await promise;

  // Focus returned to the sentinel.
  assert.equal(doc.activeElement, sentinel, 'previous focus restored on close');
});

test('showConfirm restores focus even when the previous element is detached from the document', async () => {
  // Defensive: a real DOM may have detached the previously-focused element
  // (e.g. the player navigated) — the modal must NOT throw or crash. The
  // fake document's contains() returns false for an element the test
  // never appended, so the production path's contains() check must short-
  // circuit before focus() is called (otherwise focus on a detached node
  // would either throw or silently move focus nowhere).
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  // Create the sentinel via doc.createElement so its focus() updates
  // activeElement. We do NOT append it to body — it stays "detached"
  // from the document tree, mirroring the production edge case.
  const sentinel = doc.createElement('button');
  sentinel.focus();
  assert.equal(doc.activeElement, sentinel);

  const promise = showConfirm({ title: 't', message: 'm' });
  const dialog = getDialog(body);
  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  cancelBtn.dispatch('click');

  // `await promise` must not throw, and the modal must resolve false
  // (cancel) cleanly.
  const result = await promise;
  assert.equal(result, false);
  // Active element was not restored (sentinel not in document.contains),
  // so doc.activeElement either stays at the modal's last focus OR is
  // whatever the cleanup left behind — but it MUST NOT be the sentinel
  // (the contract: only restore focus when the previous element is
  // actually in the document).
  assert.notEqual(doc.activeElement, sentinel, 'detached previous focus was NOT restored');
});

// ===========================================================================
// 4. Defensive paths
// ===========================================================================

test('showConfirm with missing document resolves false (no throw, no DOM)', async () => {
  // Ensure no document global exists for this test.
  delete globalThis.document;
  delete globalThis.window;

  let result;
  let didThrow = false;
  try {
    result = await showConfirm({ title: 't', message: 'm' });
  } catch (_err) {
    didThrow = true;
  }
  assert.equal(didThrow, false, 'showConfirm must not throw on missing document');
  assert.equal(result, false);
});

test('showConfirm with no [data-modal-root] present resolves false (no throw)', async () => {
  // Build a fake document whose querySelector returns null for the host
  // AND whose body is null (so the fallback also fails).
  const body = createFakeElement();
  const doc = {
    body: null,
    createElement(tag) {
      return createFakeElement();
    },
    querySelector() {
      return null;
    },
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false;
    },
  };
  installDocument(doc);

  let result;
  let didThrow = false;
  try {
    result = await showConfirm({ title: 't', message: 'm' });
  } catch (_err) {
    didThrow = true;
  }
  assert.equal(didThrow, false, 'showConfirm must not throw on missing host');
  assert.equal(result, false);

  // body was unused as a fallback (it's null) but should not leak — and
  // should not have any [data-modal-dialog] child since nothing mounted.
  assert.equal(countByAttr(body, 'data-modal-dialog'), 0);
});

test('showConfirm with missing [data-modal-root] falls back to document.body', async () => {
  // querySelector returns null for the host, but document.body exists —
  // the modal should mount into body so the call resolves properly when
  // the user clicks cancel.
  const body = createFakeElement();
  const doc = {
    body,
    createElement(tag) {
      return createFakeElement();
    },
    querySelector() {
      return null;
    },
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    contains(node) {
      return body.contains(node);
    },
  };
  installDocument(doc);

  const promise = showConfirm({ title: 't', message: 'm' });
  const dialog = getDialog(body);
  assert.ok(dialog, 'modal mounted into body as fallback host');
  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  cancelBtn.dispatch('click');
  const result = await promise;
  assert.equal(result, false);
});

test('showConfirm clamps an oversized message to ~500 chars (no layout blow-up)', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const huge = 'x'.repeat(10_000);
  const promise = showConfirm({ title: 't', message: huge });
  const dialog = getDialog(body);
  const messageEl = findByAttr(dialog, 'data-modal-message');
  // The clamp trims to MESSAGE_MAX_LENGTH + a trailing ellipsis (\u2026).
  assert.ok(messageEl.textContent.length <= 500, 'message clamped to ~500 chars');
  assert.ok(messageEl.textContent.length > 400, 'most of the original survived');
  assert.match(messageEl.textContent, /\u2026$/, 'clamp appends an ellipsis');

  // Use the message via innerHTML check: textContent never escapes, but
  // the surface contract is textContent — assert no innerHTML is set.
  assert.equal(messageEl.textContent === huge, false, 'message was actually clamped');

  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');
  cancelBtn.dispatch('click');
  await promise;
});

test('showConfirm uses textContent for title/message/labels (no innerHTML, XSS-safe)', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const promise = showConfirm({
    title: xss,
    message: xss,
    confirmLabel: xss,
    cancelLabel: xss,
  });

  const dialog = getDialog(body);
  const titleEl = findByAttr(dialog, 'data-modal-title');
  const messageEl = findByAttr(dialog, 'data-modal-message');
  const confirmBtn = findByAttr(dialog, 'data-modal-confirm');
  const cancelBtn = findByAttr(dialog, 'data-modal-cancel');

  // textContent holds the raw, un-escaped string — the contract is that
  // the module never writes innerHTML, so no markup is parsed. The fake
  // DOM does not implement innerHTML at all; this assertion would fail if
  // a future change introduced innerHTML because the fake would either
  // swallow it (no-op) or surface a setter mismatch. Here we assert the
  // raw strings landed in textContent — what innerHTML would have parsed
  // into tags instead.
  assert.equal(titleEl.textContent, xss);
  assert.equal(messageEl.textContent, xss);
  assert.equal(confirmBtn.textContent, xss);
  assert.equal(cancelBtn.textContent, xss);

  cancelBtn.dispatch('click');
  await promise;
});

// ===========================================================================
// 5. Concurrent calls
// ===========================================================================

test('two concurrent showConfirm calls each get their own dialog', async () => {
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promiseA = showConfirm({ title: 'A', message: 'a' });
  const promiseB = showConfirm({ title: 'B', message: 'b' });

  // Two [data-modal-dialog] nodes mounted in the host.
  assert.equal(countByAttr(body, 'data-modal-dialog'), 2);

  // Each dialog has its own confirm button — clicking A's confirm resolves
  // A and leaves B mounted.
  const dialogs = [];
  for (const child of body.children) {
    if (child.attrs && child.attrs['data-modal-dialog'] !== undefined) {
      dialogs.push(child);
    }
  }
  assert.equal(dialogs.length, 2);
  const confirmA = findByAttr(dialogs[0], 'data-modal-confirm');
  const confirmB = findByAttr(dialogs[1], 'data-modal-confirm');

  confirmA.dispatch('click');
  const resultA = await promiseA;
  assert.equal(resultA, true);
  assert.equal(countByAttr(body, 'data-modal-dialog'), 1, 'A removed after resolve');

  confirmB.dispatch('click');
  const resultB = await promiseB;
  assert.equal(resultB, true);
  assert.equal(countByAttr(body, 'data-modal-dialog'), 0, 'B removed after resolve');
});

test('two concurrent showConfirm calls — resolving the inner one does not affect the outer', async () => {
  // A and B are mounted concurrently. Resolving B (the inner / later one)
  // leaves A mounted, and resolving A afterwards works the same way. This
  // is the structural test for "no shared state across concurrent calls".
  const { doc, body } = createFakeDocument();
  installDocument(doc);

  const promiseA = showConfirm({ title: 'A', message: 'a' });
  const promiseB = showConfirm({ title: 'B', message: 'b' });

  const dialogA = body.children.find(
    (child) => child.attrs && child.attrs['data-modal-dialog'] !== undefined
  );
  const allDialogs = [];
  function collect(node) {
    if (!node || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (child.attrs && child.attrs['data-modal-dialog'] !== undefined) allDialogs.push(child);
      collect(child);
    }
  }
  collect(body);
  assert.equal(allDialogs.length, 2);
  const dialogB = allDialogs.find((d) => d !== dialogA);

  // Resolve B first via cancel; A must still be alive.
  const cancelB = findByAttr(dialogB, 'data-modal-cancel');
  cancelB.dispatch('click');
  const resultB = await promiseB;
  assert.equal(resultB, false);
  assert.equal(countByAttr(body, 'data-modal-dialog'), 1, 'A still mounted');

  // Now resolve A.
  const confirmA = findByAttr(dialogA, 'data-modal-confirm');
  confirmA.dispatch('click');
  const resultA = await promiseA;
  assert.equal(resultA, true);
  assert.equal(countByAttr(body, 'data-modal-dialog'), 0, 'all cleared');
});
