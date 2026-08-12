/**
 * tests/data/techniques.test.mjs — content validation of data/techniques/techniques.json.
 *
 * Guards the P5 technique generator catalog (ROADMAP "Technique generators &
 * proficiency") against data drift: every technique must carry the data-driven
 * contract (id, name, baseCost, costMultiplier, baseRevenue, revenuePerLevel,
 * cooldownMs), milestones must be numeric-keyed objects with type + value,
 * proficiency ladders must be non-empty arrays with name + threshold sorted
 * ascending, and ids must be unique.
 *
 * The REAL files are read relative to this module (import.meta.url), never
 * via an absolute path, so the test is portable.
 *
 * Run: the full suite as documented in tests/README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DataManager } from '../../js/core/data-manager.js';

/** Load the real content files relative to this test file. */
const rawTechniques = JSON.parse(
  readFileSync(new URL('../../data/techniques/techniques.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every technique definition in the catalog. */
const techniques = rawTechniques.definitions;

/** Real data files served by the stubbed fetch. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/techniques/techniques.json': rawTechniques,
};

/** Stub for global fetch that serves the real on-disk content files. */
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

test('technique catalog is a non-empty definitions array with at least 4 entries', () => {
  assert.ok(Array.isArray(techniques), 'data/techniques/techniques.json must carry a "definitions" array');
  assert.ok(
    techniques.length >= 4,
    `starter technique catalog must contain at least 4 techniques (got ${techniques.length})`
  );
});

test('every technique carries the data-driven contract shape', () => {
  const VALID_MILESTONE_TYPES = new Set(['cooldown', 'revenue']);

  for (const technique of techniques) {
    // Required string fields
    assert.equal(typeof technique.id, 'string', `technique missing id (${JSON.stringify(technique)})`);
    assert.ok(technique.id !== '', 'technique id must not be empty');
    assert.equal(typeof technique.name, 'string', `technique "${technique.id}" missing name`);
    assert.ok(technique.name !== '', `technique "${technique.id}" name must not be empty`);
    assert.equal(typeof technique.description, 'string', `technique "${technique.id}" missing description`);
    assert.ok(technique.description !== '', `technique "${technique.id}" description must not be empty`);

    // Required numeric fields
    assert.ok(
      Number.isFinite(technique.baseCost) && technique.baseCost > 0,
      `technique "${technique.id}" baseCost must be a finite number > 0 (got ${String(technique.baseCost)})`
    );
    assert.ok(
      Number.isFinite(technique.costMultiplier) && technique.costMultiplier >= 1,
      `technique "${technique.id}" costMultiplier must be a finite number >= 1 (got ${String(technique.costMultiplier)})`
    );
    assert.ok(
      Number.isFinite(technique.baseRevenue) && technique.baseRevenue > 0,
      `technique "${technique.id}" baseRevenue must be a finite number > 0 (got ${String(technique.baseRevenue)})`
    );
    assert.ok(
      Number.isFinite(technique.revenuePerLevel) && technique.revenuePerLevel >= 0,
      `technique "${technique.id}" revenuePerLevel must be a finite number >= 0 (got ${String(technique.revenuePerLevel)})`
    );
    assert.ok(
      Number.isFinite(technique.cooldownMs) && technique.cooldownMs > 0,
      `technique "${technique.id}" cooldownMs must be a finite number > 0 (got ${String(technique.cooldownMs)})`
    );

    // Optional fields: grade, category
    if (technique.grade !== undefined) {
      assert.equal(typeof technique.grade, 'string', `technique "${technique.id}" grade must be a string`);
    }
    if (technique.category !== undefined) {
      assert.equal(typeof technique.category, 'string', `technique "${technique.id}" category must be a string`);
    }

    // Milestones: must be an object with numeric keys mapping to { type, value }
    assert.ok(
      technique.milestones && typeof technique.milestones === 'object' && !Array.isArray(technique.milestones),
      `technique "${technique.id}" must have a milestones object`
    );
    const milestoneKeys = Object.keys(technique.milestones);
    assert.ok(milestoneKeys.length > 0, `technique "${technique.id}" milestones must not be empty`);
    const milestonesSorted = milestoneKeys.map(Number).sort((a, b) => a - b);
    for (let i = 0; i < milestonesSorted.length; i++) {
      const key = String(milestonesSorted[i]);
      assert.ok(Number.isInteger(milestonesSorted[i]) && milestonesSorted[i] > 0,
        `technique "${technique.id}" milestone key "${key}" must be a positive integer`);
      if (i > 0) {
        assert.ok(milestonesSorted[i] > milestonesSorted[i - 1],
          `technique "${technique.id}" milestones must be sorted ascending (${milestonesSorted[i - 1]} before ${milestonesSorted[i]})`);
      }
      const entry = technique.milestones[key];
      assert.ok(entry && typeof entry === 'object', `technique "${technique.id}" milestone "${key}" entry must be an object`);
      assert.ok(VALID_MILESTONE_TYPES.has(entry.type),
        `technique "${technique.id}" milestone "${key}" type must be 'cooldown' or 'revenue' (got "${entry.type}")`);
      assert.ok(Number.isFinite(entry.value) && entry.value > 0,
        `technique "${technique.id}" milestone "${key}" value must be a finite number > 0 (got ${String(entry.value)})`);
    }

    // Proficiency: must be a non-empty ladder array of { name, threshold } sorted ascending
    assert.ok(
      technique.proficiency && typeof technique.proficiency === 'object',
      `technique "${technique.id}" must have a proficiency object`
    );
    assert.ok(
      Number.isFinite(technique.proficiency.xpPerActivation) && technique.proficiency.xpPerActivation > 0,
      `technique "${technique.id}" proficiency.xpPerActivation must be a finite number > 0`
    );
    const ladder = technique.proficiency.ladder;
    assert.ok(Array.isArray(ladder) && ladder.length > 0,
      `technique "${technique.id}" proficiency.ladder must be a non-empty array`);
    for (let i = 0; i < ladder.length; i++) {
      const tier = ladder[i];
      assert.equal(typeof tier.name, 'string', `technique "${technique.id}" ladder[${i}] missing name`);
      assert.ok(tier.name !== '', `technique "${technique.id}" ladder[${i}] name must not be empty`);
      assert.ok(
        Number.isFinite(tier.threshold) && tier.threshold >= 0,
        `technique "${technique.id}" ladder[${i}] threshold must be a finite number >= 0`
      );
      if (i > 0) {
        assert.ok(tier.threshold > ladder[i - 1].threshold,
          `technique "${technique.id}" ladder thresholds must be strictly ascending`);
      }
    }
    // First tier must have threshold 0
    assert.equal(ladder[0].threshold, 0,
      `technique "${technique.id}" first proficiency tier must have threshold 0`);
    // Ladder must have exactly 7 tiers (Beginner → Transcendence)
    assert.equal(ladder.length, 7,
      `technique "${technique.id}" proficiency ladder must have exactly 7 tiers (got ${ladder.length})`);
  }
});

test('every technique id is unique', () => {
  const ids = new Set();
  for (const technique of techniques) {
    assert.ok(!ids.has(technique.id), `technique ids must be unique (duplicate "${technique.id}")`);
    ids.add(technique.id);
  }
});

test('the catalog spans at least two cost tiers (encourages progression)', () => {
  const costs = new Set(techniques.map((t) => t.baseCost));
  assert.ok(
    costs.size >= 2,
    `catalog must span at least 2 cost tiers (got ${costs.size})`
  );
});

test('the manifest registers the techniques collection', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(collectionIds.includes('techniques'), 'manifest must register a "techniques" collection');

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'techniques');
  assert.deepEqual(entry.files, ['data/techniques/techniques.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'baseCost',
    'costMultiplier',
    'baseRevenue',
    'revenuePerLevel',
    'cooldownMs',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the techniques collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('techniques');

  assert.deepEqual(
    result.errors,
    [],
    'techniques collection must load without validation errors'
  );
  assert.equal(result.count, techniques.length);
  assert.equal(dataManager.count('techniques'), techniques.length);
  assert.ok(dataManager.isLoaded('techniques'), 'techniques collection must be marked as loaded');
  assert.deepEqual(dataManager.keys('techniques'), techniques.map((t) => t.id));
});

test('cached technique definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('techniques');

  const cached = dataManager.getAll('techniques');
  assert.equal(cached.length, techniques.length);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached technique "${definition.id}" must be frozen`);
  }
});
