/**
 * tests/data/game-config.test.mjs — content validation of data/game-config.json.
 *
 * Guards the central tuning file against config drift: the offline-progress
 * block must be well-formed, and every producer's dot path (path, ratePath,
 * capPath) must resolve against the real GameState default shape — so a typo
 * in a producer path fails here instead of silently yielding zero gains at
 * runtime. The notation block must declare a default style that names one of
 * its own styles, and every style must carry a positive numeric threshold and
 * a suffixes array of strings. The file is read relative to this module
 * (import.meta.url), never via an absolute path, so the test is portable: it
 * works identically no matter which machine or directory the repo is checked
 * out into.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameState } from '../../js/core/game-state.js';

/**
 * Load the real config relative to this test file. `new URL(..., import.meta.url)`
 * resolves against the module's own location, so the path works on any machine.
 */
const config = JSON.parse(
  readFileSync(new URL('../../data/game-config.json', import.meta.url), 'utf8')
);

test('offline block declares offline progress with a sane shape', () => {
  const offline = config.offline;
  assert.ok(offline, 'config.offline block must exist');
  assert.equal(typeof offline.enabled, 'boolean');
  assert.ok(
    Number.isFinite(offline.maxOfflineMs) && offline.maxOfflineMs >= 0,
    'offline.maxOfflineMs must be a non-negative finite number'
  );
  assert.ok(Array.isArray(offline.producers), 'offline.producers must be an array');
  assert.ok(offline.producers.length > 0, 'at least one producer must be declared');
});

test('meditation block declares the qi-per-second rate with a sane shape', () => {
  const meditation = config.meditation;
  assert.ok(meditation, 'config.meditation block must exist');
  assert.ok(
    Number.isFinite(meditation.baseQiPerSecond) && meditation.baseQiPerSecond >= 0,
    'meditation.baseQiPerSecond must be a non-negative finite number'
  );
});

test('qi block declares the qi cap and its per-second sources', () => {
  const qi = config.qi;
  assert.ok(qi, 'config.qi block must exist');
  assert.ok(
    Number.isFinite(qi.baseMaxQi) && qi.baseMaxQi >= 0,
    'qi.baseMaxQi must be a non-negative finite number'
  );
  assert.ok(Array.isArray(qi.sources), 'qi.sources must be an array');
  assert.ok(qi.sources.length > 0, 'at least one qi source must be declared');
});

test('every qi source carries a non-empty id, label and ratePath with unique ids', () => {
  const ids = new Set();
  for (const source of config.qi.sources) {
    assert.equal(typeof source.id, 'string', `source missing id (${JSON.stringify(source)})`);
    assert.ok(source.id !== '', 'source id must not be empty');
    assert.equal(typeof source.label, 'string', `source "${source.id}" missing label`);
    assert.ok(source.label !== '', `source "${source.id}" label must not be empty`);
    assert.equal(typeof source.ratePath, 'string', `source "${source.id}" missing ratePath`);
    assert.ok(source.ratePath !== '', `source "${source.id}" ratePath must not be empty`);
    assert.ok(!ids.has(source.id), `source ids must be unique (duplicate "${source.id}")`);
    ids.add(source.id);
  }
});

test('every qi source ratePath resolves against the real GameState shape', () => {
  for (const source of config.qi.sources) {
    assert.ok(
      _resolves(GameState, source.ratePath),
      `source "${source.id}" ratePath "${source.ratePath}" does not resolve in GameState`
    );
  }
});

test('every producer carries a non-empty id, path and ratePath', () => {
  for (const producer of config.offline.producers) {
    assert.equal(typeof producer.id, 'string', `producer missing id (${JSON.stringify(producer)})`);
    assert.ok(producer.id !== '', 'producer id must not be empty');
    assert.equal(typeof producer.path, 'string', `producer "${producer.id}" missing path`);
    assert.ok(producer.path !== '', `producer "${producer.id}" path must not be empty`);
    assert.equal(typeof producer.ratePath, 'string', `producer "${producer.id}" missing ratePath`);
    assert.ok(producer.ratePath !== '', `producer "${producer.id}" ratePath must not be empty`);
    // capPath is optional, but when present it must be a non-empty string.
    if (producer.capPath !== undefined) {
      assert.equal(typeof producer.capPath, 'string', `producer "${producer.id}" capPath must be a string`);
      assert.ok(producer.capPath !== '', `producer "${producer.id}" capPath must not be empty`);
    }
  }
});

test('every producer path resolves against the real GameState shape', () => {
  for (const producer of config.offline.producers) {
    const paths = [
      ['path', producer.path],
      ['ratePath', producer.ratePath],
    ];
    if (producer.capPath !== undefined) {
      paths.push(['capPath', producer.capPath]);
    }
    for (const [field, dotPath] of paths) {
      assert.ok(
        _resolves(GameState, dotPath),
        `producer "${producer.id}" ${field} "${dotPath}" does not resolve in GameState`
      );
    }
  }
});

test('resources block declares wallet resources with a sane shape', () => {
  const resources = config.resources;
  assert.ok(resources, 'config.resources block must exist');
  assert.ok(Array.isArray(resources.items), 'resources.items must be an array');
  assert.ok(resources.items.length > 0, 'at least one resource must be declared');
});

test('every resource item carries a non-empty id and label with unique ids', () => {
  const ids = new Set();
  for (const item of config.resources.items) {
    assert.equal(typeof item.id, 'string', `resource item missing id (${JSON.stringify(item)})`);
    assert.ok(item.id !== '', 'resource item id must not be empty');
    assert.equal(typeof item.label, 'string', `resource "${item.id}" missing label`);
    assert.ok(item.label !== '', `resource "${item.id}" label must not be empty`);
    assert.ok(!ids.has(item.id), `resource ids must be unique (duplicate "${item.id}")`);
    ids.add(item.id);
  }
});

test('every resource item capPath is optional but non-empty when present', () => {
  for (const item of config.resources.items) {
    if (item.capPath !== undefined) {
      assert.equal(typeof item.capPath, 'string', `resource "${item.id}" capPath must be a string`);
      assert.ok(item.capPath !== '', `resource "${item.id}" capPath must not be empty`);
    }
  }
});

test('every resource id is a key of GameState.resources', () => {
  for (const item of config.resources.items) {
    assert.ok(
      item.id in GameState.resources,
      `resource "${item.id}" has no matching key in GameState.resources`
    );
  }
});

test('every resource capPath resolves against the real GameState shape', () => {
  for (const item of config.resources.items) {
    if (item.capPath !== undefined) {
      assert.ok(
        _resolves(GameState, item.capPath),
        `resource "${item.id}" capPath "${item.capPath}" does not resolve in GameState`
      );
    }
  }
});

test('notation block declares a default style that is one of its own styles', () => {
  const notation = config.notation;
  assert.ok(notation, 'config.notation block must exist');
  assert.equal(typeof notation.defaultStyle, 'string');
  assert.ok(notation.defaultStyle !== '', 'notation.defaultStyle must not be empty');
  assert.ok(
    notation.styles && typeof notation.styles === 'object' && !Array.isArray(notation.styles),
    'notation.styles must be an object'
  );
  assert.ok(
    Object.keys(notation.styles).length > 0,
    'notation.styles must not be empty'
  );
  assert.ok(
    notation.defaultStyle in notation.styles,
    `notation.defaultStyle "${notation.defaultStyle}" must be a key of notation.styles`
  );
});

test('every notation style has a positive numeric threshold and string suffixes', () => {
  for (const [name, style] of Object.entries(config.notation.styles)) {
    assert.equal(typeof style.threshold, 'number', `style "${name}" missing threshold`);
    assert.ok(
      Number.isFinite(style.threshold) && style.threshold > 0,
      `style "${name}" threshold must be a finite number greater than 0`
    );
    assert.ok(Array.isArray(style.suffixes), `style "${name}" suffixes must be an array`);
    for (const suffix of style.suffixes) {
      assert.equal(typeof suffix, 'string', `style "${name}" suffix must be a string`);
    }
  }
});

test('notifications block declares the queue bound and its type catalog', () => {
  const notifications = config.notifications;
  assert.ok(notifications, 'config.notifications block must exist');
  assert.ok(
    Number.isFinite(notifications.maxQueueSize) && notifications.maxQueueSize >= 1,
    'notifications.maxQueueSize must be a finite number >= 1'
  );
  assert.ok(Array.isArray(notifications.types), 'notifications.types must be an array');
  assert.ok(notifications.types.length > 0, 'at least one notification type must be declared');
  const ids = new Set();
  for (const typeId of notifications.types) {
    assert.equal(typeof typeId, 'string', `type id must be a string (${JSON.stringify(typeId)})`);
    assert.ok(typeId !== '', 'type id must not be empty');
    assert.ok(!ids.has(typeId), `type ids must be unique (duplicate "${typeId}")`);
    ids.add(typeId);
  }
});

/**
 * Whether a dot path resolves through a root object: every intermediate
 * segment must be an object and the terminal segment must be defined.
 * Mirrors the path resolution the OfflineProgress system performs at runtime.
 *
 * @param {object} root — state object to resolve against.
 * @param {string} dotPath — dot-separated path.
 * @returns {boolean} true when the path resolves to a defined value.
 */
function _resolves(root, dotPath) {
  let current = root;
  for (const segment of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return false;
    if (!(segment in current)) return false;
    current = current[segment];
  }
  return current !== undefined;
}
