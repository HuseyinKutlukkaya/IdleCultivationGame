/**
 * core/game.js — core game object.
 *
 * This class is the central owner of game state and the home of the
 * simulation systems:
 *   - the idle game loop / ticker (js/core/game-loop.js) — active
 *   - resource generation (cultivation / qi) — next phase
 *   - realm progression & breakthroughs
 *   - offline progress calculation
 *
 * Right now it wires config/save/state together and drives the GameLoop,
 * so the plug-in points are obvious and ready for the gameplay phases.
 */

import { EventBus } from './event-bus.js';
import { GameLoop } from './game-loop.js';
import { GameState } from './game-state.js';

export class Game {
  /**
   * @param {object} config  — parsed contents of data/game-config.json
   * @param {object|null} save — restored save state from Storage.load(),
   *                             or null when there is no previous save.
   */
  constructor(config, save) {
    // Future plug-in: initialize resources (e.g. qi, spirit stones),
    // apply saved state, and attach gameplay systems.
    this.config = config;
    this.save = save;
    // Centralized state shared by all systems (see game-state.js).
    this.state = GameState;
    this.isRunning = false;

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
   * Future plug-in: persist current state here (SaveManager is a separate
   * roadmap item — persistence comes later).
   */
  stop() {
    this.loop.stop();
    this.isRunning = false;
  }

  /**
   * Produce a serializable snapshot of the game state for saving.
   * @returns {object} plain-data save object
   */
  serialize() {
    // Future plug-in: return resources, progression, timestamps, etc.
    return {
      savedAt: Date.now(),
    };
  }
}
