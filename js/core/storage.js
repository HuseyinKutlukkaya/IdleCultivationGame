/**
 * core/storage.js — low-level localStorage save adapter.
 *
 * Provides synchronous get/put/delete against localStorage so the game works
 * on GitHub Pages with zero backend. Envelope shape, versioning, migration,
 * autosave and export/import live in the SaveManager (js/managers/
 * save-manager.js), which builds on this adapter — this file stays a thin,
 * generic persistence layer. Future plug-in: cross-tab sync.
 */

const SAVE_KEY = 'idle-cultivation-game:save';

/** true while the previous save failed (logs once, then stays quiet). */
let _saveFailed = false;

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
   * Persist a serializable save object. A write failure is logged once (not
   * on every autosave tick — the game runs for days) and clears again on the
   * first successful write.
   *
   * @param {object} data — plain-data save object from Game.serialize().
   * @returns {boolean} true when the save was written successfully.
   */
  save(data) {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      _saveFailed = false;
      return true;
    } catch (error) {
      if (!_saveFailed) {
        _saveFailed = true;
        console.error('Failed to write save:', error);
      }
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
