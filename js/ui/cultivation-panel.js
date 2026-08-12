/**
 * ui/cultivation-panel.js — Cultivation panel initializer (pure presentation).
 *
 * Wires the Cultivation game panel — the Phase-3 play-test surface that makes
 * the breakthroughs + tribulations loop REACHABLE BY A HUMAN PLAYER through
 * real buttons. The panel renders:
 *   - a character readout (player.spiritRoot + player.meridians, read fresh
 *     from state on every render),
 *   - a "Breakthrough" button enabled exactly when
 *     breakthroughs.canAttempt() is true and, when disabled, a readiness
 *     reason line derived from breakthroughs.requirements() — only the four
 *     gating reasons (progress / tribulation / max-realm / no-definition),
 *     never the informational cost/items flags,
 *   - a "Face Tribulation" button ONLY when the current realm imposes a
 *     tribulation (tribulations.requirements().type non-null), enabled while
 *     the gate is pending (canFace()),
 *   - a feedback line reporting the last attempt()/face() result — including
 *     a BLOCKED attempt (instant feedback #4: a player clicking the button
 *     against a closed gate now sees WHY it stayed closed, instead of a
 *     silent dead button).
 *
 * The panel never mutates gameplay state: clicks flow through the injected
 * system primitives — breakthroughs.attempt() and tribulations.face() —
 * exactly like the upgrades panel calls upgrades.purchase(id). The renderer
 * is read-only state → DOM and never learns about clicks (renderer
 * invariant). All data-driven content renders as textContent, never
 * innerHTML.
 *
 * Wiring model: ONE delegated `click` listener on the supplied root handles
 * every `[data-cultivation-breakthrough]` / `[data-cultivation-face]` /
 * `[data-cultivation-progress-action]` element via `event.target.closest(...)`
 * — a single delegated listener keeps the touch cheap and the destroy()
 * surface trivial. The body of the panel is rebuilt on every render()
 * (mirroring the upgrades panel), so the DOM contract attributes below are
 * created by this module, not hardcoded. The progress bar itself lives in
 * the Cultivation Realm panel (not the Cultivation panel) — the panel
 * reaches outside its own body to query `[data-cultivation-progress-action]`
 * on the supplied root and toggles its `.progress--actionable` class + the
 * adjacent `.progress-hint` visibility on every render.
 *
 * Event contract (every event triggers a re-render; the panel only READS
 * state through the systems — the systems own the writes):
 *   'realm:changed'        — a realm change (a breakthrough success or a
 *                             manual setRealm) moves the character; the new
 *                             realm's tribulation gate may appear.
 *   'realm:breakthrough'    — every accepted attempt re-renders the button
 *                             against the (possibly new) realm's gates.
 *   'tribulation:finished'  — a faced tribulation opens/closes the gate;
 *                             re-render reflects the fresh state.tribulations.
 *   'resource:changed'      — a wallet change anywhere re-renders so the
 *                             button's enabled state follows the latest
 *                             requirements() snapshot.
 *   'ui:refresh'            — explicit post-mutation hook (also emitted by
 *                             applyBreakthrough/applyFace on success).
 *   'loop:uiRefresh'        — the game loop's periodic pulse. The panel
 *                             subscribes so the Breakthrough button enables
 *                             live as realmProgress accrues on real ticks
 *                             (otherwise a player watching progress hit the
 *                             cap would stare at a stale disabled button).
 *
 * Defensive contract (every bad call is a `console.warn` + a no-op — never
 * a throw, never a mutation, never an emit):
 *   - missing root.querySelector / missing [data-cultivation-panel] /
 *     missing game state → no-op handle
 *   - missing breakthroughs dependency → applyBreakthrough warns ONCE per
 *     instance and returns false; the button renders disabled
 *   - missing tribulations dependency → applyFace warns ONCE per instance and
 *     returns false; no tribulation block renders
 *   - a click that lands outside any handled selector is a no-op
 *   - the progress bar / hint lookup is optional (the panel degrades when
 *     absent — no throw, no class toggle)
 *
 * DOM contracts (attributes this module reads/writes):
 *   [data-cultivation-panel]               on the Cultivation game-panel article
 *   [data-cultivation-body]                on the body container the panel fills
 *   [data-cultivation-character]           character readout line (<p>)
 *   [data-cultivation-breakthrough]        the Breakthrough <button>
 *   [data-cultivation-reason]              gate / readiness reason line (<p>)
 *   [data-cultivation-tribulation]         tribulation block (<div>, only when
 *                                          the current realm imposes a tribulation)
 *   [data-cultivation-tribulation-name]    tribulation type line (<p>)
 *   [data-cultivation-face]                the Face Tribulation <button>
 *   [data-cultivation-feedback]            last-attempt feedback line (<p>)
 *   [data-cultivation-progress-action]     on the Cultivation Realm progress bar;
 *                                          outside the panel's own body —
 *                                          clicking it calls applyBreakthrough()
 *   [data-cultivation-progress-hint]       on the <small> hint line next to the
 *                                          progress bar; hidden when the gate
 *                                          is not actionable
 *   .progress--actionable                  class toggled on the bar when
 *                                          requirements().canAttempt is true
 *                                          (pointer cursor + subtle glow)
 *
 * Pure presentation — reads GameState (through the injected `state`) and the
 * injected systems' read-only requirements() APIs, calls the injected
 * attempt()/face() primitives, never touches gameplay state directly,
 * framework-free and GitHub Pages compatible.
 *
 * Future plug-in: breakthrough/tribulation icons, per-outcome detail lines
 * and an attempt counter land by extending render(), not the public API.
 */

import { EventBus } from '../core/event-bus.js';

/** CSS selector resolving the Cultivation game-panel article in the root. */
const PANEL_SELECTOR = '[data-cultivation-panel]';

/** CSS selector resolving the body container the panel fills on render. */
const BODY_SELECTOR = '[data-cultivation-body]';

/** CSS selector for the Breakthrough button (delegated click anchor). */
const BREAKTHROUGH_SELECTOR = '[data-cultivation-breakthrough]';

/** CSS selector for the Face Tribulation button (delegated click anchor). */
const FACE_SELECTOR = '[data-cultivation-face]';

/** CSS selector for the Advance Layer button (delegated click anchor). */
const ADVANCE_LAYER_SELECTOR = '[data-cultivation-advance-layer]';

/**
 * CSS selector for the Cultivation Realm progress bar (outside this panel's
 * own body). The bar is the new actionable entry point: clicking it routes
 * to applyBreakthrough() exactly like the Breakthrough button, and the
 * `.progress--actionable` class is toggled on it on every render.
 */
const PROGRESS_ACTION_SELECTOR = '[data-cultivation-progress-action]';

/** CSS selector for the small hint line next to the progress bar. */
const PROGRESS_HINT_SELECTOR = '[data-cultivation-progress-hint]';

/** Class toggled on the progress bar when the gate is actionable. */
const ACTIONABLE_CLASS = 'progress--actionable';

/** Event emitted to ask the Renderer to re-flush after a successful action. */
const REFRESH_EVENT = 'ui:refresh';

/**
 * Every event the panel re-renders on. The 'loop:uiRefresh' subscription
 * (the game loop's periodic pulse) is what keeps the Breakthrough button's
 * enabled state live as realmProgress accrues on real ticks.
 */
const SUBSCRIBED_EVENTS = [
  'realm:changed',
  'realm:breakthrough',
  'tribulation:finished',
  'resource:changed',
  REFRESH_EVENT,
  'loop:uiRefresh',
];

/**
 * Readable text for a blocked attempt result — the player's click landed
 * against a closed gate, so the panel surfaces the gate reason inline
 * (instant feedback #4: no silent dead button). Keys match the canonical
 * reason ids returned by BreakthroughSystem.attempt().
 */
const BLOCKED_FEEDBACK = {
  progress: 'Progress incomplete',
  tribulation: 'Face the tribulation first',
  'max-realm': 'Already at peak realm',
  'no-definition': 'No path forward',
  layer: 'Advance to the final layer first',
};

/** Shared no-op handle for every skip path (nothing to tear down). */
const NOOP_HANDLE = {
  applyBreakthrough() {
    return false;
  },
  applyFace() {
    return false;
  },
  applyAdvanceLayer() {
    return false;
  },
  render() {},
  destroy() {},
};

/**
 * Initialize the Cultivation panel.
 *
 * @param {object} [options]
 * @param {typeof EventBus} [options.eventBus=EventBus] — bus to subscribe /
 *        emit on (ui:refresh after an accepted action).
 * @param {object|null} [options.state=null] — game state object (REQUIRED:
 *        the character readout and the no-definition cost check read it).
 *        When null the panel is skipped (no-op handle).
 * @param {object|null} [options.breakthroughs=null] — BreakthroughSystem (or
 *        a lookalike with requirements()/canAttempt()/attempt()); REQUIRED for
 *        the breakthrough button. When null the button renders disabled and
 *        applyBreakthrough warns once per instance.
 * @param {object|null} [options.tribulations=null] — TribulationSystem (or a
 *        lookalike with requirements()/canFace()/face()); when null no
 *        tribulation block renders and applyFace warns once per instance.
 * @param {object|null} [options.spiritRoots=null] — accepted for signature
 *        parity with the system wiring; the readout reads the canonical
 *        display name from state.player.spiritRoot (the SpiritRootSystem is
 *        the writer of that field, never read directly here).
 * @param {object|null} [options.notation=null] — optional NotationFormatter
 *        (.format(value, decimals)); absent → Intl.NumberFormat.
 * @param {object|null} [options.realms=null] — RealmSystem (or a lookalike
 *        with advanceLayer()); REQUIRED for the Advance Layer button. When
 *        null applyAdvanceLayer warns once per instance.
 * @param {object} [options.root=document] — DOM scope for querySelector
 *        (resolves the panel + the cross-panel progress bar) and
 *        addEventListener (the delegated click).
 * @returns {{ applyBreakthrough(): boolean, applyFace(): boolean,
 *            applyAdvanceLayer(): boolean,
 *            render(): void, destroy(): void }} the panel handle.
 *          applyBreakthrough()/applyFace() return true when the injected
 *          system accepted the action (outcome non-null); render() re-reads
 *          the systems + state and rebuilds the body; destroy() removes the
 *          delegated click listener and every event subscription (idempotent).
 */
export function initCultivationPanel({
  eventBus = EventBus,
  state = null,
  breakthroughs = null,
  tribulations = null,
  spiritRoots = null, // eslint-disable-line no-unused-vars — read via state.player
  notation = null,
  realms = null,
  root = document,
} = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn(
      'CultivationPanel: root.querySelector is missing; skipping Cultivation panel.'
    );
    return NOOP_HANDLE;
  }

  const panel = root.querySelector(PANEL_SELECTOR);
  if (!panel) {
    console.warn(
      'CultivationPanel: no [data-cultivation-panel] found; skipping Cultivation panel.'
    );
    return NOOP_HANDLE;
  }

  if (!state) {
    console.warn(
      'CultivationPanel: no game state provided; skipping Cultivation panel.'
    );
    return NOOP_HANDLE;
  }

  // The body container the panel owns. Falls back to the article itself when
  // the data-cultivation-body div is absent (a stripped test build).
  const body = panel.querySelector(BODY_SELECTOR) || panel;

  // Document for node creation (real DOM in production, the fake root's
  // ownerDocument in tests). A missing document makes makeNode() return null
  // and the guarded appendChild calls no-op — never a throw.
  const doc =
    root.ownerDocument || (typeof document !== 'undefined' ? document : null);

  // ONCE-per-instance warning flags for the missing-system apply paths.
  let warnedNoBreakthroughs = false;
  let warnedNoTribulations = false;
  let warnedNoRealms = false;

  /** @type {string} text of the last action result (persists across renders). */
  let feedbackText = '';

  /** Stable DOM references populated by mount() and updated in place. */
  let characterEl = null;
  let layerEl = null;
  let advanceLayerBtnEl = null;
  let breakthroughBtnEl = null;
  let reasonEl = null;
  let tribulationBlockEl = null;
  let tribulationNameEl = null;
  let faceBtnEl = null;
  let feedbackEl = null;


  /**
   * Format a non-negative integer for display (cost, progress). Uses the
   * injected notation formatter when available; otherwise Intl.NumberFormat
   * with the browser locale. Non-finite values render as "—".
   *
   * @param {number} value — the number to format.
   * @returns {string} the formatted text.
   */
  function formatNumber(value) {
    if (!Number.isFinite(value)) return '—';
    if (notation && typeof notation.format === 'function') {
      return notation.format(value, 0);
    }
    return new Intl.NumberFormat(undefined).format(value);
  }

  /**
   * Compose the character readout line from state — the cultivator's spirit
   * root display name and meridian count, read fresh on every render. Missing
   * fields render as "—" (defensive; a healthy state never hits that).
   *
   * @param {object} gameState — the game state (player slice).
   * @returns {string} e.g. "Spirit Root: Unawakened · Meridians: 0".
   */
  function characterText(gameState) {
    const player = gameState && gameState.player;
    const rootName =
      player && typeof player.spiritRoot === 'string'
        ? String(player.spiritRoot).slice(0, 64)
        : '—';
    const meridians =
      player && typeof player.meridians === 'number' ? player.meridians : '—';
    return `Spirit Root: ${rootName} · Meridians: ${meridians}`;
  }

  /**
   * Resolve WHICH gate blocks the breakthrough when canAttempt is false. The
   * panel surfaces only the four CANONICAL gating reasons — progress /
   * tribulation / max-realm / no-definition — even though requirements()
   * still reports the informational cost / items flags (the cost no longer
   * gates; P1 playtest fix, user decision 2026-08-11). The no-definition
   * case (no current realm, or state.cultivation.breakthroughCost null —
   * the system's own marker for "no entry for the current realm") is
   * detected first; progress second; the pending tribulation third; every
   * remaining false gate falls through to 'max-realm' (all gates met but
   * the ladder is at its top — or the rare hostile-entry case).
   *
   * @param {object|null} req — requirements() snapshot (null when no system).
   * @param {object} gameState — the game state (cultivation slice).
   * @returns {string} the blocking gate id: 'no-definition' | 'progress' |
   *          'tribulation' | 'max-realm'.
   */
  function resolveGate(req, gameState) {
    const noDefinition =
      req.realmId === null ||
      (gameState &&
        gameState.cultivation &&
        gameState.cultivation.breakthroughCost === null);
    if (noDefinition) return 'no-definition';
    if (!req.progressMet) return 'progress';
    if (req.tribulationRequired && !req.tribulationMet) return 'tribulation';
    return 'max-realm';
  }

  /**
   * Human-readable text for each blocking gate id. Placeholder, lore-light
   * wording; the progress gate is the only one carrying numbers. The
   * informational cost / items branches are GONE — the panel surfaces only
   * the four canonical gating reasons (#5).
   */
  const GATE_TEXT = {
    'no-definition': 'No path forward',
    progress: (req) =>
      `Progress required: ${formatNumber(req.progress)} / ${formatNumber(req.requiredProgress)}`,
    tribulation: 'Face the tribulation first',
    'max-realm': 'Peak realm reached',
  };

  /**
   * Text shown when the breakthrough action IS available — the readiness
   * line. Previously this was the misleading "Cost: N stones" copy; the cost
   * no longer charges on success, so the line is now a literal readiness
   * label so the player knows the button is live.
   *
   * @type {string}
   */
  const READY_TEXT = 'Ready — breakthrough available';

  /**
   * Text shown when no BreakthroughSystem was injected — the button is
   * permanently disabled with no system behind it.
   *
   * @type {string}
   */
  const UNAVAILABLE_TEXT = 'Breakthrough unavailable';

  /**
   * Describe the breakthrough action for the current render: whether the
   * button is enabled, plus the text of the reason line. When enabled the
   * line is the readiness label; when disabled it explains the blocking gate.
   *
   * @param {object|null} req — requirements() snapshot (null → no system).
   * @param {object} gameState — the game state.
   * @returns {{ disabled: boolean, reason: string }} the button + line state.
   */
  function describeBreakthrough(req, gameState) {
    if (!req) {
      // No BreakthroughSystem injected — the action is unavailable.
      return { disabled: true, reason: UNAVAILABLE_TEXT };
    }
    if (req.canAttempt) {
      return { disabled: false, reason: READY_TEXT };
    }
    const gate = resolveGate(req, gameState);
    const text = GATE_TEXT[gate];
    return {
      disabled: true,
      reason: typeof text === 'function' ? text(req) : text,
    };
  }

  /**
   * Build a DOM node (or null when no document is available — the caller's
   * appendChild guards that case). Plain <span>/<p>/<button>/<div> children
   * only — never innerHTML (data-driven text renders as text, never markup).
   *
   * @param {string} tag — element tag name.
   * @param {string[]} classNames — classes to apply.
   * @param {Object<string, string>} attrs — attributes to set.
   * @param {string} text — the text content.
   * @returns {object|null} a real DOM Node, or null.
   */
  function makeNode(tag, classNames, attrs, text) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    const node = doc.createElement(tag);
    node.classList.add(...classNames);
    for (const [name, value] of Object.entries(attrs)) {
      node.setAttribute(name, value);
    }
    node.textContent = text;
    return node;
  }

  /**
   * Toggle the progress bar's `.progress--actionable` class + the adjacent
   * hint visibility from the freshest requirements() snapshot. The bar lives
   * OUTSIDE this panel's own body (in the Cultivation Realm panel) so the
   * panel reaches outside via root.querySelector. Both lookups are optional
   * — a stripped test build or a markup change gracefully degrades to a
   * no-op (the Breakthrough button still works; the bar is just not
   * actionable-styled). Reduced-motion users still get the cursor + glow;
   * the glow transition is gated by the global @media rule below.
   *
   * @param {object|null} req — requirements() snapshot.
   * @returns {void}
   */
  function updateProgressActionable(req) {
    const bar =
      typeof root.querySelector === 'function'
        ? root.querySelector(PROGRESS_ACTION_SELECTOR)
        : null;
    if (!bar) return;

    const actionable = Boolean(req && req.canAttempt);
    if (bar.classList && typeof bar.classList.toggle === 'function') {
      bar.classList.toggle(ACTIONABLE_CLASS, actionable);
    } else if (typeof bar.setAttribute === 'function') {
      // Defensive fallback for a fake DOM that lacks classList.toggle.
      if (actionable) bar.setAttribute('class', ACTIONABLE_CLASS);
      else bar.setAttribute('class', '');
    }

    // The hint is a sibling of the bar in the Cultivation Realm panel
    // (see index.html). Sibling lookup keeps the panel agnostic of the
    // exact layout — a future markup reshuffle that moves the hint
    // elsewhere just makes this branch a no-op.
    const parent =
      bar.parentElement ||
      (typeof bar.parentNode === 'object' ? bar.parentNode : null);
    const hint =
      parent && typeof parent.querySelector === 'function'
        ? parent.querySelector(PROGRESS_HINT_SELECTOR)
        : null;
    if (hint && 'hidden' in hint) {
      hint.hidden = !actionable;
    }
  }

  /**
   * Build the panel's static DOM structure once. Subsequent state changes use
   * update() so action nodes retain their identity while a click is in flight.
   *
   * @returns {void}
   */
  function mount() {
    if (typeof body.replaceChildren !== 'function') return;
    body.replaceChildren();

    characterEl = makeNode('p', ['cultivation__character'], { 'data-cultivation-character': '' }, '');
    layerEl = makeNode('p', ['cultivation__layer'], { 'data-cultivation-layer': '' }, '');
    advanceLayerBtnEl = makeNode('button', ['btn', 'btn--primary', 'cultivation__action'], { type: 'button', 'data-cultivation-advance-layer': '', hidden: 'true' }, 'Advance Layer');
    breakthroughBtnEl = makeNode('button', ['btn', 'btn--primary', 'cultivation__action'], { type: 'button', 'data-cultivation-breakthrough': '' }, 'Breakthrough');
    reasonEl = makeNode('p', ['cultivation__reason'], { 'data-cultivation-reason': '' }, '');
    tribulationBlockEl = makeNode('div', ['cultivation__tribulation'], { 'data-cultivation-tribulation': '', hidden: 'true' }, '');
    tribulationNameEl = makeNode('p', ['cultivation__tribulation-name'], { 'data-cultivation-tribulation-name': '' }, '');
    faceBtnEl = makeNode('button', ['btn', 'btn--ghost', 'cultivation__action'], { type: 'button', 'data-cultivation-face': '' }, 'Face Tribulation');
    feedbackEl = makeNode('p', ['cultivation__feedback'], { 'data-cultivation-feedback': '' }, '');

    if (tribulationBlockEl) {
      if (tribulationNameEl) tribulationBlockEl.appendChild(tribulationNameEl);
      if (faceBtnEl) tribulationBlockEl.appendChild(faceBtnEl);
    }
    for (const node of [characterEl, layerEl, advanceLayerBtnEl, breakthroughBtnEl, reasonEl, tribulationBlockEl, feedbackEl]) {
      if (node) body.appendChild(node);
    }
  }

  /** Update existing panel nodes from the latest state snapshots. */
  function update() {
    if (!characterEl) return;
    characterEl.textContent = characterText(state);

    // Layer readout: always shown with the current layer from state.
    const cultivation = state && state.cultivation;
    const currentLayer =
      cultivation && typeof cultivation.realmLayer === 'number'
        ? Math.floor(cultivation.realmLayer)
        : 1;
    const layerMax =
      cultivation && typeof cultivation.realmLayerMax === 'number'
        ? Math.floor(cultivation.realmLayerMax)
        : 9;
    if (layerEl) {
      layerEl.textContent = `Layer ${currentLayer} / ${layerMax}`;
    }

    const req = breakthroughs && typeof breakthroughs.requirements === 'function'
      ? breakthroughs.requirements()
      : null;
    const desc = describeBreakthrough(req, state);

    // Advance Layer button: shown when progress is full and layer < max.
    // Hidden when at layer max (breakthrough button takes over).
    // Always disabled when hidden so Playwright's toBeDisabled() sees the
    // correct state regardless of visibility.
    const showAdvanceLayer =
      req &&
      req.progressMet &&
      currentLayer < layerMax;
    if (advanceLayerBtnEl) {
      if (showAdvanceLayer) {
        if (typeof advanceLayerBtnEl.removeAttribute === 'function') {
          advanceLayerBtnEl.removeAttribute('hidden');
          advanceLayerBtnEl.removeAttribute('disabled');
        } else if (advanceLayerBtnEl.attrs) {
          delete advanceLayerBtnEl.attrs.hidden;
          delete advanceLayerBtnEl.attrs.disabled;
        }
      } else {
        advanceLayerBtnEl.setAttribute('hidden', 'true');
        advanceLayerBtnEl.setAttribute('disabled', 'true');
      }
    }

    // Breakthrough button: enabled + visible only at layer max (layer === max).
    // When below layer max, the button is both hidden AND disabled so a
    // Playwright toBeDisabled() / isDisabled() check returns true regardless
    // of visibility (the DOM [disabled] attribute is the source of truth).
    if (breakthroughBtnEl) {
      const atLayerMax = currentLayer >= layerMax;
      if (!atLayerMax) {
        breakthroughBtnEl.setAttribute('hidden', 'true');
        breakthroughBtnEl.setAttribute('disabled', 'true');
      } else {
        if (typeof breakthroughBtnEl.removeAttribute === 'function') {
          breakthroughBtnEl.removeAttribute('hidden');
        } else if (breakthroughBtnEl.attrs) {
          delete breakthroughBtnEl.attrs.hidden;
        }
        if (desc.disabled) breakthroughBtnEl.setAttribute('disabled', 'true');
        else if (typeof breakthroughBtnEl.removeAttribute === 'function') breakthroughBtnEl.removeAttribute('disabled');
        else if (breakthroughBtnEl.attrs) delete breakthroughBtnEl.attrs.disabled;
      }
    }
    if (reasonEl) reasonEl.textContent = desc.reason;

    const tribReq = tribulations && typeof tribulations.requirements === 'function'
      ? tribulations.requirements()
      : null;
    const gated = Boolean(tribReq && typeof tribReq.type === 'string');
    if (tribulationBlockEl) {
      tribulationBlockEl.hidden = !gated;
      if (gated) {
        if (typeof tribulationBlockEl.removeAttribute === 'function') tribulationBlockEl.removeAttribute('hidden');
        if (tribulationNameEl) tribulationNameEl.textContent = `Tribulation: ${tribReq.type}`;
      } else tribulationBlockEl.setAttribute('hidden', 'true');
    }
    if (faceBtnEl) {
      const canFace = gated && tribulations && typeof tribulations.canFace === 'function'
        ? tribulations.canFace()
        : Boolean(gated && tribReq.canFace);
      if (!canFace) faceBtnEl.setAttribute('disabled', 'true');
      else if (typeof faceBtnEl.removeAttribute === 'function') faceBtnEl.removeAttribute('disabled');
      else if (faceBtnEl.attrs) delete faceBtnEl.attrs.disabled;
    }
    if (feedbackEl) feedbackEl.textContent = feedbackText;
    updateProgressActionable(req);
  }

  /** Public compatibility alias for update(). */
  function render() {
    update();
  }

  /**
   * Advance one sub-layer within the current realm through the injected
   * RealmSystem. Returns the system's acceptance (true when the layer
   * advanced). On success the panel re-renders from state and emits
   * 'ui:refresh'.
   *
   * @returns {boolean} true when the layer advanced.
   */
  function applyAdvanceLayer() {
    if (!realms || typeof realms.advanceLayer !== 'function') {
      if (!warnedNoRealms) {
        warnedNoRealms = true;
        console.warn(
          'CultivationPanel: no RealmSystem — applyAdvanceLayer ignored.'
        );
      }
      return false;
    }
    const ok = realms.advanceLayer();
    if (ok) {
      feedbackText = `Advanced to layer ${state.cultivation.realmLayer}.`;
      update();
      eventBus.emit(REFRESH_EVENT);
    }
    return ok;
  }

  /**
   * Attempt a breakthrough through the injected system. Returns the system's
   * acceptance (true when outcome is non-null). On success the panel renders
   * the result in the feedback line and emits 'ui:refresh' so the rest of the
   * DOM (realm bindings, resources) flushes in lock-step.
   *
   * Instant feedback (#4): when the system REJECTS the attempt
   * ({ outcome: null, advanced: false, reason }), the panel surfaces the
   * reason inline so a player clicking the (visually-live) button gets an
   * explanation instead of a silent dead click. Cost / items no longer gate
   * (P1) so those branches cannot appear; only the four canonical reasons
   * (progress / tribulation / max-realm / no-definition) are possible.
   *
   * @returns {boolean} true when the attempt was accepted.
   */
  function applyBreakthrough() {
    if (!breakthroughs || typeof breakthroughs.attempt !== 'function') {
      if (!warnedNoBreakthroughs) {
        warnedNoBreakthroughs = true;
        console.warn(
          'CultivationPanel: no BreakthroughSystem — applyBreakthrough ignored.'
        );
      }
      return false;
    }
    const result = breakthroughs.attempt();
    if (!result || result.outcome === null) {
      // Blocked attempt: surface the reason inline so the click is not a
      // silent dead button. Unknown reasons get a generic fallback so the
      // panel never renders "undefined" or empty text.
      const reason = result && typeof result.reason === 'string' ? result.reason : null;
      const text =
        (reason && BLOCKED_FEEDBACK[reason]) || 'Breakthrough unavailable';
      if (feedbackText !== text) {
        feedbackText = text;
        update();
      } else {
        // Same feedback as last time — skip the rerender so a repeated
        // click on the same blocked gate is silent (not a console-spammy
        // flicker). render() is preserved for the first miss.
      }
      return false;
    }
    if (result.advanced) {
      const realm =
        state &&
        state.cultivation &&
        typeof state.cultivation.realm === 'string'
          ? state.cultivation.realm
          : 'the next realm';
      feedbackText = `Breakthrough to ${realm}!`;
    } else {
      feedbackText = 'Breakthrough failed.';
    }
    update();
    eventBus.emit(REFRESH_EVENT);
    return true;
  }

  /**
   * Face the pending tribulation through the injected system. Returns the
   * system's acceptance (true when outcome is non-null). On success the panel
   * renders the result in the feedback line and emits 'ui:refresh'. A failed
   * face keeps the gate pending — the next render (from state) reflects it
   * (face button enabled again, breakthrough still tribulation-blocked).
   *
   * @returns {boolean} true when the face was accepted.
   */
  function applyFace() {
    if (!tribulations || typeof tribulations.face !== 'function') {
      if (!warnedNoTribulations) {
        warnedNoTribulations = true;
        console.warn(
          'CultivationPanel: no TribulationSystem — applyFace ignored.'
        );
      }
      return false;
    }
    const result = tribulations.face();
    if (!result || result.outcome === null) return false;
    feedbackText = result.survived
      ? 'Tribulation survived!'
      : 'The tribulation overwhelms you.';
    update();
    eventBus.emit(REFRESH_EVENT);
    return true;
  }

  /**
   * Delegated click handler. Routes clicks on any of the three action
   * anchors to the matching apply method via event.target.closest(...);
   * other clicks are ignored.
   *
   * @param {Event} event — DOM click event (real or fake).
   * @returns {void}
   */
  function onRootClick(event) {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest(ADVANCE_LAYER_SELECTOR)) {
      applyAdvanceLayer();
      return;
    }
    if (target.closest(BREAKTHROUGH_SELECTOR)) {
      applyBreakthrough();
      return;
    }
    if (target.closest(FACE_SELECTOR)) {
      applyFace();
      return;
    }
    if (target.closest(PROGRESS_ACTION_SELECTOR)) {
      // Click on the progress bar is the new actionable entry point
      // (#3): the bar reaches the same breakthrough path the dedicated
      // button does. When the gate is closed the click still surfaces the
      // blocking reason via the standard applyBreakthrough path.
      applyBreakthrough();
    }
  }

  // Every subscribed event re-renders from the systems + state (the same
  // handler identity is reused so destroy() can unsubscribe all of them).
  const onAnyEvent = () => update();

  root.addEventListener('click', onRootClick);
  for (const name of SUBSCRIBED_EVENTS) {
    eventBus.subscribe(name, onAnyEvent);
  }

  mount();
  update();

  return {
    applyBreakthrough,
    applyFace,
    applyAdvanceLayer,
    render,
    destroy() {
      root.removeEventListener('click', onRootClick);
      for (const name of SUBSCRIBED_EVENTS) {
        eventBus.unsubscribe(name, onAnyEvent);
      }
    },
  };
}
