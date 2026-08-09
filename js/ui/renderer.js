/**
 * ui/renderer.js — declarative state→DOM renderer (no gameplay).
 *
 * The single DOM writer for the game. Reads GameState and renders its values
 * into the static game-panel markup via `data-bind` attributes: `init()`
 * scans the root once, caches every binding as an element reference plus its
 * parsed attributes (and, for progress bars, the `.progress__fill` child),
 * then subscribes to the EventBus. On every flush the renderer recomputes the
 * output for each cached binding, compares it with the previously-rendered
 * value and writes ONLY the bindings that changed (partial refresh) — so a
 * static state leaves the DOM completely untouched.
 *
 * Batching: `requestRefresh()` marks the renderer dirty and schedules exactly
 * one flush per frame through requestAnimationFrame. Calls that arrive before
 * the pending flush are coalesced into that single pass (a second call is a
 * no-op). `refresh()` bypasses the batching and flushes synchronously — used
 * right after `init()` and after a save restore.
 *
 * Binding DSL (attributes on any element):
 *   data-bind          — dot path into GameState, e.g. "cultivation.qi".
 *                        Multiple paths are allowed separated by "|" for
 *                        composed displays (combined via data-bind-format).
 *   data-bind-mode     — "text" (DEFAULT), "progress", "switch" or
 *                        "remaining":
 *                          text      sets element.textContent; null/undefined
 *                                    render as an em dash "—".
 *                          progress  element is [role=progressbar]; sizes its
 *                                    .progress__fill child width to the
 *                                    percent (clamped 0–100, 0 when max <= 0)
 *                                    and keeps aria-valuenow/max/min in sync.
 *                                    Requires data-bind-max.
 *                          switch    element is a .switch; toggles the
 *                                    "switch--on" class for a truthy value
 *                                    (true → on).
 *                          remaining numeric "max − value" display (e.g.
 *                                    empty inventory slots); renders "—" when
 *                                    either side is null/undefined. Requires
 *                                    data-bind-max.
 *   data-bind-format   — optional text template for "text" mode using {0},
 *                        {1}, ... placeholders substituted with the bound
 *                        values in order (e.g. "{0} / {1}", "× {0}",
 *                        "{0} Realm"). Placeholder indexes without a bound
 *                        value render "—".
 *   data-bind-max      — dot path of the maximum value used by "progress"
 *                        and "remaining" modes.
 *   data-bind-decimals — decimal places for numeric formatting (default 0).
 *
 * Number formatting uses Intl.NumberFormat with the browser default locale;
 * one formatter is cached per decimals value so the hot path never allocates.
 * Numbers render with thousands separators ("1,000") and the configured
 * fraction digits ("0" → "0.0" at decimals 1).
 *
 * Event contract (subscribed in init, released in destroy):
 *   loop:uiRefresh -> requestRefresh()  (periodic, throttled by the GameLoop)
 *   ui:refresh     -> refresh()         (explicit full-refresh hook)
 *   game:restored  -> refresh()         (a save was applied)
 *
 * Pure presentation — reads GameState, never mutates it, never touches
 * gameplay systems, never uses innerHTML (textContent only), framework-free
 * and GitHub Pages compatible (relative imports, browser APIs only:
 * querySelectorAll, requestAnimationFrame, Intl.NumberFormat, classList,
 * textContent, setAttribute, style).
 *
 * Future plug-in: per-panel modules may register additional render modes by
 * extending the binding DSL; this class stays the single DOM writer.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** Em dash shown for missing or unbound values. */
const EMDASH = '—';

/** Recognized data-bind-mode values; unknown modes fall back to "text". */
const VALID_MODES = new Set(['text', 'progress', 'switch', 'remaining']);

/**
 * Guardrail for data-bind-decimals: Intl.NumberFormat throws on fraction
 * digits outside 0–100, so clamp to a sane display precision.
 */
const MAX_DECIMALS = 20;

export class Renderer {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object to read bindings
   *        from; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as DataManager and GameLoop).
   * @param {object} [options.eventBus] — pub/sub bus to subscribe to;
   *        defaults to the shared EventBus singleton. The bus must provide
   *        subscribe and unsubscribe (see core/event-bus.js).
   * @param {Document|Element} [options.root] — scan scope for [data-bind]
   *        elements; defaults to the whole document.
   */
  constructor(options = {}) {
    /** @type {object} game state object the renderer reads from. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus used for refresh events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {Document|Element} scan scope for [data-bind] nodes. */
    this._root = options.root || document;

    /**
     * Cached bindings: one entry per [data-bind] node inside the root,
     * holding the element reference, the parsed attributes and the
     * last-rendered value used for partial-refresh comparison.
     * @type {Array<object>}
     */
    this._bindings = [];

    /** @type {boolean} true while a flush is pending or needed. */
    this._dirty = false;
    /** @type {number|null} pending requestAnimationFrame handle. */
    this._rafId = null;
    /** @type {boolean} guards against double init(). */
    this._initialized = false;
    /** @type {Map<number, Intl.NumberFormat>} cached formatters per decimals. */
    this._formatters = new Map();

    // Bound once so rAF and subscribe/unsubscribe always see the same
    // function identities (same pattern as GameLoop._frame).
    this._flush = this._flush.bind(this);
    this._onUiRefresh = () => this.requestRefresh();
    this._onFullRefresh = () => this.refresh();
  }

  /**
   * Scan the root, cache every [data-bind] binding and start listening.
   *
   * Meant to be called exactly once (idempotent-safe: a second call is
   * ignored with a warning). Runs an immediate synchronous flush so the DOM
   * reflects the current state before any event can trigger an update.
   *
   * @returns {this} the renderer, for chaining.
   */
  init() {
    if (this._initialized) {
      console.warn(
        'Renderer.init: already initialized — bindings are cached, ignoring this call.'
      );
      return this;
    }
    this._initialized = true;

    const nodes = this._root.querySelectorAll('[data-bind]');
    nodes.forEach((node) => {
      const binding = this._readBinding(node);
      if (binding) this._bindings.push(binding);
    });

    this._subscribe();
    this.refresh();
    return this;
  }

  /**
   * Force a full render pass immediately, bypassing the batching. Used right
   * after init() and after a save restore (see the 'ui:refresh' and
   * 'game:restored' events). Cancels any pending batched flush.
   *
   * @returns {this} the renderer, for chaining.
   */
  refresh() {
    this._flush();
    return this;
  }

  /**
   * The batching primitive: mark the renderer dirty and schedule exactly ONE
   * flush per frame via requestAnimationFrame. A second call before the
   * flush is a no-op (coalesced into the pending pass). Safe to call from
   * hot paths such as the GameLoop's throttled UI-refresh pulse.
   *
   * @returns {this} the renderer, for chaining.
   */
  requestRefresh() {
    if (this._dirty) return this;
    this._dirty = true;
    this._rafId = requestAnimationFrame(this._flush);
    return this;
  }

  /**
   * The batched render pass (bound). Cancels any pending rAF, resets the
   * dirty flag, then walks every cached binding — computing the new output,
   * comparing it with the previously-rendered value and writing ONLY the
   * changed bindings to the DOM (partial refresh).
   *
   * @returns {void}
   */
  _flush() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._dirty = false;

    for (let i = 0; i < this._bindings.length; i += 1) {
      this._updateBinding(this._bindings[i]);
    }
  }

  /**
   * Compute and, when changed, apply the output of a single cached binding.
   * The comparison target differs by mode: the composed text for text /
   * remaining, the boolean for switch, and a canonical "width|now|max" key
   * for progress. The initial value (undefined) never matches, so the first
   * flush always writes every binding.
   *
   * @param {object} binding — cached binding (see _readBinding).
   * @returns {void}
   */
  _updateBinding(binding) {
    if (binding.mode === 'progress') {
      const output = this._renderProgress(binding);
      const key = `${output.width}|${output.now}|${output.max}`;
      if (key === binding.last) return;
      binding.last = key;

      if (binding.fillElement) {
        binding.fillElement.style.width = output.width;
      }
      binding.element.setAttribute('aria-valuenow', String(output.now));
      binding.element.setAttribute('aria-valuemax', String(output.max));
      binding.element.setAttribute('aria-valuemin', '0');
      return;
    }

    if (binding.mode === 'switch') {
      const on = this._renderSwitch(binding);
      if (on === binding.last) return;
      binding.last = on;
      binding.element.classList.toggle('switch--on', on);
      return;
    }

    const text =
      binding.mode === 'remaining'
        ? this._renderRemaining(binding)
        : this._renderText(binding);
    if (text === binding.last) return;
    binding.last = text;
    binding.element.textContent = text;
  }

  /**
   * Tear down the renderer: cancel a pending batched flush and unsubscribe
   * every event (shutdown-sequence future-proofing; the renderer must not be
   * reused after this call).
   *
   * @returns {void}
   */
  destroy() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._dirty = false;
    this._unsubscribe();
  }

  /**
   * Subscribe the three refresh events. Called by init().
   *
   * @returns {void}
   */
  _subscribe() {
    this._eventBus.subscribe('loop:uiRefresh', this._onUiRefresh);
    this._eventBus.subscribe('ui:refresh', this._onFullRefresh);
    this._eventBus.subscribe('game:restored', this._onFullRefresh);
  }

  /**
   * Unsubscribe the three refresh events. Called by destroy().
   *
   * @returns {void}
   */
  _unsubscribe() {
    this._eventBus.unsubscribe('loop:uiRefresh', this._onUiRefresh);
    this._eventBus.unsubscribe('ui:refresh', this._onFullRefresh);
    this._eventBus.unsubscribe('game:restored', this._onFullRefresh);
  }

  /**
   * Parse and cache a single [data-bind] node into a binding descriptor.
   * The node's existing text content is preserved — it serves as the no-JS /
   * initial placeholder until the first flush overwrites it.
   *
   * @param {Element} node — element carrying data-bind attributes.
   * @returns {object|null} the parsed binding, or null when the element has
   *          no usable data-bind path (logged and skipped).
   */
  _readBinding(node) {
    const raw = (node.getAttribute('data-bind') || '').trim();
    const paths = raw
      .split('|')
      .map((path) => path.trim())
      .filter((path) => path !== '');

    if (paths.length === 0) {
      console.warn('Renderer: [data-bind] has no dot path — skipping binding.', node);
      return null;
    }

    let mode = node.getAttribute('data-bind-mode') || 'text';
    if (!VALID_MODES.has(mode)) {
      console.warn(
        `Renderer: unknown data-bind-mode "${mode}" on [data-bind="${raw}"] — treating as "text".`
      );
      mode = 'text';
    }

    const maxPath = node.getAttribute('data-bind-max');
    const binding = {
      /** @type {Element} bound element. */
      element: node,
      /** @type {string[]} dot paths into state (from data-bind). */
      paths,
      /** @type {string} render mode ('text' | 'progress' | 'switch' | 'remaining'). */
      mode,
      /** @type {string|null} optional {n} template for text mode. */
      format: node.getAttribute('data-bind-format'),
      /** @type {string|null} dot path of the maximum (progress/remaining). */
      maxPath,
      /** @type {number} decimal places for numeric formatting. */
      decimals: _parseDecimals(node.getAttribute('data-bind-decimals')),
      /** @type {Element|null} cached .progress__fill child (progress mode). */
      fillElement: null,
      /** @type {*} last-rendered output (partial-refresh comparison). */
      last: undefined,
    };

    if (mode === 'progress') {
      if (!maxPath) {
        console.warn(
          `Renderer: [data-bind="${raw}"] mode="progress" has no data-bind-max — the bar will stay at 0%.`
        );
      }
      binding.fillElement = node.querySelector('.progress__fill');
      if (!binding.fillElement) {
        console.warn(
          `Renderer: [data-bind="${raw}"] mode="progress" has no .progress__fill child — the bar cannot be sized.`
        );
      }
    } else if (mode === 'remaining' && !maxPath) {
      console.warn(
        `Renderer: [data-bind="${raw}"] mode="remaining" has no data-bind-max — it will render "${EMDASH}".`
      );
    }

    return binding;
  }

  /**
   * Resolve a dot path (e.g. "cultivation.qi") through the game state.
   * Missing intermediate segments short-circuit to undefined.
   *
   * @param {string} path — dot-separated path into the state object.
   * @returns {*} the value at the path, or undefined when a segment is
   *          missing (a terminal null is returned as null so text mode can
   *          render it as "—").
   */
  _resolvePath(path) {
    let current = this._state;
    const segments = path.split('.');
    for (let i = 0; i < segments.length; i += 1) {
      if (current === null || current === undefined) return undefined;
      current = current[segments[i]];
    }
    return current;
  }

  /**
   * Compose the text-mode output: resolve every path, then either substitute
   * the values into the {n} template or render a single unformatted value.
   *
   * @param {object} binding — parsed binding.
   * @returns {string} the text to display ("—" when nothing is bound).
   */
  _renderText(binding) {
    const values = binding.paths.map((path) => this._resolvePath(path));
    if (binding.format) {
      return this._composeTemplate(binding.format, values, binding.decimals);
    }
    return this._formatValue(values[0], binding.decimals);
  }

  /**
   * Compute a progress bar's geometry: the fill width percent (clamped
   * 0–100, 0 when max <= 0) and the numeric now/max used for the ARIA
   * progressbar attributes. Non-finite sides coerce to 0.
   *
   * @param {object} binding — parsed binding.
   * @returns {{ width: string, now: number, max: number }} fill width string
   *          (e.g. "33.33%") and safe numeric bounds.
   */
  _renderProgress(binding) {
    const value = this._resolvePath(binding.paths[0]);
    const max = binding.maxPath ? this._resolvePath(binding.maxPath) : undefined;

    const now = Number(value);
    const cap = Number(max);
    const nowSafe = Number.isFinite(now) ? now : 0;
    const maxSafe = Number.isFinite(cap) ? cap : 0;

    const percent =
      maxSafe > 0 ? Math.min(Math.max((nowSafe / maxSafe) * 100, 0), 100) : 0;
    const width = `${Math.round(percent * 100) / 100}%`;

    return { width, now: nowSafe, max: maxSafe };
  }

  /**
   * Compute a switch's on/off state from its bound boolean.
   *
   * @param {object} binding — parsed binding.
   * @returns {boolean} true when the bound value is truthy (switch on).
   */
  _renderSwitch(binding) {
    return Boolean(this._resolvePath(binding.paths[0]));
  }

  /**
   * Compute the "max − value" remaining display (e.g. empty inventory
   * slots). Renders "—" when either side is null/undefined (or the
   * difference is not a finite number).
   *
   * @param {object} binding — parsed binding.
   * @returns {string} the remaining count, formatted to the binding's
   *          decimals.
   */
  _renderRemaining(binding) {
    const value = this._resolvePath(binding.paths[0]);
    const max = binding.maxPath ? this._resolvePath(binding.maxPath) : undefined;

    if (value === null || value === undefined || max === null || max === undefined) {
      return EMDASH;
    }
    const remaining = Number(max) - Number(value);
    if (!Number.isFinite(remaining)) return EMDASH;
    return this._formatNumber(remaining, binding.decimals);
  }

  /**
   * Substitute bound values into a {0} / {1} template. Placeholder indexes
   * without a bound value (or bound to null/undefined) render "—".
   *
   * @param {string} format — template string.
   * @param {Array<*>} values — resolved bound values in path order.
   * @param {number} decimals — decimal places for numeric substitutions.
   * @returns {string} the composed text.
   */
  _composeTemplate(format, values, decimals) {
    return format.replace(/\{(\d+)\}/g, (match, index) => {
      const value = values[Number(index)];
      return this._formatValue(value, decimals);
    });
  }

  /**
   * Format a single resolved value for display: null/undefined become "—",
   * numbers go through the cached Intl.NumberFormat, everything else is
   * stringified as-is.
   *
   * @param {*} value — resolved state value.
   * @param {number} decimals — decimal places for numbers.
   * @returns {string} display text.
   */
  _formatValue(value, decimals) {
    if (value === null || value === undefined) return EMDASH;
    if (typeof value === 'number') return this._formatNumber(value, decimals);
    return String(value);
  }

  /**
   * Format a number with thousands separators and the configured fraction
   * digits, using a per-decimals cached formatter (browser default locale).
   *
   * @param {number} value — number to format.
   * @param {number} decimals — decimal places (formatter cache key).
   * @returns {string} formatted number.
   */
  _formatNumber(value, decimals) {
    let formatter = this._formatters.get(decimals);
    if (!formatter) {
      formatter = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      this._formatters.set(decimals, formatter);
    }
    return formatter.format(value);
  }
}

/**
 * Validate a data-bind-decimals attribute: a non-negative integer capped at
 * MAX_DECIMALS, defaulting to 0 with a warning when unusable.
 *
 * @param {string|null} value — raw attribute value.
 * @returns {number} validated decimal places.
 */
function _parseDecimals(value) {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DECIMALS) {
    console.warn(
      `Renderer: invalid data-bind-decimals "${String(value)}" — using 0 (range 0–${MAX_DECIMALS}).`
    );
    return 0;
  }
  return parsed;
}
