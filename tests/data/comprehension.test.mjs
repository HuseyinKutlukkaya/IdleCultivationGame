/**
 * tests/data/comprehension.test.mjs — content validation of
 * data/comprehension/comprehension.json.
 *
 * Guards the Phase-3 comprehension ladder (ROADMAP "Talents / Comprehension")
 * against data drift: the collection must be the canonical 7-tier DESIGN.md
 * progression (Shallow → Dao Heart) in exact worst→best order, ids must be
 * unique, kebab-case and exactly the 7 canonical ids, all three multipliers
 * must be finite and positive and non-decreasing across the ladder (monotonic
 * per column), every name must be a non-empty string, and every description
 * must be a non-empty string. The manifest's comprehension entry must declare
 * the exact requiredFields list, so a comprehension missing any contract field
 * fails here instead of silently degrading at runtime.
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
const rawComprehension = JSON.parse(
  readFileSync(new URL('../../data/comprehension/comprehension.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every comprehension entry (the file uses the definitions shape). */
const entries = rawComprehension.definitions;

/**
 * The canonical 7-tier comprehension ladder from DESIGN.md "Comprehension",
 * worst → best, in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['shallow', 'Shallow'],
  ['limited', 'Limited'],
  ['standard', 'Standard'],
  ['insightful', 'Insightful'],
  ['penetrating', 'Penetrating'],
  ['enlightened', 'Enlightened'],
  ['dao-heart', 'Dao Heart'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/comprehension/comprehension.json': rawComprehension,
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
    'data/comprehension/comprehension.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    7,
    `the ladder must contain exactly 7 comprehensions (the DESIGN.md 7-tier progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 7 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((comprehension) => comprehension.id),
    CANONICAL_LADDER.map(([id]) => id),
    'comprehension ids must follow the canonical DESIGN.md ladder order exactly (shallow … dao-heart)'
  );
  const ids = new Set();
  for (const comprehension of entries) {
    assert.ok(
      KEBAB_CASE.test(comprehension.id),
      `comprehension id "${comprehension.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(comprehension.id), `comprehension ids must be unique (duplicate "${comprehension.id}")`);
    ids.add(comprehension.id);
  }
  assert.equal(ids.size, 7, 'exactly 7 distinct comprehension ids');
  assert.equal(entries[0].id, 'shallow', 'the first entry must be Shallow');
  assert.equal(entries[entries.length - 1].id, 'dao-heart', 'the last entry must be Dao Heart');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((comprehension) => comprehension.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'comprehension names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('daoProgressMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const comprehension of entries) {
    assert.ok(
      Number.isFinite(comprehension.daoProgressMultiplier) && comprehension.daoProgressMultiplier > 0,
      `comprehension "${comprehension.id}" daoProgressMultiplier must be a finite number > 0 (got ${String(comprehension.daoProgressMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.daoProgressMultiplier >= previous.daoProgressMultiplier,
      `daoProgressMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.daoProgressMultiplier}) -> "${current.id}" (${current.daoProgressMultiplier})`
    );
  }
});

test('techniqueEfficiencyMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const comprehension of entries) {
    assert.ok(
      Number.isFinite(comprehension.techniqueEfficiencyMultiplier) && comprehension.techniqueEfficiencyMultiplier > 0,
      `comprehension "${comprehension.id}" techniqueEfficiencyMultiplier must be a finite number > 0 (got ${String(comprehension.techniqueEfficiencyMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.techniqueEfficiencyMultiplier >= previous.techniqueEfficiencyMultiplier,
      `techniqueEfficiencyMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.techniqueEfficiencyMultiplier}) -> "${current.id}" (${current.techniqueEfficiencyMultiplier})`
    );
  }
});

test('breakthroughEfficiencyMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const comprehension of entries) {
    assert.ok(
      Number.isFinite(comprehension.breakthroughEfficiencyMultiplier) && comprehension.breakthroughEfficiencyMultiplier > 0,
      `comprehension "${comprehension.id}" breakthroughEfficiencyMultiplier must be a finite number > 0 (got ${String(comprehension.breakthroughEfficiencyMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.breakthroughEfficiencyMultiplier >= previous.breakthroughEfficiencyMultiplier,
      `breakthroughEfficiencyMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.breakthroughEfficiencyMultiplier}) -> "${current.id}" (${current.breakthroughEfficiencyMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const comprehension of entries) {
    assert.equal(typeof comprehension.name, 'string', `comprehension "${comprehension.id}" missing name`);
    assert.ok(comprehension.name !== '', `comprehension "${comprehension.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const comprehension of entries) {
    assert.equal(typeof comprehension.description, 'string', `comprehension "${comprehension.id}" missing description`);
    assert.ok(comprehension.description !== '', `comprehension "${comprehension.id}" description must not be empty`);
  }
});

test('the manifest registers the comprehension collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('comprehension'),
    'manifest must register a "comprehension" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'comprehension');
  assert.deepEqual(entry.files, ['data/comprehension/comprehension.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'daoProgressMultiplier',
    'techniqueEfficiencyMultiplier',
    'breakthroughEfficiencyMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the comprehension collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('comprehension');

  assert.deepEqual(result.errors, [], 'comprehension collection must load without validation errors');
  assert.equal(result.count, 7);
  assert.equal(dataManager.count('comprehension'), 7);
  assert.ok(dataManager.isLoaded('comprehension'), 'comprehension collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('comprehension'),
    entries.map((comprehension) => comprehension.id)
  );
});

test('cached comprehension definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('comprehension');

  const cached = dataManager.getAll('comprehension');
  assert.equal(cached.length, 7);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached comprehension "${definition.id}" must be frozen`);
  }
});
