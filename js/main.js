/**
 * main.js — application entry point (ES6 module).
 *
 * Responsibilities:
 *   - Bootstrap the app once the DOM is ready.
 *   - Wire placeholder landing-page behaviors.
 *   - Start the game simulation loop and set the boot status in the status bar.
 *
 * Future system plug-in: attach gameplay systems (meditation, qi, ...) here
 * or via the EventBus as they are implemented.
 */

import { loadConfig } from './core/config.js';
import { DataManager } from './core/data-manager.js';
import { EventBus } from './core/event-bus.js';
import { Game } from './core/game.js';
import { Storage } from './core/storage.js';
import { initFooter } from './ui/footer.js';
import { initScrollReveal } from './ui/reveal.js';

/**
 * Small boot orchestrator.
 * Each future system (audio, input, network) can be added to this list
 * and awaited before the game UI is revealed.
 */
async function bootstrap() {
  const statusText = document.getElementById('status-text');

  const setStatus = (message) => {
    if (statusText) statusText.textContent = message;
  };

  setStatus('Loading…');

  // Presentation-layer wiring (scroll reveal, footer year, etc.).
  initScrollReveal();
  initFooter();

  try {
    // Load central game config (rates, starting values, tuning).
    const config = await loadConfig();
    if (!config) {
      throw new Error('game-config.json failed to load.');
    }

    // Restore any previously saved progress.
    const save = Storage.load();
    if (save) {
      setStatus('Save found — resuming…');
    }

    // Load content definitions (realms, techniques, pills, ...) from data/.
    const dataManager = new DataManager({ eventBus: EventBus });
    await dataManager.loadAll();

    // Instantiate the core game object and start the simulation loop.
    const game = new Game(config, save);
    game.start();

    // Expose the game instances for debugging.
    window.__game = game;
    window.__dataManager = dataManager;

    setStatus(
      `Scaffold ready — ${dataManager.totalDefinitions()} definitions loaded. Game loop running.`
    );
  } catch (error) {
    console.error('Bootstrap failed:', error);
    setStatus('Failed to load. See console for details.');
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
