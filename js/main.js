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
import { OfflineProgress } from './core/offline-progress.js';
import { Storage } from './core/storage.js';
import { SaveManager } from './managers/save-manager.js';
import { MeditationSystem } from './systems/meditation.js';
import { QiSystem } from './systems/qi.js';
import { ResourceSystem } from './systems/resources.js';
import { InventorySystem } from './systems/inventory.js';
import { NotationFormatter } from './ui/notation.js';
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

    // Offline progress: simulates production for the time spent away. It
    // owns the state.meta.lastSeenAt timestamp — stamped on every save
    // (below) and measured right after a save is restored (later), before
    // the game loop starts (per the startup sequence in PLANS.md).
    const offlineProgress = new OfflineProgress({
      config,
      eventBus: EventBus,
    });

    // Persistence: restore any previous save, then autosave. Per the
    // startup sequence the save loads before the game loop starts. The
    // serialize hook stamps the last-seen timestamp first so every save
    // carries the reference point the next boot measures offline time from.
    const manifest = dataManager.getManifest();
    const saveManager = new SaveManager({
      eventBus: EventBus,
      storage: Storage,
      serialize: () => {
        offlineProgress.stamp();
        return game.serialize();
      },
      restore: (state) => game.restore(state),
      engineVersion: (config.meta && config.meta.version) || '0.0.0',
      contentVersion: (manifest && manifest.version) || 0,
      autosaveIntervalMs: (config.save && config.save.autosaveIntervalMs) || 0,
      saveOnUnload: config.save ? config.save.saveOnUnload !== false : true,
    });

    // Renderer: scan and cache DOM bindings, subscribe to refresh events,
    // and render the current state (per the startup sequence: renderer
    // initializes → initial render → save loads → loop starts). The number
    // notation formatter reads config.notation (data-driven styles) and the
    // restored settings.notationStyle override (if any) and is injected so
    // every numeric binding formats through it ("1.5K" instead of "1,500").
    const notation = new NotationFormatter({
      config: config.notation || {},
    });
    const renderer = new Renderer({ notation });
    renderer.init();

    const restored = saveManager.load();

    // Simulate the time spent away since the last save, then persist the
    // gains immediately. The serialize hook stamps the reference timestamp
    // to now, so a crash before the next autosave can neither lose the gains
    // nor re-simulate the same away-period on the next boot. The gains are
    // then reflected in the DOM right away (the next loop:uiRefresh would do
    // it anyway, but the state changed before the loop started).
    const offlineSummary = offlineProgress.apply({ now: Date.now() });
    if (offlineSummary.applied) {
      saveManager.save();
      renderer.refresh();
    }

    // Meditation: first Phase-2 gameplay system — owns the meditation
    // session and its qi rate-contribution slot (cultivation.qiSources.
    // meditation). Constructed AFTER the save restore and offline-progress
    // apply (so it starts from the restored active flag and the away-gains
    // are already in state) and BEFORE the game loop starts (so the very
    // first tick finds it subscribed). It reads its per-second rate from
    // config.meditation (data-driven, placeholder balancing).
    const meditation = new MeditationSystem({
      config,
      eventBus: EventBus,
    });

    // Qi: single owner of the qi resource. Constructed AFTER the meditation
    // system so the contribution slot already exists when this constructor
    // syncs the aggregate rate (a restored session shows the right cap/rate
    // before the first tick). Every qi source is declared in config.qi.sources
    // (ratePath = that source's own state slot); this system owns the resource
    // math — aggregation, cap clamping, statistics and 'qi:gained'.
    const qi = new QiSystem({
      config,
      eventBus: EventBus,
    });

    // Resources: single owner of the wallet resources (spirit stones, herbs,
    // jade, qi-condensation pills). Constructed AFTER the save restore and
    // offline apply so it starts from the restored balances. It reads its
    // managed resources from config.resources (data-driven, placeholder
    // balancing) and exposes the wallet primitives (get/canAfford/add/spend)
    // that future producers and consumers call; it has no loop subscription —
    // per-second resource production arrives with the first resource producer.
    const resources = new ResourceSystem({
      config,
      eventBus: EventBus,
    });

    // Inventory: single owner of the carried item stacks (state.inventory.
    // items — each stack is { id, count } and occupies one slot) and the slot
    // accounting (slots.used = number of distinct stacks). Constructed AFTER
    // the save restore and offline apply so it starts from the restored
    // stacks, and AFTER the DataManager load so item definitions resolve via
    // dataManager.get('items', id) (stackSize etc. — never hardcoded). It has
    // no loop subscription — items arrive by calling add() and leave by
    // calling remove(); the full Phase-4 inventory (filter/sort/search) reads
    // the same stacks.
    const inventory = new InventorySystem({
      config,
      eventBus: EventBus,
      dataManager,
    });

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
    window.__offlineProgress = offlineProgress;
    window.__meditation = meditation;
    window.__qi = qi;
    window.__resources = resources;
    window.__inventory = inventory;
    window.__notation = notation;

    const offlineNote =
      restored && offlineSummary.applied && hasGains(offlineSummary)
        ? ` ${formatOfflineSummary(offlineSummary)}`
        : '';

    setStatus(
      `Scaffold ready — ${dataManager.totalDefinitions()} definitions loaded. Game loop running.` +
        (restored ? ' Save restored.' : '') +
        offlineNote
    );
  } catch (error) {
    console.error('Bootstrap failed:', error);
    setStatus('Failed to load. See console for details.');
  }
}

/**
 * Whether an offline summary produced any actual gains (amount > 0 for at
 * least one producer). Gates the status-bar note so a restored session that
 * produced nothing (e.g. before any per-second system exists) stays silent.
 *
 * @param {object} summary — the summary returned by OfflineProgress.apply().
 * @returns {boolean} true when at least one producer gained resources.
 */
function hasGains(summary) {
  return summary.producers.some((producer) => producer.amount > 0);
}

/**
 * Human-readable one-line summary of an offline-progress result for the
 * status bar, e.g. "Offline gains: 8h (Qi: +28800)".
 *
 * @param {object} summary — the summary returned by OfflineProgress.apply().
 * @returns {string} the formatted gains line.
 */
function formatOfflineSummary(summary) {
  const gains = summary.producers
    .filter((producer) => producer.amount > 0)
    .map((producer) => `${producer.label}: +${producer.amount}`);
  return `Offline gains: ${formatDuration(summary.effectiveMs)} (${gains.join(', ')})`;
}

/**
 * Compact duration formatting for the status bar: "8h", "2h 15m", "45m",
 * "30s". Follows the bootstrap's plain-English convention; localization is a
 * later phase (see DESIGN.md).
 *
 * @param {number} ms — duration in milliseconds.
 * @returns {string} the formatted duration.
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

document.addEventListener('DOMContentLoaded', bootstrap);
