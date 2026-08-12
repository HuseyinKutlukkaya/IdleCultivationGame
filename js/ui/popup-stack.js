/**
 * ui/popup-stack.js — top-right transient popup renderer (pure presentation).
 *
 * The Phase-2 P2 Event Popup & Log Pipeline's visual half: notification entries
 * that carry `popup: true` (added by the NotificationManager change in the
 * sibling task) render as transient popups IN ADDITION to the log entry. The
 * popups:
 *
 *   - appear top-right, fixed overlay (do NOT scroll with the page);
 *   - slide in via the CSS animation defined by the `.popup` class;
 *   - auto-dismiss after `config.notifications.popupDurationMs` ms
 *     (default 6000; the value 0 disables auto-dismiss — click-only);
 *   - dismiss immediately on click anywhere on the popup;
 *   - cap concurrent visibility at `config.notifications.popupMaxVisible`
 *     (default 5); when the cap is exceeded, the oldest visible popup is
 *     removed first;
 *   - color-code via the existing `--color-success` / `--color-warning` /
 *     `--color-danger` / `--color-accent-bright` tokens (one per
 *     notification type — the same palette the Activity Log uses).
 *
 * Pure presentation — no gameplay state writes, no EventBus emissions, no
 * storage I/O. Framework-free and GitHub Pages compatible; the bootstrap
 * (js/main.js) wires this module in with the shared NotificationManager
 * instance and the parsed `config` so the tunables are read defensively
 * (missing block → shipped defaults; present-but-invalid → warn once).
 *
 * Subscription model:
 *   - Subscribes to 'notification:changed' (the same event the Activity Log
 *     listens to). On every emission the module walks the queue (from the
 *     payload when present, else from `notifications.queue`) and renders a
 *     popup for every entry whose `popup === true` field is set.
 *   - Per-entry idempotency: a popup whose id is already visible is skipped
 *     (re-emits never duplicate). A popup that the player dismissed is
 *     tracked in a `dismissed` set and is NOT re-added on later emits — it
 *     sticks until its entry ages out of the NotificationManager's FIFO
 *     queue (at which point the dismissed id is pruned on the next walk).
 *   - A per-popup timer auto-dismisses after `popupDurationMs`; the timer
 *     is cleared whenever the popup is dismissed by any cause.
 *
 * A11y contract:
 *   - Each popup has `role="status"` (implicit polite live region) so screen
 *     readers announce new popups without interrupting the player
 *     (aria-live="assertive" would interrupt — explicitly avoided here).
 *   - The popup host is a fixed-position container that does NOT trap focus
 *     and has no backdrop absorbing clicks; the popups themselves are
 *     clickable (dismissal) but never move focus or block page input.
 *   - All copy is written via textContent (never innerHTML) so a hostile
 *     notification message cannot inject markup into the popup.
 *
 * Defensive contract (every bad call is a `console.warn` + a no-op —
 * never a throw, never a mutation):
 *   - missing document → return NOOP_HANDLE, warn once
 *   - missing [data-popup-root] AND missing document.body → return NOOP_HANDLE
 *   - missing notifications manager → return NOOP_HANDLE, warn once
 *   - missing config block → silent defaults (matches the NotificationManager
 *     pattern — missing is silent, present-but-invalid warns once)
 *   - invalid `popupDurationMs` (non-integer or negative) → warn once, use
 *     the shipped default (6000)
 *   - invalid `popupMaxVisible` (non-integer or non-positive) → warn once,
 *     use the shipped default (5)
 *
 * DOM contracts (attributes this module reads/writes):
 *   [data-popup-root]            on the host container (index.html)
 *   [data-popup]                 on each popup <div>
 *   [data-popup-type="<type>"]   on each popup <div> — CSS color-codes via
 *                                the [data-popup-type="..."] attribute
 *                                selector (mirrors .log__item--<type> in the
 *                                Activity Log; one CSS class per type is
 *                                added in css/styles.css)
 *   [data-popup-message]         on the <p> holding the message text
 *   role="status"                on each popup <div> (a11y)
 */
import { EventBus } from '../core/event-bus.js';

/** CSS selector for the popup host (matches the static position in index.html). */
const HOST_SELECTOR = '[data-popup-root]';

/** Event name the NotificationManager emits on every queue change. */
const CHANGE_EVENT = 'notification:changed';

/** Auto-dismiss duration when config.notifications.popupDurationMs is missing or invalid. */
const DEFAULT_POPUP_DURATION_MS = 6000;

/** Max concurrent popups when config.notifications.popupMaxVisible is missing or invalid. */
const DEFAULT_POPUP_MAX_VISIBLE = 5;

/** Shared no-op handle for every skip path (nothing to tear down). */
const NOOP_HANDLE = { destroy() {} };

/**
 * Initialize the popup stack. Subscribes to 'notification:changed' and
 * renders a transient popup for every queue entry whose `popup === true`.
 *
 * @param {object} [options]
 * @param {object} [options.eventBus=EventBus] — bus to subscribe to.
 * @param {object|null} [options.notifications=null] — NotificationManager
 *        handle exposing a `queue` array. Required.
 * @param {object|null} [options.config=null] — parsed contents of
 *        data/game-config.json; reads `config.notifications.popupDurationMs`
 *        and `config.notifications.popupMaxVisible` defensively. Optional.
 * @param {object} [options.root=document] — DOM scope holding the popup
 *        host; in production this is the document object (the host is a
 *        sibling of [data-modal-root] at the end of <body>).
 * @returns {{ destroy(): void }} handle; destroy() unsubscribes the
 *          'notification:changed' handler and tears down every visible
 *          popup (no leftover DOM, no leaked timers). When the host or the
 *          manager is missing, warns once and returns a no-op.
 */
export function initPopupStack({
  eventBus = EventBus,
  notifications = null,
  config = null,
  root = document,
} = {}) {
  // No document → no DOM API at all. No-op (a hostile test / stripped build).
  if (typeof document === 'undefined') {
    console.warn('initPopupStack: no document available; skipping popup stack.');
    return NOOP_HANDLE;
  }

  // Host resolution: prefer [data-popup-root] on the supplied root; fall
  // back to document.body. Both must expose appendChild (the production host
  // is a plain <div> sitting at the end of <body>).
  let host = null;
  if (root && typeof root.querySelector === 'function') {
    host = root.querySelector(HOST_SELECTOR);
  }
  if (!host && document.body) host = document.body;
  if (!host || typeof host.appendChild !== 'function') {
    console.warn('initPopupStack: no host element found; skipping popup stack.');
    return NOOP_HANDLE;
  }

  // The manager is the source of truth for the queue; without it there is
  // nothing to render. Mirror the Activity Log's guard.
  if (!notifications || !Array.isArray(notifications.queue)) {
    console.warn(
      'initPopupStack: no notifications manager provided; skipping popup stack.'
    );
    return NOOP_HANDLE;
  }

  const duration = readPopupDuration(config);
  const maxVisible = readPopupMaxVisible(config);

  /**
   * @type {Map<string, { node: object, timer: any }>} id → visible-popup
   *        record. Insertion order = display order (oldest at top of the
   *        flex column; new ones append below).
   */
  const visible = new Map();

  /**
   * @type {Set<string>} ids the player dismissed. Sticky until the entry
   *        ages out of the NotificationManager's FIFO queue — keeps manual
   *        dismissals from being undone by a later emit (the queue still
   *        contains the entry until it ages out, so a re-emit that re-walks
   *        the queue would otherwise re-add it).
   */
  const dismissed = new Set();

  /**
   * Tear a popup down: cancel its timer (if any), remove its DOM node, drop
   * it from the visible map, and add its id to the dismissed set so later
   * emits never re‑add it (the same sticky guarantee the click path has).
   * Idempotent — a missing id is a quiet no‑op so the timer callback and
   * the click handler can both call it safely.
   *
   * Every removal path (click, auto‑dismiss timer, cap‑eviction, destroy)
   * goes through here, so a popup that has been shown once is never re‑shown
   * while its entry lives in the NotificationManager queue. The dismissed
   * set is pruned of ids that have aged out of the queue on every emit, so
   * memory stays bounded.
   *
   * @param {string} id — entry id of the popup to remove.
   * @returns {void}
   */
  function removePopup(id) {
    const entry = visible.get(id);
    if (!entry) return;
    dismissed.add(id);
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const node = entry.node;
    visible.delete(id);
    if (node && typeof node.remove === 'function') {
      node.remove();
    } else if (
      host &&
      typeof host.removeChild === 'function' &&
      node &&
      node.parentNode === host
    ) {
      host.removeChild(node);
    }
  }

  /**
   * Schedule the auto-dismiss timer for a visible popup. Cancels any prior
   * timer on the same popup first (defensive — a re-render that produced
   * the same id would otherwise leak the previous handle). When
   * `duration === 0` the function is a no-op (click-only popup).
   *
   * @param {string} id — entry id of the popup.
   * @returns {void}
   */
  function scheduleAutoDismiss(id) {
    if (duration <= 0) return;
    const entry = visible.get(id);
    if (!entry) return;
    if (entry.timer != null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      // The timer fired: clear the ref and tear the popup down.
      removePopup(id);
    }, duration);
  }

  /**
   * Build a single popup subtree. The message <p> gets the entry message
   * via textContent (never innerHTML — XSS-safe by construction). The
   * outer <div> gets a click listener that adds the id to `dismissed` and
   * tears the popup down. role="status" is set for a11y (implicit polite
   * live region — see the file header).
   *
   * @param {{ id: string, type: string, message: string }} entry — queue
   *        entry to render. `type` defaults to '' when missing so the
   *        attribute is always set (CSS keys off its presence).
   * @returns {object} the popup <div> (already wired with its click handler).
   */
  function buildPopup(entry) {
    const node = document.createElement('div');
    node.setAttribute('class', 'popup');
    node.setAttribute('data-popup', '');
    node.setAttribute('data-popup-type', typeof entry.type === 'string' ? entry.type : '');
    node.setAttribute('role', 'status');

    const message = document.createElement('p');
    message.setAttribute('class', 'popup__message');
    message.setAttribute('data-popup-message', '');
    message.textContent = typeof entry.message === 'string' ? entry.message : '';

    node.appendChild(message);

    if (typeof node.addEventListener === 'function') {
      node.addEventListener('click', () => {
        // Sticky dismiss: re-emits must not bring this popup back even
        // though the entry is still in the queue.
        dismissed.add(entry.id);
        removePopup(entry.id);
      });
    }

    return node;
  }

  /**
   * Walk a queue snapshot and reconcile it with the visible + dismissed
   * sets. For each entry whose `popup === true` field is set:
   *   - if its id is already visible, skip (per-emit idempotency);
   *   - if its id is in the dismissed set, skip (sticky manual dismiss);
   *   - otherwise enforce the max-concurrent cap (drop the oldest visible
   *     popup until the cap has room), build a popup, append to the host,
   *     register it in the visible map and schedule its auto-dismiss.
   *
   * Also prunes the dismissed set to ids that have aged out of the queue
   * (so memory stays bounded — the set never grows past the queue size).
   *
   * @param {Array<object>} queue — queue snapshot (payload or fallback).
   * @returns {void}
   */
  function renderQueue(queue) {
    if (!Array.isArray(queue)) return;

    // Prune dismissed ids that are no longer in the queue.
    for (const id of Array.from(dismissed)) {
      if (!queue.some((e) => e && e.id === id)) {
        dismissed.delete(id);
      }
    }

    for (const entry of queue) {
      if (!entry || typeof entry !== 'object') continue;
      // Strict equality: the NotificationManager only ever writes the
      // literal `true`, but we never trust the field blindly — a hostile
      // queue (e.g. an injected one in tests) could carry any value.
      if (entry.popup !== true) continue;
      if (typeof entry.id !== 'string' || entry.id === '') continue;

      if (visible.has(entry.id) || dismissed.has(entry.id)) continue;

      // Enforce the cap by removing the oldest visible popup until the
      // new entry has room. visible.keys() is in insertion order, so the
      // first key is the oldest entry.
      while (visible.size >= maxVisible) {
        const oldestId = visible.keys().next().value;
        if (oldestId === undefined) break;
        removePopup(oldestId);
      }

      const node = buildPopup(entry);
      host.appendChild(node);
      visible.set(entry.id, { node, timer: null });
      scheduleAutoDismiss(entry.id);
    }
  }

  /**
   * 'notification:changed' handler — prefers the payload's queue when
   * present (the canonical carrier emitted by NotificationManager), else
   * falls back to `notifications.queue`. Mirrors the activity-log pattern.
   *
   * @param {{ queue?: Array<object> }} [payload] — event payload.
   * @returns {void}
   */
  function onQueueChanged(payload) {
    const queue =
      payload && Array.isArray(payload.queue) ? payload.queue : notifications.queue;
    renderQueue(queue);
  }

  eventBus.subscribe(CHANGE_EVENT, onQueueChanged);

  // Initial render from the manager's current queue (mirrors the activity
  // log's bootstrap render so a pre-existing queue lights up immediately).
  renderQueue(notifications.queue);

  return {
    /**
     * Unsubscribe the 'notification:changed' handler, tear down every
     * visible popup (timer + DOM) and clear the dismissed set so the host
     * has no leftover popups and the bus has no leaked listeners.
     *
     * @returns {void}
     */
    destroy() {
      eventBus.unsubscribe(CHANGE_EVENT, onQueueChanged);
      for (const id of Array.from(visible.keys())) {
        removePopup(id);
      }
      dismissed.clear();
    },
  };
}

/**
 * Read `config.notifications.popupDurationMs` defensively. Missing block
 * is silent (matches the NotificationManager pattern); present-but-invalid
 * warns once and falls back to the shipped default.
 *
 * Allowed values:
 *   - non-negative integer (0 disables auto-dismiss → click-only popups);
 *   - anything else → warn and use the shipped default.
 *
 * @param {object|null} config — parsed game-config.json (or null/undefined
 *        for tests that don't care about the tunable).
 * @returns {number} a non-negative integer (0 or positive).
 */
function readPopupDuration(config) {
  const block = config && typeof config === 'object' ? config.notifications : null;
  if (!block || typeof block !== 'object') return DEFAULT_POPUP_DURATION_MS;
  const raw = block.popupDurationMs;
  if (raw === undefined) return DEFAULT_POPUP_DURATION_MS;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  console.warn(
    `initPopupStack: invalid notifications.popupDurationMs (${String(raw)}) — using default ${DEFAULT_POPUP_DURATION_MS}.`
  );
  return DEFAULT_POPUP_DURATION_MS;
}

/**
 * Read `config.notifications.popupMaxVisible` defensively. Same defensive
 * pattern as `readPopupDuration`: missing block is silent, present-but-
 * invalid warns once and falls back to the shipped default.
 *
 * Allowed values:
 *   - positive integer (>= 1) → use as-is;
 *   - 0 / negative / non-integer → warn and use the shipped default
 *     (5). 0 would mean "never render", which is almost certainly a
 *     typo in the config; the safe interpretation is "the popup stack
 *     is on but the cap is missing".
 *
 * @param {object|null} config — parsed game-config.json (or null/undefined
 *        for tests that don't care about the tunable).
 * @returns {number} a positive integer (>= 1).
 */
function readPopupMaxVisible(config) {
  const block = config && typeof config === 'object' ? config.notifications : null;
  if (!block || typeof block !== 'object') return DEFAULT_POPUP_MAX_VISIBLE;
  const raw = block.popupMaxVisible;
  if (raw === undefined) return DEFAULT_POPUP_MAX_VISIBLE;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  console.warn(
    `initPopupStack: invalid notifications.popupMaxVisible (${String(raw)}) — using default ${DEFAULT_POPUP_MAX_VISIBLE}.`
  );
  return DEFAULT_POPUP_MAX_VISIBLE;
}