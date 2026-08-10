/**
 * tests/fixtures/reporter-pass.mjs — passing fixture for the compact reporter
 * unit test. Deliberately NOT named *.test.mjs so the main suite glob skips it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('passing fixture test A', () => {
  assert.equal(1 + 1, 2);
});

test('passing fixture test B', () => {
  assert.deepEqual({ a: 1 }, { a: 1 });
});
