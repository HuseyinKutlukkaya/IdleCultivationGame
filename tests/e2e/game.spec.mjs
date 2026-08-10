/**
 * game.spec.mjs — real-browser smoke tests (Playwright, dev-only tooling).
 *
 * Covers the bootstrap paths that need a real browser and a real clock:
 *   1. the page boots cleanly (no console/page errors) and the loop is running;
 *   2. meditation is active by default and Qi climbs in state and in the DOM;
 *   3. a save round-trips: save → reload → state restored;
 *   4. the inventory system is wired and add()/remove() round-trip item
 *      stacks against the real data-driven item catalog;
 *   5. the notification manager is wired and add()/clear() mutate the
 *      queue; the activity log re-renders the entries.
 *
 * These run against the dependency-free static server (static-server.mjs),
 * never inside the node:test suite — the `.spec.mjs` suffix keeps them out of
 * the built-in runner's glob, which only matches `.test.mjs` files. Run with:
 * npm run test:e2e
 */
import { test, expect } from '@playwright/test';

/** Collect console errors and uncaught page exceptions for a page. */
function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

/** Read a dotted state path off the exposed game instance. */
function stateValue(page, path) {
  return page.evaluate((key) => {
    const value = key
      .split('.')
      .reduce((acc, part) => (acc == null ? acc : acc[part]), window.__game.state);
    return value == null ? null : value;
  }, path);
}

test('page boots cleanly and the game loop is running', async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto('/');

  // The status line is written at the very end of bootstrap, so its text
  // implies all boot-time console output already happened.
  await expect(page.locator('#status-text')).toContainText('Game loop running');
  await expect(page.locator('#status-text')).toContainText('Scaffold ready');

  // The resource wallet is wired from config.resources (all four declared
  // resources) and the spirit-stones binding renders its fresh zero balance.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__resources)))
    .toBe(true);
  expect(await stateValue(page, 'resources.spiritStones')).toBe(0);
  await expect(page.locator('[data-bind="resources.spiritStones"]').first()).toBeVisible();

  // The number notation formatter is wired from config.notation and defaults
  // to the config's standard style; an explicit setStyle writes the player
  // preference into state.settings (assert state, not formatted text — see
  // tests/README.md E2E rules).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__notation)))
    .toBe(true);
  expect(await page.evaluate(() => window.__notation.style)).toBe('standard');
  expect(await page.evaluate(() => window.__notation.setStyle('scientific'))).toBe(true);
  expect(await stateValue(page, 'settings.notationStyle')).toBe('scientific');

  expect(errors).toEqual([]);
});

test('meditation is active by default and Qi climbs in state and DOM', async ({ page }) => {
  await page.goto('/');

  // Fresh session: meditation starts active at the configured 2 Qi/s.
  await expect
    .poll(() => page.evaluate(() => window.__meditation?.isActive))
    .toBe(true);

  const qiBinding = page.locator('[data-bind="cultivation.qi"]').first();
  await expect(qiBinding).toBeVisible();

  const qiBefore = await stateValue(page, 'cultivation.qi');
  await page.waitForTimeout(2500);
  const qiAfter = await stateValue(page, 'cultivation.qi');
  expect(qiAfter).toBeGreaterThan(qiBefore);

  // QiSystem is wired and the meditation rate slot feeds the aggregate rate
  // (assert state, not formatted text — see tests/README.md E2E rules).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__qi)))
    .toBe(true);
  expect(await stateValue(page, 'cultivation.qiSources.meditation')).toBe(2);

  // The rendered text followed the state (no longer the static "0" shell).
  const rendered = await qiBinding.textContent();
  expect(Number(rendered.replace(/[^\d]/g, ''))).toBeGreaterThan(0);
});

test('a save round-trips: state persists across a reload', async ({ page }) => {
  await page.goto('/');

  // Let a little Qi accumulate, then persist deterministically via the
  // exposed save manager (the beforeunload path is unit-tested separately).
  await page.waitForFunction(
    () => window.__game && window.__game.state.cultivation.qi > 0,
    null,
    { timeout: 15_000 }
  );
  const qiBefore = await stateValue(page, 'cultivation.qi');
  const saved = await page.evaluate(() => window.__saveManager.save());
  expect(saved).toBe(true);

  await page.reload();
  await expect(page.locator('#status-text')).toContainText('Save restored.');
  const qiAfter = await stateValue(page, 'cultivation.qi');
  expect(qiAfter).toBeGreaterThanOrEqual(qiBefore);
});

test('inventory is wired and add()/remove() round-trip real item stacks', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // InventorySystem is exposed after bootstrap.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__inventory)))
    .toBe(true);

  // The canonical fresh inventory slice is active (20 slots, empty).
  expect(await stateValue(page, 'inventory.slots.total')).toBe(20);
  expect(await stateValue(page, 'inventory.slots.used')).toBe(0);

  // add() of a real catalog item (data/items/items.json, stackSize 99)
  // creates a stack and syncs slots.used (assert state, not formatted text).
  const added = await page.evaluate(() => window.__inventory.add('spirit-herb', 5));
  expect(added).toBe(5);
  expect(await stateValue(page, 'inventory.slots.used')).toBe(1);
  expect(await page.evaluate(() => window.__inventory.count('spirit-herb'))).toBe(5);
  expect(await page.evaluate(() => window.__inventory.has('spirit-herb', 5))).toBe(true);

  // Stacking onto the existing stack opens no new slot.
  expect(await page.evaluate(() => window.__inventory.add('spirit-herb', 4))).toBe(4);
  expect(await stateValue(page, 'inventory.slots.used')).toBe(1);
  expect(await page.evaluate(() => window.__inventory.count('spirit-herb'))).toBe(9);

  // remove() drains the stack and reports the remaining total.
  expect(await page.evaluate(() => window.__inventory.remove('spirit-herb', 3))).toBe(3);
  expect(await page.evaluate(() => window.__inventory.count('spirit-herb'))).toBe(6);
  expect(await stateValue(page, 'inventory.slots.used')).toBe(1);
  expect(await page.evaluate(() => window.__inventory.remainingSlots)).toBe(19);

  // The raw state carries exactly the surviving stack.
  expect(await page.evaluate(() => window.__game.state.inventory.items)).toEqual([
    { id: 'spirit-herb', count: 6 },
  ]);

  // The Inventory panel's stacks-held binding reflects the real stack count
  // after a UI refresh (integer text, locale-safe — no Intl formatting).
  const stacksHeld = page.locator('[data-bind="inventory.items.length"]').first();
  await expect(stacksHeld).toBeVisible();
  await expect(stacksHeld).toHaveText('1');

  expect(errors).toEqual([]);
});

test('notifications manager is wired and add()/clear() re-render the activity log', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // NotificationManager is exposed after bootstrap with its tuning pulled
  // from config.notifications (assert state, not formatted text — see
  // tests/README.md E2E rules).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__notifications)))
    .toBe(true);
  expect(await page.evaluate(() => window.__notifications.maxQueueSize)).toBe(50);
  expect(await page.evaluate(() => window.__notifications.types)).toEqual([
    'info',
    'success',
    'warning',
    'error',
    'achievement',
  ]);

  // Fresh boot → empty queue and the activity log is empty (the two no-JS
  // placeholder items in index.html are wiped on the first render).
  expect(await page.evaluate(() => window.__notifications.size())).toBe(0);

  // add() enqueues an entry; the queue mutates and the activity log
  // re-renders to a single entry. The id is generated by the manager (we
  // only assert shape, not the exact value).
  const firstId = await page.evaluate(() =>
    window.__notifications.add('Welcome, cultivator.', { type: 'info' })
  );
  expect(typeof firstId).toBe('string');
  expect(await page.evaluate(() => window.__notifications.size())).toBe(1);
  expect(
    await page.evaluate(() => window.__notifications.queue[0].type)
  ).toBe('info');
  expect(
    await page.evaluate(() => window.__notifications.queue[0].message)
  ).toBe('Welcome, cultivator.');

  // The activity log in the DOM mirrors the queue.
  await expect(page.locator('#activity-log .log__item')).toHaveCount(1);
  await expect(page.locator('#activity-log .log__item--info')).toHaveCount(1);

  // dismiss() by id removes just that entry (the captured id is a Node-side
  // variable — pass it explicitly to page.evaluate so the browser closure sees
  // it).
  expect(
    await page.evaluate((id) => window.__notifications.dismiss(id), firstId)
  ).toBe(true);
  expect(await page.evaluate(() => window.__notifications.size())).toBe(0);
  await expect(page.locator('#activity-log .log__item')).toHaveCount(0);

  // clear() empties a populated queue in one call.
  await page.evaluate(() => {
    window.__notifications.add('Two.');
    window.__notifications.add('Three.');
  });
  expect(await page.evaluate(() => window.__notifications.size())).toBe(2);
  await page.evaluate(() => window.__notifications.clear());
  expect(await page.evaluate(() => window.__notifications.size())).toBe(0);

  expect(errors).toEqual([]);
});
