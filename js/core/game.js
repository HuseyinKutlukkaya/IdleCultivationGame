/**
 * core/game.js — core game object (placeholder).
 *
 * This class is the central owner of game state and is the intended home
 * of the future simulation systems:
 *   - resource generation (cultivation / qi)
 *   - the idle game loop / ticker
 *   - realm progression & breakthroughs
 *   - offline progress calculation
 *
 * Right now it only loads config/save data and exposes a tiny public API,
 * so the wiring points are obvious and ready for real implementation.
 */

import { GameState } from './game-state.js';

export class Game {
  /**
   * @param {object} config  — parsed contents of data/game-config.json
   * @param {object|null} save — restored save state from Storage.load(),
   *                             or null when there is no previous save.
   */
  constructor(config, save) {
    // Future plug-in: initialize resources (e.g. qi, spirit stones),
    // apply saved state, and start the ticker.
    this.config = config;
    this.save = save;
    // Centralized state shared by all systems (see game-state.js).
    this.state = GameState;
    this.isRunning = false;
  }

  /**
   * Start the simulation.
   * Future plug-in: kick off requestAnimationFrame / setInterval ticker,
   * attach listeners for gameplay actions.
   */
  start() {
    this.isRunning = true;
    // TODO(gameplay): start the idle tick loop here.
  }

  /**
   * Pause the simulation.
   * Future plug-in: stop the ticker and persist state via Storage.
   */
  stop() {
    this.isRunning = false;
    // TODO(gameplay): persist current state here.
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
