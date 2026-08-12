/**
 * ui/techniques-panel.js — Techniques panel initializer (pure presentation).
 *
 * Wires the Techniques game panel: lists all technique definitions from the
 * TechniqueSystem, renders each owned technique with level, proficiency,
 * qi/s rate, and cost. Un-owned techniques show a "Buy" button with base cost.
 * Owned techniques show an "Upgrade" button with the next-level cost.
 *
 * Wiring model: ONE delegated `click` listener on the panel root handles
 * every `[data-technique-buy]` / `[data-technique-upgrade]` element via
 * `event.target.closest(...)`.
 *
 * Event contract:
 *   technique:purchased { id, level } — the panel re-renders.
 *   technique:upgraded { id, level, cost } — the panel re-renders.
 *   resource:changed { id, label, delta, total } — wallet changes re-render.
 *   ui:refresh — re-render on the loop pulse.
 *
 * Defensive contract: missing root / missing panel → no-op handle; missing
 * techniqueSystem → warn-once.
 *
 * Pure presentation — reads TechniqueSystem, calls TechniqueSystem.buy/upgrade,
 * never touches gameplay state directly.
 */

import { EventBus } from '../core/event-bus.js';

/** CSS selector resolving the technique panel article. */
const PANEL_SELECTOR = '[data-techniques-panel]';

/** CSS selector for the body container. */
const BODY_SELECTOR = '[data-techniques-body]';

/** CSS selector for the owned count tag. */
const COUNT_SELECTOR = '[data-techniques-count]';

/** Selector for a buy button. */
const BUY_SELECTOR = '[data-technique-buy]';

/** Selector for an upgrade button. */
const UPGRADE_SELECTOR = '[data-technique-upgrade]';

/** Shared no-op handle. */
const NOOP_HANDLE = {
  render() {},
  destroy() {},
};

/**
 * Initialize the Techniques panel.
 *
 * @param {object} [options]
 * @param {typeof EventBus} [options.eventBus=EventBus]
 * @param {object|null} [options.techniqueSystem=null] — TechniqueSystem instance.
 * @param {object} [options.root=document] — DOM scope.
 * @param {object} [options.formatter=null] — NotationFormatter-compatible.
 * @returns {{ render(): void, destroy(): void }}
 */
export function initTechniquesPanel({
  eventBus = EventBus,
  techniqueSystem = null,
  root = document,
  formatter = null,
} = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn('TechniquesPanel: root.querySelector is missing; skipping.');
    return NOOP_HANDLE;
  }

  const panel = root.querySelector(PANEL_SELECTOR);
  if (!panel) {
    console.warn('TechniquesPanel: no [data-techniques-panel] found; skipping.');
    return NOOP_HANDLE;
  }

  const body = panel.querySelector(BODY_SELECTOR);
  const countTag = panel.querySelector(COUNT_SELECTOR);

  /** @type {boolean} one-shot flag for no-system warnings. */
  let warnedNoSystem = false;

  /**
   * Format a non-negative number for display.
   *
   * @param {number} value
   * @param {number} [decimals=0]
   * @returns {string}
   */
  function formatNumber(value, decimals = 0) {
    if (!Number.isFinite(value)) return '—';
    if (formatter && typeof formatter.format === 'function') {
      return formatter.format(value, decimals);
    }
    return new Intl.NumberFormat(undefined).format(value);
  }

  /**
   * Re-render the panel body.
   */
  function render() {
    if (!techniqueSystem) {
      if (!warnedNoSystem) {
        warnedNoSystem = true;
        console.warn('TechniquesPanel: no TechniqueSystem — render skipped.');
      }
      return;
    }

    const definitions = techniqueSystem.list();
    const owned = techniqueSystem.getAll();
    const ownedIds = new Set(owned.map((entry) => entry.id));
    const totalOwned = ownedIds.size;

    // Update count tag.
    if (countTag) {
      countTag.textContent = `${totalOwned} owned`;
    }

    // Clear and rebuild the body.
    if (body && typeof body.replaceChildren === 'function') {
      body.replaceChildren();

      for (const definition of definitions) {
        const row = buildRow(definition, ownedIds);
        if (row && typeof body.appendChild === 'function') {
          body.appendChild(row);
        }
      }
    }
  }

  /**
   * Build one technique row.
   *
   * @param {object} definition — technique definition.
   * @param {Set<string>} ownedIds — ids of owned techniques.
   * @returns {HTMLElement|null}
   */
  function buildRow(definition, ownedIds) {
    const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') return null;

    const isOwned = ownedIds.has(definition.id);
    const level = techniqueSystem ? techniqueSystem.level(definition.id) : 0;
    const proficiencyName = isOwned ? techniqueSystem.getProficiencyName(definition.id) : '—';
    const revenue = isOwned ? techniqueSystem.getRevenue(definition.id) : 0;
    const cooldown = isOwned ? techniqueSystem.getCooldown(definition.id) : definition.cooldownMs;
    const qiPerSec = isOwned && cooldown > 0 ? revenue / (cooldown / 1000) : 0;
    const cost = techniqueSystem ? techniqueSystem.cost(definition.id) : definition.baseCost;

    const proficiencyClass = `technique__proficiency technique__proficiency--${proficiencyName.toLowerCase().replace(/\s+/g, '-')}`;

    const row = doc.createElement('div');
    row.classList.add('technique');
    row.setAttribute('data-technique-id', definition.id);
    row.setAttribute('data-technique-level', String(level));

    // Info column
    const info = doc.createElement('div');
    info.classList.add('technique__info');

    const nameEl = doc.createElement('span');
    nameEl.classList.add('technique__name');
    nameEl.textContent = definition.name;

    const levelEl = doc.createElement('span');
    levelEl.classList.add('technique__level');
    levelEl.textContent = isOwned ? `Lv.${level}` : 'Not owned';

    const profEl = doc.createElement('span');
    profEl.classList.add('technique__proficiency');
    profEl.setAttribute('data-technique-proficiency', '');
    profEl.textContent = isOwned ? proficiencyName : '—';
    // Add proficiency color class
    profEl.classList.add(`technique__proficiency--${proficiencyName.toLowerCase().replace(/\s+/g, '-')}`);

    info.appendChild(nameEl);
    info.appendChild(levelEl);
    info.appendChild(profEl);

    // Stats column
    const stats = doc.createElement('div');
    stats.classList.add('technique__stats');

    const qiStat = doc.createElement('span');
    qiStat.classList.add('technique__stat');
    if (isOwned) {
      qiStat.textContent = `${formatNumber(qiPerSec, 1)} Qi/s`;
    } else {
      const baseRevenue = definition.baseRevenue;
      const baseCooldown = definition.cooldownMs;
      qiStat.textContent = `${formatNumber(baseRevenue / (baseCooldown / 1000), 1)} Qi/s (base)`;
    }

    stats.appendChild(qiStat);

    // Actions column
    const actions = doc.createElement('div');
    actions.classList.add('technique__actions');

    const costEl = doc.createElement('span');
    costEl.classList.add('technique__cost');
    costEl.textContent = `${formatNumber(cost)} stones`;

    const button = doc.createElement('button');
    button.classList.add('btn', 'btn--ghost', 'btn--sm');
    button.setAttribute('type', 'button');

    if (isOwned) {
      button.setAttribute('data-technique-upgrade', '');
      button.textContent = 'Upgrade';
      // Check if the player can afford it.
      const resourceSystem = techniqueSystem && techniqueSystem._resourceSystem;
      const canBuy = resourceSystem && resourceSystem.canAfford
        ? resourceSystem.canAfford('spiritStones', cost)
        : false;
      if (!canBuy) {
        button.setAttribute('disabled', 'true');
        button.classList.add('technique__action--disabled');
      }
    } else {
      button.setAttribute('data-technique-buy', '');
      button.textContent = 'Buy';
      const resourceSystem = techniqueSystem && techniqueSystem._resourceSystem;
      const canBuy = resourceSystem && resourceSystem.canAfford
        ? resourceSystem.canAfford('spiritStones', cost)
        : false;
      if (!canBuy) {
        button.setAttribute('disabled', 'true');
        button.classList.add('technique__action--disabled');
      }
    }

    actions.appendChild(costEl);
    actions.appendChild(button);

    row.appendChild(info);
    row.appendChild(stats);
    row.appendChild(actions);

    return row;
  }

  /**
   * Click delegation handler.
   *
   * @param {Event} event — the DOM click event.
   */
  function onPanelClick(event) {
    if (!techniqueSystem) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    // Buy button
    const buyBtn = target.closest(BUY_SELECTOR);
    if (buyBtn) {
      const row = buyBtn.closest('[data-technique-id]');
      if (row) {
        const id = row.getAttribute('data-technique-id');
        if (id) {
          techniqueSystem.buy(id);
          render();
          eventBus.emit('ui:refresh');
        }
      }
      return;
    }

    // Upgrade button
    const upgradeBtn = target.closest(UPGRADE_SELECTOR);
    if (upgradeBtn) {
      const row = upgradeBtn.closest('[data-technique-id]');
      if (row) {
        const id = row.getAttribute('data-technique-id');
        if (id) {
          techniqueSystem.upgrade(id);
          render();
          eventBus.emit('ui:refresh');
        }
      }
    }
  }

  panel.addEventListener('click', onPanelClick);

  // Re-render on every technique event and wallet change.
  function onForceRender() {
    render();
  }
  eventBus.subscribe('technique:purchased', onForceRender);
  eventBus.subscribe('technique:upgraded', onForceRender);
  eventBus.subscribe('resource:changed', onForceRender);
  eventBus.subscribe('ui:refresh', onForceRender);

  // Initial render.
  render();

  return {
    render,
    destroy() {
      panel.removeEventListener('click', onPanelClick);
      eventBus.unsubscribe('technique:purchased', onForceRender);
      eventBus.unsubscribe('technique:upgraded', onForceRender);
      eventBus.unsubscribe('resource:changed', onForceRender);
      eventBus.unsubscribe('ui:refresh', onForceRender);
    },
  };
}
