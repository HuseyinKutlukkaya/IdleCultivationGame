/**
 * core/event-bus.js — lightweight, framework-free event bus (no gameplay).
 *
 * Implements pub/sub so future gameplay systems can communicate without
 * referencing each other directly (per project philosophy: gameplay
 * systems should be independent and prefer event-driven communication).
 *
 * Example flow once gameplay exists:
 *   - System A: `EventBus.emit('resource.gained', { type: 'qi', amount: 5 })`
 *   - System B: `EventBus.subscribe('resource.gained', onResourceGained)`
 *
 * Pure infrastructure — no DOM access, no storage I/O, GitHub Pages
 * compatible. Not connected to gameplay yet.
 */

/** @type {Map<string, Set<Function>>} event name → subscribed callbacks */
const _listeners = new Map();

export const EventBus = {
  /**
   * Subscribe a callback to an event.
   * Duplicate (event, callback) pairs are ignored.
   *
   * @param {string} eventName — event to listen for.
   * @param {Function} callback — invoked with the payload on emit.
   */
  subscribe(eventName, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('EventBus.subscribe: callback must be a function.');
    }

    let callbacks = _listeners.get(eventName);
    if (!callbacks) {
      callbacks = new Set();
      _listeners.set(eventName, callbacks);
    }
    callbacks.add(callback);
  },

  /**
   * Remove a callback from an event. No-op when the pair is not subscribed.
   *
   * @param {string} eventName — event to unsubscribe from.
   * @param {Function} callback — the exact callback previously subscribed.
   */
  unsubscribe(eventName, callback) {
    const callbacks = _listeners.get(eventName);
    if (!callbacks) return;

    callbacks.delete(callback);

    // Drop empty buckets so clear() and memory stay tidy.
    if (callbacks.size === 0) {
      _listeners.delete(eventName);
    }
  },

  /**
   * Emit an event, invoking every subscribed callback with the payload.
   * A throwing callback does not prevent the remaining callbacks from
   * running; the error is logged and swallowed.
   *
   * @param {string} eventName — event to fire.
   * @param {*} [payload] — optional data passed to each callback.
   */
  emit(eventName, payload) {
    const callbacks = _listeners.get(eventName);
    if (!callbacks) return;

    for (const callback of callbacks) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`EventBus: error in "${eventName}" listener:`, error);
      }
    }
  },

  /**
   * Remove all subscriptions for every event.
   */
  clear() {
    _listeners.clear();
  },
};
