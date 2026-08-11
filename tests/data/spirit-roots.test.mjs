/**
 * tests/data/spirit-roots.test.mjs — content validation of
 * data/spirit-roots/spirit-roots.json.
 *
 * Guards the Phase-3 spirit root ladder (ROADMAP "Spirit Roots") against data
 * drift: the collection must be the canonical 10-type DESIGN.md progression
 * (No Root → Chaos) in exact worst→best order, ids must be unique, kebab-case
 * and exactly the 10 canonical ids, tier must be a bijection 0..9 matching
 * array position (file order = ladder order), speedMultiplier must be finite
 * positive and non-decreasing across the ladder (it feeds
 * cultivation.spiritRootMultiplier in the future SpiritRootSystem),
 * attributes must carry exactly the 5 canonical DESIGN.md keys (purity,
 * stability, growth, mutation, compatibility) each finite in 0..1, elements
 * must be drawn only from the canonical 12-element set (Fire, Water, Earth,
 * Metal, Wood, Lightning, Ice, Wind, Light, Dark, Space, Time), weight must
 * be finite positive, and every name must be a non-empty string. No lore is
 * asserted — only the data contract. The manifest's spirit-roots entry must
 * declare the exact requiredFields list, so a root missing any contract
 * field fails here instead of silently degrading at runtime.
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
const rawSpiritRoots = JSON.parse(
  readFileSync(new URL('../../data/spirit-roots/spirit-roots.json', import.meta.url), 'utf8')
);
const rawManifest = JSON.parse(
  readFileSync(new URL('../../data/manifest.json', import.meta.url), 'utf8')
);

/** Every spirit root entry (the file uses the definitions shape). */
const entries = rawSpiritRoots.definitions;

/**
 * The canonical 10-type spirit root ladder from DESIGN.md "Spirit Roots",
 * worst → best, in exact progression order: [id, name] pairs.
 */
const CANONICAL_LADDER = [
  ['no-root', 'No Root'],
  ['pseudo-root', 'Pseudo Root'],
  ['mixed-root', 'Mixed Root'],
  ['three-element', 'Three Element'],
  ['dual-element', 'Dual Element'],
  ['single-element', 'Single Element'],
  ['mutated', 'Mutated'],
  ['heavenly', 'Heavenly'],
  ['divine', 'Divine'],
  ['chaos', 'Chaos'],
];

/** Canonical element id whitelist (DESIGN.md 'Spirit Roots', all 12). */
const CANONICAL_ELEMENTS = new Set([
  'fire',
  'water',
  'earth',
  'metal',
  'wood',
  'lightning',
  'ice',
  'wind',
  'light',
  'dark',
  'space',
  'time',
]);

/** Canonical attribute keys (DESIGN.md 'Spirit Roots', all 5). */
const CANONICAL_ATTRIBUTES = ['purity', 'stability', 'growth', 'mutation', 'compatibility'];

/** Kebab-case id pattern (lowercase letters/digits, single hyphens). */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Real data files served by the stubbed fetch, keyed by relative URL. */
const DATA_FILES = {
  'data/manifest.json': rawManifest,
  'data/spirit-roots/spirit-roots.json': rawSpiritRoots,
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

test('the file loads as a non-empty array with exactly 10 entries', () => {
  assert.ok(
    Array.isArray(entries),
    'data/spirit-roots/spirit-roots.json must carry a "definitions" array'
  );
  assert.ok(entries.length > 0, 'the definitions array must not be empty');
  assert.equal(
    entries.length,
    10,
    `the ladder must contain exactly 10 spirit roots (the DESIGN.md 10-type progression; got ${entries.length})`
  );
});

test('ids are unique, kebab-case and exactly the 10 canonical ids in ladder order', () => {
  assert.deepEqual(
    entries.map((root) => root.id),
    CANONICAL_LADDER.map(([id]) => id),
    'spirit root ids must follow the canonical DESIGN.md ladder order exactly (no-root … chaos)'
  );
  const ids = new Set();
  for (const root of entries) {
    assert.ok(
      KEBAB_CASE.test(root.id),
      `root id "${root.id}" must be kebab-case (lowercase letters/digits separated by single hyphens)`
    );
    assert.ok(!ids.has(root.id), `spirit root ids must be unique (duplicate "${root.id}")`);
    ids.add(root.id);
  }
  assert.equal(ids.size, 10, 'exactly 10 distinct root ids');
  assert.equal(entries[0].id, 'no-root', 'the first entry must be No Root');
  assert.equal(entries[entries.length - 1].id, 'chaos', 'the last entry must be Chaos');
});

test('names follow the canonical DESIGN.md ladder order', () => {
  assert.deepEqual(
    entries.map((root) => root.name),
    CANONICAL_LADDER.map(([, name]) => name),
    'spirit root names must follow the canonical DESIGN.md ladder order exactly'
  );
});

test('tier is a bijection 0..9 in file order (file order = ladder order)', () => {
  for (const [index, root] of entries.entries()) {
    assert.ok(
      Number.isInteger(root.tier),
      `root "${root.id}" tier must be an integer (got ${String(root.tier)})`
    );
    assert.equal(
      root.tier,
      index,
      `root "${root.id}" tier must equal its array position ${index} (got ${root.tier})`
    );
  }
  const tiers = entries.map((root) => root.tier);
  assert.deepEqual(
    [...tiers].sort((a, b) => a - b),
    Array.from({ length: 10 }, (_, i) => i),
    'every tier 0..9 must be present exactly once (no gaps, no duplicates)'
  );
});

test('speedMultiplier is finite, positive and non-decreasing across the ladder', () => {
  for (const root of entries) {
    assert.ok(
      Number.isFinite(root.speedMultiplier) && root.speedMultiplier > 0,
      `root "${root.id}" speedMultiplier must be a finite number > 0 (got ${String(root.speedMultiplier)})`
    );
  }
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    assert.ok(
      current.speedMultiplier >= previous.speedMultiplier,
      `speedMultiplier must be non-decreasing across tiers: "${previous.id}" (${previous.speedMultiplier}) -> "${current.id}" (${current.speedMultiplier})`
    );
  }
});

test('attributes has exactly the 5 canonical keys, each finite in 0..1', () => {
  for (const root of entries) {
    assert.ok(
      root.attributes !== null &&
        typeof root.attributes === 'object' &&
        !Array.isArray(root.attributes),
      `root "${root.id}" attributes must be a plain object`
    );
    assert.deepEqual(
      Object.keys(root.attributes),
      CANONICAL_ATTRIBUTES,
      `root "${root.id}" attributes must have exactly the canonical keys ${CANONICAL_ATTRIBUTES.join(', ')}`
    );
    for (const key of CANONICAL_ATTRIBUTES) {
      const value = root.attributes[key];
      assert.ok(
        Number.isFinite(value) && value >= 0 && value <= 1,
        `root "${root.id}" attribute "${key}" must be a finite number in 0..1 (got ${String(value)})`
      );
    }
  }
});

test('elements is an array and every element id is in the canonical 12-set', () => {
  assert.equal(CANONICAL_ELEMENTS.size, 12, 'exactly twelve canonical elements');
  for (const root of entries) {
    assert.ok(Array.isArray(root.elements), `root "${root.id}" elements must be an array`);
    for (const element of root.elements) {
      assert.ok(
        CANONICAL_ELEMENTS.has(element),
        `root "${root.id}" has unknown element "${String(element)}" (must be one of the canonical 12)`
      );
    }
  }
});

test('weight is a finite number > 0', () => {
  for (const root of entries) {
    assert.ok(
      Number.isFinite(root.weight) && root.weight > 0,
      `root "${root.id}" weight must be a finite number > 0 (got ${String(root.weight)})`
    );
  }
});

test('every name is a non-empty string', () => {
  for (const root of entries) {
    assert.equal(typeof root.name, 'string', `root "${root.id}" missing name`);
    assert.ok(root.name !== '', `root "${root.id}" name must not be empty`);
  }
});

test('the manifest registers the spirit-roots collection with the entry contract', () => {
  const collectionIds = rawManifest.collections.map((entry) => entry.id);
  assert.ok(
    collectionIds.includes('spirit-roots'),
    'manifest must register a "spirit-roots" collection'
  );

  const entry = rawManifest.collections.find((candidate) => candidate.id === 'spirit-roots');
  assert.deepEqual(entry.files, ['data/spirit-roots/spirit-roots.json']);
  assert.deepEqual(entry.validation.requiredFields, [
    'id',
    'name',
    'tier',
    'elements',
    'attributes',
    'speedMultiplier',
    'weight',
  ]);
  assert.equal(entry.validation.uniqueField, 'id');
});

test('the spirit-roots collection loads through the DataManager with zero errors', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  const result = await dataManager.loadCollection('spirit-roots');

  assert.deepEqual(result.errors, [], 'spirit-roots collection must load without validation errors');
  assert.equal(result.count, 10);
  assert.equal(dataManager.count('spirit-roots'), 10);
  assert.ok(dataManager.isLoaded('spirit-roots'), 'spirit-roots collection must be marked as loaded');
  // The cache preserves file order, so the keys mirror the raw entries.
  assert.deepEqual(
    dataManager.keys('spirit-roots'),
    entries.map((root) => root.id)
  );
});

test('cached spirit root definitions are deep-frozen and read-only', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFetch());

  const dataManager = new DataManager({ manifestPath: 'data/manifest.json' });
  await dataManager.loadCollection('spirit-roots');

  const cached = dataManager.getAll('spirit-roots');
  assert.equal(cached.length, 10);
  for (const definition of cached) {
    assert.ok(Object.isFrozen(definition), `cached spirit root "${definition.id}" must be frozen`);
    assert.ok(
      Object.isFrozen(definition.elements),
      `cached spirit root "${definition.id}" elements array must be frozen`
    );
    assert.ok(
      Object.isFrozen(definition.attributes),
      `cached spirit root "${definition.id}" attributes object must be frozen`
    );
  }
});
