/**
 * tests/data/luck.test.mjs — content validation of data/luck/luck.json.
 *
 * Guards the Phase-3 luck ladder (ROADMAP "Destiny & Luck") against data
 * drift: the collection must be the canonical 7-tier DESIGN.md progression
 * (Jinxed → Fortune's Darling) in exact worst→best order, ids must be unique,
 * kebab-case and exactly the 7 canonical ids, each multiplier must be finite
 * and positive and non-decreasing across the ladder, every name must be a
 * non-empty string, and every description must be a non-empty string. The
 * manifest's luck entry must declare the exact requiredFields list, so a luck
 * missing any contract field fails here instead of silently degrading at
 * runtime.
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
const rawLuck = JSON.parse(
  readFileSync(new URL('../../data/luck/luck.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every luck entry (the file uses the definitions shape). */
const entries = rawLuck.definitions;

/**
 * The canonical 7-tier luck ladder from DESIGN.md "Luck", worst → best, in
 * exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['jinxed', 'Jinxed'],
  ['unlucky', 'Unlucky'],
  ['average', 'Average'],
  ['lucky', 'Lucky'],
  ['fortunate', 'Fortunate'],
  ['heaven-blessed', 'Heaven-Blessed'],
  ['fortunes-darling', "Fortune's Darling"],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/luck/luck.json': rawLuck,
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
    'data/luck/luck.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    7,
    `the ladder must contain exactly 7 lucks (the DESIGN.md 7-tier progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 7 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((luck) => luck.id),
    CANONICAL_LADDER.map(([id]) => id),
    'luck ids must follow the canonical DESIGN.md ladder order exactly (jinxed … fortunes-darling)'
  );
  const ids = new Set();
  for (const luck of entries) {
    assert.ok(
      KEBAB_CASE.test(luck.id),
      `luck id "${luck.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(luck.id), `luck ids must be unique (duplicate "${luck.id}")`);
    ids.add(luck.id);
  }
  assert.equal(ids.size, 7, 'exactly 7 distinct luck ids');
  assert.equal(entries[0].id, 'jinxed', 'the first entry must be Jinxed');
  assert.equal(entries[entries.length - 1].id, 'fortunes-darling', 'the last entry must be Fortune\'s Darling');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((luck) => luck.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'luck names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('craftingMultiplier and dropMultiplier are finite, positive and non-decreasing across the ladder', () => {
  for (const luck of entries) {
    assert.ok(
      Number.isFinite(luck.craftingMultiplier) && luck.craftingMultiplier > 0,
      `luck "${luck.id}" craftingMultiplier must be a finite number > 0 (got ${String(luck.craftingMultiplier)})`
    );
    assert.ok(
      Number.isFinite(luck.dropMultiplier) && luck.dropMultiplier > 0,
      `luck "${luck.id}" dropMultiplier must be a finite number > 0 (got ${String(luck.dropMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.craftingMultiplier >= previous.craftingMultiplier,
      `craftingMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.craftingMultiplier}) -> "${current.id}" (${current.craftingMultiplier})`
    );
    assert.ok(
      current.dropMultiplier >= previous.dropMultiplier,
      `dropMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.dropMultiplier}) -> "${current.id}" (${current.dropMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const luck of entries) {
    assert.equal(typeof luck.name, 'string', `luck "${luck.id}" missing name`);
    assert.ok(luck.name !== '', `luck "${luck.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const luck of entries) {
    assert.equal(typeof luck.description, 'string', `luck "${luck.id}" missing description`);
    assert.ok(luck.description !== '', `luck "${luck.id}" description must not be empty`);
  }
});

test('the manifest registers the luck collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('luck'),
    'manifest must register a "luck" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'luck');
  assert.deepEqual(entry.files, ['data/luck/luck.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'craftingMultiplier',
    'dropMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the luck collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('luck');

  assert.deepEqual(result.errors, [], 'luck collection must load without validation errors');
  assert.equal(result.count, 7);
  assert.equal(dataManager.count('luck'), 7);
  assert.ok(dataManager.isLoaded('luck'), 'luck collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('luck'),
    entries.map((luck) => luck.id)
  );
});

test('cached luck definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('luck');

  const cached = dataManager.getAll('luck');
  assert.equal(cached.length, 7);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached luck "${definition.id}" must be frozen`);
  }
});
