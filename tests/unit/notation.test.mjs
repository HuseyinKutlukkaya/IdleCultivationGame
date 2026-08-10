/**
 * tests/unit/notation.test.mjs — unit tests for js/ui/notation.js.
 *
 * Exercises the data-driven notation formatter: constructor defaults and
 * fallbacks, the standard abbreviated style (locked exact outputs), zero
 * trimming, plain-path decimals, scientific fallback for suffix exhaustion
 * and suffix-less styles, the setStyle() preference write (known vs unknown
 * ids, absent state), the effective style getter (state override vs stale
 * ids), non-finite passthrough, null-state degradation and the exact
 * threshold boundary.
 *
 * No DOM needed — the module is pure presentation math. Locale-sensitive
 * plain-path outputs are normalized (decimal separator → ".") before
 * asserting, so the tests are machine-independent.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotationFormatter } from '../../js/ui/notation.js';

/** Standard abbreviated style (mirrors the future config.notation block). */
const STANDARD = {
  defaultStyle: 'standard',
  styles: {
    standard: { threshold: 1000, suffixes: ['K', 'M', 'B', 'T'] },
  },
};

/**
 * Normalize a locale-formatted number's decimal separator to "." so
 * plain-path assertions are machine-independent ("999,50" → "999.50").
 * Values under 1000 carry no grouping separator, so only the decimal
 * separator can vary between locales.
 *
 * @param {string} text — locale-formatted number.
 * @returns {string} the same text with every "," replaced by ".".
 */
function dotDecimal(text) {
  return text.replace(/,/g, '.');
}

test('constructor defaults degrade gracefully with no config', () => {
  const nf = new NotationFormatter();

  // No styles configured → effective style is '' and format() falls back to
  // plain String output (same text the plain path would produce here).
  assert.equal(nf.style, '');
  assert.equal(nf.format(123, 0), '123');
});

test('an unknown defaultStyle id falls back to the first styles key', () => {
  const nf = new NotationFormatter({
    config: {
      defaultStyle: 'missing',
      styles: {
        standard: { threshold: 1000, suffixes: ['K', 'M', 'B', 'T'] },
        scientific: { threshold: 1000000, suffixes: [] },
      },
    },
  });

  assert.equal(nf.style, 'standard');
});

test('standard style formats the locked examples exactly', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  assert.equal(nf.format(1500, 0), '1.5K');
  assert.equal(nf.format(1000, 0), '1K');
  assert.equal(nf.format(1234567, 2), '1.23M');
  assert.equal(nf.format(950, 0), '950');
  assert.equal(nf.format(-1500, 0), '-1.5K');
  assert.equal(nf.format(0, 0), '0');
});

test('values near the trillion boundary scale to the last suffixes', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  // 999_999_999_999 is one below 10^12: magnitude 11 → tier 3 → scaled by
  // 10^9 → 999.999999999 → rounds up to "1000" + suffixes[tier-1] =
  // suffixes[2] = "B". (The feature brief's sample claimed "1T", but the
  // specified algorithm yields "1000B" — tier 3 uses the third suffix, and
  // a value below 10^12 rounds to a scaled value of 1000.)
  assert.equal(nf.format(999999999999, 0), '1000B');

  // Exactly 10^12: magnitude 12 → tier 4 → suffixes[3] = "T" → "1T".
  assert.equal(nf.format(1000000000000, 0), '1T');
});

test('trailing zeros are trimmed from abbreviated values', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  assert.equal(nf.format(1000, 0), '1K'); // not "1.00K"
  assert.equal(nf.format(1500, 0), '1.5K'); // not "1.50K"
  assert.equal(nf.format(10000, 0), '10K'); // not "10.00K"
  // decimals is a precision ceiling, not a fixed width: "1.2M", not "1.20M".
  assert.equal(nf.format(1200000, 2), '1.2M');
});

test('decimals are honored on the plain path (cached Intl, behavior-identical)', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  // Below the threshold the value goes through the cached Intl.NumberFormat,
  // whose decimal separator is host-locale dependent — normalize before
  // asserting.
  assert.equal(dotDecimal(nf.format(999.5, 2)), '999.50');
  // Behavior-identical to a fresh formatter built the renderer's way.
  const reference = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(999.5);
  assert.equal(nf.format(999.5, 2), reference);
});

test('values beyond the last suffix fall back to scientific notation', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  assert.equal(nf.format(1e15, 0), '1.00e+15');
  assert.equal(nf.format(5e15, 2), '5.00e+15');
});

test('a suffix-less style renders scientific notation above its threshold', () => {
  const nf = new NotationFormatter({
    config: {
      defaultStyle: 'scientific',
      styles: {
        scientific: { threshold: 1000000, suffixes: [] },
      },
    },
  });

  // No suffixes → above the threshold everything is exponential.
  assert.equal(nf.format(2e6, 2), '2.00e+6');
  // Below the threshold stays plain. A value under 1000 keeps the plain
  // output free of grouping separators (locale-safe after normalization).
  assert.equal(dotDecimal(nf.format(999.5, 2)), '999.50');
});

test('setStyle writes a known style id and refuses unknown ids', () => {
  const state = { settings: {} };
  const nf = new NotationFormatter({ config: STANDARD, state });

  assert.equal(nf.setStyle('standard'), true);
  assert.equal(state.settings.notationStyle, 'standard');

  // Unknown id: returns false and never writes.
  assert.equal(nf.setStyle('vanished'), false);
  assert.equal(state.settings.notationStyle, 'standard');
});

test('style getter honors a known override and ignores stale ids', () => {
  // Default when no override is set.
  assert.equal(new NotationFormatter({ config: STANDARD }).style, 'standard');

  // A known override wins over the default.
  const state = { settings: { notationStyle: 'standard' } };
  assert.equal(new NotationFormatter({ config: STANDARD, state }).style, 'standard');

  // A stale override (id not in styles) falls back to the default.
  const stale = { settings: { notationStyle: 'vanished' } };
  assert.equal(new NotationFormatter({ config: STANDARD, state: stale }).style, 'standard');
});

test('a state override selects a different style and formats through it', () => {
  const config = {
    defaultStyle: 'standard',
    styles: {
      standard: { threshold: 1000, suffixes: ['K', 'M', 'B', 'T'] },
      scientific: { threshold: 1000, suffixes: [] },
    },
  };
  const state = { settings: { notationStyle: 'scientific' } };
  const nf = new NotationFormatter({ config, state });

  assert.equal(nf.style, 'scientific');
  assert.equal(nf.format(1500, 0), '1.50e+3');
});

test('non-finite values pass through without throwing', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  assert.equal(nf.format(NaN), 'NaN');
  assert.equal(nf.format(Infinity), 'Infinity');
  assert.equal(nf.format(-Infinity), '-Infinity');
});

test('a null state never throws on any method', () => {
  const nf = new NotationFormatter({ config: STANDARD, state: null });

  assert.equal(nf.style, 'standard');
  assert.equal(nf.format(1500, 0), '1.5K');
  assert.equal(nf.setStyle('standard'), false);
  assert.equal(nf.format(NaN), 'NaN');
});

test('the threshold boundary is exact', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  // One step below the threshold stays plain (decimal separator normalized).
  assert.equal(dotDecimal(nf.format(999.99, 2)), '999.99');
  // At the threshold the abbreviation kicks in.
  assert.equal(nf.format(1000, 0), '1K');
});

test('setStyle rejects prototype-alias ids without writing', () => {
  const state = { settings: {} };
  const nf = new NotationFormatter({ config: STANDARD, state });

  // Object.hasOwn rejects inherited Object.prototype keys ("__proto__",
  // "constructor", ...) that the old `in` membership accepted.
  assert.equal(nf.setStyle('__proto__'), false);
  assert.equal(Object.hasOwn(state.settings, 'notationStyle'), false);
  assert.equal(nf.setStyle('constructor'), false);
  assert.equal(Object.hasOwn(state.settings, 'notationStyle'), false);
});

test('a hostile notationStyle override degrades to the default style', () => {
  const state = { settings: { notationStyle: '__proto__' } };
  const nf = new NotationFormatter({ config: STANDARD, state });

  // A save poisoned with a prototype-alias id is not a known style, so the
  // effective style falls back to the configured default.
  assert.equal(nf.style, 'standard');
  assert.equal(nf.format(1500, 0), '1.5K');
});

test('a sub-1000 threshold keeps values under 1000 plain', () => {
  const nf = new NotationFormatter({
    config: {
      defaultStyle: 'standard',
      styles: {
        standard: { threshold: 950, suffixes: ['K', 'M', 'B', 'T'] },
      },
    },
  });

  // 999: magnitude 2 → tier 0 → the abbreviated path only starts at 1000.
  assert.equal(nf.format(999, 0), '999');
  // 1000: magnitude 3 → tier 1 → abbreviation kicks in.
  assert.equal(nf.format(1000, 0), '1K');
});

test('sub-unit values format plain without grouping separators', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  // 0.001 with 0 decimals rounds to "0" — the plain path honors decimals
  // exactly like the legacy renderer's Intl formatter.
  assert.equal(nf.format(0.001, 0), '0');
  // With enough decimals the digits show; only a decimal separator appears
  // (never a grouping separator) — normalize it before asserting.
  assert.equal(dotDecimal(nf.format(0.001, 3)), '0.001');
});

test('out-of-range decimals are clamped instead of throwing', () => {
  const nf = new NotationFormatter({ config: STANDARD });

  // 200 → clamped to 20 (MAX_DECIMALS): the plain path pads to the clamped
  // fraction digits rather than throwing a RangeError from Intl.
  assert.equal(dotDecimal(nf.format(123.456, 200)), '123.45600000000000000000');
  // The abbreviated path clamps too, then trims the padded zeros away.
  assert.equal(nf.format(2e6, 200), '2M');
  // The scientific path (past the last suffix) clamps as well — 1e15 is
  // exactly representable, so the padded exponential is deterministic.
  assert.equal(nf.format(1e15, 200), '1.00000000000000000000e+15');
  // A non-finite decimals request falls back to 0 instead of throwing.
  assert.equal(nf.format(123.456, NaN), '123');
});
