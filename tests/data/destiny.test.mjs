/**
 * tests/data/destiny.test.mjs — content validation of data/destiny/destiny.json.
 *
 * Guards the Phase-3 destiny ladder (ROADMAP "Destiny & Luck") against data
 * drift: the collection must be the canonical 7-tier DESIGN.md progression
 * (Doomed → Son of Heaven) in exact worst→best order, ids must be unique,
 * kebab-case and exactly the 7 canonical ids, each multiplier must be finite
 * and positive and non-decreasing across the ladder, every name must be a
 * non-empty string, and every description must be a non-empty string. The
 * manifest's destiny entry must declare the exact requiredFields list, so a
 * destiny missing any contract field fails here instead of silently degrading
 * at runtime.
 *
 * The REAL files are read relative to this module (import.meta.url), never
 * via an absolute path, so the test is portable: it works identically no
 * matter which machine or directory the repo is checked out into. The
 * collection is then loaded through the REAL DataManager pipeline (manifest
 * → fetch → validation → deep-freeze cache) with global fetch stubbed to
 * serve exactly the on-disk contents — so a malformed entry or a broken
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
const rawDestiny = JSON.parse(
  readFileSync(new URL('../../data/destiny/destiny.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every destiny entry (the file uses the definitions shape). */
const entries = rawDestiny.definitions;

/**
 * The canonical 7-tier destiny ladder from DESIGN.md "Destiny", worst → best,
 * in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['doomed', 'Doomed'],
  ['ill-fated', 'Ill-Fated'],
  ['mundane', 'Mundane'],
  ['favored', 'Favored'],
  ['blessed', 'Blessed'],
  ['heavenly-favored', 'Heavenly-Favored'],
  ['son-of-heaven', 'Son of Heaven'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/destiny/destiny.json': rawDestiny,
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

test('the file loads as a non-empty array with exactly 7 entries', () => {
  assert.ok(
    Array.isArray(entries),
    'data/destiny/destiny.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    7,
    `the ladder must contain exactly 7 destinies (the DESIGN.md 7-tier progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 7 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((destiny) => destiny.id),
    CANONICAL_LADDER.map(([id]) => id),
    'destiny ids must follow the canonical DESIGN.md ladder order exactly (doomed … son-of-heaven)'
  );
  const ids = new Set();
  for (const destiny of entries) {
    assert.ok(
      KEBAB_CASE.test(destiny.id),
      `destiny id "${destiny.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(destiny.id), `destiny ids must be unique (duplicate "${destiny.id}")`);
    ids.add(destiny.id);
  }
  assert.equal(ids.size, 7, 'exactly 7 distinct destiny ids');
  assert.equal(entries[0].id, 'doomed', 'the first entry must be Doomed');
  assert.equal(entries[entries.length - 1].id, 'son-of-heaven', 'the last entry must be Son of Heaven');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((destiny) => destiny.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'destiny names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('fortuneMultiplier and calamityMultiplier are finite, positive and non-decreasing across the ladder', () => {
  for (const destiny of entries) {
    assert.ok(
      Number.isFinite(destiny.fortuneMultiplier) && destiny.fortuneMultiplier > 0,
      `destiny "${destiny.id}" fortuneMultiplier must be a finite number > 0 (got ${String(destiny.fortuneMultiplier)})`
    );
    assert.ok(
      Number.isFinite(destiny.calamityMultiplier) && destiny.calamityMultiplier > 0,
      `destiny "${destiny.id}" calamityMultiplier must be a finite number > 0 (got ${String(destiny.calamityMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.fortuneMultiplier >= previous.fortuneMultiplier,
      `fortuneMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.fortuneMultiplier}) -> "${current.id}" (${current.fortuneMultiplier})`
    );
    assert.ok(
      current.calamityMultiplier >= previous.calamityMultiplier,
      `calamityMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.calamityMultiplier}) -> "${current.id}" (${current.calamityMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const destiny of entries) {
    assert.equal(typeof destiny.name, 'string', `destiny "${destiny.id}" missing name`);
    assert.ok(destiny.name !== '', `destiny "${destiny.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const destiny of entries) {
    assert.equal(typeof destiny.description, 'string', `destiny "${destiny.id}" missing description`);
    assert.ok(destiny.description !== '', `destiny "${destiny.id}" description must not be empty`);
  }
});

test('the manifest registers the destiny collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('destiny'),
    'manifest must register a "destiny" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'destiny');
  assert.deepEqual(entry.files, ['data/destiny/destiny.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'fortuneMultiplier',
    'calamityMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the destiny collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('destiny');

  assert.deepEqual(result.errors, [], 'destiny collection must load without validation errors');
  assert.equal(result.count, 7);
  assert.equal(dataManager.count('destiny'), 7);
  assert.ok(dataManager.isLoaded('destiny'), 'destiny collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('destiny'),
    entries.map((destiny) => destiny.id)
  );
});

test('cached destiny definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('destiny');

  const cached = dataManager.getAll('destiny');
  assert.equal(cached.length, 7);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached destiny "${definition.id}" must be frozen`);
  }
});
