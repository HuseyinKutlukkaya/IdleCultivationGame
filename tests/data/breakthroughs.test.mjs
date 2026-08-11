/**
 * tests/data/breakthroughs.test.mjs — content validation of
 * data/breakthroughs/breakthroughs.json.
 *
 * Guards the Phase-3 breakthrough tables (ROADMAP "Breakthroughs
 * (requirements, results, bottlenecks)") against data drift: there must be a
 * BIJECTION with the canonical 15-tier realm ladder (data/realms/realms.json)
 * — every realm id has exactly one entry, in tier order — and every entry
 * must carry the full breakthrough contract (realmId, requiredProgress, cost,
 * bottleneck, results). The results table must be non-empty with finite
 * positive weights, every outcome must come from the canonical 7-outcome
 * whitelist (perfect / great-success / success / barely-successful /
 * failure / heavy-failure / qi-deviation — DEATH is excluded in v1, DESIGN.md
 * marks it 'future optional'), success outcomes carry NO progressLoss while
 * failure outcomes carry a finite 0..1 loss, and the per-realm success weight
 * must sit near 80% with failures near 20%. requiredProgress must be finite
 * and positive with a monotonic placeholder curve; cost.spiritStones finite
 * and non-negative (0 for mortal, monotonic rise); and every bottleneck item
 * must reference a REAL id from data/items/items.json (never a phantom item).
 * The manifest's breakthroughs entry must declare the exact full
 * requiredFields list, so an entry missing any contract field fails here
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
const rawBreakthroughs = JSON.parse(
  readFileSync(
    new URL('../../data/breakthroughs/breakthroughs.json', import.meta.url),
    'utf8'
  )
);
const rawRealms = JSON.parse(
  readFileSync(new URL('../../data/realms/realms.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);
const rawItems = JSON.parse(
  readFileSync(new URL('../../data/items/items.json', import.meta.url), 'utf8')
);

/** Every breakthrough entry (the file uses the definitions shape). */
const entries = rawBreakthroughs.definitions;

/** The canonical realm ladder ids (file order = tier order). */
const realmIds = rawRealms.definitions.map((realm) => realm.id);

/** Real item ids the bottleneck entries must resolve against. */
const itemIds = new Set(rawItems.definitions.map((item) => item.id));

/** Canonical outcome ids (DESIGN.md 'Breakthroughs'; death is v1-excluded). */
const SUCCESS_OUTCOMES = new Set([
  'perfect',
  'great-success',
  'success',
  'barely-successful',
]);
const FAILURE_OUTCOMES = new Set(['failure', 'heavy-failure', 'qi-deviation']);
const CANONICAL_OUTCOMES = new Set([...SUCCESS_OUTCOMES, ...FAILURE_OUTCOMES]);

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/realms/realms.json': rawRealms,
  'data/breakthroughs/breakthroughs.json': rawBreakthroughs,
  'data/items/items.json': rawItems,
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

test('every realm id has exactly one breakthrough entry, in tier order (bijection)', () => {
  assert.ok(
    Array.isArray(entries),
    'data/breakthroughs/breakthroughs.json must carry a "definitions" array'
  );
  assert.equal(
    entries.length,
    realmIds.length,
    `there must be one breakthrough entry per realm (${realmIds.length} realms, got ${entries.length})`
  );
  assert.deepEqual(
    entries.map((entry) => entry.realmId),
    realmIds,
    'breakthrough realmIds must mirror the realm ladder order exactly'
  );
  const unique = new Set(entries.map((entry) => entry.realmId));
  assert.equal(
    unique.size,
    entries.length,
    'realmId must be unique across entries (no duplicates)'
  );
  assert.equal(entries[0].realmId, 'mortal', 'the first entry must be Mortal');
  assert.equal(
    entries[entries.length - 1].realmId,
    'beyond-heaven',
    'the last entry must be Beyond Heaven'
  );
});

test('every entry carries a non-empty results table with finite positive weights', () => {
  for (const entry of entries) {
    assert.ok(
      Array.isArray(entry.results),
      `entry "${entry.realmId}" results must be an array`
    );
    assert.ok(
      entry.results.length > 0,
      `entry "${entry.realmId}" results must not be empty`
    );
    let total = 0;
    for (const result of entry.results) {
      assert.ok(
        Number.isFinite(result.weight) && result.weight > 0,
        `entry "${entry.realmId}" result "${String(result.outcome)}" weight must be a finite number > 0 (got ${String(result.weight)})`
      );
      total += result.weight;
    }
    assert.ok(
      total > 0,
      `entry "${entry.realmId}" results must have a positive total weight`
    );
  }
});

test('every outcome id comes from the canonical 7-outcome whitelist (no death in v1)', () => {
  assert.equal(CANONICAL_OUTCOMES.size, 7, 'exactly seven canonical outcomes');
  assert.ok(
    !CANONICAL_OUTCOMES.has('death'),
    'death must be excluded in v1 (DESIGN.md marks it future optional)'
  );
  for (const entry of entries) {
    for (const result of entry.results) {
      assert.ok(
        CANONICAL_OUTCOMES.has(result.outcome),
        `entry "${entry.realmId}" has unknown outcome "${String(result.outcome)}"`
      );
    }
  }
});

test('success outcomes carry no progressLoss; failure outcomes carry a finite 0..1 loss', () => {
  for (const entry of entries) {
    for (const result of entry.results) {
      if (SUCCESS_OUTCOMES.has(result.outcome)) {
        assert.equal(
          result.progressLoss,
          undefined,
          `success outcome "${result.outcome}" in "${entry.realmId}" must not declare progressLoss (advance is unconditional)`
        );
      } else {
        assert.ok(
          Number.isFinite(result.progressLoss) &&
            result.progressLoss >= 0 &&
            result.progressLoss <= 1,
          `failure outcome "${result.outcome}" in "${entry.realmId}" progressLoss must be a finite number in 0..1 (got ${String(result.progressLoss)})`
        );
      }
    }
  }
});

test('per-realm success weight stays near 80% and failure weight near 20%', () => {
  for (const entry of entries) {
    const successWeight = entry.results
      .filter((result) => SUCCESS_OUTCOMES.has(result.outcome))
      .reduce((sum, result) => sum + result.weight, 0);
    const failureWeight = entry.results
      .filter((result) => FAILURE_OUTCOMES.has(result.outcome))
      .reduce((sum, result) => sum + result.weight, 0);
    const total = successWeight + failureWeight;
    assert.ok(
      successWeight >= total * 0.7 && successWeight <= total * 0.9,
      `entry "${entry.realmId}" success weight ${successWeight} must be ~80% of ${total}`
    );
    assert.equal(
      failureWeight,
      total - successWeight,
      `entry "${entry.realmId}" failure weight must be the remainder`
    );
  }
});

test('every entry declares a finite positive requiredProgress (monotonic curve)', () => {
  for (const entry of entries) {
    assert.ok(
      Number.isFinite(entry.requiredProgress) && entry.requiredProgress > 0,
      `entry "${entry.realmId}" requiredProgress must be a finite number > 0 (got ${String(entry.requiredProgress)})`
    );
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    assert.ok(
      current.requiredProgress >= previous.requiredProgress,
      `requiredProgress must be non-decreasing: "${previous.realmId}" (${previous.requiredProgress}) -> "${current.realmId}" (${current.requiredProgress})`
    );
  }
});

test('every cost is a finite non-negative number (0 for mortal, monotonic rise)', () => {
  for (const entry of entries) {
    assert.ok(
      entry.cost && typeof entry.cost === 'object' && !Array.isArray(entry.cost),
      `entry "${entry.realmId}" cost must be an object`
    );
    for (const [id, amount] of Object.entries(entry.cost)) {
      assert.ok(
        Number.isFinite(amount) && amount >= 0,
        `entry "${entry.realmId}" cost.${id} must be a finite number >= 0 (got ${String(amount)})`
      );
    }
  }
  assert.equal(
    entries[0].cost.spiritStones,
    0,
    'the mortal entry must carry a zero spirit-stone cost'
  );
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    assert.ok(
      current.cost.spiritStones >= previous.cost.spiritStones,
      `cost.spiritStones must be non-decreasing: "${previous.realmId}" (${previous.cost.spiritStones}) -> "${current.realmId}" (${current.cost.spiritStones})`
    );
  }
});

test('every bottleneck references a real item id from data/items/items.json', () => {
  for (const entry of entries) {
    assert.ok(
      Array.isArray(entry.bottleneck),
      `entry "${entry.realmId}" bottleneck must be an array`
    );
    for (const item of entry.bottleneck) {
      assert.equal(
        typeof item.id,
        'string',
        `entry "${entry.realmId}" bottleneck item must carry a string id`
      );
      assert.ok(
        itemIds.has(item.id),
        `entry "${entry.realmId}" bottleneck item "${item.id}" is not in data/items/items.json`
      );
      assert.ok(
        Number.isFinite(item.count) && item.count > 0,
        `entry "${entry.realmId}" bottleneck item "${item.id}" count must be a finite number > 0 (got ${String(item.count)})`
      );
    }
  }
});

test('the manifest registers the breakthroughs collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('breakthroughs'),
    'manifest must register a "breakthroughs" collection'
  );

  const entry = rawManifest.collections.find(
    (candidate) => candidate.id === 'breakthroughs'
  );
  assert.deepEqual(entry.files, ['data/breakthroughs/breakthroughs.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'realmId',
    'requiredProgress',
    'cost',
    'bottleneck',
    'results',
  ]);
  assert.equal(entry.validation.uniqueField, 'realmId');
});

test('the breakthroughs collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('breakthroughs');

  assert.deepEqual(result.errors, [], 'breakthroughs collection must load without validation errors');
  assert.equal(result.count, 15);
  assert.equal(dataManager.count('breakthroughs'), 15);
  assert.ok(dataManager.isLoaded('breakthroughs'), 'breakthroughs collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('breakthroughs'),
    entries.map((entry) => entry.realmId)
  );
});

test('cached breakthrough definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('breakthroughs');

  const cached = dataManager.getAll('breakthroughs');
  assert.equal(cached.length, 15);
  for (const definition of cached) {
    assert.ok(
      Object.isFrozen(definition),
      `cached breakthrough "${definition.realmId}" must be frozen`
    );
    assert.ok(
      Object.isFrozen(definition.results),
      `cached breakthrough "${definition.realmId}" results array must be frozen`
    );
  }
});
