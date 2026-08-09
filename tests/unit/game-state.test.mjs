/**
 * tests/unit/game-state.test.mjs — unit tests for js/core/game-state.js.
 *
 * Locks the GameState singleton's placeholder shape to the exact defaults
 * every gameplay system will build on. The singleton is a module-level
 * const shared by the whole app; these tests are read-only (no mutation),
 * so the shared instance stays pristine and no isolation dance is needed.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../../js/core/game-state.js';

test('has the exact default placeholder shape', () => {
  assert.deepEqual(GameState, {
    version: {
      schema: 1,
      game: '0.1.0',
    },

    player: {
      name: 'Unnamed Cultivator',
      title: '',
      spiritRoot: 'Unawakened',
      physique: 'Common',
      bloodline: 'None',
      meridians: 0,
    },

    cultivation: {
      realm: 'Mortal',
      realmStage: 1,
      nextRealm: 'Qi Condensation',
      breakthroughCost: null,
      realmProgress: 0,
      realmProgressMax: 1000,
      qi: 0,
      qiMax: 100,
      qiPerSecond: 0,
      breakthroughs: 0,
    },

    resources: {
      spiritStones: 0,
      herbs: 0,
      jade: 0,
      qiCondensationPills: 0,
    },

    inventory: {
      slots: {
        total: 20,
        used: 0,
      },
      items: [],
    },

    techniques: {
      known: [],
      active: [],
      activeSlots: 3,
    },

    sect: {
      name: 'None',
      rank: 'Outer Disciple',
      contributions: 0,
    },

    world: {
      region: 'Mortal Plains',
      unlockedRegions: ['Mortal Plains'],
      time: 0,
    },

    settings: {
      offlineProgress: true,
      sound: false,
      notifications: false,
    },

    statistics: {
      playtimeMs: 0,
      meditationsCompleted: 0,
      breakthroughsTotal: 0,
      qiGenerated: 0,
    },
  });
});

test('exposes exactly the ten top-level state slices', () => {
  assert.deepEqual(Object.keys(GameState).sort(), [
    'cultivation',
    'inventory',
    'player',
    'resources',
    'sect',
    'settings',
    'statistics',
    'techniques',
    'version',
    'world',
  ]);
});

test('placeholder values later systems build on start empty or zeroed', () => {
  assert.deepEqual(GameState.inventory.items, []);
  assert.deepEqual(GameState.techniques.known, []);
  assert.deepEqual(GameState.techniques.active, []);
  assert.deepEqual(GameState.world.unlockedRegions, ['Mortal Plains']);

  assert.equal(GameState.player.meridians, 0);
  assert.equal(GameState.cultivation.realmStage, 1);
  assert.equal(GameState.cultivation.realmProgress, 0);
  assert.equal(GameState.cultivation.qi, 0);
  assert.equal(GameState.cultivation.breakthroughs, 0);
  assert.equal(GameState.resources.spiritStones, 0);
  assert.equal(GameState.inventory.slots.used, 0);
  assert.equal(GameState.sect.contributions, 0);
  assert.equal(GameState.world.time, 0);
  assert.equal(GameState.statistics.playtimeMs, 0);
});

test('default settings favour offline progress and stay silent by default', () => {
  assert.equal(GameState.settings.offlineProgress, true);
  assert.equal(GameState.settings.sound, false);
  assert.equal(GameState.settings.notifications, false);
});
