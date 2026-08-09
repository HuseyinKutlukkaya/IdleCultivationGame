/**
 * managers/save-manager.js — save / load / autosave / export / import.
 *
 * The persistence service for the game. Wraps the low-level Storage adapter
 * (js/core/storage.js) with a versioned save envelope so old saves keep
 * working as the game evolves:
 *
 *   {
 *     schema:          "idle-cultivation-game/save",
 *     saveVersion:     <number>  envelope schema version,
 *     engineVersion:   <string>  game version that wrote the save,
 *     contentVersion:  <number>  content-data version (manifest version),
 *     migrationVersion:<number>  migration code version,
 *     savedAt:         <number>  epoch ms,
 *     state:           <object>  serialized game state (Game.serialize())
 *   }
 *
 * Responsibilities:
 *   - save()       build an envelope from Game.serialize() and persist it
 *   - load()       read, validate and migrate a save, then restore state
 *   - start()/stop() manage autosave (interval + beforeunload) listeners
 *   - exportSave() produce a portable JSON string of the current save
 *   - importSave() parse, validate, migrate and restore an exported string
 *   - clear()      wipe any stored save
 *
 * Migration: the MIGRATIONS table maps an old saveVersion to a function that
 * upgrades a save to the next version. load()/importSave() run every step in
 * order, then stamp the envelope with the current saveVersion and
 * migrationVersion. When no migration path exists, the save is rejected with
 * a warning instead of being partially restored.
 *
 * Pure manager — no DOM access, no gameplay logic, framework-free and GitHub
 * Pages compatible. Event contract: emits 'game:saved' after each successful
 * persist and 'game:restored' after a successful restore (load or import).
 * Tuning (autosave interval, save-on-unload) lives in data/game-config.json,
 * never in code.
 */

import { EventBus } from '../core/event-bus.js';
import { Storage } from '../core/storage.js';

/** Envelope schema identifier; distinguishes game saves from arbitrary JSON. */
export const SAVE_SCHEMA = 'idle-cultivation-game/save';
/** Current save envelope schema version. Bump only when the envelope shape changes. */
const SAVE_VERSION = 1;
/** Current migration code version. Bump whenever a migration is added or changed. */
const MIGRATION_VERSION = 1;

/**
 * Migration table. Keys are the saveVersion a save currently has; each value
 * upgrades that save to saveVersion + 1. Version 1 is the first real schema,
 * so no steps exist yet — add one before bumping SAVE_VERSION.
 *
 * @type {Object<number, (save: object) => object>}
 */
const MIGRATIONS = {
  // 1: (save) => ({ ...save, state: transform(save.state) }),
};

/**
 * @param {object} [options]
 * @param {object} [options.storage] — low-level storage adapter (default Storage).
 * @param {object} [options.eventBus] — pub/sub bus (default EventBus).
 * @param {() => object} [options.serialize] — returns a serializable snapshot
 *        of game state (default Game.serialize). The returned object is
 *        stored as `state` on every save.
 * @param {(state: object) => void} [options.restore] — applies a deserialized
 *        state snapshot (default Game.restore). Called after load/import.
 * @param {string} [options.engineVersion] — game version stamped on saves
 *        (from config meta.version).
 * @param {number} [options.contentVersion] — content-data version stamped on
 *        saves (from the DataManager manifest version).
 * @param {number} [options.autosaveIntervalMs] — autosave period in ms;
 *        0 or undefined disables the interval (config save.autosaveIntervalMs).
 * @param {boolean} [options.saveOnUnload] — persist on beforeunload
 *        (config save.saveOnUnload; default true).
 */
export class SaveManager {
  constructor(options = {}) {
    /** @type {object} low-level persistence adapter. */
    this._storage = options.storage || Storage;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {() => object} serialization callback. */
    this._serialize = typeof options.serialize === 'function' ? options.serialize : null;
    /** @type {(state: object) => void} restoration callback. */
    this._restore = typeof options.restore === 'function' ? options.restore : null;

    /** @type {string} engine version stamped on every save. */
    this._engineVersion = options.engineVersion || '0.0.0';
    /** @type {number} content-data version stamped on every save. */
    this._contentVersion = _nonNegativeInteger(options.contentVersion, 0, 'contentVersion');

    /** @type {number} autosave period in ms (0 disables). */
    this._autosaveIntervalMs = _nonNegativeNumber(
      options.autosaveIntervalMs,
      0,
      'autosaveIntervalMs'
    );
    /** @type {boolean} whether to save on beforeunload. */
    this._saveOnUnload = options.saveOnUnload !== false;

    /** @type {number|null} active autosave interval handle. */
    this._timer = null;
    /** @type {number} epoch ms of the last successful save. */
    this._lastSavedAt = 0;
    /** @type {boolean} true once start() has run. */
    this._started = false;

    // Bound once so start()/stop() attach and remove the same listener.
    this._handleUnload = this._handleUnload.bind(this);
  }

  /**
   * Begin autosave: start the interval (when enabled) and register the
   * beforeunload handler. Idempotent.
   *
   * @returns {void}
   */
  start() {
    if (this._started) return;
    this._started = true;

    if (this._saveOnUnload) {
      window.addEventListener('beforeunload', this._handleUnload);
    }
    if (this._autosaveIntervalMs > 0) {
      this._timer = window.setInterval(() => this.save(), this._autosaveIntervalMs);
    }
  }

  /**
   * Halt autosave: clear the interval and unregister the unload handler.
   * Idempotent. A final save is NOT issued here — call save() explicitly if
   * one is wanted (e.g. before a manual stop).
   *
   * @returns {void}
   */
  stop() {
    if (!this._started) return;
    this._started = false;

    if (this._saveOnUnload) {
      window.removeEventListener('beforeunload', this._handleUnload);
    }
    if (this._timer !== null) {
      window.clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Serialize the current game state and persist it as a versioned envelope.
   *
   * @returns {boolean} true when the save was written successfully.
   */
  save() {
    const envelope = this._buildEnvelope();
    const ok = this._storage.save(envelope);
    if (ok) {
      this._lastSavedAt = envelope.savedAt;
      this._eventBus.emit('game:saved', { savedAt: envelope.savedAt });
    }
    return ok;
  }

  /**
   * Load a stored save, migrate it and restore the game state. No-op (with a
   * console warning) when the stored value is missing, invalid or has no
   * migration path.
   *
   * @returns {boolean} true when a save was restored.
   */
  load() {
    const envelope = this._parseEnvelope(this._storage.load());
    if (!envelope) return false;

    const migrated = this._migrate(envelope);
    if (!migrated) return false;

    if (this._restore) {
      this._restore(migrated.state);
      this._lastSavedAt = migrated.savedAt || 0;
      this._eventBus.emit('game:restored', { savedAt: this._lastSavedAt });
    }
    return true;
  }

  /**
   * Build a portable JSON string of the current save (for manual backup).
   *
   * @returns {string} the serialized envelope.
   */
  exportSave() {
    return JSON.stringify(this._buildEnvelope());
  }

  /**
   * Parse, migrate and restore a save string produced by exportSave(). The
   * restored save is persisted so it becomes the active save.
   *
   * @param {string} saveString — the exported save JSON.
   * @returns {boolean} true when the import was applied.
   */
  importSave(saveString) {
    if (typeof saveString !== 'string' || saveString === '') {
      console.warn('SaveManager: import failed — no save string provided.');
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(saveString);
    } catch (error) {
      console.warn('SaveManager: import failed — invalid JSON.', error);
      return false;
    }

    // Parsing and the envelope check both live under try/catch so a
    // pathologically-nested payload that passes JSON.parse but overflows the
    // recursive validation walk becomes a logged warning, not an uncaught
    // exception (it only aborts this one import).
    try {
      const envelope = this._parseEnvelope(parsed);
      if (!envelope) return false;

      const migrated = this._migrate(envelope);
      if (!migrated) return false;

      const ok = this._storage.save(migrated);
      if (ok) {
        if (this._restore) this._restore(migrated.state);
        this._lastSavedAt = migrated.savedAt || 0;
        this._eventBus.emit('game:restored', { savedAt: this._lastSavedAt });
        this._eventBus.emit('game:saved', { savedAt: this._lastSavedAt });
      }
      return ok;
    } catch (error) {
      console.warn('SaveManager: import failed — unreadable save.', error);
      return false;
    }
  }

  /**
   * Delete any stored save.
   *
   * @returns {void}
   */
  clear() {
    this._storage.clear();
    this._lastSavedAt = 0;
  }

  /**
   * @returns {number} epoch ms of the last successful save (0 when never).
   */
  get lastSavedAt() {
    return this._lastSavedAt;
  }

  /**
   * @returns {boolean} true while autosave listeners are active.
   */
  get isActive() {
    return this._started;
  }

  /**
   * beforeunload handler (bound). Persists immediately — localStorage is
   * synchronous, so the write completes before the page is torn down.
   *
   * @returns {void}
   */
  _handleUnload() {
    this.save();
  }

  /**
   * Build a fresh save envelope around the current serialized state.
   *
   * @returns {object} the versioned envelope.
   */
  _buildEnvelope() {
    const state = this._serialize ? this._serialize() : {};
    return {
      schema: SAVE_SCHEMA,
      saveVersion: SAVE_VERSION,
      engineVersion: this._engineVersion,
      contentVersion: this._contentVersion,
      migrationVersion: MIGRATION_VERSION,
      savedAt: Date.now(),
      state,
    };
  }

  /**
   * Validate that a value is a recognizable save envelope. Anything that is
   * not an object carrying the schema marker and a saveVersion is rejected.
   * As defense-in-depth against prototype pollution, envelopes whose state
   * carries prototype-alias keys (`__proto__`, `constructor`, `prototype`)
   * are rejected here so a poisoned envelope never reaches storage — even
   * though deepMerge also skips those keys when restoring.
   *
   * Note: a null raw value (no save present) returns null silently — a fresh
   * boot is not an error, and callers decide whether to surface it.
   *
   * @param {*} raw — value read from storage or parsed from an import.
   * @returns {object|null} the envelope, or null when invalid.
   */
  _parseEnvelope(raw) {
    if (raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn('SaveManager: stored value is not an object — ignoring it.');
      return null;
    }
    if (raw.schema !== SAVE_SCHEMA) {
      console.warn('SaveManager: stored value has no game-save schema — ignoring it.');
      return null;
    }
    if (typeof raw.saveVersion !== 'number') {
      console.warn('SaveManager: save has no saveVersion — ignoring it.');
      return null;
    }
    if (raw.state === null || typeof raw.state !== 'object' || Array.isArray(raw.state)) {
      console.warn('SaveManager: save has no valid state object — ignoring it.');
      return null;
    }
    if (_hasUnsafeStateKey(raw.state)) {
      console.warn('SaveManager: save state carries unsafe keys — ignoring it.');
      return null;
    }
    return raw;
  }

  /**
   * Run every registered migration step in order and stamp the envelope with
   * the current versions. Saves from a newer version than this build are
   * rejected with a warning (a newer save must not be relabeled as current),
   * and returns null when no migration path exists from the save's version.
   *
   * @param {object} envelope — validated save envelope.
   * @returns {object|null} the migrated envelope, or null on failure.
   */
  _migrate(envelope) {
    let current = envelope;
    let version = current.saveVersion;

    if (version > SAVE_VERSION) {
      console.warn(
        `SaveManager: save from newer version ${version} (build supports ${SAVE_VERSION}) — ignoring save.`
      );
      return null;
    }

    while (version < SAVE_VERSION) {
      const step = MIGRATIONS[version];
      if (typeof step !== 'function') {
        console.warn(
          `SaveManager: no migration path from save version ${version} — ignoring save.`
        );
        return null;
      }
      current = step(current);
      version += 1;
    }

    current.saveVersion = SAVE_VERSION;
    current.migrationVersion = MIGRATION_VERSION;
    return current;
  }
}

/**
 * Recursively check whether a state subtree carries a prototype-alias key
 * (`__proto__`, `constructor`, `prototype`). JSON.parse materializes
 * `"__proto__"` as an own data key, so such a key in a save must reject the
 * envelope before it can reach deepMerge or storage (defense in depth).
 *
 * @param {*} value — value to inspect (typically the save's state subtree).
 * @returns {boolean} true when any own key is prototype-alias.
 */
function _hasUnsafeStateKey(value) {
  if (value === null || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (_hasUnsafeStateKey(value[key])) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce a tuning option to a non-negative finite number, falling back to a
 * default when missing or invalid.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _nonNegativeNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  if (value !== undefined) {
    console.warn(`SaveManager: invalid ${name} (${String(value)}) — using default ${fallback}.`);
  }
  return fallback;
}

/**
 * Coerce a tuning option to a non-negative integer, falling back to a
 * default when missing or invalid.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _nonNegativeInteger(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0 && Number.isInteger(parsed)) return parsed;
  if (value !== undefined) {
    console.warn(`SaveManager: invalid ${name} (${String(value)}) — using default ${fallback}.`);
  }
  return fallback;
}
