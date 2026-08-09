/**
 * tests/unit/deep-merge.test.mjs — unit tests for js/utils/deep-merge.js.
 *
 * Exercises the plain-data merge used for save restoration: recursive
 * plain-object merging, wholesale replacement of arrays/primitives/null,
 * missing source keys leaving the target untouched, the prototype-alias
 * security guard (__proto__ / constructor / prototype are skipped) and the
 * no-op cases (non-object source, null source). The function mutates and
 * returns the target, so every test asserts both values and identity.
 *
 * Pure function — no globals, no I/O. Uses the Node built-in test runner
 * with zero dependencies and imports the real module under test.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../../js/utils/deep-merge.js';

test('merges nested plain objects recursively key-by-key', () => {
  const target = { outer: { a: 1, b: 2 }, keep: true };
  const source = { outer: { b: 20 } };

  const result = deepMerge(target, source);

  // The nested object is merged in place; keys the source does not carry
  // (outer.a) are left untouched.
  assert.deepEqual(result, { outer: { a: 1, b: 20 }, keep: true });
});

test('arrays are replaced wholesale, never merged', () => {
  const target = { list: [1, 2, 3] };
  const source = { list: [9, 9] };

  deepMerge(target, source);

  assert.deepEqual(target.list, [9, 9]);
  // Wholesale replacement: the target now references the source array.
  assert.strictEqual(target.list, source.list);
});

test('primitives and null replace the target value wholesale', () => {
  const target = { a: 1, b: 'x', c: { d: 1 }, e: [1] };
  const source = { a: 2, b: 'y', c: null, e: 'flat' };

  deepMerge(target, source);

  assert.deepEqual(target, { a: 2, b: 'y', c: null, e: 'flat' });
});

test('missing source keys leave the target untouched', () => {
  const target = { a: 1, b: 2, nested: { x: 1, y: 2 } };
  const source = { b: 9, nested: { y: 3 } };

  deepMerge(target, source);

  assert.deepEqual(target, { a: 1, b: 9, nested: { x: 1, y: 3 } });
});

test('unsafe prototype-alias keys are skipped and cannot pollute', () => {
  // JSON.parse materializes "__proto__" as an own data key (the object
  // literal syntax would instead set the prototype). This is exactly the
  // attack shape deepMerge must defend against.
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2},"safe":42}'
  );
  const target = { safe: 0 };

  const result = deepMerge(target, source);

  // The legitimate key is merged...
  assert.equal(result.safe, 42);
  // ...but none of the alias keys become own properties of the target.
  assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'prototype'), false);
  // ...and Object.prototype itself is untouched.
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);
});

test('unsafe prototype-alias keys nested in a plain object are skipped too', () => {
  // DeepMerge only recurses into a nested key when the target already holds
  // a plain object there (otherwise the subtree is replaced wholesale), so
  // the target provides `outer` to exercise the recursive skip.
  const source = JSON.parse('{"outer":{"__proto__":{"polluted":true},"safe":1}}');
  const target = { outer: { safe: 0 } };

  const result = deepMerge(target, source);

  // The legitimate nested value merges; the nested alias key is skipped.
  assert.deepEqual(result.outer, { safe: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(result.outer, '__proto__'), false);
  // Object.prototype is untouched even when the poisoned key is one level deep.
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);
});

test('a target already owning an alias key keeps its value when the source skips it', () => {
  const source = JSON.parse('{"constructor":{"x":1},"prototype":{"y":2}}');
  const target = { constructor: 'original', prototype: 'kept' };

  const result = deepMerge(target, source);

  // The source's alias values are skipped, so the target's own (legitimate)
  // values under those names are preserved untouched.
  assert.equal(result.constructor, 'original');
  assert.equal(result.prototype, 'kept');
});

test('a non-object source is a no-op', () => {
  const target = { a: 1 };

  deepMerge(target, 42);
  deepMerge(target, 'string');
  deepMerge(target, true);
  deepMerge(target, [1, 2, 3]);

  assert.deepEqual(target, { a: 1 });
});

test('a null source is a no-op', () => {
  const target = { a: 1 };

  deepMerge(target, null);

  assert.deepEqual(target, { a: 1 });
});

test('returns the (mutated) target object', () => {
  const target = { a: 1 };

  const result = deepMerge(target, { b: 2 });

  assert.strictEqual(result, target);
  assert.deepEqual(result, { a: 1, b: 2 });
});
