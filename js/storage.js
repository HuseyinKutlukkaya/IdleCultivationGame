/**
 * storage.js — save / load persistence (placeholder).
 *
 * Uses localStorage so the game works on GitHub Pages with zero backend.
 * Future plug-in: add schema versioning, migration, export/import of save
 * strings, and cross-tab sync.
 */

const SAVE_KEY = 'idle-cultivation-game:save';

export const Storage = {
  /**
   * Load a save, or null when none exists.
   * @returns {object|null}
   */
  load() {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error('Failed to read save:', error);
      return null;
    }
  },

  /**
   * Persist a serializable save object.
   * @param {object} data — plain-data save object from Game.serialize().
   * @returns {boolean} true when the save was written successfully.
   */
  save(data) {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      return true;
    } catch (error) {
      console.error('Failed to write save:', error);
      return false;
    }
  },

  /**
   * Delete any existing save.
   * Future plug-in: add a "hard reset" confirmation flow.
   */
  clear() {
    window.localStorage.removeItem(SAVE_KEY);
  },
};
