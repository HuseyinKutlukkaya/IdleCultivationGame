/**
 * tests/data/physiques.test.mjs — content validation of
 * data/physiques/physiques.json.
 *
 * Guards the Phase-3 physique ladder (ROADMAP "Physiques") against data
 * drift: the collection must be the canonical 6-state DESIGN.md progression
 * (Ordinary → Chaos) in exact worst→best order, ids must be unique, kebab-case
 * and exactly the 6 canonical ids, all four multipliers must be finite and
 * positive and non-decreasing across the ladder (monotonic), breakthroughBonus
 * must be finite, non-negative and non-decreasing, every name must be a
 * non-empty string, and every description must be a non-empty string. The
 * manifest's physiques entry must declare the exact requiredFields list, so a
 * physique missing any contract field fails here instead of silently
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
const rawPhysiques = JSON.parse(
  readFileSync(new URL('../../data/physiques/physiques.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every physique entry (the file uses the definitions shape). */
const entries = rawPhysiques.definitions;

/**
 * The canonical 6-state physique ladder from DESIGN.md "Physiques",
 * worst → best, in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['ordinary', 'Ordinary Body'],
  ['iron-body', 'Iron Body'],
  ['jade-body', 'Jade Body'],
  ['saint-body', 'Saint Body'],
  ['immortal-body', 'Immortal Body'],
  ['chaos-body', 'Chaos Body'],
];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/physiques/physiques.json': rawPhysiques,
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

test('the file loads as a non-empty array with exactly 6 entries', () => {
  assert.ok(
    Array.isArray(entries),
    'data/physiques/physiques.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    6,
    `the ladder must contain exactly 6 physiques (the DESIGN.md 6-state progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 6 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((physique) => physique.id),
    CANONICAL_LADDER.map(([id]) => id),
    'physique ids must follow the canonical DESIGN.md ladder order exactly (ordinary … chaos-body)'
  );
  const ids = new Set();
  for (const physique of entries) {
    assert.ok(
      KEBAB_CASE.test(physique.id),
      `physique id "${physique.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(physique.id), `physique ids must be unique (duplicate "${physique.id}")`);
    ids.add(physique.id);
  }
  assert.equal(ids.size, 6, 'exactly 6 distinct physique ids');
  assert.equal(entries[0].id, 'ordinary', 'the first entry must be Ordinary');
  assert.equal(entries[entries.length - 1].id, 'chaos-body', 'the last entry must be Chaos Body');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((physique) => physique.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'physique names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('breakthroughBonus is finite, non-negative and non-decreasing across the ladder', () => {
  for (const physique of entries) {
    assert.ok(
      Number.isFinite(physique.breakthroughBonus) && physique.breakthroughBonus >= 0,
      `physique "${physique.id}" breakthroughBonus must be a finite number >= 0 (got ${String(physique.breakthroughBonus)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.breakthroughBonus >= previous.breakthroughBonus,
      `breakthroughBonus must be non-decreasing across the ladder: "${previous.id}" (${previous.breakthroughBonus}) -> "${current.id}" (${current.breakthroughBonus})`
    );
  }
});

test('lifespanMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const physique of entries) {
    assert.ok(
      Number.isFinite(physique.lifespanMultiplier) && physique.lifespanMultiplier > 0,
      `physique "${physique.id}" lifespanMultiplier must be a finite number > 0 (got ${String(physique.lifespanMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.lifespanMultiplier >= previous.lifespanMultiplier,
      `lifespanMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.lifespanMultiplier}) -> "${current.id}" (${current.lifespanMultiplier})`
    );
  }
});

test('healthMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const physique of entries) {
    assert.ok(
      Number.isFinite(physique.healthMultiplier) && physique.healthMultiplier > 0,
      `physique "${physique.id}" healthMultiplier must be a finite number > 0 (got ${String(physique.healthMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.healthMultiplier >= previous.healthMultiplier,
      `healthMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.healthMultiplier}) -> "${current.id}" (${current.healthMultiplier})`
    );
  }
});

test('powerMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const physique of entries) {
    assert.ok(
      Number.isFinite(physique.powerMultiplier) && physique.powerMultiplier > 0,
      `physique "${physique.id}" powerMultiplier must be a finite number > 0 (got ${String(physique.powerMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.powerMultiplier >= previous.powerMultiplier,
      `powerMultiplier must be non-decreasing across the ladder: "${previous.id}" (${previous.powerMultiplier}) -> "${current.id}" (${current.powerMultiplier})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const physique of entries) {
    assert.equal(typeof physique.name, 'string', `physique "${physique.id}" missing name`);
    assert.ok(physique.name !== '', `physique "${physique.id}" name must not be empty`);
  }
});

test('every description is a non-empty string', () => {
  for (const physique of entries) {
    assert.equal(typeof physique.description, 'string', `physique "${physique.id}" missing description`);
    assert.ok(physique.description !== '', `physique "${physique.id}" description must not be empty`);
  }
});

test('the manifest registers the physiques collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('physiques'),
    'manifest must register a "physiques" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'physiques');
  assert.deepEqual(entry.files, ['data/physiques/physiques.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'breakthroughBonus',
    'lifespanMultiplier',
    'healthMultiplier',
    'powerMultiplier',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the physiques collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('physiques');

  assert.deepEqual(result.errors, [], 'physiques collection must load without validation errors');
  assert.equal(result.count, 6);
  assert.equal(dataManager.count('physiques'), 6);
  assert.ok(dataManager.isLoaded('physiques'), 'physiques collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('physiques'),
    entries.map((physique) => physique.id)
  );
});

test('cached physique definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('physiques');

  const cached = dataManager.getAll('physiques');
  assert.equal(cached.length, 6);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached physique "${definition.id}" must be frozen`);
  }
});
