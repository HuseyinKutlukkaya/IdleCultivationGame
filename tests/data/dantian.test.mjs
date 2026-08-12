/**
 * tests/data/dantian.test.mjs — content validation of
 * data/dantian/dantian.json.
 *
 * Guards the Phase-3 dantian ladder (ROADMAP "Dantian") against data
 * drift: the collection must be the canonical 8-state DESIGN.md progression
 * (Cracked → Void) in exact worst→best order, ids must be unique, kebab-case
 * and exactly the 8 canonical ids, all four multipliers must be finite and
 * positive and non-decreasing across the ladder (monotonic), every name must
 * be a non-empty string, and every description must be a non-empty string.
 * The manifest's dantian entry must declare the exact requiredFields list,
 * so a dantian missing any contract field fails here instead of silently
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
const rawDantian = JSON.parse(
  readFileSync(new URL('../../data/dantian/dantian.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every dantian entry (the file uses the definitions shape). */
const entries = rawDantian.definitions;

/**
 * The canonical 8-state dantian ladder from DESIGN.md "Dantian",
 * worst → best, in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['cracked', 'Cracked Dantian'],
  ['small', 'Small Dantian'],
  ['normal', 'Normal Dantian'],
  ['large', 'Large Dantian'],
  ['perfect', 'Perfect Dantian'],
  ['golden', 'Golden Dantian'],
  ['universe', 'Universe Dantian'],
  ['void', 'Void Dantian'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/dantian/dantian.json': rawDantian,
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
    'data/dantian/dantian.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    8,
    `the ladder must contain exactly 8 dantian (the DESIGN.md 8-state progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 8 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((dantian) => dantian.id),
    CANONICAL_LADDER.map(([id]) => id),
    'dantian ids must follow the canonical DESIGN.md ladder order exactly (cracked … void)'
  );
  const ids = new Set();
  for (const dantian of entries) {
    assert.ok(
      KEBAB_CASE.test(dantian.id),
      `dantian id "${dantian.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(dantian.id), `dantian ids must be unique (duplicate "${dantian.id}")`);
    ids.add(dantian.id);
  }
  assert.equal(ids.size, 8, 'exactly 8 distinct dantian ids');
  assert.equal(entries[0].id, 'cracked', 'the first entry must be Cracked');
  assert.equal(entries[entries.length - 1].id, 'void', 'the last entry must be Void');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((dantian) => dantian.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'dantian names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('capacityMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const dantian of entries) {
    assert.ok(
      Number.isFinite(dantian.capacityMultiplier) && dantian.capacityMultiplier > 0,
      `dantian "${dantian.id}" capacityMultiplier must be a finite number > 0 (got ${String(dantian.capacityMultiplier)})`
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

test('densityMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const dantian of entries) {
    assert.ok(
      Number.isFinite(dantian.densityMultiplier) && dantian.densityMultiplier > 0,
      `dantian "${dantian.id}" densityMultiplier must be a finite number > 0 (got ${String(dantian.densityMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.densityMultiplier >= previous.densityMultiplier,
      `densityMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.densityMultiplier}) -> "${current.id}" (${current.densityMultiplier})`
    );
  }
});

test('purityMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const dantian of entries) {
    assert.ok(
      Number.isFinite(dantian.purityMultiplier) && dantian.purityMultiplier > 0,
      `dantian "${dantian.id}" purityMultiplier must be a finite number > 0 (got ${String(dantian.purityMultiplier)})`
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

test('efficiencyMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const dantian of entries) {
    assert.ok(
      Number.isFinite(dantian.efficiencyMultiplier) && dantian.efficiencyMultiplier > 0,
      `dantian "${dantian.id}" efficiencyMultiplier must be a finite number > 0 (got ${String(dantian.efficiencyMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.efficiencyMultiplier >= previous.efficiencyMultiplier,
      `efficiencyMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.efficiencyMultiplier}) -> "${current.id}" (${current.efficiencyMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const dantian of entries) {
    assert.equal(typeof dantian.name, 'string', `dantian "${dantian.id}" missing name`);
    assert.ok(dantian.name !== '', `dantian "${dantian.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const dantian of entries) {
    assert.equal(typeof dantian.description, 'string', `dantian "${dantian.id}" missing description`);
    assert.ok(dantian.description !== '', `dantian "${dantian.id}" description must not be empty`);
  }
});

test('the manifest registers the dantian collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('dantian'),
    'manifest must register a "dantian" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'dantian');
  assert.deepEqual(entry.files, ['data/dantian/dantian.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'capacityMultiplier',
    'densityMultiplier',
    'purityMultiplier',
    'efficiencyMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the dantian collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('dantian');

  assert.deepEqual(result.errors, [], 'dantian collection must load without validation errors');
  assert.equal(result.count, 8);
  assert.equal(dataManager.count('dantian'), 8);
  assert.ok(dataManager.isLoaded('dantian'), 'dantian collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('dantian'),
    entries.map((dantian) => dantian.id)
  );
});

test('cached dantian definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('dantian');

  const cached = dataManager.getAll('dantian');
  assert.equal(cached.length, 8);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached dantian "${definition.id}" must be frozen`);
  }
});
