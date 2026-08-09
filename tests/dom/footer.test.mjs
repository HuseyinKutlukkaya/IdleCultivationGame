/**
 * tests/dom/footer.test.mjs — DOM-level tests for js/ui/footer.js.
 *
 * Exercises initFooter() against a stubbed document global: it looks up the
 * element by id 'year' and writes the current year into its textContent, and
 * is a safe no-op when that element does not exist (e.g. the footer is
 * omitted from the page).
 *
 * The document global is stubbed per test and restored in afterEach so
 * nothing leaks between tests or into other test files.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with the
 * quoted glob form, not the bare-directory form).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initFooter } from '../../js/ui/footer.js';
import { createFakeElement } from '../helpers/fake-dom.mjs';

/** Original document global, captured in beforeEach and restored after. */
let savedDocument = null;

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
 * Install a fake document global whose getElementById delegates to the given
 * resolver and records every id it is asked for.
 *
 * @param {(id: string) => object|null} resolver — returns the fake element
 *        for an id, or null when the element does not exist.
 * @returns {{ calls: Array<string> }} the recorded getElementById ids.
 */
function installDocumentStub(resolver) {
  const calls = [];
  globalThis.document = {
    getElementById(id) {
      calls.push(id);
      return resolver(id);
    },
  };
  return { calls };
}

/** Save the pristine document global before every test. */
beforeEach(() => {
  savedDocument = captureGlobal('document');
});

/** Restore the pristine document global after every test. */
afterEach(() => {
  restoreGlobal('document', savedDocument);
  savedDocument = null;
});

test('writes the current year into the footer element', () => {
  const yearEl = createFakeElement();
  const { calls } = installDocumentStub((id) => (id === 'year' ? yearEl : null));

  initFooter();

  assert.deepEqual(calls, ['year']);
  assert.equal(yearEl.textContent, String(new Date().getFullYear()));
});

test('is a safe no-op when the year element is missing', () => {
  installDocumentStub(() => null);

  assert.doesNotThrow(() => initFooter());
});
