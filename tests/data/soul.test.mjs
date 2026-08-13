/**
 * tests/data/soul.test.mjs — content validation of data/soul/soul.json.
 *
 * Guards the Phase-3 soul ladder (ROADMAP "Soul") against data drift: the
 * collection must be the canonical 7-state DESIGN.md progression (Shattered →
 * Chaos Soul) in exact worst→best order, ids must be unique, kebab-case and
 * exactly the 7 canonical ids, all four multipliers must be finite and
 * positive and non-decreasing across the ladder (monotonic per column), every
 * name must be a non-empty string, and every description must be a non-empty
 * string. The manifest's soul entry must declare the exact requiredFields
 * list, so a soul missing any contract field fails here instead of silently
 * degrading at runtime.
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
const rawSoul = JSON.parse(
  readFileSync(new URL('../../data/soul/soul.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every soul entry (the file uses the definitions shape). */
const entries = rawSoul.definitions;

/**
 * The canonical 7-state soul ladder from DESIGN.md "Soul", worst → best, in
 * exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['shattered', 'Shattered Soul'],
  ['fragile', 'Fragile Soul'],
  ['stable', 'Stable Soul'],
  ['firm', 'Firm Soul'],
  ['radiant', 'Radiant Soul'],
  ['grand', 'Grand Soul'],
  ['chaos-soul', 'Chaos Soul'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/soul/soul.json': rawSoul,
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
    'data/soul/soul.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    7,
    `the ladder must contain exactly 7 souls (the DESIGN.md 7-state progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 7 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((soul) => soul.id),
    CANONICAL_LADDER.map(([id]) => id),
    'soul ids must follow the canonical DESIGN.md ladder order exactly (shattered … chaos-soul)'
  );
  const ids = new Set();
  for (const soul of entries) {
    assert.ok(
      KEBAB_CASE.test(soul.id),
      `soul id "${soul.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(soul.id), `soul ids must be unique (duplicate "${soul.id}")`);
    ids.add(soul.id);
  }
  assert.equal(ids.size, 7, 'exactly 7 distinct soul ids');
  assert.equal(entries[0].id, 'shattered', 'the first entry must be Shattered Soul');
  assert.equal(entries[entries.length - 1].id, 'chaos-soul', 'the last entry must be Chaos Soul');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((soul) => soul.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'soul names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('stabilityMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const soul of entries) {
    assert.ok(
      Number.isFinite(soul.stabilityMultiplier) && soul.stabilityMultiplier > 0,
      `soul "${soul.id}" stabilityMultiplier must be a finite number > 0 (got ${String(soul.stabilityMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.stabilityMultiplier >= previous.stabilityMultiplier,
      `stabilityMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.stabilityMultiplier}) -> "${current.id}" (${current.stabilityMultiplier})`
    );
  }
});

test('purityMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const soul of entries) {
    assert.ok(
      Number.isFinite(soul.purityMultiplier) && soul.purityMultiplier > 0,
      `soul "${soul.id}" purityMultiplier must be a finite number > 0 (got ${String(soul.purityMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.purityMultiplier >= previous.purityMultiplier,
      `purityMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.purityMultiplier}) -> "${current.id}" (${current.purityMultiplier})`
    );
  }
});

test('willpowerMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const soul of entries) {
    assert.ok(
      Number.isFinite(soul.willpowerMultiplier) && soul.willpowerMultiplier > 0,
      `soul "${soul.id}" willpowerMultiplier must be a finite number > 0 (got ${String(soul.willpowerMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.willpowerMultiplier >= previous.willpowerMultiplier,
      `willpowerMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.willpowerMultiplier}) -> "${current.id}" (${current.willpowerMultiplier})`
    );
  }
});

test('comprehensionMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const soul of entries) {
    assert.ok(
      Number.isFinite(soul.comprehensionMultiplier) && soul.comprehensionMultiplier > 0,
      `soul "${soul.id}" comprehensionMultiplier must be a finite number > 0 (got ${String(soul.comprehensionMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.comprehensionMultiplier >= previous.comprehensionMultiplier,
      `comprehensionMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.comprehensionMultiplier}) -> "${current.id}" (${current.comprehensionMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const soul of entries) {
    assert.equal(typeof soul.name, 'string', `soul "${soul.id}" missing name`);
    assert.ok(soul.name !== '', `soul "${soul.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const soul of entries) {
    assert.equal(typeof soul.description, 'string', `soul "${soul.id}" missing description`);
    assert.ok(soul.description !== '', `soul "${soul.id}" description must not be empty`);
  }
});

test('the manifest registers the soul collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('soul'),
    'manifest must register a "soul" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'soul');
  assert.deepEqual(entry.files, ['data/soul/soul.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'stabilityMultiplier',
    'purityMultiplier',
    'willpowerMultiplier',
    'comprehensionMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the soul collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('soul');

  assert.deepEqual(result.errors, [], 'soul collection must load without validation errors');
  assert.equal(result.count, 7);
  assert.equal(dataManager.count('soul'), 7);
  assert.ok(dataManager.isLoaded('soul'), 'soul collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('soul'),
    entries.map((soul) => soul.id)
  );
});

test('cached soul definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('soul');

  const cached = dataManager.getAll('soul');
  assert.equal(cached.length, 7);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached soul "${definition.id}" must be frozen`);
  }
});
