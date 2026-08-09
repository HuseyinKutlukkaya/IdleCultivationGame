/**
 * tests/dom/reveal.test.mjs — DOM-level tests for js/ui/reveal.js.
 *
 * Exercises initScrollReveal() against stubbed browser globals: the `js`
 * marker class on documentElement, the fallback path (no IntersectionObserver
 * in window, or zero [data-reveal] targets) that reveals everything
 * immediately, and the observer path that watches each target with
 * threshold 0.12 and reveals + unobserves entries that are intersecting.
 *
 * The document, window and IntersectionObserver globals are stubbed per test
 * and restored in afterEach so nothing leaks between tests or into other test
 * files. The fake observer class and reveal targets come from
 * tests/helpers/intersection-observer-stub.mjs.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with the
 * quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initScrollReveal } from '../../js/ui/reveal.js';
import {
  createRevealTarget,
  createIntersectionObserverStub,
} from '../helpers/intersection-observer-stub.mjs';

/** Originals of the stubbed globals, restored in afterEach. */
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
 * Install the document/window/IntersectionObserver globals reveal.js reads
 * and return the fake documentElement for assertions.
 *
 * @param {object} opts — target and observer wiring.
 * @param {Array<object>} opts.targets — fake [data-reveal] elements returned
 *        by document.querySelectorAll.
 * @param {Function|null} opts.observer — FakeIntersectionObserver class to
 *        expose on both `window` and the global scope, or null to emulate an
 *        environment without IntersectionObserver (fallback path).
 * @returns {{ documentElement: object }} the fake documentElement.
 */
function installRevealGlobals({ targets, observer }) {
  const documentElement = createRevealTarget();
  globalThis.document = {
    documentElement,
    querySelectorAll(selector) {
      assert.equal(selector, '[data-reveal]');
      return targets;
    },
  };
  if (observer === null) {
    // Emulate an environment where IntersectionObserver is unavailable:
    // window exists (so `in window` is a legal check) but lacks the property.
    globalThis.window = {};
    delete globalThis.IntersectionObserver;
  } else {
    globalThis.window = { IntersectionObserver: observer };
    globalThis.IntersectionObserver = observer;
  }
  return { documentElement };
}

/** Save the pristine globals before every test. */
beforeEach(() => {
  savedGlobals = {
    document: captureGlobal('document'),
    window: captureGlobal('window'),
    IntersectionObserver: captureGlobal('IntersectionObserver'),
  };
});

/** Restore the pristine globals after every test. */
afterEach(() => {
  restoreGlobal('document', savedGlobals.document);
  restoreGlobal('window', savedGlobals.window);
  restoreGlobal('IntersectionObserver', savedGlobals.IntersectionObserver);
  savedGlobals = null;
});

test("adds the 'js' marker class to document.documentElement", () => {
  const { FakeIntersectionObserver } = createIntersectionObserverStub();
  const { documentElement } = installRevealGlobals({
    targets: [createRevealTarget()],
    observer: FakeIntersectionObserver,
  });

  initScrollReveal();

  assert.equal(documentElement.classes.has('js'), true);
});

test('falls back to showing everything when IntersectionObserver is missing', () => {
  const targets = [createRevealTarget(), createRevealTarget(), createRevealTarget()];
  installRevealGlobals({ targets, observer: null });

  initScrollReveal();

  // Every [data-reveal] target is revealed immediately, with no observer.
  for (const target of targets) {
    assert.equal(target.classes.has('is-visible'), true);
  }
});

test('handles zero [data-reveal] targets via the fallback path without error', () => {
  const { FakeIntersectionObserver, instances } = createIntersectionObserverStub();
  installRevealGlobals({ targets: [], observer: FakeIntersectionObserver });

  assert.doesNotThrow(() => initScrollReveal());

  // The fallback returns before ever constructing an observer.
  assert.equal(instances.length, 0);
});

test('observer path creates one observer with threshold 0.12 and observes every target', () => {
  const first = createRevealTarget();
  const second = createRevealTarget();
  const { FakeIntersectionObserver, instances } = createIntersectionObserverStub();
  installRevealGlobals({ targets: [first, second], observer: FakeIntersectionObserver });

  initScrollReveal();

  assert.equal(instances.length, 1);
  const observer = instances[0];
  assert.deepEqual(observer.options, { threshold: 0.12 });
  assert.equal(observer.observed.has(first), true);
  assert.equal(observer.observed.has(second), true);
  // Nothing revealed yet — entries have not been delivered.
  assert.equal(first.classes.has('is-visible'), false);
  assert.equal(second.classes.has('is-visible'), false);
});

test('intersecting entries are revealed and unobserved; non-intersecting are left alone', () => {
  const first = createRevealTarget();
  const second = createRevealTarget();
  const { FakeIntersectionObserver, instances } = createIntersectionObserverStub();
  installRevealGlobals({ targets: [first, second], observer: FakeIntersectionObserver });

  initScrollReveal();
  const observer = instances[0];

  // Deliver one intersecting and one non-intersecting entry in a single
  // callback, exactly as the browser batches observer notifications.
  observer.fire([
    { isIntersecting: true, target: first },
    { isIntersecting: false, target: second },
  ]);

  // Intersecting entry: revealed and unobserved.
  assert.equal(first.classes.has('is-visible'), true);
  assert.equal(observer.observed.has(first), false);
  assert.equal(observer.unobserved.has(first), true);

  // Non-intersecting entry: untouched and still observed.
  assert.equal(second.classes.has('is-visible'), false);
  assert.equal(observer.observed.has(second), true);
  assert.equal(observer.unobserved.has(second), false);
});
