/**
 * tests/helpers/fake-dom.mjs — minimal fake DOM for UI tests.
 *
 * The Renderer (js/ui/renderer.js) is browser-only code (querySelectorAll,
 * getAttribute/setAttribute, classList, textContent, style). This helper
 * provides tiny plain-object stand-ins for the exact API surface the
 * Renderer touches, so tests can exercise real render logic without jsdom
 * and without mutating any real DOM.
 *
 * Supported fakes:
 *   - createFakeElement(attrs, hasFill): a fake element whose attributes
 *     double as its own store (the same object passed in). querySelector
 *     resolves '.progress__fill' only, returning a fill whose `style` object
 *     IS the element's own `style` object (so a width written on the fill is
 *     readable straight off the element). classList.toggle is backed by a
 *     `classes` Set exposed on the element for assertions.
 *   - createFakeRoot(elements): a scan scope whose querySelectorAll returns
 *     a fixed element list (what init() walks to find [data-bind] nodes).
 *
 * Zero dependencies; consumed only by tests (not shipped with the game).
 */

/**
 * Create a fake DOM element mimicking the surface the Renderer touches.
 *
 * The `attrs` object doubles as the element's attribute store: getAttribute
 * reads it and setAttribute writes String(value) back into it. When
 * `hasFill` is true, querySelector('.progress__fill') returns a fill node
 * sharing the element's `style` object (progress bars write their width
 * through that fill).
 *
 * @param {object} [attrs={}] — attribute map used as the element's store
 *        (e.g. { 'data-bind': 'cultivation.qi' }).
 * @param {boolean} [hasFill=false] — whether the element exposes a
 *        .progress__fill child (for mode="progress" bindings).
 * @returns {object} fake element with getAttribute/setAttribute,
 *          querySelector, textContent, style and classList.toggle.
 */
export function createFakeElement(attrs = {}, hasFill = false) {
  /** @type {object} style object shared with the fake .progress__fill. */
  const style = {};
  /** @type {Set<string>} classes managed through classList.toggle. */
  const classes = new Set();

  return {
    /** Own attribute store (the object passed in, mutated in place). */
    attrs,
    /** @type {object} element style; shared with the fill when hasFill. */
    style,
    /** @type {Set<string>} live class set for assertions. */
    classes,
    /** @type {string} text written by text-mode bindings. */
    textContent: '',

    /**
     * Read an attribute from the store.
     *
     * @param {string} name — attribute name.
     * @returns {string|null} stored value, or null when unset.
     */
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },

    /**
     * Store an attribute, stringified (mirrors the DOM's coercion).
     *
     * @param {string} name — attribute name.
     * @param {string|number} value — value to store.
     * @returns {void}
     */
    setAttribute(name, value) {
      attrs[name] = String(value);
    },

    /**
     * Resolve a child selector. Only '.progress__fill' exists on the fake;
     * its style object is the element's own style (so the Renderer's
     * `fillElement.style.width = ...` is visible as `element.style.width`).
     *
     * @param {string} selector — CSS selector (must be '.progress__fill').
     * @returns {object|null} fill node when hasFill, else null.
     */
    querySelector(selector) {
      if (selector !== '.progress__fill' || !hasFill) return null;
      return { style };
    },

    /** Fake classList implementing exactly the toggle the Renderer uses. */
    classList: {
      /**
       * Toggle a class. When `on` is undefined the class flips; the
       * Renderer always passes an explicit boolean.
       *
       * @param {string} cls — class name.
       * @param {boolean} [on] — force on/off state.
       * @returns {void}
       */
      toggle(cls, on) {
        if (on === undefined) {
          on = !classes.has(cls);
        }
        if (on) classes.add(cls);
        else classes.delete(cls);
      },
    },
  };
}

/**
 * Create a fake scan scope for init(): an object whose querySelectorAll
 * returns a fixed element list.
 *
 * @param {Array<object>} elements — the fake [data-bind] elements the
 *        renderer should find.
 * @returns {object} scope with querySelectorAll: () => elements.
 */
export function createFakeRoot(elements) {
  return {
    /** @returns {Array<object>} the fixed element list. */
    querySelectorAll() {
      return elements;
    },
  };
}
