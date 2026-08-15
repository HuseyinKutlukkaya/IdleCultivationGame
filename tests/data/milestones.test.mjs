/**
 * tests/data/milestones.test.mjs — content validation of data/milestones/milestones.json.
 *
 * Guards the Phase-3 starter milestone catalog (ROADMAP "Milestones
 * (threshold rewards: first X qi, first breakthrough, ...)") against data
 * drift: every milestone must carry the data-driven contract (id, name, stat,
 * threshold, reward), ids must be unique, `stat` must be one of the four
 * lifetime counter keys (STATISTICS_KEYS in js/systems/statistics.js:
 * playtimeMs, meditationsCompleted, breakthroughsTotal, qiGenerated),
 * thresholds must be finite positive numbers, and every reward resourceId
 * must resolve to a declared resource in data/game-config.json with a
 * positive finite amount — so a typo in a reward resource fails here instead
 * of silently granting nothing at runtime.
 *
 * The REAL files are read relative to this module (import.meta.url), never
 * via an absolute path, so the test is portable: it works identically no
 * matter which machine or directory the repo is checked out into. The
 * collection is then loaded through the REAL DataManager pipeline (manifest
 * → fetch → validation → deep-freeze cache) with global fetch stubbed to
 * serve exactly the on-disk contents — so a malformed milestone or a broken
 * manifest reference fails here instead of surfacing at runtime.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DataManager } from '../../js/core/data-manager.js';
import { STATISTICS_KEYS } from '../../js/systems/statistics.js';

/**
 * Load the real content files relative to this test file. `new URL(...,
 * import.meta.url)` resolves against the module's own location, so the paths
 * work on any machine.
 */
const rawMilestones = JSON.parse(
  readFileSync(new URL('../../data/milestones/milestones.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);
const rawConfig = JSON.parse(
  readFileSync(new URL('../../data/game-config.json', import.meta.url), 'utf8')
);

/** Every milestone definition in the catalog. */
const milestones = rawMilestones.definitions;

/** Resource ids declared in config.resources.items (reward ids must match). */
const declaredResourceIds = new Set(
  (rawConfig.resources.items || []).map((entry) => entry.id)
);

/** Real data files served by the stubbed fetch. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/game-config.json': rawConfig,
  'data/milestones/milestones.json': rawMilestones,
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

test('milestone catalog is a non-empty starter set with at least 6 entries', () => {
  assert.ok(
    Array.isArray(milestones),
    'data/milestones/milestones.json must carry a "definitions" array'
  );
  assert.ok(
    milestones.length >= 6,
    `starter milestone catalog must contain at least 6 milestones (got ${milestones.length})`
  );
});

test('every milestone carries the data-driven contract shape', () => {
  for (const milestone of milestones) {
    assert.equal(typeof milestone.id, 'string', `milestone missing id (${JSON.stringify(milestone)})`);
    assert.ok(milestone.id !== '', 'milestone id must not be empty');
    assert.equal(typeof milestone.name, 'string', `milestone "${milestone.id}" missing name`);
    assert.ok(milestone.name !== '', `milestone "${milestone.id}" name must not be empty`);
    // stat: must be one of the four lifetime counter keys (STATISTICS_KEYS).
    assert.equal(typeof milestone.stat, 'string', `milestone "${milestone.id}" missing stat`);
    assert.ok(
      STATISTICS_KEYS.includes(milestone.stat),
      `milestone "${milestone.id}" stat "${milestone.stat}" is not a lifetime counter ` +
        `(must be one of ${STATISTICS_KEYS.join(', ')})`
    );
    // threshold: a finite positive number.
    assert.ok(
      Number.isFinite(milestone.threshold) && milestone.threshold > 0,
      `milestone "${milestone.id}" threshold must be a finite number > 0 ` +
        `(got ${String(milestone.threshold)})`
    );
    // reward: a plain object whose resourceIds all resolve in
    // config.resources.items with positive finite amounts.
    assert.ok(
      milestone.reward !== null &&
        typeof milestone.reward === 'object' &&
        !Array.isArray(milestone.reward),
      `milestone "${milestone.id}" reward must be a plain object`
    );
    const rewardEntries = Object.entries(milestone.reward);
    assert.ok(
      rewardEntries.length > 0,
      `milestone "${milestone.id}" reward must not be empty`
    );
    for (const [resourceId, amount] of rewardEntries) {
      assert.ok(
        declaredResourceIds.has(resourceId),
        `milestone "${milestone.id}" reward resource "${resourceId}" is not a declared resource ` +
          `(must be one of ${[...declaredResourceIds].join(', ')})`
      );
      assert.ok(
        Number.isFinite(amount) && amount > 0,
        `milestone "${milestone.id}" reward "${resourceId}" amount must be a finite number > 0 ` +
          `(got ${String(amount)})`
      );
    }
  }
});

test('every milestone id is unique', () => {
  const ids = new Set();
  for (const milestone of milestones) {
    assert.ok(
      !ids.has(milestone.id),
      `milestone ids must be unique (duplicate "${milestone.id}")`
    );
    ids.add(milestone.id);
  }
});

test('the catalog spans all four lifetime counters', () => {
  const stats = new Set(milestones.map((milestone) => milestone.stat));
  for (const key of STATISTICS_KEYS) {
    assert.ok(
      stats.has(key),
      `catalog must cover the "${key}" counter (a milestone per lifetime counter keeps ` +
        `every threshold class reachable)`
    );
  }
});

test('the manifest registers the milestones collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('milestones'),
    'manifest must register a "milestones" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'milestones');
  assert.deepEqual(entry.files, ['data/milestones/milestones.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'stat',
    'threshold',
    'reward',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the milestones collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('milestones');

  assert.deepEqual(
    result.errors,
    [],
    'milestones collection must load without validation errors'
  );
  assert.equal(result.count, milestones.length);
  assert.equal(dataManager.count('milestones'), milestones.length);
  assert.ok(dataManager.isLoaded('milestones'), 'milestones collection must be marked as loaded');
  assert.deepEqual(dataManager.keys('milestones'), milestones.map((milestone) => milestone.id));
});

test('cached milestone definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('milestones');

  const cached = dataManager.getAll('milestones');
  assert.equal(cached.length, milestones.length);
  for (const definition of cached) {
    assert.ok(
      Object.isFrozen(definition),
      `cached milestone "${definition.id}" must be frozen`
    );
  }
});