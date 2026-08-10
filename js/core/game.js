/**
 * core/game.js — core game object.
 *
 * This class is the central owner of game state and the home of the
 * simulation systems:
 *   - the idle game loop / ticker (js/core/game-loop.js) — active
 *   - resource generation (cultivation / qi) — next phase
 *   - realm progression & breakthroughs
 *   - offline progress calculation (js/core/offline-progress.js) — done;
 *     stamped on save and applied by the bootstrap before the loop starts
 *
 * Right now it wires config/state together, drives the GameLoop and exposes
 * serialize()/restore() for the SaveManager (js/managers/save-manager.js),
 * so the plug-in points are obvious and ready for the gameplay phases.
 */

import { EventBus } from './event-bus.js';
import { GameLoop } from './game-loop.js';
import { GameState } from './game-state.js';
import { deepMerge } from '../utils/deep-merge.js';

export class Game {
  /**
   * @param {object} config — parsed contents of data/game-config.json.
   */
  constructor(config) {
    // Future plug-in: initialize resources (e.g. qi, spirit stones) and
    // attach gameplay systems. Saved state is applied via restore().
    this.config = config;
    // Centralized state shared by all systems (see game-state.js).
    this.state = GameState;
    this.isRunning = false;

    // Apply data-driven origin endowment on construction. The canonical
    // fresh slice (js/core/game-state.js createGameState()) carries the
    // same value as the canonical fallback below; we overwrite here so:
    //   - a custom `config.startingState.spiritStones` (testing, modding,
    //     Phase-5 sect-origin adjustments) lands in state WITHOUT a code
    //     edit;
    //   - a missing/malformed config still gets the lore-canonical 50;
    //   - on a restored save (`Game.restore()` is called next), the deep-
    //     merged snapshot's spiritStones wins, leaving this write as a
    //     frame for restore-trust (a hostile empty save still lands at
    //     50, not 0).
    // See DESIGN.md "Spirit Stone Acquisition" + ROADMAP "Spirit stones
    // origin endowment".
    this.state.resources.spiritStones =
      _readStartingSpiritStones(config);

    // Build the fixed-timestep loop from config.loop (data-driven tuning —
    // never hardcode rates). Missing keys fall back to GameLoop defaults,
    // so a partial config can never break the loop.
    const loopConfig = (config && config.loop) || {};
    this.loop = new GameLoop({
      eventBus: EventBus,
      tickRateMs: loopConfig.tickRateMs,
      uiRefreshRateMs: loopConfig.uiRefreshRateMs,
      maxFrameDeltaMs: loopConfig.maxFrameDeltaMs,
    });
  }

  /**
   * Start the simulation loop. Idempotent: no-op when already running.
   */
  start() {
    if (this.isRunning) return;
    this.loop.start();
    this.isRunning = true;
  }

  /**
   * Stop the simulation loop.
   * Note: persistence is handled by SaveManager (autosave interval +
   * beforeunload); Game.stop() only halts the loop.
   */
  stop() {
    this.loop.stop();
    this.isRunning = false;
  }

  /**
   * Produce a serializable snapshot of the game state for saving.
   * The GameState singleton is mutated in place by systems, so a deep copy
   * is taken to keep the snapshot stable regardless of later changes.
   *
   * @returns {object} plain-data snapshot of GameState.
   */
  serialize() {
    return JSON.parse(JSON.stringify(GameState));
  }

  /**
   * Apply a deserialized state snapshot onto the shared GameState singleton.
   * Deep-merges so a save written by an older version simply leaves any
   * newly-added keys at their current (fresh-default) values — old saves
   * keep working. The singleton is mutated in place so every system that
   * already holds a reference to GameState sees the restored values.
   *
   * @param {object} snapshot — plain-data state from SaveManager.load() or
   *        importSave(), as produced by serialize().
   * @returns {void}
   */
  restore(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      console.warn('Game.restore: ignoring invalid state snapshot.');
      return;
    }
    deepMerge(GameState, snapshot);
  }
}

/**
 * Resolve the master's parting gift amount from the config. Reads
 * `config.startingState.spiritStones` (data-driven per AGENTS.md) and
 * falls back to the lore-canonical 50 stones so the game always boots at
 * a sane baseline (a missing / malformed config is never fatal).
 *
 * @param {object} [config] — game-config object (or undefined on miss).
 * @returns {number} a finite, non-negative integer.
 */
function _readStartingSpiritStones(config) {
  const raw =
    config && config.startingState
      ? config.startingState.spiritStones
      : undefined;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  return 50;
}
