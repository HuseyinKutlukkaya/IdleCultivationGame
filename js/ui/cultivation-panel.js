/**
 * ui/cultivation-panel.js — Cultivation panel initializer (pure presentation).
 *
 * Wires the Cultivation game panel — the Phase-3 play-test surface that makes
 * the breakthroughs + tribulations loop REACHABLE BY A HUMAN PLAYER through
 * real buttons. The panel renders:
 *   - a character readout (player.spiritRoot + player.meridians, read fresh
 *     from state on every render),
 *   - a "Breakthrough" button enabled exactly when
 *     breakthroughs.canAttempt() is true and, when disabled, a reason line
 *     derived from breakthroughs.requirements() (progress / cost / items /
 *     tribulation / max-realm / no-definition),
 *   - a "Face Tribulation" button ONLY when the current realm imposes a
 *     tribulation (tribulations.requirements().type non-null), enabled while
 *     the gate is pending (canFace()),
 *   - a feedback line reporting the last attempt()/face() result.
 *
 * The panel never mutates gameplay state: clicks flow through the injected
 * system primitives — breakthroughs.attempt() and tribulations.face() —
 * exactly like the upgrades panel calls upgrades.purchase(id). The renderer
 * is read-only state → DOM and never learns about clicks (renderer
 * invariant). All data-driven content renders as textContent, never
 * innerHTML.
 *
 * Wiring model: ONE delegated `click` listener on the supplied root handles
 * every `[data-cultivation-breakthrough]` / `[data-cultivation-face]` element
 * via `event.target.closest(...)` — a single delegated listener keeps the
 * touch cheap and the destroy() surface trivial. The body of the panel is
 * rebuilt on every render() (mirroring the upgrades panel), so the DOM
 * contract attributes below are created by this module, not hardcoded.
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
 *                             cost gate (button disabled state) follows.
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
 *   - a click that lands outside both buttons is a no-op
 *
 * DOM contracts (attributes this module reads/writes):
 *   [data-cultivation-panel]          on the Cultivation game-panel article
 *   [data-cultivation-body]           on the body container the panel fills
 *   [data-cultivation-character]      character readout line (<p>)
 *   [data-cultivation-breakthrough]   the Breakthrough <button>
 *   [data-cultivation-reason]         cost / gate-reason line (<p>)
 *   [data-cultivation-tribulation]    tribulation block (<div>, only when the
 *                                     current realm imposes a tribulation)
 *   [data-cultivation-tribulation-name] tribulation type line (<p>)
 *   [data-cultivation-face]           the Face Tribulation <button>
 *   [data-cultivation-feedback]       last-attempt feedback line (<p>)
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

/** Shared no-op handle for every skip path (nothing to tear down). */
const NOOP_HANDLE = {
  applyBreakthrough() {
    return false;
  },
  applyFace() {
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
 * @param {object} [options.root=document] — DOM scope for querySelector
 *        (resolves the panel) and addEventListener (the delegated click).
 * @returns {{ applyBreakthrough(): boolean, applyFace(): boolean,
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

  /** @type {string} text of the last action result (persists across renders). */
  let feedbackText = '';

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
   * Resolve WHICH gate blocks the breakthrough when canAttempt is false, in
   * the same order the BreakthroughSystem's attempt() checks them. The
   * no-definition cases (no current realm, or state.cultivation.breakthroughCost
   * null — the system's own marker for "no entry for the current realm") are
   * detected first; every remaining false gate falls through to 'max-realm'
   * (all gates met but the ladder is at its top — or the rare hostile-entry
   * case).
   *
   * @param {object|null} req — requirements() snapshot (null when no system).
   * @param {object} gameState — the game state (cultivation slice).
   * @returns {string} the blocking gate id: 'no-definition' | 'progress' |
   *          'cost' | 'items' | 'tribulation' | 'max-realm'.
   */
  function resolveGate(req, gameState) {
    const noDefinition =
      req.realmId === null ||
      (gameState &&
        gameState.cultivation &&
        gameState.cultivation.breakthroughCost === null);
    if (noDefinition) return 'no-definition';
    if (!req.progressMet) return 'progress';
    if (!req.costMet) return 'cost';
    if (!req.bottleneckMet) return 'items';
    if (req.tribulationRequired && !req.tribulationMet) return 'tribulation';
    return 'max-realm';
  }

  /**
   * Human-readable text for each blocking gate id. Placeholder, lore-light
   * wording; the progress gate is the only one carrying numbers.
   */
  const GATE_TEXT = {
    'no-definition': 'No path forward',
    progress: (req) =>
      `Progress required: ${formatNumber(req.progress)} / ${formatNumber(req.requiredProgress)}`,
    cost: 'Cost not met',
    items: 'Missing items',
    tribulation: 'Face the tribulation first',
    'max-realm': 'Peak realm reached',
  };

  /**
   * Describe the breakthrough action for the current render: whether the
   * button is enabled, plus the text of the reason/cost line. When enabled
   * the line labels the action with its cost ("Cost: N stones", "Cost: —"
   * when no entry); when disabled it explains the blocking gate.
   *
   * @param {object|null} req — requirements() snapshot (null → no system).
   * @param {object} gameState — the game state.
   * @returns {{ disabled: boolean, reason: string }} the button + line state.
   */
  function describeBreakthrough(req, gameState) {
    if (!req) {
      // No BreakthroughSystem injected — the action is unavailable.
      return { disabled: true, reason: 'Cost: —' };
    }
    if (req.canAttempt) {
      const cost = Number.isFinite(req.cost && req.cost.spiritStones)
        ? req.cost.spiritStones
        : null;
      return {
        disabled: false,
        reason: `Cost: ${cost === null ? '—' : `${formatNumber(cost)} stones`}`,
      };
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
   * Append the character readout line to the body.
   *
   * @param {object} bodyEl — the body container.
   * @returns {void}
   */
  function appendCharacter(bodyEl) {
    const node = makeNode(
      'p',
      ['cultivation__character'],
      { 'data-cultivation-character': '' },
      characterText(state)
    );
    if (node && typeof bodyEl.appendChild === 'function') {
      bodyEl.appendChild(node);
    }
  }

  /**
   * Append the Breakthrough button + reason/cost line to the body.
   *
   * @param {object} bodyEl — the body container.
   * @returns {void}
   */
  function appendBreakthrough(bodyEl) {
    const req =
      breakthroughs && typeof breakthroughs.requirements === 'function'
        ? breakthroughs.requirements()
        : null;
    const desc = describeBreakthrough(req, state);

    const button = makeNode(
      'button',
      ['btn', 'btn--primary', 'cultivation__action'],
      { type: 'button', 'data-cultivation-breakthrough': '' },
      'Breakthrough'
    );
    if (!button) return;
    if (desc.disabled) button.setAttribute('disabled', 'true');
    if (typeof bodyEl.appendChild === 'function') bodyEl.appendChild(button);

    const reason = makeNode(
      'p',
      ['cultivation__reason'],
      { 'data-cultivation-reason': '' },
      desc.reason
    );
    if (reason && typeof bodyEl.appendChild === 'function') {
      bodyEl.appendChild(reason);
    }
  }

  /**
   * Append the tribulation block (name + Face Tribulation button) to the body
   * — only when the current realm imposes a tribulation
   * (tribulations.requirements().type non-null). The face button is enabled
   * exactly while the gate is pending (canFace()).
   *
   * @param {object} bodyEl — the body container.
   * @returns {void}
   */
  function appendTribulation(bodyEl) {
    const req =
      tribulations && typeof tribulations.requirements === 'function'
        ? tribulations.requirements()
        : null;
    if (!req || req.type === null || typeof req.type !== 'string') return;

    const block = makeNode(
      'div',
      ['cultivation__tribulation'],
      { 'data-cultivation-tribulation': '' },
      ''
    );
    if (!block) return;

    const name = makeNode(
      'p',
      ['cultivation__tribulation-name'],
      { 'data-cultivation-tribulation-name': '' },
      `Tribulation: ${req.type}`
    );
    if (name && typeof block.appendChild === 'function') block.appendChild(name);

    const face = makeNode(
      'button',
      ['btn', 'btn--ghost', 'cultivation__action'],
      { type: 'button', 'data-cultivation-face': '' },
      'Face Tribulation'
    );
    if (face) {
      if (!req.canFace) face.setAttribute('disabled', 'true');
      if (typeof block.appendChild === 'function') block.appendChild(face);
    }

    if (typeof bodyEl.appendChild === 'function') bodyEl.appendChild(block);
  }

  /**
   * Re-render the panel body. Cheap (a handful of nodes); called on init,
   * after every accepted action and on every subscribed event.
   *
   * @returns {void}
   */
  function render() {
    if (typeof body.replaceChildren !== 'function') return;
    body.replaceChildren();

    appendCharacter(body);
    appendBreakthrough(body);
    appendTribulation(body);

    const feedback = makeNode(
      'p',
      ['cultivation__feedback'],
      { 'data-cultivation-feedback': '' },
      feedbackText
    );
    if (feedback && typeof body.appendChild === 'function') {
      body.appendChild(feedback);
    }
  }

  /**
   * Attempt a breakthrough through the injected system. Returns the system's
   * acceptance (true when outcome is non-null). On success the panel renders
   * the result in the feedback line and emits 'ui:refresh' so the rest of the
   * DOM (realm bindings, resources) flushes in lock-step.
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
    if (!result || result.outcome === null) return false;
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
    render();
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
    render();
    eventBus.emit(REFRESH_EVENT);
    return true;
  }

  /**
   * Delegated click handler. Routes clicks on either action button to the
   * matching apply method via event.target.closest(...); other clicks are
   * ignored.
   *
   * @param {Event} event — DOM click event (real or fake).
   * @returns {void}
   */
  function onRootClick(event) {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest(BREAKTHROUGH_SELECTOR)) {
      applyBreakthrough();
      return;
    }
    if (target.closest(FACE_SELECTOR)) {
      applyFace();
    }
  }

  // Every subscribed event re-renders from the systems + state (the same
  // handler identity is reused so destroy() can unsubscribe all of them).
  const onAnyEvent = () => render();

  root.addEventListener('click', onRootClick);
  for (const name of SUBSCRIBED_EVENTS) {
    eventBus.subscribe(name, onAnyEvent);
  }

  // Initial render — the panel shows the fresh-state readout, the disabled
  // breakthrough button (fresh Mortal realm: zero progress) and, when the
  // realm imposes one, the tribulation gate.
  render();

  return {
    applyBreakthrough,
    applyFace,
    render,
    destroy() {
      root.removeEventListener('click', onRootClick);
      for (const name of SUBSCRIBED_EVENTS) {
        eventBus.unsubscribe(name, onAnyEvent);
      }
    },
  };
}
