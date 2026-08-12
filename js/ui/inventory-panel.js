/**
 * ui/inventory-panel.js — Inventory grid renderer (pure presentation).
 *
 * Renders the player's item stacks as a box grid inside the Inventory game
 * panel. Each item card shows the item's name, count, category badge, and
 * grade/quality text. The grid supports pagination when the number of stacks
 * exceeds the configured page size.
 *
 * Responsibilities:
 *   - Reads stacks from the injected inventorySystem (state.inventory.items).
 *   - Resolves item definitions from DataManager.get('items', id) for display
 *     metadata (name, description, category, grade, quality).
 *   - Renders item cards as a CSS grid inside the panel's body.
 *   - Paginates when stack count > pageSize (default 12), showing Prev/Next
 *     buttons and a "Page X of Y" info line.
 *   - Subscribes to 'inventory:changed' and 'ui:refresh' events for live
 *     re-rendering.
 *   - Handles empty inventory (placeholder text) and unknown item ids
 *     (degraded "Unknown item" card).
 *
 * Reads state only — never mutates gameplay, no storage access, no innerHTML
 * (all content via textContent). Framework-free and GitHub Pages compatible.
 *
 * Defensive contracts: missing DOM → console.warn once + no-op handle; missing
 * inventorySystem → renders empty grid; missing DataManager → all items
 * degrade to "Unknown item" cards.
 */
import { EventBus } from '../core/event-bus.js';

/** CSS selector for the inventory panel container. */
const PANEL_SELECTOR = '[data-inventory-panel]';

/** CSS selector for the body element inside the panel. */
const BODY_SELECTOR = '[data-inventory-body]';

/** CSS class for the pagination container. */
const PAGINATION_CLASS = 'inventory-pagination';

/** CSS class for the item grid. */
const GRID_CLASS = 'inventory-grid';

/** CSS class for individual item cards. */
const ITEM_CLASS = 'inventory-item';

/** CSS class for the empty-state placeholder. */
const PLACEHOLDER_CLASS = 'inventory-placeholder';

/** Event the InventorySystem emits on every stack mutation. */
const INVENTORY_CHANGED = 'inventory:changed';

/** Event emitted for explicit UI refresh. */
const UI_REFRESH = 'ui:refresh';

/** Shared no-op handle for every skip path. */
const NOOP_HANDLE = {
  render() {},
  destroy() {},
};

/**
 * Initialize the Inventory panel.
 *
 * @param {object} [options]
 * @param {object} [options.root=document] — DOM scope for querySelector.
 * @param {object|null} [options.inventorySystem=null] — InventorySystem (or a
 *        lookalike with an `inventory` getter returning an array of
 *        { id, count } stacks). When null, an empty grid is rendered.
 * @param {object|null} [options.dataManager=null] — DataManager (or a
 *        lookalike with `get(collection, id)`) for item definitions from the
 *        'items' collection. When null, every item degrades to "Unknown item".
 * @param {object} [options.eventBus=EventBus] — pub/sub bus for lifecycle
 *        events.
 * @param {object|null} [options.config=null] — optional config for tuning
 *        (reserved for future panel-specific options).
 * @param {number} [options.pageSize=12] — number of stacks per page.
 * @returns {{ render(): void, destroy(): void }} the panel handle. render()
 *        rebuilds the grid from the current inventory system state. destroy()
 *        unsubscribes all event listeners (idempotent).
 */
export function initInventoryPanel({
  root = document,
  inventorySystem = null,
  dataManager = null,
  eventBus = EventBus,
  config = null,
  pageSize = 12,
} = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn('InventoryPanel: root.querySelector is missing; skipping Inventory panel.');
    return NOOP_HANDLE;
  }

  const panel = root.querySelector(PANEL_SELECTOR);
  if (!panel) {
    console.warn('InventoryPanel: no [data-inventory-panel] found; skipping Inventory panel.');
    return NOOP_HANDLE;
  }

  const body = panel.querySelector(BODY_SELECTOR) || panel;

  /** @type {number} stacks per page (positive integer). */
  const _pageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 12;

  /** @type {number} current page index (0-based). */
  let _currentPage = 0;

  /** @type {Array<Function>} event callbacks registered for teardown. */
  const _subscriptions = [];

  /** @type {boolean} one-shot warning for missing inventory system. */
  let warnedNoInventorySystem = false;

  /** @type {boolean} one-shot warning for missing dataManager. */
  let warnedNoDataManager = false;

  /** @type {boolean} one-shot warning for unknown item ids. */
  let warnedUnknownItem = false;

  /**
   * Build a single item card element.
   *
   * @param {{ id: string, count: number }} stack — the stack from inventory.
   * @param {object|null} definition — item definition from DataManager, or
   *        null for unknown items.
   * @returns {Element} the populated .inventory-item card.
   */
  function createItemCard(stack, definition) {
    const card = document.createElement('div');
    card.className = ITEM_CLASS;
    card.setAttribute('data-item-id', stack.id);

    const name = document.createElement('span');
    name.className = 'inventory-item__name';
    if (definition) {
      name.textContent = definition.name || stack.id;
      card.setAttribute('data-item-category', definition.category || '');
      card.setAttribute('data-item-grade', definition.grade || '');
    } else {
      name.textContent = `Unknown item (${stack.id})`;
      card.setAttribute('data-item-category', '');
      card.setAttribute('data-item-grade', '');
    }

    const count = document.createElement('span');
    count.className = 'inventory-item__count';
    count.textContent = `\u00d7${stack.count}`;

    const category = document.createElement('span');
    category.className = 'inventory-item__category';
    category.textContent = definition ? (definition.category || '—') : '—';

    const grade = document.createElement('span');
    grade.className = 'inventory-item__grade';
    grade.textContent = definition ? (definition.grade || '') : '';

    card.appendChild(name);
    card.appendChild(count);
    card.appendChild(category);
    card.appendChild(grade);

    return card;
  }

  /**
   * Get item definition from the DataManager. Degrades gracefully when
   * DataManager is absent or the id is not found.
   *
   * @param {string} id — item id to look up.
   * @returns {object|null} the definition or null.
   */
  function resolveDefinition(id) {
    if (!dataManager || typeof dataManager.get !== 'function') {
      if (!warnedNoDataManager) {
        console.warn('InventoryPanel: no DataManager provided; item definitions unavailable.');
        warnedNoDataManager = true;
      }
      return null;
    }

    const def = dataManager.get('items', id);
    if (!def) {
      if (!warnedUnknownItem) {
        console.warn(`InventoryPanel: unknown item id "${id}" — no definition found.`);
        warnedUnknownItem = true;
      }
      return null;
    }

    return def;
  }

  /**
   * Render (or re-render) the inventory grid. Reads the current stacks from
   * the inventory system, resolves definitions, paginates, and rebuilds the
   * DOM inside the panel body.
   */
  function render() {
    // Clear the body.
    while (body.firstChild) {
      body.removeChild(body.firstChild);
    }

    // Resolve stacks from the inventory system.
    let stacks = [];
    if (!inventorySystem) {
      if (!warnedNoInventorySystem) {
        console.warn('InventoryPanel: no InventorySystem provided; rendering empty grid.');
        warnedNoInventorySystem = true;
      }
    } else if (typeof inventorySystem.inventory !== 'undefined') {
      stacks = Array.isArray(inventorySystem.inventory) ? inventorySystem.inventory : [];
    }

    if (stacks.length === 0) {
      const placeholder = document.createElement('p');
      placeholder.className = PLACEHOLDER_CLASS;
      placeholder.textContent = 'No items in inventory';
      body.appendChild(placeholder);
      _currentPage = 0;
      return;
    }

    // Pagination math.
    const totalPages = Math.ceil(stacks.length / _pageSize);
    if (_currentPage >= totalPages) {
      _currentPage = Math.max(totalPages - 1, 0);
    }

    const start = _currentPage * _pageSize;
    const pageStacks = stacks.slice(start, start + _pageSize);

    // Build the grid.
    const grid = document.createElement('div');
    grid.className = GRID_CLASS;
    grid.setAttribute('data-inventory-grid', '');

    for (const stack of pageStacks) {
      const definition = resolveDefinition(stack.id);
      const card = createItemCard(stack, definition);
      grid.appendChild(card);
    }

    body.appendChild(grid);

    // Pagination controls (only when more than one page).
    if (totalPages > 1) {
      const pagination = document.createElement('div');
      pagination.className = PAGINATION_CLASS;
      pagination.setAttribute('data-inventory-pagination', '');

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'btn btn--ghost';
      prevBtn.setAttribute('data-inventory-prev', '');
      prevBtn.textContent = 'Prev';
      if (_currentPage <= 0) {
        prevBtn.disabled = true;
      }

      const pageInfo = document.createElement('span');
      pageInfo.className = 'inventory-pagination__info';
      pageInfo.setAttribute('data-inventory-page-info', '');
      pageInfo.textContent = `Page ${_currentPage + 1} of ${totalPages}`;

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn btn--ghost';
      nextBtn.setAttribute('data-inventory-next', '');
      nextBtn.textContent = 'Next';
      if (_currentPage >= totalPages - 1) {
        nextBtn.disabled = true;
      }

      // Pagination click handlers.
      prevBtn.addEventListener('click', () => {
        if (_currentPage > 0) {
          _currentPage -= 1;
          render();
        }
      });

      nextBtn.addEventListener('click', () => {
        if (_currentPage < totalPages - 1) {
          _currentPage += 1;
          render();
        }
      });

      pagination.appendChild(prevBtn);
      pagination.appendChild(pageInfo);
      pagination.appendChild(nextBtn);
      body.appendChild(pagination);
    }
  }

  // Subscribe to inventory change events for live re-rendering.
  /**
   * Handler for 'inventory:changed' event.
   */
  function onInventoryChanged() {
    render();
  }

  eventBus.subscribe(INVENTORY_CHANGED, onInventoryChanged);
  _subscriptions.push({ event: INVENTORY_CHANGED, handler: onInventoryChanged });

  /**
   * Handler for 'ui:refresh' event.
   */
  function onUiRefresh() {
    render();
  }

  eventBus.subscribe(UI_REFRESH, onUiRefresh);
  _subscriptions.push({ event: UI_REFRESH, handler: onUiRefresh });

  // Initial render.
  render();

  return {
    render,
    destroy() {
      for (const { event, handler } of _subscriptions) {
        eventBus.unsubscribe(event, handler);
      }
      _subscriptions.length = 0;
    },
  };
}
