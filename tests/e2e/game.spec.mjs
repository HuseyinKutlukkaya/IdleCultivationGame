/**
 * game.spec.mjs — real-browser smoke tests (Playwright, dev-only tooling).
 *
 * Covers the bootstrap paths that need a real browser and a real clock:
 *   1. the page boots cleanly (no console/page errors) and the loop is running;
 *   2. meditation is active by default and Qi climbs in state and in the DOM;
 *   3. a save round-trips: save → reload → state restored.
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
