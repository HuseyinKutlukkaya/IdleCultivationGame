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

    meta: {
      lastSeenAt: 0,
    },

    meditation: {
      active: true,
      mode: 'basic',
      startedAt: 0,
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
      qiSources: { meditation: 0, upgrades: 0 },
      breakthroughs: 0,
    },

    resources: {
      // Master's parting gift (Phase 2 origin endowment) — the only
      // spirit-stone source in Phase 2. Phase 5 Sects will introduce
      // stipends and replace this narrative with sustainable income.
      spiritStones: 50,
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

    upgrades: {
      purchased: {},
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
      notationStyle: null,
    },

    statistics: {
      playtimeMs: 0,
      meditationsCompleted: 0,
      breakthroughsTotal: 0,
      qiGenerated: 0,
    },
  });
});

test('exposes exactly the thirteen top-level state slices', () => {
  assert.deepEqual(Object.keys(GameState).sort(), [
    'cultivation',
    'inventory',
    'meditation',
    'meta',
    'player',
    'resources',
    'sect',
    'settings',
    'statistics',
    'techniques',
    'upgrades',
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
  // Master's parting gift — fresh-state spirit-stone endowment (50 stones).
  // The other resources still start at zero (no equivalent endowment for
  // herbs/jade/pills yet; those arrive with the Phase-4 alchemical market).
  assert.equal(GameState.resources.spiritStones, 50);
  assert.equal(GameState.inventory.slots.used, 0);
  assert.equal(GameState.sect.contributions, 0);
  assert.equal(GameState.world.time, 0);
  assert.equal(GameState.meta.lastSeenAt, 0);
  assert.equal(GameState.statistics.playtimeMs, 0);

  // The meditation slice starts as a fresh active 'basic' session (the
  // MeditationSystem syncs the per-second rate from this flag).
  assert.equal(GameState.meditation.active, true);
  assert.equal(GameState.meditation.mode, 'basic');
  assert.equal(GameState.meditation.startedAt, 0);
});

test('default settings favour offline progress and stay silent by default', () => {
  assert.equal(GameState.settings.offlineProgress, true);
  assert.equal(GameState.settings.sound, false);
  assert.equal(GameState.settings.notifications, false);
  assert.equal(GameState.settings.notationStyle, null);
});
