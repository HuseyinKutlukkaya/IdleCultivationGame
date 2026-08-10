/**
 * managers/notification-manager.js — queue-based NotificationManager (core service).
 *
 * The single source of truth for the in-game notification queue. Anything in the
 * game that wants to surface a message to the player (a milestone, an offline
 * gain, a quest finish, a sect event, ...) calls notifs.add(message, { type })
 * and the bounded FIFO queue absorbs it; the Activity Log renderer
 * (js/ui/activity-log.js) watches the queue and re-renders on every change.
 *
 * Responsibilities:
 *   - add(message, options?)  append an entry; returns the new id or null on a bad call
 *   - dismiss(id)             remove a specific entry by id; returns true on hit
 *   - clear()                 empty the queue
 *   - size()                  current queue length
 *   - get queue()             shallow snapshot of the current entries
 *   - get maxQueueSize()      configured cap (entries)
 *   - get types()             defensive shallow copy of the whitelist
 *   - dispose()               tear-down seam (no listeners today; future-proof)
 *
 * Event contract (emitted on the injected eventBus):
 *   notification:changed { queue }  — fired once for every successful queue
 *     mutation (add / dismiss / clear). NEVER fired for a rejected call, a
 *     no-op dismiss, or a no-op add; the activity-log renderer treats the
 *     absence of an event as a guarantee that the queue did not change. The
 *     payload's `queue` is the same shape notifs.get queue() returns, so
 *     subscribers can read straight off the payload and never need to query
 *     the manager a second time.
 *
 * Queue shape (every entry):
 *   { id: string, type: string, message: string, at: number /* epoch ms *\/ }
 *
 * Pure manager service — no DOM access, no storage I/O, no GameState mutation
 * (notifications are transient UI state; they intentionally do NOT survive a
 * reload — a save does not capture them, a restore does not replay them).
 * No requestAnimationFrame, no globals, framework-free and GitHub Pages
 * compatible (relative imports, browser APIs only: Set, Number, console).
 *
 * Defensive contract (every bad call is a logged warning + a no-op return —
 * never a throw, never a mutation, never an emit):
 *   - non-string / empty / whitespace-only message   → add() returns null
 *   - unknown / prototype-alias / missing-default    → add() returns null
 *     type
 *   - non-string / prototype-alias id                → dismiss() returns false
 *
 * Data-driven: every tunable (queue cap, type whitelist) comes from
 * data/game-config.json `notifications` block. The shipped defaults are
 * maxQueueSize = 50 and types = ['info','success','warning','error','achievement']
 * — adding a type is a JSON-only change (and a matching `log__item--<type>`
 * CSS class on the Activity Log panel).
 *
 * Future expansion (per PLANS.md): animations, icons, history, filters.
 * None of those need a manager rewrite — they hang off the existing
 * 'notification:changed' stream.
 */

import { EventBus } from '../core/event-bus.js';

/** Keys that alias the prototype chain and must never appear in a queue field. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Default queue cap when config or config.notifications is missing/unusable. */
const DEFAULT_MAX_QUEUE_SIZE = 50;

/** Default type whitelist when config or config.notifications.types is missing/unusable. */
const DEFAULT_TYPES = Object.freeze(['info', 'success', 'warning', 'error', 'achievement']);

/** Default type for add() when no options.type is supplied. */
const DEFAULT_TYPE = 'info';

/** Monotonic id prefix; ids are short and human-readable for debugging. */
const ID_PREFIX = 'n';

/**
 * @typedef {object} NotificationEntry
 * @property {string} id
 * @property {string} type
 * @property {string} message
 * @property {number} at Epoch milliseconds.
 */

/**
 * @param {object} [options] — constructor options.
 * @param {object} [options.config] — parsed contents of data/game-config.json;
 *        the `notifications` block is read (maxQueueSize, types). Missing or
 *        invalid values fall back to the shipped defaults (silent on missing,
 *        warned on present-but-invalid).
 * @param {object} [options.eventBus] — pub/sub bus emitting 'notification:changed';
 *        defaults to the shared EventBus singleton.
 * @param {() => number} [options.now] — clock for the `at` stamp; defaults to
 *        Date.now (injectable for deterministic tests).
 */
export class NotificationManager {
  constructor(options = {}) {
    const notifications = (options.config && options.config.notifications) || {};

    /** @type {object} pub/sub bus lifecycle events are emitted on. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {() => number} wall-clock source for the `at` stamp. */
    this._now = typeof options.now === 'function' ? options.now : Date.now;

    /** @type {number} effective queue cap (positive integer). */
    this._maxQueueSize = _readMaxQueueSize(notifications);
    /** @type {string[]} defensive defensive shallow copy of the configured types. */
    this._types = _readTypes(notifications);

    /** @type {NotificationEntry[]} bounded FIFO queue (oldest at index 0). */
    this._queue = [];
    /** @type {number} monotonic counter feeding add()'s generated ids. */
    this._idCounter = 0;

    /** @type {boolean} true once dispose() has run. */
    this._disposed = false;
  }

  /**
   * Append a new entry to the queue.
   *
   * Bad-call paths (any of): non-string message, empty/whitespace-only
   * message, unknown type (not in the whitelist), prototype-alias type. Each
   * returns null with a single console.warn, never mutates the queue and
   * never emits 'notification:changed'.
   *
   * FIFO cap: when the queue is at capacity the oldest entry is dropped
   * first; the new entry is then appended and a single event is emitted.
   *
   * @param {string} message — human-readable notification text (trimmed check
   *        requires a non-empty, non-whitespace string).
   * @param {{type?: string}} [options] — optional metadata. `type` defaults
   *        to 'info' and must be in the configured whitelist.
   * @returns {string|null} the new entry's id, or null on a rejected call.
   */
  add(message, options = {}) {
    if (this._disposed) {
      console.warn('NotificationManager.add: manager was disposed — ignoring add.');
      return null;
    }

    if (typeof message !== 'string') {
      console.warn(
        `NotificationManager.add: message must be a string (got ${typeof message}) — ignoring add.`
      );
      return null;
    }

    const trimmed = message.trim();
    if (trimmed === '') {
      console.warn('NotificationManager.add: empty/whitespace message — ignoring add.');
      return null;
    }

    const requestedType =
      options && typeof options.type === 'string' && options.type !== ''
        ? options.type
        : DEFAULT_TYPE;

    if (!this._isValidType(requestedType)) {
      // _isValidType already warns (and rejects prototype-alias ids defensively).
      return null;
    }

    const entry = {
      id: this._nextId(),
      type: requestedType,
      message,
      at: this._now(),
    };

    // FIFO cap: drop the oldest entries until the new one fits.
    while (this._queue.length >= this._maxQueueSize) {
      this._queue.shift();
    }
    this._queue.push(entry);

    this._emitChanged();
    return entry.id;
  }

  /**
   * Remove an entry by id.
   *
   * @param {string} id — the entry id to remove. Non-string or
   *        prototype-alias ids are rejected with a warning and return false
   *        (never invoke Array.prototype.find with such a value — that could
   *        touch Object.prototype via `__proto__`).
   * @returns {boolean} true when an entry was removed, false otherwise (no
   *          event emitted on a no-op).
   */
  dismiss(id) {
    if (this._disposed) {
      console.warn('NotificationManager.dismiss: manager was disposed — ignoring dismiss.');
      return false;
    }
    if (typeof id !== 'string' || id === '') {
      console.warn(
        `NotificationManager.dismiss: id must be a non-empty string (got ${String(id)}) — ignoring dismiss.`
      );
      return false;
    }
    if (UNSAFE_KEYS.has(id)) {
      console.warn(`NotificationManager.dismiss: unsafe id "${id}" — ignoring dismiss.`);
      return false;
    }

    const index = this._queue.findIndex((entry) => entry.id === id);
    if (index === -1) return false;

    this._queue.splice(index, 1);
    this._emitChanged();
    return true;
  }

  /**
   * Empty the queue. Emits one event only when something was actually
   * removed (so the activity-log's no-op renders are not pushed onto a busy
   * frame). Calling clear() on an empty queue is a quiet no-op.
   *
   * @returns {void}
   */
  clear() {
    if (this._disposed) {
      console.warn('NotificationManager.clear: manager was disposed — ignoring clear.');
      return;
    }
    if (this._queue.length === 0) return;
    this._queue.length = 0;
    this._emitChanged();
  }

  /**
   * @returns {number} the current queue length.
   */
  size() {
    return this._queue.length;
  }

  /**
   * @returns {NotificationEntry[]} a fresh shallow array of the current
   *          entries — mutating the returned array never leaks into the queue
   *          (the renderer only reads it; this prevents accidental coupling).
   */
  get queue() {
    return this._queue.map((entry) => ({ ...entry }));
  }

  /**
   * @returns {number} the configured queue cap (a positive integer — always
   *          >= 1 even after fallback).
   */
  get maxQueueSize() {
    return this._maxQueueSize;
  }

  /**
   * @returns {string[]} a defensive shallow copy of the configured type
   *          whitelist. Mutating the returned array never leaks into the
   *          whitelist.
   */
  get types() {
    return this._types.slice();
  }

  /**
   * Tear-down hook. The manager holds no listeners today, so this is a future
   * seam — but it must exist so the bootstrap can symmetrically call dispose
   * when the manager is replaced (e.g. on a hard reload / future hot-swap).
   *
   * Idempotent: a second call is a no-op.
   *
   * @returns {void}
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._queue.length = 0;
  }

  /**
   * Generate the next monotonic id. Strictly private; never exported.
   *
   * @returns {string} a short id like "n1", "n2", ...
   */
  _nextId() {
    this._idCounter += 1;
    return `${ID_PREFIX}${this._idCounter}`;
  }

  /**
   * Validate a type against the configured whitelist. Rejects prototype-alias
   * values defensively and warns on every rejection — keeping the queue's
   * `type` column a known-good subset of the configured catalog.
   *
   * @param {string} type — type id to check.
   * @returns {boolean} true when type is in the whitelist.
   */
  _isValidType(type) {
    if (typeof type !== 'string' || type === '' || UNSAFE_KEYS.has(type)) {
      console.warn(
        `NotificationManager.add: invalid type "${String(type)}" — ignoring add.`
      );
      return false;
    }
    if (!this._types.includes(type)) {
      console.warn(
        `NotificationManager.add: unknown type "${type}" (not in the configured whitelist) — ignoring add.`
      );
      return false;
    }
    return true;
  }

  /**
   * Emit the 'notification:changed' event with the current queue snapshot.
   *
   * @returns {void}
   */
  _emitChanged() {
    this._eventBus.emit('notification:changed', { queue: this.queue });
  }
}

/**
 * Read the configured queue cap. A missing or invalid value falls back to the
 * shipped default; a missing block is silent, a present-but-invalid value
 * warns once.
 *
 * @param {object} notifications — raw config.notifications block.
 * @returns {number} a positive integer (always >= 1).
 */
function _readMaxQueueSize(notifications) {
  const raw = notifications && notifications.maxQueueSize;
  if (raw === undefined) return DEFAULT_MAX_QUEUE_SIZE;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  console.warn(
    `NotificationManager: invalid "maxQueueSize" (${String(raw)}) — using default ${DEFAULT_MAX_QUEUE_SIZE}.`
  );
  return DEFAULT_MAX_QUEUE_SIZE;
}

/**
 * Read the configured type whitelist. A missing block or array falls back to
 * the shipped default; an invalid non-array warns; an empty array is
 * rejected (a whitelist with no entries means nothing can ever be enqueued,
 * which is not the intent — the player would never see anything).
 *
 * @param {object} notifications — raw config.notifications block.
 * @returns {string[]} a defensive shallow copy of the resolved whitelist.
 */
function _readTypes(notifications) {
  const raw = notifications && notifications.types;
  if (raw === undefined) return DEFAULT_TYPES.slice();
  if (!Array.isArray(raw)) {
    console.warn(
      'NotificationManager: invalid "types" (not an array) — using the shipped default.'
    );
    return DEFAULT_TYPES.slice();
  }
  const cleaned = [];
  const seen = new Set();
  for (const entry of raw) {
    if (
      typeof entry !== 'string' ||
      entry === '' ||
      UNSAFE_KEYS.has(entry) ||
      seen.has(entry)
    ) {
      console.warn(
        `NotificationManager: skipping invalid/duplicate notification type ${JSON.stringify(entry)}.`
      );
      continue;
    }
    seen.add(entry);
    cleaned.push(entry);
  }
  if (cleaned.length === 0) {
    console.warn(
      'NotificationManager: empty "types" whitelist — using the shipped default.'
    );
    return DEFAULT_TYPES.slice();
  }
  return cleaned;
}
