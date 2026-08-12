/**
 * tests/data/meridians.test.mjs — content validation of
 * data/meridians/meridians.json.
 *
 * Guards the Phase-3 meridian ladder (ROADMAP "Meridians") against data
 * drift: the collection must be the canonical 7-state DESIGN.md progression
 * (Broken → Heavenly) in exact worst→best order, ids must be unique, kebab-case
 * and exactly the 7 canonical ids, capacityMultiplier and flowMultiplier must
 * be finite positive and non-decreasing across the ladder (monotonic), every
 * name must be a non-empty string, and every description must be a non-empty
 * string. The manifest's meridians entry must declare the exact
 * requiredFields list, so a meridian missing any contract field fails here
 * instead of silently degrading at runtime.
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
const rawMeridians = JSON.parse(
  readFileSync(new URL('../../data/meridians/meridians.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every meridian entry (the file uses the definitions shape). */
const entries = rawMeridians.definitions;

/**
 * The canonical 7-state meridian ladder from DESIGN.md "Meridians",
 * worst → best, in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['broken', 'Broken'],
  ['damaged', 'Damaged'],
  ['normal', 'Normal'],
  ['wide', 'Wide'],
  ['perfect', 'Perfect'],
  ['golden', 'Golden'],
  ['heavenly', 'Heavenly'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/meridians/meridians.json': rawMeridians,
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
    'data/meridians/meridians.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    7,
    `the ladder must contain exactly 7 meridians (the DESIGN.md 7-state progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 7 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((meridian) => meridian.id),
    CANONICAL_LADDER.map(([id]) => id),
    'meridian ids must follow the canonical DESIGN.md ladder order exactly (broken … heavenly)'
  );
  const ids = new Set();
  for (const meridian of entries) {
    assert.ok(
      KEBAB_CASE.test(meridian.id),
      `meridian id "${meridian.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(meridian.id), `meridian ids must be unique (duplicate "${meridian.id}")`);
    ids.add(meridian.id);
  }
  assert.equal(ids.size, 7, 'exactly 7 distinct meridian ids');
  assert.equal(entries[0].id, 'broken', 'the first entry must be Broken');
  assert.equal(entries[entries.length - 1].id, 'heavenly', 'the last entry must be Heavenly');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((meridian) => meridian.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'meridian names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('capacityMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const meridian of entries) {
    assert.ok(
      Number.isFinite(meridian.capacityMultiplier) && meridian.capacityMultiplier > 0,
      `meridian "${meridian.id}" capacityMultiplier must be a finite number > 0 (got ${String(meridian.capacityMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.capacityMultiplier >= previous.capacityMultiplier,
      `capacityMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.capacityMultiplier}) -> "${current.id}" (${current.capacityMultiplier})`
    );
  }
});

test('flowMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const meridian of entries) {
    assert.ok(
      Number.isFinite(meridian.flowMultiplier) && meridian.flowMultiplier > 0,
      `meridian "${meridian.id}" flowMultiplier must be a finite number > 0 (got ${String(meridian.flowMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.flowMultiplier >= previous.flowMultiplier,
      `flowMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.flowMultiplier}) -> "${current.id}" (${current.flowMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const meridian of entries) {
    assert.equal(typeof meridian.name, 'string', `meridian "${meridian.id}" missing name`);
    assert.ok(meridian.name !== '', `meridian "${meridian.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const meridian of entries) {
    assert.equal(typeof meridian.description, 'string', `meridian "${meridian.id}" missing description`);
    assert.ok(meridian.description !== '', `meridian "${meridian.id}" description must not be empty`);
  }
});

test('the manifest registers the meridians collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('meridians'),
    'manifest must register a "meridians" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'meridians');
  assert.deepEqual(entry.files, ['data/meridians/meridians.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'capacityMultiplier',
    'flowMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the meridians collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('meridians');

  assert.deepEqual(result.errors, [], 'meridians collection must load without validation errors');
  assert.equal(result.count, 7);
  assert.equal(dataManager.count('meridians'), 7);
  assert.ok(dataManager.isLoaded('meridians'), 'meridians collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('meridians'),
    entries.map((meridian) => meridian.id)
  );
});

test('cached meridian definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('meridians');

  const cached = dataManager.getAll('meridians');
  assert.equal(cached.length, 7);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached meridian "${definition.id}" must be frozen`);
  }
});
