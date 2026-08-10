/**
 * ui/notation.js — data-driven number notation formatting (presentation).
 *
 * Formats large numbers into abbreviated ("1.5K", "1.23M") or scientific
 * ("1.00e+15") forms, driven by the config.notation block
 * ({ defaultStyle, styles }) with an optional player override stored in
 * GameState.settings.notationStyle (a style id string, or null for the
 * default — read defensively: missing/unknown values use the default).
 *
 * Style shapes (data/game-config.json, owned by another engineer):
 *   {
 *     "defaultStyle": "standard",
 *     "styles": {
 *       "standard":  { "threshold": 1000, "suffixes": ["K", "M", "B", "T"] },
 *       "scientific": { "threshold": 1000000, "suffixes": [] }
 *     }
 *   }
 *
 * format() rules for a finite value with a usable style:
 *   - |value| below the style threshold, or within the first thousand (a
 *     threshold configured below 1000), goes through a cached
 *     Intl.NumberFormat (one formatter per decimals value, mirroring the
 *     Renderer's plain path — behavior-identical to toLocaleString).
 *   - Otherwise the value is scaled down by 10^(3·tier) and appended with
 *     the tier-th suffix; trailing fractional zeros are trimmed
 *     ("1.50K" → "1.5K").
 *   - A style without suffixes (scientific notation) or a value past the
 *     last suffix falls back to toExponential.
 *   - decimals is clamped to 0–MAX_DECIMALS; on the abbreviated path it is
 *     a precision ceiling (trailing zeros trimmed), not a fixed width.
 *
 * Pure presentation — reads GameState, never mutates it (setStyle() writes
 * the player's notationStyle preference on explicit user action, the same
 * pattern as settings.offlineProgress). No DOM access, no gameplay systems,
 * framework-free and GitHub Pages compatible.
 */

import { GameState } from '../core/game-state.js';

/** Display range for decimals (mirrors the Renderer's MAX_DECIMALS). */
const MAX_DECIMALS = 20;

export class NotationFormatter {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.config] — the config.notation block:
   *        { defaultStyle, styles }; defaults to an empty block (no styles
   *        configured → format() falls back to plain String output).
   * @param {object} [options.state] — game state read for the
   *        settings.notationStyle override; defaults to the shared
   *        GameState singleton. Pass null to run without a state (style
   *        lookups just use the default).
   */
  constructor({ config = {}, state = GameState } = {}) {
    /**
     * Style definitions keyed by style id (config.notation.styles).
     * @type {Object<string, { threshold: number, suffixes?: string[] }>}
     */
    this._styles = config.styles || {};

    /**
     * Fallback style id used when the state holds no usable override:
     * config.defaultStyle when it names a known style, else the first
     * style key, else '' (no styles configured).
     * @type {string}
     */
    this._default =
      config.defaultStyle in this._styles
        ? config.defaultStyle
        : Object.keys(this._styles)[0] || '';

    /**
     * Game state read for the player's notationStyle override; null runs
     * the formatter without a state (defaults only).
     * @type {object|null}
     */
    this._state = state;

    /**
     * Cached plain-path formatters, one per decimals value (mirrors the
     * Renderer's _formatters map — the hot path never allocates).
     * @type {Map<number, Intl.NumberFormat>}
     */
    this._plainFormatters = new Map();
  }

  /**
   * The effective style id: the state's settings.notationStyle when it is a
   * string naming a known style, otherwise the configured default. A stale
   * override (an id no longer present in the styles) falls back to the
   * default; a missing state never throws.
   *
   * @returns {string} the style id to use for formatting.
   */
  get style() {
    const override = this._state ? this._state.settings : undefined;
    if (
      override &&
      typeof override.notationStyle === 'string' &&
      Object.hasOwn(this._styles, override.notationStyle)
    ) {
      return override.notationStyle;
    }
    return this._default;
  }

  /**
   * Persist a style choice on explicit user action (mirrors how
   * settings.offlineProgress is written). Writes only known style ids, only
   * when a state with a settings slice is present; never throws. Prototype
   * aliases ("__proto__", "constructor") are rejected by Object.hasOwn, so a
   * hostile id can never be written.
   *
   * @param {string} styleId — a key of config.notation.styles.
   * @returns {boolean} true when the override was written.
   */
  setStyle(styleId) {
    if (
      !this._state ||
      !this._state.settings ||
      !Object.hasOwn(this._styles, styleId)
    ) {
      return false;
    }
    this._state.settings.notationStyle = styleId;
    return true;
  }

  /**
   * Format a number for display according to the effective style.
   *
   * decimals is clamped to 0–MAX_DECIMALS (Intl.NumberFormat and toFixed /
   * toExponential throw for digits outside 0–100, and this formatter is
   * exposed on window.__notation — a console caller must never crash it).
   * On the abbreviated path trailing fractional zeros are always trimmed,
   * so decimals is a precision *ceiling*, not a fixed width
   * (format(1200000, 2) → "1.2M", not "1.20M").
   *
   * @param {number} value — number to format.
   * @param {number} [decimals=0] — decimal places; 0 still abbreviates with
   *        up to two digits, trailing zeros trimmed ("1.5K", "1K").
   * @returns {string} formatted display text.
   */
  format(value, decimals = 0) {
    const safeDecimals = clampDecimals(decimals);

    const style = this._styles[this.style];
    if (!style || !Number.isFinite(value)) {
      return String(value);
    }

    const threshold = style.threshold;
    const suffixes = style.suffixes || [];
    const abs = Math.abs(value);
    const magnitude = Math.floor(Math.log10(abs));
    const tier = Math.floor(magnitude / 3);

    // Plain path: below the threshold, or within the first thousand (a
    // threshold configured below 1000, e.g. 999 with threshold 950 → the
    // abbreviated path only starts at the thousands). Cached per decimals
    // value, mirroring the Renderer's Intl.NumberFormat path.
    if (abs < threshold || tier <= 0) {
      return this._formatPlain(value, safeDecimals);
    }

    // Scientific fallback: no suffixes configured, or the value is past the
    // last suffix (e.g. 1e15 with suffixes up to T → "1.00e+15").
    if (tier > suffixes.length) {
      const digits = safeDecimals > 0 ? safeDecimals : 2;
      return value.toExponential(digits);
    }

    const digits = safeDecimals > 0 ? safeDecimals : 2;
    const scaled = value / 10 ** (tier * 3);
    return `${trimZeros(scaled.toFixed(digits))}${suffixes[tier - 1]}`;
  }

  /**
   * The plain (locale-formatted) path, mirroring the Renderer's cached
   * Intl.NumberFormat: one formatter per decimals value so the hot path
   * never allocates. Behavior-identical to value.toLocaleString(undefined,
   * options) — same locale resolution.
   *
   * @param {number} value — number to format.
   * @param {number} decimals — clamped decimal places (formatter cache key).
   * @returns {string} locale-formatted number.
   */
  _formatPlain(value, decimals) {
    let formatter = this._plainFormatters.get(decimals);
    if (!formatter) {
      formatter = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      this._plainFormatters.set(decimals, formatter);
    }
    return formatter.format(value);
  }
}

/**
 * Strip trailing fractional zeros and a trailing decimal point from a
 * toFixed() result ("1.50" → "1.5", "2.00" → "2", "10.00" → "10").
 *
 * @param {string} text — toFixed() output.
 * @returns {string} the trimmed text.
 */
function trimZeros(text) {
  let trimmed = text;
  while (trimmed.includes('.') && trimmed.endsWith('0')) {
    trimmed = trimmed.slice(0, -1);
  }
  if (trimmed.endsWith('.')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Clamp a decimals request to the display range 0–MAX_DECIMALS. Intl and
 * toFixed / toExponential throw outside 0–100; a non-finite request
 * (NaN/Infinity) or a fractional one defaults/rounds to a safe integer.
 * Mirrors the Renderer's MAX_DECIMALS guardrail.
 *
 * @param {number} decimals — requested decimal places.
 * @returns {number} clamped integer in 0–MAX_DECIMALS.
 */
function clampDecimals(decimals) {
  return Number.isFinite(decimals)
    ? Math.min(Math.max(Math.trunc(decimals), 0), MAX_DECIMALS)
    : 0;
}
