/**
 * tests/helpers/raf-stub.mjs — synchronous requestAnimationFrame stub.
 *
 * The Renderer batches DOM writes through requestAnimationFrame
 * (requestRefresh() schedules one flush per frame; _flush() cancels the
 * pending handle). Since Node has no rAF, DOM tests install this stub to
 * capture pending callbacks and run them deterministically.
 *
 * installRafStub() replaces the two globals and returns a handle with:
 *   - calls — the live array of pending callbacks (length shows whether
 *     requests coalesced into a single flush);
 *   - flush() — copies the pending callbacks, clears the array, then runs
 *     each copy. Copying first means a flush that itself calls
 *     cancelAnimationFrame (as Renderer._flush does) cannot wipe the
 *     in-flight callbacks.
 *
 * uninstallRafStub() restores the pristine global namespace.
 */

/**
 * Install the rAF stub globals.
 *
 * @returns {{ calls: Array<Function>, flush: () => void }} live pending
 *          callbacks and a synchronous flusher.
 */
export function installRafStub() {
  /** @type {Array<Function>} pending frame callbacks (live array). */
  const calls = [];

  globalThis.requestAnimationFrame = (callback) => {
    calls.push(callback);
    return calls.length;
  };
  globalThis.cancelAnimationFrame = () => {
    calls.length = 0;
  };

  return {
    calls,
    /**
     * Run every pending frame callback synchronously. The pending array is
     * copied and cleared before the callbacks run, so a callback that
     * cancels frames cannot clear its own in-flight copies.
     *
     * @returns {void}
     */
    flush() {
      const pending = [...calls];
      calls.length = 0;
      pending.forEach((callback) => callback());
    },
  };
}

/**
 * Remove the stubbed rAF globals.
 *
 * @returns {void}
 */
export function uninstallRafStub() {
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
}
