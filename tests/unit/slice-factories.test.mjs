/**
 * tests/unit/slice-factories.test.mjs — unit tests for the canonical fresh
 * slice factories exported from js/core/game-state.js.
 *
 * Guard against restore-trust drift: the factories are the single source of
 * truth every gameplay system imports (js/systems/*.js), so they must mirror
 * the canonical state slices FIELD-FOR-FIELD and hand back a NEW object on
 * every call. If the canonical `cultivation` / `player` / `statistics` blocks
 * in core/game-state.js change, these deep-equality assertions fail until the
 * factory (and this test) are updated in the same commit.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameState,
  freshCultivationSlice,
  freshPlayerSlice,
  freshStatisticsSlice,
  coerceMultiplier,
} from '../../js/core/game-state.js';

test('freshCultivationSlice() deep-equals the canonical cultivation slice', () => {
  assert.deepStrictEqual(freshCultivationSlice(), createGameState().cultivation);
});

test('freshPlayerSlice() deep-equals the canonical player slice', () => {
  assert.deepStrictEqual(freshPlayerSlice(), createGameState().player);
});

test('freshStatisticsSlice() deep-equals the canonical statistics slice', () => {
  assert.deepStrictEqual(freshStatisticsSlice(), createGameState().statistics);
});

test('every fresh factory returns a NEW object each call (mutations never leak)', () => {
  const first = freshCultivationSlice();
  const second = freshCultivationSlice();
  assert.notStrictEqual(first, second);
  // Nested containers are fresh too.
  assert.notStrictEqual(first.realmEffects, second.realmEffects);
  assert.notStrictEqual(first.qiSources, second.qiSources);

  // Mutating one call's result must not affect the next call or the canonical
  // construction.
  first.qi = 5;
  first.realmEffects.qiMaxMultiplier = 2;
  first.qiSources.meditation = 9;
  assert.equal(second.qi, 0);
  assert.equal(second.realmEffects.qiMaxMultiplier, 1);
  assert.equal(second.qiSources.meditation, 0);
  assert.equal(createGameState().cultivation.qi, 0);
  assert.equal(createGameState().cultivation.realmEffects.qiMaxMultiplier, 1);
  assert.equal(createGameState().cultivation.qiSources.meditation, 0);

  const playerA = freshPlayerSlice();
  const playerB = freshPlayerSlice();
  assert.notStrictEqual(playerA, playerB);
  playerA.name = 'Ren';
  assert.equal(playerB.name, 'Unnamed Cultivator');
  assert.equal(createGameState().player.name, 'Unnamed Cultivator');

  const statsA = freshStatisticsSlice();
  const statsB = freshStatisticsSlice();
  assert.notStrictEqual(statsA, statsB);
  statsA.qiGenerated = 99;
  assert.equal(statsB.qiGenerated, 0);
  assert.equal(createGameState().statistics.qiGenerated, 0);
});

test('coerceMultiplier returns the neutral 1 for anything unusable and keeps finite positives', () => {
  const table = [
    [undefined, 1],
    [null, 1],
    [NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [0, 1],
    [-5, 1],
    ['abc', 1],
    ['', 1],
    ['3.5', 3.5],
    [2, 2],
    [0.5, 0.5],
  ];
  for (const [input, expected] of table) {
    assert.equal(coerceMultiplier(input), expected, `coerceMultiplier(${String(input)})`);
  }
});
