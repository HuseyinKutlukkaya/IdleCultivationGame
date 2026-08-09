/**
 * tests/unit/paths.test.mjs — unit tests for js/utils/paths.js.
 *
 * Verifies the portable project-root resolver (the ESM/browser equivalent of
 * .NET's AppDomain.CurrentDomain.BaseDirectory / Application.StartupPath):
 * projectRoot() returns the repo root as a URL, and resolveFromRoot() anchors
 * relative segments to it. No machine-specific path is asserted anywhere —
 * the resolver is what makes data reads location-independent.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectRoot, resolveFromRoot } from '../../js/utils/paths.js';

test('projectRoot() returns the repo root as a directory URL', () => {
  const root = projectRoot();
  assert.ok(root instanceof URL);
  // A directory URL always ends with a slash.
  assert.ok(root.href.endsWith('/'), `root should end with '/': ${root.href}`);
  // The root is a parent of this module (js/utils/paths.js → two levels up).
  assert.ok(import.meta.url.startsWith(root.href), import.meta.url);
});

test('projectRoot() returns a fresh URL each call (no shared mutable state)', () => {
  const first = projectRoot();
  const second = projectRoot();
  assert.notEqual(first, second);
  assert.equal(first.href, second.href);
});

test('resolveFromRoot() anchors relative segments to the project root', () => {
  const config = resolveFromRoot('data', 'game-config.json');
  assert.ok(config instanceof URL);
  assert.ok(config.href.endsWith('/data/game-config.json'), config.href);
  // Same base as projectRoot().
  assert.ok(config.href.startsWith(projectRoot().href), config.href);
});

test('resolveFromRoot() tolerates dot segments and keeps the root base', () => {
  const backToRoot = resolveFromRoot('data', '..', 'manifest.json');
  assert.ok(backToRoot.href.endsWith('/manifest.json'), backToRoot.href);
});

test('the resolved config URL actually reads the real data file (no machine path)', () => {
  const configUrl = resolveFromRoot('data', 'game-config.json');
  const config = JSON.parse(readFileSync(configUrl, 'utf8'));
  assert.equal(config.meta.game, 'Idle Cultivation Game');
});
