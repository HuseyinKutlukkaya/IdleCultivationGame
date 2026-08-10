/**
 * tests/fixtures/reporter-fail.mjs — failing fixture for the compact reporter
 * unit test. Deliberately NOT named *.test.mjs so the main suite glob skips it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('failing fixture test (expected)', () => {
  assert.equal(1 + 1, 3);
});
