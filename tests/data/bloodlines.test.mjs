/**
 * tests/data/bloodlines.test.mjs — content validation of
 * data/bloodlines/bloodlines.json.
 *
 * Guards the Phase-3 bloodline ladder (ROADMAP "Bloodlines") against data
 * drift: the collection must be the canonical 8-state DESIGN.md progression
 * (Ancient Human → Chaos Blood) in exact worst→best order, ids must be
 * unique, kebab-case and exactly the 8 canonical ids, both multipliers must
 * be finite and positive and non-decreasing across the ladder (monotonic),
 * every name must be a non-empty string, and every description must be a
 * non-empty string. The manifest's bloodlines entry must declare the exact
 * requiredFields list, so a bloodline missing any contract field fails here
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
const rawBloodlines = JSON.parse(
  readFileSync(new URL('../../data/bloodlines/bloodlines.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every bloodline entry (the file uses the definitions shape). */
const entries = rawBloodlines.definitions;

/**
 * The canonical 8-state bloodline ladder from DESIGN.md "Bloodlines",
 * worst → best, in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['ancient-human', 'Ancient Human'],
  ['tiger', 'Tiger Bloodline'],
  ['turtle', 'Turtle Bloodline'],
  ['qilin', 'Qilin Bloodline'],
  ['phoenix', 'Phoenix Bloodline'],
  ['dragon', 'Dragon Bloodline'],
  ['celestial', 'Celestial Bloodline'],
  ['chaos-blood', 'Chaos Bloodline'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/bloodlines/bloodlines.json': rawBloodlines,
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

test('the file loads as a non-empty array with exactly 8 entries', () => {
  assert.ok(
    Array.isArray(entries),
    'data/bloodlines/bloodlines.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    8,
    `the ladder must contain exactly 8 bloodlines (the DESIGN.md 8-state progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 8 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((bloodline) => bloodline.id),
    CANONICAL_LADDER.map(([id]) => id),
    'bloodline ids must follow the canonical DESIGN.md ladder order exactly (ancient-human … chaos-blood)'
  );
  const ids = new Set();
  for (const bloodline of entries) {
    assert.ok(
      KEBAB_CASE.test(bloodline.id),
      `bloodline id "${bloodline.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(bloodline.id), `bloodline ids must be unique (duplicate "${bloodline.id}")`);
    ids.add(bloodline.id);
  }
  assert.equal(ids.size, 8, 'exactly 8 distinct bloodline ids');
  assert.equal(entries[0].id, 'ancient-human', 'the first entry must be Ancient Human');
  assert.equal(entries[entries.length - 1].id, 'chaos-blood', 'the last entry must be Chaos Blood');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((bloodline) => bloodline.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'bloodline names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('cultivationSpeedMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const bloodline of entries) {
    assert.ok(
      Number.isFinite(bloodline.cultivationSpeedMultiplier) && bloodline.cultivationSpeedMultiplier > 0,
      `bloodline "${bloodline.id}" cultivationSpeedMultiplier must be a finite number > 0 (got ${String(bloodline.cultivationSpeedMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.cultivationSpeedMultiplier >= previous.cultivationSpeedMultiplier,
      `cultivationSpeedMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.cultivationSpeedMultiplier}) -> "${current.id}" (${current.cultivationSpeedMultiplier})`
    );
  }
});

test('qiMaxMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const bloodline of entries) {
    assert.ok(
      Number.isFinite(bloodline.qiMaxMultiplier) && bloodline.qiMaxMultiplier > 0,
      `bloodline "${bloodline.id}" qiMaxMultiplier must be a finite number > 0 (got ${String(bloodline.qiMaxMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.qiMaxMultiplier >= previous.qiMaxMultiplier,
      `qiMaxMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.qiMaxMultiplier}) -> "${current.id}" (${current.qiMaxMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const bloodline of entries) {
    assert.equal(typeof bloodline.name, 'string', `bloodline "${bloodline.id}" missing name`);
    assert.ok(bloodline.name !== '', `bloodline "${bloodline.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const bloodline of entries) {
    assert.equal(typeof bloodline.description, 'string', `bloodline "${bloodline.id}" missing description`);
    assert.ok(bloodline.description !== '', `bloodline "${bloodline.id}" description must not be empty`);
  }
});

test('the manifest registers the bloodlines collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('bloodlines'),
    'manifest must register a "bloodlines" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'bloodlines');
  assert.deepEqual(entry.files, ['data/bloodlines/bloodlines.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'cultivationSpeedMultiplier',
    'qiMaxMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the bloodlines collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('bloodlines');

  assert.deepEqual(result.errors, [], 'bloodlines collection must load without validation errors');
  assert.equal(result.count, 8);
  assert.equal(dataManager.count('bloodlines'), 8);
  assert.ok(dataManager.isLoaded('bloodlines'), 'bloodlines collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('bloodlines'),
    entries.map((bloodline) => bloodline.id)
  );
});

test('cached bloodlines definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('bloodlines');

  const cached = dataManager.getAll('bloodlines');
  assert.equal(cached.length, 8);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached bloodline "${definition.id}" must be frozen`);
  }
});
