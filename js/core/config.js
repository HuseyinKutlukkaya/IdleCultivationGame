/**
 * core/config.js — loads the central game config from data/game-config.json.
 *
 * Keeps tuning numbers out of the code so designers/balancers can edit
 * values without touching JS. Loaded via fetch at bootstrap; the app is
 * fully static so this works on GitHub Pages with no build step. The fetch
 * URL is resolved against the project root via utils/paths.js, so the load
 * works no matter where the page is served from.
 *
 * Future plug-in: split into per-system config files (realms.json,
 * upgrades.json, etc.) and merge them here.
 */

import { resolveFromRoot } from '../utils/paths.js';

/**
 * @returns {Promise<object|null>} parsed config, or null on failure.
 */
export async function loadConfig() {
  try {
    const response = await fetch(resolveFromRoot('data', 'game-config.json'));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Failed to load game config:', error);
    return null;
  }
}
