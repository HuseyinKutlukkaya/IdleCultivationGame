/**
 * main.js — application entry point (ES6 module).
 *
 * Responsibilities:
 *   - Bootstrap the app once the DOM is ready.
 *   - Wire placeholder landing-page behaviors.
 *   - Set the boot status in the status bar.
 *
 * Future system plug-in: import and start the game loop here once
 * gameplay systems are implemented (e.g. `import { Game } from './core/game.js'`).
 */

import { loadConfig } from './core/config.js';
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

    // Instantiate the (placeholder) core game object.
    // Future plug-in: call game.start() once the game loop exists.
    const game = new Game(config, save);

    // Expose the game instance for debugging.
    window.__game = game;

    setStatus('Scaffold ready — gameplay coming soon.');
  } catch (error) {
    console.error('Bootstrap failed:', error);
    setStatus('Failed to load. See console for details.');
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
