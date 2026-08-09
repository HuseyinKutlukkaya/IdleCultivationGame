/**
 * tests/helpers/intersection-observer-stub.mjs — reveal test doubles.
 *
 * js/ui/reveal.js (scroll-reveal) touches classList.add on real elements and
 * `new IntersectionObserver(...)` with the real observer API. This helper
 * provides the two stand-ins those tests need:
 *
 *   - createRevealTarget(): a fake element whose classList supports
 *     add/remove/toggle, backed by a live `classes` Set for assertions.
 *     Built on the shared createFakeElement and augmented with the
 *     add/remove surface reveal.js uses.
 *   - createIntersectionObserverStub(): a FakeIntersectionObserver class
 *     that records every instance and each instance's observe/unobserve
 *     sets, plus a fire(entries) method that runs the constructor callback
 *     with a given entry list — exactly the shape the real browser API
 *     delivers to the reveal callback.
 *
 * Zero dependencies; consumed only by tests (not shipped with the game).
 */
import { createFakeElement } from './fake-dom.mjs';

/**
 * Create a fake [data-reveal] target element.
 *
 * Reuses createFakeElement (attribute store, style, textContent) and layers
 * the classList.add/remove surface reveal.js calls on top; the `classes`
 * Set stays live for assertions.
 *
 * @returns {object} fake element with a `classes` Set and a classList
 *          supporting add/remove/toggle.
 */
export function createRevealTarget() {
  const el = createFakeElement();
  el.classList.add = (cls) => {
    el.classes.add(cls);
  };
  el.classList.remove = (cls) => {
    el.classes.delete(cls);
  };
  return el;
}

/**
 * Create a stub for the IntersectionObserver browser API.
 *
 * The returned class pushes every constructed instance onto `instances`
 * (so tests can assert how many observers were created). Each instance
 * exposes its constructor callback and options, `observed`/`unobserved`
 * sets, and a deterministic `fire(entries)` that replays an intersection
 * callback.
 *
 * @returns {{ FakeIntersectionObserver: typeof FakeIntersectionObserver,
 *             instances: Array<FakeIntersectionObserver> }} the fake class
 *          and every instance it has created.
 */
export function createIntersectionObserverStub() {
  /** @type {Array<FakeIntersectionObserver>} every constructed instance. */
  const instances = [];

  class FakeIntersectionObserver {
    /**
     * @param {Function} callback — the intersection callback (as the real
     *        API receives it).
     * @param {object} [options] — observer options (reveal passes
     *        { threshold: 0.12 }).
     */
    constructor(callback, options) {
      /** @type {Function} the callback supplied to the constructor. */
      this.callback = callback;
      /** @type {object|undefined} the options supplied to the constructor. */
      this.options = options;
      /** @type {Set<object>} targets currently being observed. */
      this.observed = new Set();
      /** @type {Set<object>} targets unobserved so far. */
      this.unobserved = new Set();
      instances.push(this);
    }

    /**
     * Mark a target as observed.
     *
     * @param {object} target — fake element to observe.
     * @returns {void}
     */
    observe(target) {
      this.observed.add(target);
      this.unobserved.delete(target);
    }

    /**
     * Mark a target as unobserved.
     *
     * @param {object} target — fake element to stop observing.
     * @returns {void}
     */
    unobserve(target) {
      this.observed.delete(target);
      this.unobserved.add(target);
    }

    /**
     * Replay an intersection callback with the given entries, exactly as
     * the browser would invoke it.
     *
     * @param {Array<{ isIntersecting: boolean, target: object }>} entries —
     *        fake IntersectionObserverEntry objects.
     * @returns {void}
     */
    fire(entries) {
      this.callback(entries, this);
    }
  }

  return { FakeIntersectionObserver, instances };
}
