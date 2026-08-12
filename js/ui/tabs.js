/**
 * ui/tabs.js — Tab controller for the game panel navigation (pure presentation).
 *
 * Wires the tab bar (role="tablist") to show/hide tab panels on click. Each
 * tab button carries a data-tab attribute whose value matches the
 * data-tab-panel attribute on the corresponding panel wrapper.
 *
 * Responsibilities:
 *   - Find tab buttons via [data-tab] and panels via [data-tab-panel] inside
 *     the injected root.
 *   - On click of a tab button, hide all panels (hidden attribute), show the
 *     matching panel, set the clicked tab's aria-selected to true (others to
 *     false), and add .tab--active class.
 *   - Show the initial tab on init, hide all others.
 *   - Return a handle with { selectTab(id), destroy() }.
 *
 * Reads DOM state only — never mutates gameplay, no storage access, no
 * innerHTML. Framework-free and GitHub Pages compatible.
 *
 * Defensive contracts: missing root.querySelector → console.warn once + no-op
 * handle; no tabs or panels found → warn once + no-op.
 */
import { EventBus } from '../core/event-bus.js';

/** CSS selector for tab buttons. */
const TAB_SELECTOR = '[data-tab]';

/** CSS selector for tab panels. */
const PANEL_SELECTOR = '[data-tab-panel]';

/** Shared no-op handle for every skip path. */
const NOOP_HANDLE = {
  selectTab() {},
  destroy() {},
};

/**
 * Initialize the tab controller.
 *
 * @param {object} [options]
 * @param {object} [options.root=document] — DOM scope for querySelector and
 *        addEventListener. The delegated click listener is attached here.
 * @param {string} [options.initialTab='cultivation'] — data-tab value of the
 *        tab to show on init.
 * @returns {{ selectTab(id: string): void, destroy(): void }} the tab handle.
 *        destroy() removes the delegated click listener (idempotent).
 */
export function initTabs({ root = document, initialTab = 'cultivation' } = {}) {
  if (typeof root.querySelector !== 'function') {
    console.warn('Tabs: root.querySelector is missing; skipping tab navigation.');
    return NOOP_HANDLE;
  }

  const tabButtons = root.querySelectorAll(TAB_SELECTOR);
  const tabPanels = root.querySelectorAll(PANEL_SELECTOR);

  if (!tabButtons || tabButtons.length === 0) {
    console.warn('Tabs: no [data-tab] buttons found; skipping tab navigation.');
    return NOOP_HANDLE;
  }

  if (!tabPanels || tabPanels.length === 0) {
    console.warn('Tabs: no [data-tab-panel] panels found; skipping tab navigation.');
    return NOOP_HANDLE;
  }

  /** @type {Map<string, Element>} data-tab value → button element. */
  const buttonMap = new Map();
  for (const btn of tabButtons) {
    const tab = btn.getAttribute('data-tab');
    if (tab) buttonMap.set(tab, btn);
  }

  /** @type {Map<string, Element>} data-tab-panel value → panel element. */
  const panelMap = new Map();
  for (const panel of tabPanels) {
    const tab = panel.getAttribute('data-tab-panel');
    if (tab) panelMap.set(tab, panel);
  }

  /** @type {Function|null} the delegated click handler (for teardown). */
  let clickHandler = null;

  /** @type {boolean} one-shot warning flag for unknown tab id. */
  let warnedUnknownTab = false;

  /**
   * Select a tab by its data-tab id. Shows the matching panel, hides all
   * others, updates aria-selected and the .tab--active class.
   *
   * @param {string} id — the data-tab value to select.
   */
  function selectTab(id) {
    const targetBtn = buttonMap.get(id);
    const targetPanel = panelMap.get(id);

    if (!targetBtn || !targetPanel) {
      if (!warnedUnknownTab) {
        console.warn(`Tabs: unknown tab "${id}" — no matching button or panel found.`);
        warnedUnknownTab = true;
      }
      return;
    }

    // Hide all panels, show the target.
    for (const [, panel] of panelMap) {
      if (panel === targetPanel) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    }

    // Update aria-selected and class on all buttons.
    for (const [, btn] of buttonMap) {
      if (btn === targetBtn) {
        btn.setAttribute('aria-selected', 'true');
        btn.classList.add('tab--active');
      } else {
        btn.setAttribute('aria-selected', 'false');
        btn.classList.remove('tab--active');
      }
    }
  }

  /**
   * Delegated click handler: finds the closest [data-tab] button and
   * selects the matching tab.
   *
   * @param {Event} event — the click event.
   */
  clickHandler = function onTabClick(event) {
    const tabBtn = event.target.closest(TAB_SELECTOR);
    if (!tabBtn) return;

    const tabId = tabBtn.getAttribute('data-tab');
    if (tabId) {
      selectTab(tabId);
    }
  };

  root.addEventListener('click', clickHandler);

  // Show the initial tab.
  selectTab(initialTab);

  return {
    selectTab,
    destroy() {
      if (clickHandler) {
        root.removeEventListener('click', clickHandler);
        clickHandler = null;
      }
    },
  };
}
