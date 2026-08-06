/**
 * utils/deep-merge.js — merge plain-data objects for save restoration.
 *
 * Recursively copies own enumerable keys from `source` onto `target`,
 * mutating and returning `target`. Arrays, primitives and null replace the
 * target value wholesale; plain objects are merged key-by-key so fields the
 * source does not carry are left untouched. This is what lets old saves keep
 * working: restoring a save written by an older version simply leaves any
 * newly-added state keys at their current (fresh-default) values.
 *
 * Security: keys that alias the prototype chain (`__proto__`, `constructor`,
 * `prototype`) are skipped. JSON.parse materializes `"__proto__"` as an own
 * data key, and merging it could otherwise write attacker-controlled values
 * straight onto Object.prototype. Legitimate saves never carry these keys
 * (GameState has none and JSON.stringify omits a plain `__proto__`), so
 * skipping them is lossless.
 *
 * Pure infrastructure — no DOM access, no storage I/O, no gameplay logic,
 * framework-free and GitHub Pages compatible.
 */

/** Keys that alias the prototype chain and must never be merged. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deep-merge `source` into `target` in place.
 *
 * @param {object} target — object to merge into (mutated).
 * @param {*} source — value to merge; non-plain values are copied over.
 * @returns {object} the mutated target.
 */
export function deepMerge(target, source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return target;
  }

  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;

    const value = source[key];
    const current = target[key];

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      deepMerge(current, value);
    } else {
      target[key] = value;
    }
  }

  return target;
}
