/**
 * tests/data/talents.test.mjs — content validation of data/talents/talents.json.
 *
 * Guards the Phase-3 talent ladder (ROADMAP "Talents / Comprehension")
 * against data drift: the collection must be the canonical 7-tier DESIGN.md
 * progression (Dull → Prodigy) in exact worst→best order, ids must be unique,
 * kebab-case and exactly the 7 canonical ids, the multiplier must be finite
 * and positive and non-decreasing across the ladder, every name must be a
 * non-empty string, and every description must be a non-empty string. The
 * manifest's talents entry must declare the exact requiredFields list, so a
 * talent missing any contract field fails here instead of silently degrading
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
const rawTalents = JSON.parse(
  readFileSync(new URL('../../data/talents/talents.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every talent entry (the file uses the definitions shape). */
const entries = rawTalents.definitions;

/**
 * The canonical 7-tier talent ladder from DESIGN.md "Talent", worst → best, in
 * exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['dull', 'Dull'],
  ['slow', 'Slow'],
  ['ordinary', 'Ordinary'],
  ['bright', 'Bright'],
  ['gifted', 'Gifted'],
  ['genius', 'Genius'],
  ['prodigy', 'Prodigy'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/talents/talents.json': rawTalents,
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
    'data/talents/talents.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    7,
    `the ladder must contain exactly 7 talents (the DESIGN.md 7-tier progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 7 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((talent) => talent.id),
    CANONICAL_LADDER.map(([id]) => id),
    'talent ids must follow the canonical DESIGN.md ladder order exactly (dull … prodigy)'
  );
  const ids = new Set();
  for (const talent of entries) {
    assert.ok(
      KEBAB_CASE.test(talent.id),
      `talent id "${talent.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(talent.id), `talent ids must be unique (duplicate "${talent.id}")`);
    ids.add(talent.id);
  }
  assert.equal(ids.size, 7, 'exactly 7 distinct talent ids');
  assert.equal(entries[0].id, 'dull', 'the first entry must be Dull');
  assert.equal(entries[entries.length - 1].id, 'prodigy', 'the last entry must be Prodigy');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((talent) => talent.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'talent names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('learningSpeedMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const talent of entries) {
    assert.ok(
      Number.isFinite(talent.learningSpeedMultiplier) && talent.learningSpeedMultiplier > 0,
      `talent "${talent.id}" learningSpeedMultiplier must be a finite number > 0 (got ${String(talent.learningSpeedMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.learningSpeedMultiplier >= previous.learningSpeedMultiplier,
      `learningSpeedMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.learningSpeedMultiplier}) -> "${current.id}" (${current.learningSpeedMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const talent of entries) {
    assert.equal(typeof talent.name, 'string', `talent "${talent.id}" missing name`);
    assert.ok(talent.name !== '', `talent "${talent.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const talent of entries) {
    assert.equal(typeof talent.description, 'string', `talent "${talent.id}" missing description`);
    assert.ok(talent.description !== '', `talent "${talent.id}" description must not be empty`);
  }
});

test('the manifest registers the talents collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('talents'),
    'manifest must register a "talents" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'talents');
  assert.deepEqual(entry.files, ['data/talents/talents.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'learningSpeedMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the talents collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('talents');

  assert.deepEqual(result.errors, [], 'talents collection must load without validation errors');
  assert.equal(result.count, 7);
  assert.equal(dataManager.count('talents'), 7);
  assert.ok(dataManager.isLoaded('talents'), 'talents collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('talents'),
    entries.map((talent) => talent.id)
  );
});

test('cached talent definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('talents');

  const cached = dataManager.getAll('talents');
  assert.equal(cached.length, 7);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached talent "${definition.id}" must be frozen`);
  }
});
