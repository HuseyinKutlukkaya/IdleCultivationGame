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
import { SaveManager } from './managers/save-manager.js';
import { Renderer } from './ui/renderer.js';
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

    // Load content definitions (realms, techniques, pills, ...) from data/.
    const dataManager = new DataManager({ eventBus: EventBus });
    await dataManager.loadAll();

    // Instantiate the core game object.
    const game = new Game(config);

    // Persistence: restore any previous save, then autosave. Per the
    // startup sequence the save loads before the game loop starts.
    const manifest = dataManager.getManifest();
    const saveManager = new SaveManager({
      eventBus: EventBus,
      storage: Storage,
      serialize: () => game.serialize(),
      restore: (state) => game.restore(state),
      engineVersion: (config.meta && config.meta.version) || '0.0.0',
      contentVersion: (manifest && manifest.version) || 0,
      autosaveIntervalMs: (config.save && config.save.autosaveIntervalMs) || 0,
      saveOnUnload: config.save ? config.save.saveOnUnload !== false : true,
    });

    // Renderer: scan and cache DOM bindings, subscribe to refresh events,
    // and render the current state (per the startup sequence: renderer
    // initializes → initial render → save loads → loop starts).
    const renderer = new Renderer();
    renderer.init();

    const restored = saveManager.load();

    // Start the simulation loop, then begin autosave.
    game.start();
    saveManager.start();
    if (restored) {
      setStatus('Save found — resuming…');
    }

    // Expose the game instances for debugging.
    window.__game = game;
    window.__dataManager = dataManager;
    window.__saveManager = saveManager;
    window.__renderer = renderer;

    setStatus(
      `Scaffold ready — ${dataManager.totalDefinitions()} definitions loaded. Game loop running.` +
        (restored ? ' Save restored.' : '')
    );
  } catch (error) {
    console.error('Bootstrap failed:', error);
    setStatus('Failed to load. See console for details.');
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);
