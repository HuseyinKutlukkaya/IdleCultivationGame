/**
 * tests/data/upgrades.test.mjs — content validation of data/upgrades/upgrades.json.
 *
 * Guards the Phase-2 starter upgrade catalog (ROADMAP "Upgrades (basic
 * purchasable boosts)") against data drift: every upgrade must carry the
 * data-driven contract (id, name, description, category, costResource,
 * baseCost, costGrowth, effectPerLevel, optional maxLevel), ids must be
 * unique, every numeric field must be a usable value, the catalog must
 * declare at least one qiRateAdd upgrade (so the QiSystem's `upgrades`
 * source has data to feed on) and every costResource id must resolve to a
 * declared resource in data/game-config.json — so a typo in the cost
 * resource fails here instead of silently rejecting every purchase at
 * runtime.
 *
 * The REAL files are read relative to this module (import.meta.url), never
 * via an absolute path, so the test is portable: it works identically no
 * matter which machine or directory the repo is checked out into. The
 * collection is then loaded through the REAL DataManager pipeline (manifest
 * → fetch → validation → deep-freeze cache) with global fetch stubbed to
 * serve exactly the on-disk contents — so a malformed upgrade or a broken
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
const rawUpgrades = JSON.parse(
  readFileSync(new URL('../../data/upgrades/upgrades.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);
const rawConfig = JSON.parse(
  readFileSync(new URL('../../data/game-config.json', import.meta.url), 'utf8')
);

/** Every upgrade definition in the catalog. */
const upgrades = rawUpgrades.definitions;

/** Resource ids declared in config.resources.items (costResource must match). */
const declaredResourceIds = new Set(
  (rawConfig.resources.items || []).map((entry) => entry.id)
);

/** Real data files served by the stubbed fetch. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/game-config.json': rawConfig,
  'data/upgrades/upgrades.json': rawUpgrades,
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

test('upgrade catalog is a non-empty starter set with at least 3 entries', () => {
  assert.ok(Array.isArray(upgrades), 'data/upgrades/upgrades.json must carry a "definitions" array');
  assert.ok(
    upgrades.length >= 3,
    `starter upgrade catalog must contain at least 3 upgrades (got ${upgrades.length})`
  );
});

test('every upgrade carries the data-driven contract shape', () => {
  for (const upgrade of upgrades) {
    assert.equal(typeof upgrade.id, 'string', `upgrade missing id (${JSON.stringify(upgrade)})`);
    assert.ok(upgrade.id !== '', 'upgrade id must not be empty');
    assert.equal(typeof upgrade.name, 'string', `upgrade "${upgrade.id}" missing name`);
    assert.ok(upgrade.name !== '', `upgrade "${upgrade.id}" name must not be empty`);
    assert.equal(typeof upgrade.description, 'string', `upgrade "${upgrade.id}" missing description`);
    assert.ok(upgrade.description !== '', `upgrade "${upgrade.id}" description must not be empty`);
    // Category: v1 supports 'qiRateAdd' only. Future categories are explicit opt-in.
    assert.equal(typeof upgrade.category, 'string', `upgrade "${upgrade.id}" missing category`);
    assert.ok(upgrade.category !== '', `upgrade "${upgrade.id}" category must not be empty`);
    assert.equal(
      upgrade.category,
      'qiRateAdd',
      `upgrade "${upgrade.id}" has unknown category "${upgrade.category}" (v1 supports qiRateAdd only)`
    );
    // costResource: must reference a declared resource from data/game-config.json.
    assert.equal(
      typeof upgrade.costResource,
      'string',
      `upgrade "${upgrade.id}" missing costResource`
    );
    assert.ok(upgrade.costResource !== '', `upgrade "${upgrade.id}" costResource must not be empty`);
    assert.ok(
      declaredResourceIds.has(upgrade.costResource),
      `upgrade "${upgrade.id}" costResource "${upgrade.costResource}" is not a declared resource ` +
        `(must be one of ${[...declaredResourceIds].join(', ')})`
    );
    assert.ok(
      Number.isFinite(upgrade.baseCost) && upgrade.baseCost > 0,
      `upgrade "${upgrade.id}" baseCost must be a finite number > 0 (got ${String(upgrade.baseCost)})`
    );
    assert.ok(
      Number.isFinite(upgrade.costGrowth) && upgrade.costGrowth >= 1,
      `upgrade "${upgrade.id}" costGrowth must be a finite number >= 1 (got ${String(upgrade.costGrowth)})`
    );
    assert.ok(
      Number.isFinite(upgrade.effectPerLevel) && upgrade.effectPerLevel > 0,
      `upgrade "${upgrade.id}" effectPerLevel must be a finite number > 0 (got ${String(upgrade.effectPerLevel)})`
    );
    // maxLevel is optional; when present it must be a positive integer.
    if (upgrade.maxLevel !== undefined && upgrade.maxLevel !== null) {
      assert.ok(
        Number.isInteger(upgrade.maxLevel) && upgrade.maxLevel >= 1,
        `upgrade "${upgrade.id}" maxLevel must be a positive integer (got ${String(upgrade.maxLevel)})`
      );
    }
  }
});

test('every upgrade id is unique', () => {
  const ids = new Set();
  for (const upgrade of upgrades) {
    assert.ok(!ids.has(upgrade.id), `upgrade ids must be unique (duplicate "${upgrade.id}")`);
    ids.add(upgrade.id);
  }
});

test('the catalog spans at least two effect tiers (encourages progression)', () => {
  const effects = new Set(upgrades.map((upgrade) => upgrade.effectPerLevel));
  assert.ok(
    effects.size >= 2,
    `catalog must span at least 2 effect tiers to give players a progression curve (got ${effects.size})`
  );
});

test('the manifest registers the upgrades collection and keeps the realms + items entries', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(collectionIds.includes('upgrades'), 'manifest must register an "upgrades" collection');
  assert.ok(collectionIds.includes('realms'), 'manifest must keep the pre-existing "realms" collection');
  assert.ok(collectionIds.includes('items'), 'manifest must keep the pre-existing "items" collection');

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'upgrades');
  assert.deepEqual(entry.files, ['data/upgrades/upgrades.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'category',
    'costResource',
    'baseCost',
    'costGrowth',
    'effectPerLevel',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the upgrades collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('upgrades');

  assert.deepEqual(
    result.errors,
    [],
    'upgrades collection must load without validation errors'
  );
  assert.equal(result.count, upgrades.length);
  assert.equal(dataManager.count('upgrades'), upgrades.length);
  assert.ok(dataManager.isLoaded('upgrades'), 'upgrades collection must be marked as loaded');
  assert.deepEqual(dataManager.keys('upgrades'), upgrades.map((upgrade) => upgrade.id));
});

test('cached upgrade definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('upgrades');

  const cached = dataManager.getAll('upgrades');
  assert.equal(cached.length, upgrades.length);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached upgrade "${definition.id}" must be frozen`);
  }
});
