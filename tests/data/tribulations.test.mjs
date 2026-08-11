/**
 * tests/data/tribulations.test.mjs — content validation of
 * data/tribulations/tribulations.json.
 *
 * Guards the Phase-3 tribulation table (ROADMAP "Tribulations") against data
 * drift: there must be a BIJECTION with the canonical 15-tier realm ladder
 * (data/realms/realms.json) — every realm id has exactly one entry, in tier
 * order — and every entry must carry the full tribulation contract (realmId,
 * tribulationType, results). tribulationType must be either null (the realm
 * imposes no tribulation gate — results is then an empty array) or one of the
 * canonical 7 types from DESIGN.md (lightning / heart-devil / karma /
 * heavenly-fire / void / soul / body), with every canonical type appearing at
 * least once across entries. Gated entries (non-null type) carry a non-empty
 * results table whose every outcome comes from the canonical 4-outcome
 * whitelist (survived / barely-survived / injured / near-death — DEATH is
 * excluded in v1, DESIGN.md marks it 'future optional', the same discipline as
 * breakthroughs), weights are finite positive, the per-realm success weight
 * sits near 80% (70%..90%) with failures as the remainder, SUCCESS outcomes
 * declare NO progressLoss while FAILURE outcomes carry a finite 0..1 loss, and
 * the manifest's tribulations entry must declare the exact requiredFields
 * list, so an entry missing any contract field fails here instead of silently
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
const rawTribulations = JSON.parse(
  readFileSync(
    new URL('../../data/tribulations/tribulations.json', import.meta.url),
    'utf8'
  )
);
const rawRealms = JSON.parse(
  readFileSync(new URL('../../data/realms/realms.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every tribulation entry (the file uses the definitions shape). */
const entries = rawTribulations.definitions;

/** The canonical realm ladder ids (file order = tier order). */
const realmIds = rawRealms.definitions.map((realm) => realm.id);

/** Canonical tribulation type whitelist (DESIGN.md 'Tribulations', all 7). */
const CANONICAL_TYPES = new Set([
  'lightning',
  'heart-devil',
  'karma',
  'heavenly-fire',
  'void',
  'soul',
  'body',
]);

/** Canonical outcome ids (DESIGN.md 'Tribulations'; death is v1-excluded). */
const SUCCESS_OUTCOMES = new Set(['survived', 'barely-survived']);
const FAILURE_OUTCOMES = new Set(['injured', 'near-death']);
const CANONICAL_OUTCOMES = new Set([...SUCCESS_OUTCOMES, ...FAILURE_OUTCOMES]);

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/realms/realms.json': rawRealms,
  'data/tribulations/tribulations.json': rawTribulations,
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

test('every realm id has exactly one tribulation entry, in tier order (bijection)', () => {
  assert.ok(
    Array.isArray(entries),
    'data/tribulations/tribulations.json must carry a "definitions" array'
  );
  assert.equal(
    entries.length,
    realmIds.length,
    `there must be one tribulation entry per realm (${realmIds.length} realms, got ${entries.length})`
  );
  assert.deepEqual(
    entries.map((entry) => entry.realmId),
    realmIds,
    'tribulation realmIds must mirror the realm ladder order exactly'
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

test('tribulationType is null or a canonical type, and all 7 canonical types appear', () => {
  for (const entry of entries) {
    assert.ok(
      entry.tribulationType === null || CANONICAL_TYPES.has(entry.tribulationType),
      `entry "${entry.realmId}" tribulationType must be null or one of the canonical DESIGN.md types (got ${String(entry.tribulationType)})`
    );
  }
  const typesSeen = new Set(
    entries.map((entry) => entry.tribulationType).filter((type) => type !== null)
  );
  assert.equal(
    typesSeen.size,
    CANONICAL_TYPES.size,
    `all ${CANONICAL_TYPES.size} canonical tribulation types must appear across entries`
  );
  for (const type of CANONICAL_TYPES) {
    assert.ok(
      typesSeen.has(type),
      `canonical tribulation type "${type}" must appear in at least one entry`
    );
  }
});

test('gated entries carry a non-empty results table from the canonical 4-outcome whitelist', () => {
  assert.equal(CANONICAL_OUTCOMES.size, 4, 'exactly four canonical outcomes');
  assert.ok(
    !CANONICAL_OUTCOMES.has('death'),
    'death must be excluded in v1 (DESIGN.md marks it future optional)'
  );
  const gated = entries.filter((entry) => entry.tribulationType !== null);
  assert.ok(gated.length > 0, 'there must be at least one gated realm');
  for (const entry of gated) {
    assert.ok(
      Array.isArray(entry.results) && entry.results.length > 0,
      `gated entry "${entry.realmId}" results must be a non-empty array`
    );
    let total = 0;
    for (const result of entry.results) {
      assert.ok(
        CANONICAL_OUTCOMES.has(result.outcome),
        `entry "${entry.realmId}" has unknown outcome "${String(result.outcome)}"`
      );
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

test('success outcomes carry no progressLoss; failure outcomes carry a finite 0..1 loss', () => {
  for (const entry of entries) {
    for (const result of entry.results) {
      if (SUCCESS_OUTCOMES.has(result.outcome)) {
        assert.equal(
          result.progressLoss,
          undefined,
          `success outcome "${result.outcome}" in "${entry.realmId}" must not declare progressLoss (the gate opens unconditionally)`
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
  for (const entry of entries.filter((candidate) => candidate.tribulationType !== null)) {
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

test('ungated entries carry an empty results table', () => {
  const ungated = entries.filter((entry) => entry.tribulationType === null);
  assert.ok(ungated.length > 0, 'there must be at least one ungated realm');
  for (const entry of ungated) {
    assert.ok(
      Array.isArray(entry.results) && entry.results.length === 0,
      `ungated entry "${entry.realmId}" results must be an empty array (got ${JSON.stringify(entry.results)})`
    );
  }
});

test('the manifest registers the tribulations collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('tribulations'),
    'manifest must register a "tribulations" collection'
  );

  const entry = rawManifest.collections.find(
    (candidate) => candidate.id === 'tribulations'
  );
  assert.deepEqual(entry.files, ['data/tribulations/tribulations.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'realmId',
    'tribulationType',
    'results',
  ]);
  assert.equal(entry.validation.uniqueField, 'realmId');
});

test('the tribulations collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('tribulations');

  assert.deepEqual(result.errors, [], 'tribulations collection must load without validation errors');
  assert.equal(result.count, 15);
  assert.equal(dataManager.count('tribulations'), 15);
  assert.ok(dataManager.isLoaded('tribulations'), 'tribulations collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('tribulations'),
    entries.map((entry) => entry.realmId)
  );
});

test('cached tribulation definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('tribulations');

  const cached = dataManager.getAll('tribulations');
  assert.equal(cached.length, 15);
  for (const definition of cached) {
    assert.ok(
      Object.isFrozen(definition),
      `cached tribulation "${definition.realmId}" must be frozen`
    );
    assert.ok(
      Object.isFrozen(definition.results),
      `cached tribulation "${definition.realmId}" results array must be frozen`
    );
  }
});
