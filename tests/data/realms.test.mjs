/**
 * tests/data/realms.test.mjs — content validation of data/realms/realms.json.
 *
 * Guards the Phase-3 realm ladder (ROADMAP "Realms (JSON-driven)") against
 * data drift: the collection must be the canonical 15-tier DESIGN.md
 * progression (Mortal → Beyond Heaven) in exact order, every realm must
 * carry the full realm contract (id, name, description, tier, the three
 * realm effects DESIGN.md names — qiMaxMultiplier, cultivationSpeedMultiplier,
 * powerMultiplier — plus lifespanYears and the unlocks array), ids must be
 * unique, tier values must be the contiguous integers 0..14 matching array
 * position, and the placeholder curves must stay monotonic (qiMaxMultiplier
 * strictly increasing — the DESIGN.md contract "each realm raises max qi" —
 * with lifespanYears and powerMultiplier non-decreasing). The manifest's
 * realms entry must declare the exact full requiredFields list, so a realm
 * missing any contract field fails here instead of silently degrading at
 * runtime.
 *
 * The REAL files are read relative to this module (import.meta.url), never
 * via an absolute path, so the test is portable: it works identically no
 * matter which machine or directory the repo is checked out into. The
 * collection is then loaded through the REAL DataManager pipeline (manifest
 * → fetch → validation → deep-freeze cache) with global fetch stubbed to
 * serve exactly the on-disk contents — so a malformed realm or a broken
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
const rawRealms = JSON.parse(
  readFileSync(new URL('../../data/realms/realms.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every realm definition in the ladder (the file uses the definitions shape). */
const realms = rawRealms.definitions;

/**
 * The canonical 15-tier realm ladder from DESIGN.md "Realms"
 * (Mortal → Beyond Heaven), in exact progression order: [id, name] pairs.
 * Any deviation in count, order, id or name fails the ladder assertions.
 */
const CANONICAL_LADDER = [
  ['mortal', 'Mortal'],
  ['qi-gathering', 'Qi Gathering'],
  ['foundation-establishment', 'Foundation Establishment'],
  ['core-formation', 'Core Formation'],
  ['nascent-soul', 'Nascent Soul'],
  ['soul-transformation', 'Soul Transformation'],
  ['void-refinement', 'Void Refinement'],
  ['body-integration', 'Body Integration'],
  ['great-ascension', 'Great Ascension'],
  ['true-immortal', 'True Immortal'],
  ['celestial-immortal', 'Celestial Immortal'],
  ['golden-immortal', 'Golden Immortal'],
  ['dao-lord', 'Dao Lord'],
  ['heavenly-sovereign', 'Heavenly Sovereign'],
  ['beyond-heaven', 'Beyond Heaven'],
];

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/realms/realms.json': rawRealms,
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

test('the realm ladder is the DESIGN.md 15-tier progression (Mortal → Beyond Heaven)', () => {
  assert.ok(
    Array.isArray(realms),
    'data/realms/realms.json must carry a "definitions" array'
  );
  assert.equal(
    realms.length,
    15,
    `the ladder must contain exactly 15 realms (the DESIGN.md 15-tier progression; got ${realms.length})`
  );
  assert.deepEqual(
    realms.map((realm) => realm.id),
    CANONICAL_LADDER.map(([id]) => id),
    'realm ids must follow the canonical DESIGN.md ladder order exactly'
  );
  assert.deepEqual(
    realms.map((realm) => realm.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'realm names must follow the canonical DESIGN.md ladder order exactly'
  );
  assert.equal(realms[0].id, 'mortal', 'tier 0 must be Mortal');
  assert.equal(realms[14].id, 'beyond-heaven', 'tier 14 must be Beyond Heaven');
});

test('tier values are the contiguous integers 0..14 matching array position', () => {
  for (const [index, realm] of realms.entries()) {
    assert.ok(
      Number.isInteger(realm.tier),
      `realm "${realm.id}" tier must be an integer (got ${String(realm.tier)})`
    );
    assert.equal(
      realm.tier,
      index,
      `realm "${realm.id}" tier must equal its array position ${index} (got ${realm.tier})`
    );
  }
  const tiers = realms.map((realm) => realm.tier);
  assert.deepEqual(
    [...tiers].sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, i) => i),
    'every tier 0..14 must be present exactly once (no gaps, no duplicates)'
  );
});

test('every realm carries the full data-driven contract shape', () => {
  for (const realm of realms) {
    assert.equal(typeof realm.id, 'string', `realm missing id (${JSON.stringify(realm)})`);
    assert.ok(realm.id !== '', 'realm id must not be empty');
    assert.equal(typeof realm.name, 'string', `realm "${realm.id}" missing name`);
    assert.ok(realm.name !== '', `realm "${realm.id}" name must not be empty`);
    assert.equal(typeof realm.description, 'string', `realm "${realm.id}" missing description`);
    assert.ok(realm.description !== '', `realm "${realm.id}" description must not be empty`);
    assert.ok(
      Number.isFinite(realm.qiMaxMultiplier) && realm.qiMaxMultiplier > 0,
      `realm "${realm.id}" qiMaxMultiplier must be a finite number > 0 (got ${String(realm.qiMaxMultiplier)})`
    );
    assert.ok(
      Number.isFinite(realm.cultivationSpeedMultiplier) && realm.cultivationSpeedMultiplier > 0,
      `realm "${realm.id}" cultivationSpeedMultiplier must be a finite number > 0 (got ${String(realm.cultivationSpeedMultiplier)})`
    );
    assert.ok(
      Number.isFinite(realm.powerMultiplier) && realm.powerMultiplier > 0,
      `realm "${realm.id}" powerMultiplier must be a finite number > 0 (got ${String(realm.powerMultiplier)})`
    );
    assert.ok(
      Number.isFinite(realm.lifespanYears) && realm.lifespanYears > 0,
      `realm "${realm.id}" lifespanYears must be a finite number > 0 (got ${String(realm.lifespanYears)})`
    );
    assert.ok(Array.isArray(realm.unlocks), `realm "${realm.id}" unlocks must be an array`);
  }
});

test('every realm id is unique', () => {
  const ids = new Set();
  for (const realm of realms) {
    assert.ok(!ids.has(realm.id), `realm ids must be unique (duplicate "${realm.id}")`);
    ids.add(realm.id);
  }
});

test('the placeholder balance curves stay monotonic across the ladder', () => {
  for (let i = 1; i < realms.length; i += 1) {
    const previous = realms[i - 1];
    const current = realms[i];
    // DESIGN.md: "Each realm raises max qi" — strictly increasing.
    assert.ok(
      current.qiMaxMultiplier > previous.qiMaxMultiplier,
      `qiMaxMultiplier must be strictly increasing: "${previous.id}" (${previous.qiMaxMultiplier}) -> ` +
        `"${current.id}" (${current.qiMaxMultiplier})`
    );
    // DESIGN.md: "Each realm raises ... efficiency ..." — non-decreasing.
    assert.ok(
      current.cultivationSpeedMultiplier >= previous.cultivationSpeedMultiplier,
      `cultivationSpeedMultiplier must be non-decreasing: "${previous.id}" ` +
        `(${previous.cultivationSpeedMultiplier}) -> "${current.id}" ` +
        `(${current.cultivationSpeedMultiplier})`
    );
    // DESIGN.md: "Each realm raises ... lifespan ... and power" — non-decreasing.
    assert.ok(
      current.lifespanYears >= previous.lifespanYears,
      `lifespanYears must be non-decreasing: "${previous.id}" (${previous.lifespanYears}) -> ` +
        `"${current.id}" (${current.lifespanYears})`
    );
    assert.ok(
      current.powerMultiplier >= previous.powerMultiplier,
      `powerMultiplier must be non-decreasing: "${previous.id}" (${previous.powerMultiplier}) -> ` +
        `"${current.id}" (${current.powerMultiplier})`
    );
  }
});

test('the manifest registers the realms collection with the full realm contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('realms'),
    'manifest must register a "realms" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'realms');
  assert.deepEqual(entry.files, ['data/realms/realms.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'description',
    'tier',
    'qiMaxMultiplier',
    'cultivationSpeedMultiplier',
    'lifespanYears',
    'powerMultiplier',
    'unlocks',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the realms collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('realms');

  assert.deepEqual(result.errors, [], 'realms collection must load without validation errors');
  assert.equal(result.count, 15);
  assert.equal(dataManager.count('realms'), 15);
  assert.ok(dataManager.isLoaded('realms'), 'realms collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw definitions.
  assert.deepEqual(dataManager.keys('realms'), realms.map((realm) => realm.id));
});

test('cached realm definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('realms');

  const cached = dataManager.getAll('realms');
  assert.equal(cached.length, 15);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached realm "${definition.id}" must be frozen`);
    assert.ok(
      Object.isFrozen(definition.unlocks),
      `cached realm "${definition.id}" unlocks array must be frozen`
    );
  }
});
