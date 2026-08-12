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
 * @property {Object} meditation — meditation session (active flag, mode, startedAt)
 * @property {Object} player — character identity and attributes
 * @property {Object} cultivation — cultivation progress and qi
 * @property {number} cultivation.spiritRootMultiplier — spirit-root cultivation-speed slot (neutral 1 while unawakened)
 * @property {Object} spiritRoot — the cultivator's spirit root (id, name, tier, elements, purity, stability, growth, mutation, compatibility, speedMultiplier)
 * @property {Object} meridians — the cultivator's meridian state (id, name, capacityMultiplier, flowMultiplier)
 * @property {number} cultivation.meridianCapacityMultiplier — meridian qi-cap slot (neutral 1 by default; written by MeridianSystem)
 * @property {number} cultivation.meridianFlowMultiplier — meridian qi-rate slot (neutral 1 by default; written by MeridianSystem)
 * @property {Object} resources — currency and material counts
 * @property {Object} inventory — carried items
 * @property {Object} techniques — known and active techniques
 * @property {Object} tribulations — tribulation gate on the current realm's breakthrough (type, pending, survived)
 * @property {Object} sect — sect membership
 * @property {Object} world — world position and progression
 * @property {Object} settings — user preferences
 * @property {boolean} settings.offlineProgress — keep generating resources while away
 * @property {boolean} settings.sound — play audio effects
 * @property {boolean} settings.notifications — surface browser/UI notifications
 * @property {?string} settings.notationStyle — null = the data-driven default style (see config.notation); a string = a style id from config.notation.styles (overrides the default)
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

    meditation: {
      // Owned by the MeditationSystem (js/systems/meditation.js). active means
      // the cultivator is currently meditating → produces qi every tick; mode
      // is a placeholder key (future: focused, deep, guided, automatic);
      // startedAt is the epoch ms the current session began (0 = no session).
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
      meridians: 'Normal',
    },

    cultivation: {
      // Realm identity. realm is the DISPLAY NAME (the UI binds it and old
      // saves store names — kept in state deliberately); realmTier is the
      // numeric progression key 0..14 that Breakthroughs will advance.
      // Both are owned/written by the RealmSystem (js/systems/realms.js).
      realm: 'Mortal',
      realmTier: 0,
      realmStage: 1,
      // Sub-layer progression within a realm (P4 — Nine sub-levels per
      // realm). Layer 1–9: each layer requires progressively more progress;
      // realm breakthrough (+ tribulation) gates on layer 9. Owned/written
      // by the RealmSystem (js/systems/realms.js). realmLayerMax is always 9.
      realmLayer: 1,
      realmLayerMax: 9,
      nextRealm: 'Qi Gathering',
      // Breakthrough progression. Owned/written by the BreakthroughSystem
      // (js/systems/breakthroughs.js): realmProgress accrues every tick from
      // qiPerSecond × config.breakthroughs.progressRate (clamped to
      // realmProgressMax); realmProgressMax is the current realm's
      // data-driven requiredProgress (data/breakthroughs/breakthroughs.json);
      // breakthroughCost is the current realm's spirit-stone cost (null = no
      // definition for the realm — the renderer renders null as "—"). Both
      // max and cost are re-synced on boot and after every accepted attempt.
      breakthroughCost: null,
      realmProgress: 0,
      realmProgressMax: 1000,
      // RealmSystem-owned effect slots (consumer pattern like qiSources):
      // the QiSystem reads qiMaxMultiplier (cap) and
      // cultivationSpeedMultiplier (rate) from here; powerMultiplier and
      // lifespanYears are future-consumer slots. Neutral fresh defaults =
      // the Mortal realm's data-driven effects (data/realms/realms.json).
      realmEffects: {
        qiMaxMultiplier: 1,
        cultivationSpeedMultiplier: 1,
        powerMultiplier: 1,
        lifespanYears: 100,
      },
      // Spirit-root cultivation-speed slot (consumer pattern like
      // realmEffects.cultivationSpeedMultiplier): written by the
      // SpiritRootSystem (js/systems/spirit-roots.js) from the current
      // root's data-driven speedMultiplier; the QiSystem stacks it into the
      // per-second rate aggregate. Fresh default 1 (neutral — exactly
      // today's rates); a missing/malformed value is coerced to 1 by the
      // QiSystem.
      spiritRootMultiplier: 1,
      // Meridian circulation slots (consumer pattern like
      // spiritRootMultiplier): written by the MeridianSystem
      // (js/systems/meridians.js) from the current meridian's data-driven
      // capacityMultiplier / flowMultiplier; the QiSystem stacks
      // meridianCapacityMultiplier into _computeQiMax (cap) and
      // meridianFlowMultiplier into the per-second rate aggregate.
      // Fresh default 1 (neutral — exactly today's rates); a
      // missing/malformed value is coerced to 1 by the QiSystem.
      meridianCapacityMultiplier: 1,
      meridianFlowMultiplier: 1,
      qi: 0,
      qiMax: 100,
      qiPerSecond: 0,
      // Per-source qi rate contribution slots. Each qi source owns its slot:
      // the MeditationSystem writes cultivation.qiSources.meditation (its
      // effective rate while active, 0 while inactive); the UpgradeSystem
      // (js/systems/upgrades.js) writes cultivation.qiSources.upgrades
      // (the aggregate of every qiRateAdd upgrade's effectPerLevel × level).
      // The QiSystem (js/systems/qi.js) aggregates them every tick via
      // config.qi.sources[].ratePath. More slots appear as more qi-producing
      // systems land.
      qiSources: { meditation: 0, upgrades: 0, techniques: 0 },
      breakthroughs: 0,
    },

    spiritRoot: {
      // Owned by the SpiritRootSystem (js/systems/spirit-roots.js). The
      // cultivator's primary cultivation affinity: id is the data-table key
      // (data/spirit-roots/spirit-roots.json — 'unawakened' matches nothing
      // in the ladder: the pre-roll state); name is the display name mirrored
      // on player.spiritRoot; tier is the numeric progression key, -1 below
      // the data ladder (data tiers are 0..9: no-root … chaos); elements
      // holds the future elemental-affinity slots (no consumer yet); purity /
      // stability / growth / mutation / compatibility are the five canonical
      // DESIGN attributes, neutral 0 while unawakened; speedMultiplier is the
      // data-driven cultivation-speed factor (1 = exactly today's rates, so
      // fresh games and old saves stay numerically identical).
      id: 'unawakened',
      name: 'Unawakened',
      tier: -1,
      elements: [],
      purity: 0,
      stability: 0,
      growth: 0,
      mutation: 0,
      compatibility: 0,
      speedMultiplier: 1,
    },

    meridians: {
      // Owned by the MeridianSystem (js/systems/meridians.js). The
      // cultivator's qi-circulation network state: id is the data-table key
      // (data/meridians/meridians.json — 'normal' in the ladder); name is
      // the display name mirrored on player.meridians; capacityMultiplier
      // feeds cultivation.meridianCapacityMultiplier (qi cap) and
      // flowMultiplier feeds cultivation.meridianFlowMultiplier (qi rate) —
      // both neutral 1.0, so fresh games and old saves stay numerically
      // identical to today.
      id: 'normal',
      name: 'Normal',
      capacityMultiplier: 1.0,
      flowMultiplier: 1.0,
    },

    resources: {
      // The master's parting gift — the canonical xianxia origin endowment for
      // a wandering cultivator who hasn't yet joined a sect. This is the
      // ONLY spirit-stone source in Phase 2; sect stipends / mission pay /
      // mining royalties land in Phase 5+ (Sects) per ROADMAP. Loaded at
      // fresh state, narratively framed as a one-shot gift on first boot.
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
      // Per-upgrade level (number of times bought, 0 = unpurchased).
      // Owned by the UpgradeSystem (js/systems/upgrades.js); it is the only
      // writer. Each purchase increments the matching id and the system
      // recomputes cultivation.qiSources.upgrades from the catalog's
      // effectPerLevel × level for every qiRateAdd upgrade.
      purchased: {},
    },

    techniques: {
      // Owned by the TechniqueSystem (js/systems/techniques.js). Each entry
      // is keyed by technique id with { level, proficiencyXp, lastActivationMs }.
      // The aggregate qi/s contribution lands in cultivation.qiSources.techniques.
      owned: {},
    },

    tribulations: {
      // Owned by the TribulationSystem (js/systems/tribulations.js). The
      // tribulation gate on the current realm's breakthrough: type is the
      // current realm's tribulation type (null when the realm imposes no
      // tribulation — data/tribulations/tribulations.json); pending is true
      // while a tribulation stands between the cultivator and the realm's
      // breakthrough (the player must face() and survive before the
      // BreakthroughSystem accepts an attempt); survived is true after a
      // successful face() during this stay in the realm (cleared on every
      // realm change).
      type: null,
      pending: false,
      survived: false,
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
      // null = use the data-driven default style (see config.notation);
      // a string = a style id from config.notation.styles (overrides the default).
      notationStyle: null,
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

/**
 * Public constructor for a fresh game state slice. Exported so feature code
 * (e.g. the Settings panel's destructive reset, future save importers) can
 * build a clean slate without re-implementing the placeholder shape. The
 * GameState singleton above is the canonical shared instance.
 */
export { createGameState };
