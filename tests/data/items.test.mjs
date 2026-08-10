/**
 * tests/data/items.test.mjs — content validation of data/items/items.json.
 *
 * Guards the starter item catalog (ROADMAP Phase 2 — Inventory (basic))
 * against data drift: every item must carry the data-driven contract from
 * DESIGN.md "Items & Economy" (id, name, description, grade, quality, value,
 * tags, stackSize, icon, optional category), ids must be unique and the
 * catalog must span at least two categories so the InventorySystem's
 * filtering is exercised. Grade must come from the 11-tier scale
 * (Mortal..Chaos) and quality from the 7-tier scale (Broken..Legendary).
 *
 * The REAL files are read relative to this module (import.meta.url), never
 * via an absolute path, so the test is portable: it works identically no
 * matter which machine or directory the repo is checked out into. The
 * collection is then loaded through the REAL DataManager pipeline (manifest
 * → fetch → validation → deep-freeze cache) with global fetch stubbed to
 * serve exactly the on-disk contents — so a malformed item or a broken
 * manifest reference fails here instead of surfacing at runtime.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DataManager } from '../../js/core/data-manager.js';

/**
 * Load the real content files relative to this test file. `new URL(...,
 * import.meta.url)` resolves against the module's own location, so the paths
 * work on any machine.
 */
const rawItems = JSON.parse(
  readFileSync(new URL('../../data/items/items.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every item definition in the catalog (the file uses the definitions shape). */
const items = rawItems.definitions;

/**
 * The 11-grade item scale from DESIGN.md "Items & Economy" (Grades).
 * Any grade a content author writes must be one of these.
 */
const GRADES = new Set([
  'Mortal',
  'Common',
  'Earth',
  'Heaven',
  'Spirit',
  'King',
  'Saint',
  'Immortal',
  'Celestial',
  'Divine',
  'Chaos',
]);

/**
 * The 7-quality item scale from DESIGN.md "Items & Economy" (Quality).
 * Any quality a content author writes must be one of these.
 */
const QUALITIES = new Set([
  'Broken',
  'Poor',
  'Normal',
  'Fine',
  'Excellent',
  'Perfect',
  'Legendary',
]);

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/items/items.json': rawItems,
};

/**
 * Stub for global fetch that serves the real on-disk content files. Matches
 * by URL suffix so both config-style absolute URLs and DataManager-style
 * relative strings resolve to the same keys.
 *
 * @returns {Function} the fetch stub.
 */
function makeFetch() {
  return async (url) => {
    const text = String(url);
    const key = Object.keys(DATA_FILES).find((candidate) => text.endsWith(candidate));
    if (key === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(DATA_FILES[key]) };
  };
}

test('item catalog is a non-empty starter set of at least five items', () => {
  assert.ok(Array.isArray(items), 'data/items/items.json must carry a "definitions" array');
  assert.ok(
    items.length >= 5,
    `starter catalog must contain at least 5 items (got ${items.length})`
  );
});

test('every item carries the full data-driven contract shape', () => {
  for (const item of items) {
    assert.equal(typeof item.id, 'string', `item missing id (${JSON.stringify(item)})`);
    assert.ok(item.id !== '', 'item id must not be empty');
    assert.equal(typeof item.name, 'string', `item "${item.id}" missing name`);
    assert.ok(item.name !== '', `item "${item.id}" name must not be empty`);
    assert.equal(typeof item.description, 'string', `item "${item.id}" missing description`);
    assert.ok(item.description !== '', `item "${item.id}" description must not be empty`);
    assert.equal(typeof item.category, 'string', `item "${item.id}" missing category`);
    assert.ok(item.category !== '', `item "${item.id}" category must not be empty`);
    assert.ok(GRADES.has(item.grade), `item "${item.id}" has unknown grade "${item.grade}"`);
    assert.ok(
      QUALITIES.has(item.quality),
      `item "${item.id}" has unknown quality "${item.quality}"`
    );
    assert.ok(
      Number.isFinite(item.value) && item.value >= 0,
      `item "${item.id}" value must be a non-negative finite number`
    );
    assert.ok(
      Number.isInteger(item.stackSize) && item.stackSize >= 1,
      `item "${item.id}" stackSize must be a positive integer (>= 1)`
    );
    assert.ok(Array.isArray(item.tags), `item "${item.id}" tags must be an array`);
    assert.ok(item.tags.length > 0, `item "${item.id}" tags must not be empty`);
    for (const tag of item.tags) {
      assert.equal(typeof tag, 'string', `item "${item.id}" tag must be a string`);
      assert.ok(tag !== '', `item "${item.id}" tag must not be empty`);
    }
    assert.equal(typeof item.icon, 'string', `item "${item.id}" icon must be a string`);
  }
});

test('every item id is unique', () => {
  const ids = new Set();
  for (const item of items) {
    assert.ok(!ids.has(item.id), `item ids must be unique (duplicate "${item.id}")`);
    ids.add(item.id);
  }
});

test('the catalog spans at least two categories', () => {
  const categories = new Set(items.map((item) => item.category));
  assert.ok(
    categories.size >= 2,
    `catalog must span at least 2 categories to exercise inventory filtering (got ${categories.size})`
  );
});

test('the manifest registers the items collection and keeps the realms entry', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('items'),
    'manifest must register an "items" collection'
  );
  assert.ok(
    collectionIds.includes('realms'),
    'manifest must keep the pre-existing "realms" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'items');
  assert.deepEqual(entry.files, ['data/items/items.json']);
  assert.deepEqual(entry.validation.requiredFields, ['id', 'name', 'stackSize']);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the items collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('items');

  assert.deepEqual(result.errors, [], 'items collection must load without validation errors');
  assert.equal(result.count, items.length);
  assert.equal(dataManager.count('items'), items.length);
  assert.ok(dataManager.isLoaded('items'), 'items collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw definitions.
  assert.deepEqual(dataManager.keys('items'), items.map((item) => item.id));
});

test('cached item definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('items');

  const cached = dataManager.getAll('items');
  assert.equal(cached.length, items.length);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached item "${definition.id}" must be frozen`);
    assert.ok(
      Object.isFrozen(definition.tags),
      `cached item "${definition.id}" tags array must be frozen`
    );
  }
});
