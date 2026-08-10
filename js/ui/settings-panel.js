/**
 * ui/settings-panel.js — Settings panel initializer (pure presentation).
 *
 * Wires the three boolean switches (offlineProgress / sound / notifications),
 * the notation-style <select> and the destructive "Reset save" button inside
 * the Settings game panel. The panel is just a fragment of static markup —
 * the renderer (js/ui/renderer.js) drives the bound values visually, and this
 * initializer owns the user's CLICKS and CHANGES so the renderer never learns
 * about interaction events (renderer invariant: state → DOM, no game
 * knowledge).
 *
 * Wiring model: ONE delegated `click` listener on the supplied root handles
 * every `[data-settings-toggle]`, `[data-settings-select]` and
 * `[data-settings-reset]` element via `event.target.closest(...)`, AND ONE
 * delegated `change` listener handles the `<select>` (select changes fire
 * `change`, not `click` — opening the dropdown does not mutate the value).
 * A single delegated listener per event keeps the touch cheap and the
 * destroy() surface trivial.
 *
 * Event contract:
 *   'settings:changed' { key, value } — emitted by applyToggle and
 *          applyNotationStyle after a successful mutation. `key` is the leaf
 *          name ('offlineProgress', 'sound', 'notifications', 'notationStyle')
 *          and `value` is the new boolean/string.
 *   'settings:reset'    — emitted by applyReset BEFORE game:restored so a
 *          listener can detect the "intentional wipe" event distinctly from
 *          a normal save load.
 *   'game:restored'     — emitted by applyReset after the state slice is
 *          replaced so existing renderers / subscribers refresh in place
 *          (Renderer already listens to this event).
 *   'ui:refresh'        — emitted after every successful mutation so the
 *          Renderer flushes its DOM immediately (the loop also schedules
 *          refreshes via 'loop:uiRefresh', but ui:refresh is the explicit
 *          post-mutation hook).
 *
 * Defensive contract (every bad call is a `console.warn` + a no-op —
 * never a throw, never a mutation, never an emit):
 *   - missing root.querySelector / missing settings panel → no-op handle
 *   - applyToggle: non-string key, unknown key, prototype-alias key, no
 *     state dependency, panel has no [data-settings-toggle]
 *   - applyNotationStyle: non-string id (including null/undefined), unknown
 *     id, prototype-alias id, empty string, no notation dependency, panel
 *     has no [data-settings-select="notationStyle"]
 *   - applyReset: missing saveManager, unusable config.notation.styles,
 *     panel has no [data-settings-reset]
 *
 * The module imports GameState-derived dependencies only through the
 * constructor (state, notation, saveManager) — never the singletons — so the
 * surface stays pluggable and tests can inject fakes. createGameState is
 * imported only to seed the destructive reset's fresh slice (never read from
 * or mutated outside the apply path).
 *
 * DOM contracts (attributes this module reads/writes):
 *   [data-settings-panel]              on the Settings game-panel article
 *   [data-settings-toggle="<key>"]     on each boolean switch (button)
 *   [data-settings-select="notationStyle"] on the notation <select>
 *   [data-settings-reset]              on the destructive button
 *
 * Pure presentation — reads GameState (through the injected `state`), never
 * touches gameplay systems, framework-free and GitHub Pages compatible.
 *
 * Future plug-in: new toggles land by adding (1) the leaf key to TOGGLE_KEYS,
 * (2) the data-settings-toggle attribute on the new <button>, and (3) the
 * matching state.settings.<key> field. New <select>s follow the same pattern
 * (whitelist map + data-settings-select attribute); the constructor only
 * needs a dedicated apply<Name>Style method when the writer logic isn't
 * trivially notation.setStyle.
 */

import { EventBus } from '../core/event-bus.js';
import { createGameState } from '../core/game-state.js';

/** CSS selector resolving the Settings game-panel article in the root. */
const PANEL_SELECTOR = '[data-settings-panel]';

/** Event emitted on every successful applyToggle / applyNotationStyle. */
const CHANGED_EVENT = 'settings:changed';

/** Event emitted by applyReset, before game:restored. */
const RESET_EVENT = 'settings:reset';

/** Event emitted after every successful mutation, including applyReset. */
const REFRESH_EVENT = 'ui:refresh';

/**
 * Whitelist of settings.<leafKey> paths the toggles may flip. Stored on a
 * prototype-less object so Object.hasOwn reliably rejects prototype aliases
 * ('__proto__', 'constructor', 'prototype').
 */
const TOGGLE_KEYS = Object.create(null);
TOGGLE_KEYS.offlineProgress = true;
TOGGLE_KEYS.sound = true;
TOGGLE_KEYS.notifications = true;

/** Shared no-op handle for every skip path (nothing to tear down). */
const NOOP_HANDLE = {
  applyToggle() {
    return false;
  },
  applyNotationStyle() {
    return false;
  },
  applyReset() {
    return false;
  },
  destroy() {},
};

/**
 * Initialize the Settings panel.
 *
 * @param {object} [options]
 * @param {typeof EventBus} [options.eventBus=EventBus] — bus to subscribe / emit on.
 * @param {object} [options.state] — game state object (defaults to the
 *        shared GameState singleton). Mutations to settings.* go here.
 * @param {object|null} [options.notation=null] — NotationFormatter instance;
 *        REQUIRED for applyNotationStyle (it delegates to notation.setStyle,
 *        which also writes state.settings.notationStyle).
 * @param {object|null} [options.saveManager=null] — SaveManager instance;
 *        REQUIRED for applyReset (calls saveManager.clear()).
 * @param {object|null} [options.config=null] — parsed contents of
 *        data/game-config.json; the notation <select> is populated from
 *        config.notation.styles (style ids + labels).
 * @param {object} [options.root=document] — DOM scope for querySelector
 *        (resolves the panel) and addEventListener (the delegated click).
 * @returns {{ destroy(): void, applyToggle(key: string): boolean,
 *          applyNotationStyle(styleId: string): boolean,
 *          applyReset(): boolean }} the panel handle. The `apply*` methods
 *          return true on a successful mutation and false on a no-op (every
 *          failure mode warns exactly once). `destroy()` removes the
 *          delegated click listener and is idempotent.
 */
export function initSettingsPanel({
  eventBus = EventBus,
  state = null,
  notation = null,
  saveManager = null,
  config = null,
  root = document,
} = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn(
      'SettingsPanel: root.querySelector is missing; skipping Settings panel.'
    );
    return NOOP_HANDLE;
  }

  const panel = root.querySelector(PANEL_SELECTOR);
  if (!panel) {
    console.warn(
      'SettingsPanel: no [data-settings-panel] found; skipping Settings panel.'
    );
    return NOOP_HANDLE;
  }

  // Presence of the apply attributes inside the panel — the apply methods
  // degrade gracefully when their attribute is absent (warn ONCE, no-op).
  const hasToggleAttr = Boolean(panel.querySelector('[data-settings-toggle]'));
  const hasSelectAttr = Boolean(
    panel.querySelector('[data-settings-select="notationStyle"]')
  );
  const hasResetAttr = Boolean(panel.querySelector('[data-settings-reset]'));

  // The notation block is data-driven; it may legitimately be absent in
  // tests / stripped builds. Empty styles = the <select> is rendered with
  // zero options and applyNotationStyle warns ONCE per missing input.
  const notationStyles =
    config && config.notation && config.notation.styles
      ? config.notation.styles
      : null;
  if (!notationStyles || Object.keys(notationStyles).length === 0) {
    console.warn(
      'SettingsPanel: config.notation.styles is missing or empty; notation <select> will have no options.'
    );
  }

  // Populate the notation <select> from config.notation.styles (idempotent —
  // runs once on init, never again). An absent / empty block leaves the
  // <select> in place with no <option> children.
  populateNotationSelect(panel, notationStyles, state, config);

  // ONCE-per-instance warning flags. Reset only at construction time so a
  // bad call from the first time never re-warns every subsequent time.
  let warnedToggleNoState = false;
  let warnedToggleNoAttr = false;
  let warnedNotationNoDep = false;
  let warnedNotationNoAttr = false;
  let warnedNotationUnknownId = false;
  let warnedResetNoSave = false;
  let warnedResetNoConfig = false;
  let warnedResetNoAttr = false;

  /**
   * Flip a boolean leaf on state.settings and emit the change + refresh
   * events. Unknown / non-string / prototype-alias keys return false and
   * never mutate. Missing state OR missing [data-settings-toggle] attribute
   * each warn ONCE per instance and return false.
   *
   * @param {string} key — leaf key (offlineProgress | sound | notifications).
   * @returns {boolean} true when the mutation was applied.
   */
  function applyToggle(key) {
    if (typeof key !== 'string' || !Object.hasOwn(TOGGLE_KEYS, key)) {
      console.warn(
        `SettingsPanel: applyToggle('${String(key)}') — unknown or invalid key; expected one of ${Object.keys(TOGGLE_KEYS).join(', ')}.`
      );
      return false;
    }

    if (!hasToggleAttr) {
      if (!warnedToggleNoAttr) {
        warnedToggleNoAttr = true;
        console.warn(
          'SettingsPanel: no [data-settings-toggle] attribute in the panel; applyToggle ignored.'
        );
      }
      return false;
    }

    if (!state || !state.settings) {
      if (!warnedToggleNoState) {
        warnedToggleNoState = true;
        console.warn(
          'SettingsPanel: no state provided — applyToggle ignored.'
        );
      }
      return false;
    }

    state.settings[key] = !state.settings[key];
    const value = state.settings[key];
    eventBus.emit(CHANGED_EVENT, { key, value });
    eventBus.emit(REFRESH_EVENT);
    return true;
  }

  /**
   * Set the notation style by delegating to notation.setStyle (which owns
   * the whitelist and writes state.settings.notationStyle). Missing notation
   * OR missing [data-settings-select="notationStyle"] attribute each warn
   * ONCE per instance and return false. Unknown / prototype-alias / empty /
   * non-string style ids warn once and return false without mutating.
   *
   * @param {string} styleId — a key of config.notation.styles.
   * @returns {boolean} true when the mutation was applied.
   */
  function applyNotationStyle(styleId) {
    if (typeof styleId !== 'string' || styleId === '') {
      if (!warnedNotationUnknownId) {
        warnedNotationUnknownId = true;
        console.warn(
          'SettingsPanel: applyNotationStyle() — styleId must be a non-empty string.'
        );
      }
      return false;
    }

    // Known-style validation: even before delegating to setStyle, reject
    // unknown ids here so the warning is local and the message names the
    // supplied id. setStyle re-validates via Object.hasOwn.
    if (!notationStyles || !Object.hasOwn(notationStyles, styleId)) {
      if (!warnedNotationUnknownId) {
        warnedNotationUnknownId = true;
        console.warn(
          `SettingsPanel: applyNotationStyle('${styleId}') — unknown styleId; not a key of config.notation.styles.`
        );
      }
      return false;
    }

    if (!notation) {
      if (!warnedNotationNoDep) {
        warnedNotationNoDep = true;
        console.warn(
          'SettingsPanel: no notation formatter provided — applyNotationStyle ignored.'
        );
      }
      return false;
    }

    if (!hasSelectAttr) {
      if (!warnedNotationNoAttr) {
        warnedNotationNoAttr = true;
        console.warn(
          'SettingsPanel: no [data-settings-select="notationStyle"] in the panel; applyNotationStyle ignored.'
        );
      }
      return false;
    }

    const ok = notation.setStyle(styleId);
    if (!ok) return false;

    eventBus.emit(CHANGED_EVENT, { key: 'notationStyle', value: styleId });
    eventBus.emit(REFRESH_EVENT);
    return true;
  }

  /**
   * Reset the save: clear the storage, replace the state slice with a deep
   * clone of createGameState(), then emit settings:reset, game:restored and
   * ui:refresh in that order. Missing saveManager, unusable config.notation
   * block, or missing [data-settings-reset] attribute each warn ONCE per
   * instance and return false (no mutation, no emit).
   *
   * State replacement is in-place (the original `state` object's contents are
   * overwritten) so callers that hold the reference keep observing the
   * fresh slice. The fresh slice is structuredClone()d so a second applyReset
   * is not a no-op against an already-mutated seed.
   *
   * @returns {boolean} true when the save was cleared and the slice replaced.
   */
  function applyReset() {
    if (!saveManager || typeof saveManager.clear !== 'function') {
      if (!warnedResetNoSave) {
        warnedResetNoSave = true;
        console.warn(
          'SettingsPanel: no saveManager provided — applyReset ignored.'
        );
      }
      return false;
    }

    if (!notationStyles || Object.keys(notationStyles).length === 0) {
      if (!warnedResetNoConfig) {
        warnedResetNoConfig = true;
        console.warn(
          'SettingsPanel: config.notation.styles missing or empty — applyReset ignored.'
        );
      }
      return false;
    }

    if (!hasResetAttr) {
      if (!warnedResetNoAttr) {
        warnedResetNoAttr = true;
        console.warn(
          'SettingsPanel: no [data-settings-reset] attribute in the panel; applyReset ignored.'
        );
      }
      return false;
    }

    saveManager.clear();

    if (state) {
      const fresh = structuredClone(createGameState());
      // In-place replacement: delete every existing top-level key, then copy
      // the fresh slice's keys. Existing references observing `state` see
      // the wipe; the renderer re-reads on the next ui:refresh / game:restored.
      for (const key of Object.keys(state)) {
        delete state[key];
      }
      Object.assign(state, fresh);
    }

    eventBus.emit(RESET_EVENT);
    eventBus.emit('game:restored');
    eventBus.emit(REFRESH_EVENT);
    return true;
  }

  /**
   * The delegated click handler. Routes to the matching apply method via
   * event.target.closest(...); other clicks are ignored.
   *
   * @param {Event} event — DOM click event (real or fake).
   * @returns {void}
   */
  function onRootClick(event) {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;

    const toggle = target.closest('[data-settings-toggle]');
    if (toggle) {
      const key = toggle.getAttribute('data-settings-toggle');
      const ok = applyToggle(key);
      if (ok) {
        // Mirror the new boolean onto aria-checked (a presentation concern
        // owned by this initializer so the renderer doesn't have to learn it).
        // The visual switch--on class is the renderer's job via data-bind.
        const newValue = state && state.settings ? state.settings[key] : false;
        toggle.setAttribute('aria-checked', newValue ? 'true' : 'false');
      }
      return;
    }

    const select = target.closest('[data-settings-select="notationStyle"]');
    if (select) {
      applyNotationStyle(select.value);
      return;
    }

    if (target.closest('[data-settings-reset]')) {
      applyReset();
    }
  }

  root.addEventListener('click', onRootClick);

  // Same delegation model for `change`: a `<select>` change fires `change`,
  // never a meaningful `click` (the user opens the dropdown with click and
  // commits the choice with Enter / blur, but no `click` lands inside
  // `[data-settings-select]`). The delegated `change` listener routes to
  // applyNotationStyle when the change target sits inside a notation
  // select; clicks on the select itself (e.g. expanding the dropdown) are
  // no-ops.
  const onRootChange = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const select = target.closest('[data-settings-select="notationStyle"]');
    if (!select) return;
    const value = target.value !== undefined ? target.value : select.value;
    applyNotationStyle(value);
  };
  root.addEventListener('change', onRootChange);

  // Mirror the toggles' current state onto aria-checked on init so screen
  // readers see the right value before the user clicks anything. Done once,
  // not on every apply — the renderer's data-bind path keeps the visual
  // switch--on class fresh; aria-checked is a presentation concern owned by
  // this initializer so the renderer doesn't have to learn it.
  syncAriaChecked(panel, state);

  return {
    /**
     * Remove the delegated click listener. Idempotent.
     *
     * @returns {void}
     */
    destroy() {
      root.removeEventListener('click', onRootClick);
      root.removeEventListener('change', onRootChange);
    },

    applyToggle,
    applyNotationStyle,
    applyReset,
  };
}

/**
 * Populate the notation <select> from config.notation.styles (idempotent —
 * runs once during init; never re-populates). Each <option>'s value is the
 * style id and its label comes from config.notation.styles[id].label, with
 * the style id itself as the fallback. The initially-selected option is the
 * player's state.settings.notationStyle when it names a known style, else
 * config.notations.defaultStyle (legacy typo-safe fallthrough), else
 * config.notation.defaultStyle, else the first style id.
 *
 * In a real browser the <option> children are built via
 * `document.createElement('option')` so the dropdown renders correctly;
 * tests inject a fake <select> that records the appended children directly.
 *
 * Never called when notationStyles is null — the caller warns in that case
 * and leaves the <select> empty.
 *
 * @param {Element} panel — the Settings panel container.
 * @param {object|null} notationStyles — config.notation.styles (may be null).
 * @param {object|null} state — game state (used for the initial selection).
 * @param {object|null} config — full config (used for defaultStyle fallback).
 * @returns {void}
 */
function populateNotationSelect(panel, notationStyles, state, config) {
  const select = panel.querySelector('[data-settings-select="notationStyle"]');
  if (!select) return;

  // Clear any prior children (idempotency guard — an init() called twice on
  // the same handle would otherwise append duplicate <option>s).
  if ('textContent' in select) {
    select.textContent = '';
  } else if ('clear' in select && typeof select.clear === 'function') {
    select.clear();
  }

  if (!notationStyles) return;

  const styleIds = Object.keys(notationStyles);
  for (const styleId of styleIds) {
    const entry = notationStyles[styleId] || {};
    const label = typeof entry.label === 'string' ? entry.label : styleId;
    const option = createOption(styleId, label);
    select.appendChild(option);
  }

  // Initial selection: the player's override (if known), else the configured
  // default, else the first style. Mirrors NotationFormatter._default's
  // fall-through order so the <select> and the formatter agree on defaults.
  const override =
    state && state.settings && typeof state.settings.notationStyle === 'string'
      ? state.settings.notationStyle
      : null;
  const defaultStyle = pickDefaultStyleId(config, styleIds);
  const initial = override && Object.hasOwn(notationStyles, override)
    ? override
    : defaultStyle;
  if (initial) select.value = initial;
}

/**
 * Build an <option> node. Uses `document.createElement('option')` when
 * available so the real DOM gets proper HTMLOptionElement nodes; falls back
 * to a plain { value, label } object in test fakes that don't expose
 * document.
 *
 * @param {string} value — the option's value (the style id).
 * @param {string} label — the option's visible text.
 * @returns {object} an option-like node.
 */
function createOption(value, label) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }
  return { value, label };
}

/**
 * Resolve the default style id with the documented fall-through order:
 *   1. config.notation.defaultStyle when it names a known style.
 *   2. The first key of config.notation.styles.
 *   3. '' (no styles configured).
 *
 * @param {object|null} config — full config (may be null).
 * @param {string[]} styleIds — keys of config.notation.styles (may be empty).
 * @returns {string} the style id to preselect, or '' when none qualifies.
 */
function pickDefaultStyleId(config, styleIds) {
  const declared = config && config.notation && config.notation.defaultStyle;
  if (typeof declared === 'string' && styleIds.includes(declared)) {
    return declared;
  }
  return styleIds[0] || '';
}

/**
 * Mirror state.settings.<key> onto each [data-settings-toggle] element's
 * aria-checked attribute. Runs once on init so a screen reader announces
 * the right state before any click; subsequent applies also re-sync the
 * toggled element via the click handler (defense in depth — the
   * data-bind-driven switch--on class is the renderer's job).
 *
 * @param {Element} panel — the Settings panel container.
 * @param {object|null} state — game state.
 * @returns {void}
 */
function syncAriaChecked(panel, state) {
  if (!state || !state.settings) return;
  const toggles = panel.querySelectorAll('[data-settings-toggle]');
  for (const toggle of toggles) {
    const key = toggle.getAttribute('data-settings-toggle');
    if (typeof key !== 'string') continue;
    const on = Boolean(state.settings[key]);
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    toggle.setAttribute('role', 'switch');
  }
}
