/**
 * core/game-state.js — centralized game state (placeholder).
 *
 * Single source of truth for every piece of game data. All values are
 * placeholders; gameplay systems will read from and mutate this object
 * as they are implemented. Pure data — no DOM access, no storage I/O,
 * framework-free and GitHub Pages compatible.
 *
 * Future plug-in: initialize this singleton from Storage.load() on boot
 * and pass it to Game so every system operates on the same instance.
 */

/**
 * A single game state instance representing the entire game.
 *
 * @typedef {Object} GameState
 * @property {Object} version — schema & game version info
 * @property {Object} meta — runtime bookkeeping (offline-progress last-seen timestamp)
 * @property {Object} player — character identity and attributes
 * @property {Object} cultivation — cultivation progress and qi
 * @property {Object} resources — currency and material counts
 * @property {Object} inventory — carried items
 * @property {Object} techniques — known and active techniques
 * @property {Object} sect — sect membership
 * @property {Object} world — world position and progression
 * @property {Object} settings — user preferences
 * @property {Object} statistics — lifetime counters
 */

/**
 * Build a fresh game state instance.
 *
 * @returns {GameState} the full placeholder state.
 */
function createGameState() {
  return {
    version: {
      schema: 1,
      game: '0.1.0',
    },

    meta: {
      // Wall-clock (epoch ms) of the end of the last active session. Owned by
      // the OfflineProgress system (js/core/offline-progress.js): stamped on
      // every save and read on boot to measure time spent away. 0 = never
      // played before (a fresh game gets no offline progress).
      lastSeenAt: 0,
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
  };
}

/**
 * Singleton instance shared across the application.
 * Every gameplay and UI module should read/write this same object.
 */
export const GameState = createGameState();
