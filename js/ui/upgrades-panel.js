/**
 * ui/upgrades-panel.js — Upgrades panel initializer (pure presentation).
 *
 * Wires the Upgrades game panel: each upgrade from the catalog
 * (data/upgrades/upgrades.json) becomes one clickable row with the
 * upgrade's name, current level, next cost and (when canPurchase() is
 * false) a disabled state. The catalog is data-driven — never hardcode
 * upgrade ids here — and the upgrade clicks flow through the
 * UpgradeSystem.purchase(id) primitive (which owns the wallet deduction
 * and the level math). The renderer is read-only state → DOM and
 * intentionally never learns about clicks (renderer invariant).
 *
 * Wiring model: ONE delegated `click` listener on the supplied root
 * handles every `[data-upgrade-id]` element via
 * `event.target.closest(...)`. A single delegated listener keeps the
 * touch cheap and the destroy() surface trivial.
 *
 * Event contract:
 *   'upgrades:purchased' { id, level, cost, effectPerLevel } — the
 *     panel subscribes to this event (which UpgradeSystem already emits
 *     for every successful purchase) and re-renders so the player sees
 *     the new level / cost instantly.
 *   'resource:changed' { id, label, delta, total } — the panel ALSO
 *     subscribes so a wallet change (e.g. add() or spend() elsewhere)
 *     re-renders the rows with the new affordability / next-cost. The
 *     on-click re-render from applyPurchase() makes the post-purchase
 *     case fast; this subscription handles the case where something
 *     ELSE bumped the wallet (a future producer, an automation tick,
 *     a console call by the developer).
 *   'ui:refresh' — emitted by applyPurchase() so the rest of the DOM
 *     (resources, qi) refreshes in lock-step.
 *
 * Defensive contract (every bad call is a `console.warn` + a no-op —
 * never a throw, never a mutation, never an emit):
 *   - missing root.querySelector / missing upgrades panel → no-op handle
 *   - missing upgrades dependency → apply* methods warn ONCE per
 *     instance and return false; the panel still renders whatever the
 *     catalog already supports (id-list)
 *   - applyPurchase(unknown id): UpgradeSystem already rejects unknown
 *     ids with a warn; the panel only forwards ids that exist in the
 *     rendered DOM (each row's data-upgrade-id is one of the listed
 *     upgrades)
 *
 * DOM contracts (attributes this module reads/writes):
 *   [data-upgrades-panel]                on the Upgrades game-panel article
 *   [data-upgrade-id="<id>"]             on each row's <button>
 *
 * Pure presentation — reads UpgradeSystem, calls UpgradeSystem.purchase,
 * never touches gameplay state directly, framework-free and GitHub Pages
 * compatible.
 *
 * Future plug-in: per-row icons / description tooltips / bulk-buy modes
 * land by extending renderRow(), not by extending the public API.
 */

import { EventBus } from '../core/event-bus.js';

/** CSS selector resolving the Upgrades game-panel article in the root. */
const PANEL_SELECTOR = '[data-upgrades-panel]';

/** Event emitted by UpgradeSystem on every successful purchase. */
const PURCHASED_EVENT = 'upgrades:purchased';

/** Event emitted by ResourceSystem when any resource balance changes. */
const RESOURCE_EVENT = 'resource:changed';

/** Selector for a single row's purchase button. */
const ROW_BUTTON_SELECTOR = '[data-upgrade-id]';

/** Event emitted to ask the Renderer to re-flush after a successful purchase. */
const REFRESH_EVENT = 'ui:refresh';

/** Shared no-op handle for every skip path (nothing to tear down). */
const NOOP_HANDLE = {
  applyPurchase() {
    return false;
  },
  render() {},
  destroy() {},
};

/**
 * Initialize the Upgrades panel.
 *
 * @param {object} [options]
 * @param {typeof EventBus} [options.eventBus=EventBus] — bus to subscribe.
 * @param {object|null} [options.upgrades=null] — UpgradeSystem instance
 *        (REQUIRED for the panel's click + rerender). When null the panel
 *        renders no rows and applyPurchase is a no-op.
 * @param {object} [options.root=document] — DOM scope for querySelector.
 * @param {object} [options.formatter=null] — Optional number formatter
 *        (NotationFormatter-compatible; .format(value, decimals)). When
 *        present, numeric values render through it (e.g. "1.5K" instead
 *        of "1,500"). Absent → plain toLocaleString via Intl.NumberFormat.
 * @returns {{ destroy(): void, applyPurchase(id: string): boolean,
 *          render(): void }} the panel handle. render() re-renders from
 *          the system state — useful after every purchase (this panel
 *          also re-renders on the `upgrades:purchased` event
 *          automatically). destroy() unsubscribes the delegated click +
 *          the purchased event handler and is idempotent.
 */
export function initUpgradesPanel({
  eventBus = EventBus,
  upgrades = null,
  root = document,
  formatter = null,
} = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn('UpgradesPanel: root.querySelector is missing; skipping Upgrades panel.');
    return NOOP_HANDLE;
  }

  const panel = root.querySelector(PANEL_SELECTOR);
  if (!panel) {
    console.warn('UpgradesPanel: no [data-upgrades-panel] found; skipping Upgrades panel.');
    return NOOP_HANDLE;
  }

  // The "no UpgradeSystem" warning is deferred until the FIRST applyPurchase
  // call (matches the project's "warn once, on first occurrence" defensive
  // contract — see settings-panel.js for the same pattern). Rendering
  // without a system is a legitimate state (the panel shows no rows).

  /** @type {boolean} one-shot flag for "no upgrades" warnings. */
  let warnedNoUpgradeSystem = false;

  /**
   * Format a non-negative integer for display (cost, level). Uses the
   * injected formatter when available; otherwise Intl.NumberFormat with
   * browser locale. Non-finite values render as "—".
   *
   * @param {number} value — the number to format.
   * @returns {string} the formatted text.
   */
  function formatNumber(value) {
    if (!Number.isFinite(value)) return '—';
    if (formatter && typeof formatter.format === 'function') {
      return formatter.format(value, 0);
    }
    return new Intl.NumberFormat(undefined).format(value);
  }

  /**
   * Build (or rebuild) a row <button> for an upgrade. The button carries
   * `data-upgrade-id` so a delegated click handler can route back here.
   *
   * The row exposes:
   *   - the upgrade's name and description (text),
   *   - the current level,
   *   - the next-level cost,
   *   - a disabled state when the upgrade cannot be purchased right now
   *     (maxed, or no resource).
   *
   * @param {object} definition — the upgrade definition.
   * @returns {object} a real DOM node (a <button>) ready to append to
   *          the panel body. A plain object is only ever returned in tests
   *          whose root has no `ownerDocument` AND no `createElement` —
   *          the real production path goes through `doc.createElement`.
   */
  function buildRow(definition) {
    const level = upgrades ? upgrades.level(definition.id) : 0;
    const cost = upgrades ? upgrades.cost(definition.id) : 0;
    const canBuy = upgrades ? upgrades.canPurchase(definition.id) : false;
    const maxLevel = definition.maxLevel;
    const isMaxed = typeof maxLevel === 'number' && level >= maxLevel;

    const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const row = doc && typeof doc.createElement === 'function'
      ? doc.createElement('button')
      : null;
    if (!row) return null;

    row.setAttribute('type', 'button');
    row.setAttribute('data-upgrade-id', definition.id);
    row.setAttribute(
      'aria-label',
      `${definition.name} — level ${level}, cost ${formatNumber(cost)}`
    );
    if (isMaxed) row.setAttribute('data-upgrade-maxed', 'true');
    if (!canBuy && !isMaxed) row.setAttribute('disabled', 'true');
    row.classList.add('upgrade');
    if (isMaxed) row.classList.add('upgrade--maxed');
    if (!canBuy && !isMaxed) row.classList.add('upgrade--disabled');

    // Body: name + description stacked, then level + cost on a row to
    // the right. Plain <span> children — never innerHTML (data-driven
    // names/descriptions must render as text, never as markup).
    const name = createSpan(doc, ['upgrade__name'], definition.name);
    const description = createSpan(doc, ['upgrade__description'], definition.description);
    const meta = createSpan(
      doc,
      ['upgrade__meta'],
      isMaxed
        ? `Level ${formatNumber(level)}/${formatNumber(maxLevel)} (maxed)`
        : `Level ${formatNumber(level)} · Next cost ${formatNumber(cost)} ${definition.costResource}`
    );
    row.appendChild(name);
    row.appendChild(description);
    row.appendChild(meta);
    return row;
  }

  /**
   * Re-render the panel body. Cheap (a few rows); called on init and
   * after every successful purchase.
   *
   * @returns {void}
   */
  function render() {
    if (typeof panel.replaceChildren !== 'function') return;

    const definitions = upgrades ? upgrades.list() : [];
    panel.replaceChildren();

    for (const definition of definitions) {
      const row = buildRow(definition);
      if (typeof panel.appendChild === 'function') {
        panel.appendChild(row);
      }
    }
  }

  /**
   * Attempt to purchase one level of an upgrade. Returns the system's
   * purchase() result (true on success, false on a bad call). On
   * success the panel re-renders to show the new level + cost and asks
   * the renderer to flush so other panels (resources, qi) update too.
   *
   * @param {string} id — the upgrade id.
   * @returns {boolean} true when a level was bought.
   */
  function applyPurchase(id) {
    if (!upgrades) {
      if (!warnedNoUpgradeSystem) {
        warnedNoUpgradeSystem = true;
        console.warn(
          'UpgradesPanel: no UpgradeSystem — applyPurchase ignored.'
        );
      }
      return false;
    }
    const ok = upgrades.purchase(id);
    if (ok) {
      render();
      // Emitting `ui:refresh` here (independent of the system's event)
      // means the rest of the DOM refreshes even if the system is the
      // fake in tests or a non-event-emitting future implementation.
      eventBus.emit(REFRESH_EVENT);
    }
    return ok;
  }

  /**
   * Click delegation handler. Reads the nearest [data-upgrade-id] on
   * the click target and forwards to applyPurchase().
   *
   * @param {Event} event — the DOM click event.
   * @returns {void}
   */
  function onRootClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const row = target.closest(ROW_BUTTON_SELECTOR);
    if (!row) return;
    const id = row.getAttribute('data-upgrade-id');
    if (!id) return;
    applyPurchase(id);
  }

  root.addEventListener('click', onRootClick);

  // The system already emits `upgrades:purchased` on every successful
  // purchase, but applyPurchase() inside a click handler only re-renders
  // synchronously on success — an event-driven external mutation (a
  // future programmatic purchase from a console / automation layer) must
  // also trigger a re-render. Same for `resource:changed`: a wallet
  // change from anywhere (an external add/spend or the applyPurchase
  // path itself) re-renders the rows so the disabled state and next-cost
  // follow the wallet.
  function onPurchased() {
    render();
    eventBus.emit(REFRESH_EVENT);
  }
  eventBus.subscribe(PURCHASED_EVENT, onPurchased);
  eventBus.subscribe(RESOURCE_EVENT, onPurchased);

  // Initial render — show every upgrade at level 0 with the level-1 cost.
  render();

  return {
    applyPurchase,
    render,
    destroy() {
      root.removeEventListener('click', onRootClick);
      eventBus.unsubscribe(PURCHASED_EVENT, onPurchased);
      eventBus.unsubscribe(RESOURCE_EVENT, onPurchased);
    },
  };
}

/**
 * Tiny helper: create a <span> node with the given classes and text. Used
 * by buildRow() so the row's children render as text (never innerHTML).
 *
 * @param {object} doc — Document-like (must expose createElement); falls
 *        back to the global `document` when null/undefined.
 * @param {string[]} classNames — class names to apply.
 * @param {string} text — the text content.
 * @returns {object} a real DOM Node (or null when no document is
 *          available — the caller's appendChild guards that case).
 */
function createSpan(doc, classNames, text) {
  const realDoc = doc || (typeof document !== 'undefined' ? document : null);
  if (!realDoc || typeof realDoc.createElement !== 'function') return null;
  const node = realDoc.createElement('span');
  node.classList.add(...classNames);
  node.textContent = text;
  return node;
}
