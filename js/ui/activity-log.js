/**
 * ui/activity-log.js — Activity Log panel renderer (pure presentation).
 *
 * Renders the NotificationManager's bounded FIFO queue into the
 * #activity-log list inside the Activity Log game panel and keeps it in
 * sync: the initial render reads the manager's current queue, and every
 * 'notification:changed' event re-renders the list from the payload
 * (falling back to the manager's queue when the payload carries none).
 *
 * Reads state only — never mutates gameplay, no storage access, no
 * innerHTML (queue messages are data-driven and must always render as
 * plain text). Framework-free and GitHub Pages compatible; the bootstrap
 * (js/main.js) wires this module in with the NotificationManager instance.
 *
 * This module is deliberately tolerant: when the panel is absent from the
 * DOM or no notifications manager is provided, initActivityLog() warns once
 * and returns a no-op handle so bootstrap never crashes (some test
 * environments, e.g. the integration fake DOM, lack querySelector).
 */
import { EventBus } from '../core/event-bus.js';

/** CSS selector for the log list inside the Activity Log panel. */
const LOG_SELECTOR = '#activity-log';

/** Event name the NotificationManager emits on every queue change. */
const CHANGE_EVENT = 'notification:changed';

/** Shared no-op handle for every skip path (nothing to tear down). */
const NOOP_HANDLE = { destroy() {} };

/**
 * Format a timestamp as UTC HH:MM:SS.
 *
 * Deterministic and machine-independent: built from getUTCHours /
 * getUTCMinutes / getUTCSeconds with padStart — never
 * toLocaleTimeString, which is locale/timezone sensitive.
 *
 * @param {number|string|Date} at — ms epoch, ISO 8601 string, or Date.
 *        new Date(at) accepts all three (a Date is copied).
 * @returns {string} zero-padded "HH:MM:SS" in UTC.
 */
function formatUtcTime(at) {
  const date = new Date(at);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Initialize the Activity Log panel.
 *
 * @param {object} [options]
 * @param {typeof EventBus} [options.eventBus=EventBus] — bus to subscribe to.
 * @param {object|null} [options.notifications=null] — NotificationManager
 *        handle exposing a `queue` array of { id, type, message, at }.
 * @param {object} [options.root=document] — DOM scope holding the log list.
 * @returns {{ destroy(): void }} handle; destroy() unsubscribes the
 *          'notification:changed' handler. Never throws: when the panel is
 *          absent or no manager is provided, warns once and returns a no-op.
 */
export function initActivityLog({
  eventBus = EventBus,
  notifications = null,
  root = document,
} = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn('initActivityLog: root.querySelector is missing; skipping Activity Log.');
    return NOOP_HANDLE;
  }

  const container = root.querySelector(LOG_SELECTOR);
  if (!container) {
    console.warn('initActivityLog: no #activity-log container found; skipping Activity Log.');
    return NOOP_HANDLE;
  }

  if (!notifications) {
    console.warn('initActivityLog: no notifications manager provided; skipping Activity Log.');
    return NOOP_HANDLE;
  }

  /**
   * Re-render the whole log from a queue snapshot. Replaces all children
   * (which also drops the no-JS placeholder items on first render).
   *
   * @param {Array<{id: string, type: string, message: string, at: number|string|Date}>} queue
   * @returns {void}
   */
  const render = (queue) => {
    container.textContent = '';

    for (const entry of queue) {
      const item = document.createElement('li');
      item.classList.add('log__item', `log__item--${entry.type}`);

      const time = document.createElement('span');
      time.classList.add('log__time');
      time.textContent = formatUtcTime(entry.at);

      const message = document.createElement('span');
      message.textContent = entry.message;

      item.appendChild(time);
      item.appendChild(message);
      container.appendChild(item);
    }
  };

  /**
   * Re-render from an event payload, preferring its queue when present.
   *
   * @param {{ queue?: Array<object> }} [payload] — event payload.
   * @returns {void}
   */
  const onQueueChanged = (payload) => {
    const queue =
      payload && Array.isArray(payload.queue) ? payload.queue : notifications.queue;
    render(queue);
  };

  eventBus.subscribe(CHANGE_EVENT, onQueueChanged);

  // Initial render from the manager's current queue.
  render(notifications.queue);

  return {
    /** Unsubscribe the 'notification:changed' handler. */
    destroy() {
      eventBus.unsubscribe(CHANGE_EVENT, onQueueChanged);
    },
  };
}
