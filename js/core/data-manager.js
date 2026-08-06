/**
 * core/data-manager.js — loads, validates and caches content definitions.
 *
 * The general-purpose DEFINITIONS loader for the game (realms, techniques,
 * pills, sects, events, ...). It coexists with core/config.js: config.js
 * loads the single tuning file (data/game-config.json), while DataManager
 * loads every content collection registered in data/manifest.json. Content
 * files are authored by designers and are never hardcoded in code (data
 * driven rule).
 *
 * Manifest contract (data/manifest.json):
 *   {
 *     "version": <number>,
 *     "meta": { ... },
 *     "collections": [
 *       {
 *         "id": "realms",
 *         "files": ["data/realms/realms.json"],
 *         "validation": { "requiredFields": ["id", "name"], "uniqueField": "id" }
 *       }
 *     ]
 *   }
 *
 * Each collection file may contain EITHER:
 *   - a plain array of definition objects,
 *   - an object like { "meta": {...}, "definitions": [ ... ] }, or
 *   - a single definition object carrying the unique field (default "id").
 *
 * Every cached definition is deep-frozen so consumers only ever get
 * read-only data. Fail-soft by design: a broken or missing content file
 * degrades to console warnings and never aborts the load — a bad file
 * should not brick the game.
 *
 * Pure infrastructure — no DOM access, no storage I/O, no gameplay logic,
 * framework-free and GitHub Pages compatible (static, relative fetch paths).
 *
 * Future plug-in: per-system lazy loading, cross-collection reference
 * resolution, content schema versioning and migration.
 */

import { EventBus } from './event-bus.js';

export class DataManager {
  /**
   * @param {object} [options] — constructor options.
   * @param {string} [options.manifestPath] — relative path to the manifest
   *        file (default "data/manifest.json").
   * @param {object} [options.eventBus] — pub/sub bus used for lifecycle
   *        events; defaults to the shared EventBus singleton.
   */
  constructor(options = {}) {
    /** @type {string} relative path to the manifest file. */
    this._manifestPath = options.manifestPath || 'data/manifest.json';
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;

    /** @type {object|null} cached manifest (sanitized collections array). */
    this._manifest = null;

    /**
     * Cache of loaded definitions per collection.
     * @type {Map<string, { defs: Map<string, object>, order: string[] }>}
     */
    this._collections = new Map();

    /** @type {Map<string, 'loading'|'loaded'|'error'>} per-collection status. */
    this._status = new Map();

    /** @type {Map<string, string[]>} last load errors per collection. */
    this._lastErrors = new Map();

    /** @type {Map<string, Promise>} in-flight collection loads (dedupe). */
    this._inFlight = new Map();
  }

  /**
   * Load the manifest (if not cached) and every registered collection.
   * Emits 'game:loaded' on the event bus once all collections have been
   * processed, with a minimal payload of per-collection counts.
   *
   * @returns {Promise<{ collections: Object<string, number> }>} summary of
   *          loaded definition counts keyed by collection id.
   */
  async loadAll() {
    if (!this._manifest) {
      await this.loadManifest();
    }

    const summary = { collections: {} };
    if (this._manifest) {
      for (const entry of this._manifest.collections) {
        const result = await this.loadCollection(entry.id);
        summary.collections[entry.id] = result.count;
      }
    }

    this._eventBus.emit('game:loaded', { collections: summary.collections });
    return summary;
  }

  /**
   * Fetch and parse the manifest, validating its structure. Entries with a
   * missing/empty id or a missing/non-string file list are skipped with a
   * warning; duplicate ids keep the first occurrence and warn. The sanitized
   * manifest is cached for subsequent calls.
   *
   * @returns {Promise<object|null>} the cached manifest, or null when it
   *          could not be fetched or did not contain a valid "collections"
   *          array.
   */
  async loadManifest() {
    const content = await _fetchJson(this._manifestPath);
    if (content === null) {
      this._manifest = null;
      return null;
    }

    if (!Array.isArray(content.collections)) {
      console.warn(
        `DataManager: manifest "${this._manifestPath}" has no "collections" array — ignoring manifest.`
      );
      this._manifest = null;
      return null;
    }

    const seen = new Set();
    const collections = [];

    for (const entry of content.collections) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        console.warn('DataManager: skipping manifest entry that is not an object.');
        continue;
      }
      if (typeof entry.id !== 'string' || entry.id === '') {
        console.warn('DataManager: skipping manifest entry with a missing or empty "id".');
        continue;
      }
      const filesValid =
        Array.isArray(entry.files) &&
        entry.files.length > 0 &&
        entry.files.every((file) => typeof file === 'string' && file !== '');
      if (!filesValid) {
        console.warn(
          `DataManager: skipping collection "${entry.id}" — "files" must be a non-empty array of non-empty strings.`
        );
        continue;
      }
      if (seen.has(entry.id)) {
        console.warn(
          `DataManager: duplicate collection id "${entry.id}" — keeping the first entry, ignoring this one.`
        );
        continue;
      }
      seen.add(entry.id);
      collections.push(entry);
    }

    this._manifest = { ...content, collections };
    return this._manifest;
  }

  /**
   * Fetch every file registered for a collection, extract + validate the
   * definitions and merge the valid ones into the cache. Idempotent: a
   * collection whose status is already "loaded" or "error" is not re-fetched.
   *
   * @param {string} collectionId — collection id as listed in the manifest.
   * @returns {Promise<{ collectionId: string, count: number, errors: string[] }>}
   *          summary: the collection id, the number of cached definitions and
   *          any per-file errors (path-prefixed).
   */
  async loadCollection(collectionId) {
    if (typeof collectionId !== 'string' || collectionId === '') {
      return { collectionId, count: 0, errors: ['collection id must be a non-empty string.'] };
    }

    if (!this._manifest) {
      await this.loadManifest();
    }

    const status = this._status.get(collectionId);
    if (status === 'loaded' || status === 'error') {
      return {
        collectionId,
        count: this.count(collectionId),
        errors: this._lastErrors.get(collectionId) || [],
      };
    }
    const pending = this._inFlight.get(collectionId);
    if (pending) {
      return pending;
    }

    const entry = this._manifest
      ? this._manifest.collections.find((candidate) => candidate.id === collectionId)
      : undefined;
    if (!entry) {
      const message = `Unknown collection "${collectionId}" — not listed in the manifest.`;
      console.warn(`DataManager: ${message}`);
      this._status.set(collectionId, 'error');
      this._lastErrors.set(collectionId, [message]);
      return { collectionId, count: 0, errors: [message] };
    }

    const task = this._loadCollectionFiles(entry);
    this._inFlight.set(collectionId, task);
    try {
      return await task;
    } finally {
      this._inFlight.delete(collectionId);
    }
  }

  /**
   * Load and cache a single collection. Private — call loadCollection instead.
   *
   * @param {object} entry — sanitized manifest entry for the collection.
   * @returns {Promise<{ collectionId: string, count: number, errors: string[] }>}
   */
  async _loadCollectionFiles(entry) {
    const collectionId = entry.id;
    const rules = _resolveValidationRules(entry.validation);
    const cache = this._ensureCollectionCache(collectionId);
    const errors = [];

    this._status.set(collectionId, 'loading');

    for (const path of entry.files) {
      const content = await _fetchJson(path);
      if (content === null) {
        errors.push(`${path}: failed to fetch or parse.`);
        continue;
      }

      let definitions;
      try {
        definitions = _extractDefinitions(content, rules);
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
        continue;
      }

      const { valid, errors: validationErrors } = _validateDefinitions(
        collectionId,
        definitions,
        rules
      );
      for (const error of validationErrors) {
        errors.push(`${path}: ${error}`);
      }

      for (const definition of valid) {
        const key = definition[rules.uniqueField];
        if (cache.defs.has(key)) {
          errors.push(
            `${path}: duplicate unique field '${key}' across files — keeping the first occurrence.`
          );
          continue;
        }
        cache.defs.set(key, _deepFreeze(definition));
        cache.order.push(key);
      }
    }

    for (const error of errors) {
      console.warn(`DataManager: ${error}`);
    }

    if (cache.order.length === 0) {
      console.warn(
        `DataManager: collection "${collectionId}" ended with zero valid definitions.`
      );
      this._status.set(collectionId, 'error');
    } else {
      this._status.set(collectionId, 'loaded');
    }

    this._lastErrors.set(collectionId, errors);

    return { collectionId, count: cache.defs.size, errors };
  }

  /**
   * Get a single cached definition.
   *
   * @param {string} collectionId — collection id.
   * @param {string} id — unique-field value of the definition.
   * @returns {object|undefined} the deep-frozen definition, or undefined.
   */
  get(collectionId, id) {
    const cache = this._collections.get(collectionId);
    return cache ? cache.defs.get(id) : undefined;
  }

  /**
   * Get every cached definition for a collection, in file order.
   *
   * @param {string} collectionId — collection id.
   * @returns {object[]} fresh array of deep-frozen definitions (empty when
   *          the collection is unknown or has not been loaded).
   */
  getAll(collectionId) {
    const cache = this._collections.get(collectionId);
    return cache ? cache.order.map((id) => cache.defs.get(id)) : [];
  }

  /**
   * @param {string} collectionId — collection id.
   * @param {string} id — unique-field value of the definition.
   * @returns {boolean} true when the definition is cached.
   */
  has(collectionId, id) {
    const cache = this._collections.get(collectionId);
    return Boolean(cache && cache.defs.has(id));
  }

  /**
   * @param {string} collectionId — collection id.
   * @returns {string[]} fresh array of definition ids, in file order.
   */
  keys(collectionId) {
    const cache = this._collections.get(collectionId);
    return cache ? [...cache.order] : [];
  }

  /**
   * @param {string} collectionId — collection id.
   * @returns {number} number of cached definitions for the collection.
   */
  count(collectionId) {
    const cache = this._collections.get(collectionId);
    return cache ? cache.defs.size : 0;
  }

  /**
   * @param {string} collectionId — collection id.
   * @returns {boolean} true when the collection finished loading with at
   *          least one valid definition.
   */
  isLoaded(collectionId) {
    return this._status.get(collectionId) === 'loaded';
  }

  /**
   * @returns {object[]} shallow copies of every manifest collection entry
   *          (empty when the manifest has not been loaded).
   */
  getCollections() {
    if (!this._manifest) return [];
    return this._manifest.collections.map(_shallowCopyCollectionEntry);
  }

  /**
   * @param {string} collectionId — collection id.
   * @returns {object|undefined} shallow copy of the manifest collection
   *          entry, or undefined when unknown.
   */
  getCollection(collectionId) {
    if (!this._manifest) return undefined;
    const entry = this._manifest.collections.find((candidate) => candidate.id === collectionId);
    return entry ? _shallowCopyCollectionEntry(entry) : undefined;
  }

  /**
   * @returns {object|null} deep copy of the cached manifest (so callers can
   *          never mutate the internal copy), or null when not yet loaded.
   */
  getManifest() {
    if (!this._manifest) return null;
    return JSON.parse(JSON.stringify(this._manifest));
  }

  /**
   * @returns {number} total number of cached definitions across all
   *          collections.
   */
  totalDefinitions() {
    let total = 0;
    for (const cache of this._collections.values()) {
      total += cache.defs.size;
    }
    return total;
  }

  /**
   * Get (or create) the internal cache bucket for a collection.
   *
   * @param {string} collectionId — collection id.
   * @returns {{ defs: Map<string, object>, order: string[] }}
   *          the collection's cache bucket.
   */
  _ensureCollectionCache(collectionId) {
    let cache = this._collections.get(collectionId);
    if (!cache) {
      cache = { defs: new Map(), order: [] };
      this._collections.set(collectionId, cache);
    }
    return cache;
  }
}

/**
 * Fetch and JSON-parse a file. Fail-soft: any failure is logged and yields
 * null instead of throwing, so loaders can keep going.
 *
 * @param {string} path — relative path to fetch.
 * @returns {Promise<object|null>} parsed JSON, or null on any failure.
 */
async function _fetchJson(path) {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.warn(`DataManager: failed to fetch "${path}":`, error);
    return null;
  }
}

/**
 * Normalize a collection file into an array of definition objects. Supports
 * the three contract shapes: a plain array, an object with a "definitions"
 * array, or a single definition object carrying the unique field.
 *
 * @param {*} fileContent — parsed JSON content of a collection file.
 * @param {object} rules — effective validation rules for the collection
 *        (used to detect the single-definition-object shape via its unique
 *        field).
 * @returns {object[]} extracted definition objects.
 * @throws {Error} when the shape is not recognized.
 */
function _extractDefinitions(fileContent, rules) {
  if (Array.isArray(fileContent)) {
    return fileContent;
  }
  if (fileContent !== null && typeof fileContent === 'object') {
    if (Array.isArray(fileContent.definitions)) {
      return fileContent.definitions;
    }
    if (
      typeof fileContent[rules.uniqueField] === 'string' &&
      fileContent[rules.uniqueField] !== ''
    ) {
      return [fileContent];
    }
  }
  throw new Error(
    `unrecognized file shape: expected an array of definitions, an object with a "definitions" array, or a single definition object carrying the unique field "${rules.uniqueField}".`
  );
}

/**
 * Resolve effective validation rules, defaulting to requiring an "id" that is
 * also the unique field when a collection entry has no validation block.
 *
 * @param {object} [rules] — raw validation block from the manifest entry.
 * @returns {{ requiredFields: string[], uniqueField: string }} effective rules.
 */
function _resolveValidationRules(rules) {
  rules = rules || {};
  const requiredFields = Array.isArray(rules.requiredFields) ? rules.requiredFields : ['id'];
  const uniqueField =
    typeof rules.uniqueField === 'string' && rules.uniqueField !== '' ? rules.uniqueField : 'id';
  return { requiredFields, uniqueField };
}

/**
 * Structural validation of a collection's definitions. Non-objects, missing
 * required fields, empty unique-field values and duplicate unique-field
 * values are reported and skipped (first occurrence wins).
 *
 * @param {string} collectionId — collection id (used in error messages).
 * @param {object[]} definitions — raw definition objects to validate.
 * @param {object} [rules] — validation rules (defaults to required "id").
 * @returns {{ valid: object[], errors: string[] }} valid definitions and
 *          descriptive error strings (callers prepend the file path).
 */
function _validateDefinitions(collectionId, definitions, rules) {
  const { requiredFields, uniqueField } = _resolveValidationRules(rules);
  const valid = [];
  const errors = [];
  const seen = new Map();
  const prefix = `[${collectionId}]`;

  definitions.forEach((definition, index) => {
    const at = `definition #${index}`;

    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      const kind =
        definition === null ? 'null' : Array.isArray(definition) ? 'array' : typeof definition;
      errors.push(`${prefix} ${at} is not a plain object (got ${kind}).`);
      return;
    }

    const missing = requiredFields.filter((field) => definition[field] === undefined);
    if (missing.length > 0) {
      errors.push(
        `${prefix} ${at} missing required field${missing.length > 1 ? 's' : ''} '${missing.join("', '")}'.`
      );
      return;
    }

    const key = definition[uniqueField];
    if (key === undefined || key === null || key === '') {
      errors.push(`${prefix} ${at} has an empty unique field '${uniqueField}'.`);
      return;
    }

    if (seen.has(key)) {
      errors.push(
        `${prefix} ${at} duplicates unique field '${uniqueField}' value '${String(key)}' (first seen at #${seen.get(key)}).`
      );
      return;
    }

    seen.set(key, index);
    valid.push(definition);
  });

  return { valid, errors };
}

/**
 * Recursively freeze a value so cached definitions are read-only at runtime.
 *
 * @param {*} value — value to deep-freeze.
 * @returns {*} the frozen value.
 */
function _deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      _deepFreeze(value[key]);
    }
  }
  return value;
}

/**
 * Defensive shallow copy of a manifest collection entry (the "files" array
 * is copied so callers cannot mutate the internal manifest). The
 * "validation" block is copied as well, including its "requiredFields"
 * array, so callers cannot mutate the internal manifest through it.
 *
 * @param {object} entry — manifest collection entry.
 * @returns {object} shallow copy.
 */
function _shallowCopyCollectionEntry(entry) {
  const copy = { ...entry, files: [...entry.files] };
  if (entry.validation) {
    copy.validation = { ...entry.validation };
    if (Array.isArray(entry.validation.requiredFields)) {
      copy.validation.requiredFields = [...entry.validation.requiredFields];
    }
  }
  return copy;
}
