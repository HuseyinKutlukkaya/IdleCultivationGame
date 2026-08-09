/**
 * tests/unit/config.test.mjs — unit tests for js/core/config.js.
 *
 * Exercises loadConfig() — the bootstrap fetch of data/game-config.json —
 * against a stubbed global fetch: the success path (HTTP 200 + JSON body),
 * the fail-soft path for a non-ok response, and the fail-soft path for a
 * rejected fetch. Every failure must yield null (never throw) after logging
 * the error to console.error.
 *
 * fetch and console.error are stubbed with `t.mock.method` (node:test
 * mocks), which auto-restores the originals when each test ends.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../js/core/config.js';

test('returns the parsed config when the fetch succeeds', async (t) => {
  const config = { meta: { version: '0.1.0' }, loop: { tickRateMs: 1000 } };
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => config,
  }));

  const result = await loadConfig();

  assert.deepEqual(result, config);
  // The loader requests exactly the central tuning file, resolved against
  // the project root as an absolute URL.
  assert.equal(fetchMock.mock.callCount(), 1);
  const requested = fetchMock.mock.calls[0].arguments[0];
  assert.ok(requested instanceof URL, 'fetch should receive a URL object');
  assert.ok(requested.href.endsWith('/data/game-config.json'), requested.href);
});

test('returns null and logs when the response is not ok (fail-soft)', async (t) => {
  const errorMock = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  }));

  const result = await loadConfig();

  assert.equal(result, null);
  assert.equal(errorMock.mock.callCount(), 1);
});

test('returns null and logs when fetch rejects (fail-soft)', async (t) => {
  const errorMock = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });

  const result = await loadConfig();

  assert.equal(result, null);
  assert.equal(errorMock.mock.callCount(), 1);
});

test('returns null and logs when response.json() rejects (fail-soft)', async (t) => {
  const errorMock = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('corrupt body');
    },
  }));

  const result = await loadConfig();

  assert.equal(result, null);
  assert.equal(errorMock.mock.callCount(), 1);
});
