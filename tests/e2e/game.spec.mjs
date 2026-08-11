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
 *      queue; the activity log re-renders the entries;
 *   6. the Settings panel initializer is wired — the three boolean
 *      switches toggle state on click, the notation style <select>
 *      changes the formatter via NotationFormatter.setStyle(), and the
 *      Reset save button replaces the state with a fresh slice;
 *   7. the upgrades system renders data-driven rows in the Upgrades
 *      panel, a click on the cheapest upgrade deducts spirit stones,
 *      bumps the level, and lets the qi aggregate grow.
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
  // resources) and the spirit-stones binding renders the master's parting
  // gift (50 stones on a fresh game — no save to restore).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__resources)))
    .toBe(true);
  expect(await stateValue(page, 'resources.spiritStones')).toBe(50);
  await expect(page.locator('[data-bind="resources.spiritStones"]').first()).toBeVisible();

  // The data manager is wired from the manifest: the 'realms' collection
  // holds the canonical DESIGN.md 15-tier ladder (data/realms/realms.json),
  // loaded through the real DataManager pipeline (assert on state — the
  // count and the ordered canonical ids — not formatted text; see
  // tests/README.md E2E rules). Breakthroughs will consume it later.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__dataManager)))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__dataManager.count('realms')))
    .toBe(15);
  expect(
    await page.evaluate(() => window.__dataManager.keys('realms'))
  ).toEqual([
    'mortal',
    'qi-gathering',
    'foundation-establishment',
    'core-formation',
    'nascent-soul',
    'soul-transformation',
    'void-refinement',
    'body-integration',
    'great-ascension',
    'true-immortal',
    'celestial-immortal',
    'golden-immortal',
    'dao-lord',
    'heavenly-sovereign',
    'beyond-heaven',
  ]);

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

  // Fresh boot → the master's parting gift notification is the seed entry
  // (lore: a one-shot endowment framing narrates why the wallet starts at
  // 50 stones). Subsequent add() calls grow the queue from there.
  expect(await page.evaluate(() => window.__notifications.size())).toBe(1);
  expect(await page.evaluate(() => window.__notifications.queue[0].type)).toBe('info');
  await expect(page.locator('#activity-log .log__item')).toHaveCount(1);
  await expect(page.locator('#activity-log .log__item--info')).toHaveCount(1);

  // add() enqueues another entry; the queue mutates and the activity log
  // re-renders to two entries. The id is generated by the manager (we
  // only assert shape, not the exact value).
  const firstId = await page.evaluate(() =>
    window.__notifications.add('Welcome, cultivator.', { type: 'info' })
  );
  expect(typeof firstId).toBe('string');
  // Queue now carries [masterGift, welcome]. The two .info-class log entries
  // render in the activity log.
  expect(await page.evaluate(() => window.__notifications.size())).toBe(2);
  await expect(page.locator('#activity-log .log__item')).toHaveCount(2);
  await expect(page.locator('#activity-log .log__item--info')).toHaveCount(2);

  // dismiss() by id removes just that entry (the captured id is a Node-side
  // variable — pass it explicitly to page.evaluate so the browser closure sees
  // it). After dismissing the welcome row the queue holds only the gift.
  expect(
    await page.evaluate((id) => window.__notifications.dismiss(id), firstId)
  ).toBe(true);
  expect(await page.evaluate(() => window.__notifications.size())).toBe(1);
  await expect(page.locator('#activity-log .log__item')).toHaveCount(1);

  // clear() empties the rest of the queue (the master's gift included — it
  // was a one-shot narrative seed, not persistent ledger state).
  await page.evaluate(() => {
    window.__notifications.add('Two.');
    window.__notifications.add('Three.');
  });
  expect(await page.evaluate(() => window.__notifications.size())).toBe(3);
  await page.evaluate(() => window.__notifications.clear());
  expect(await page.evaluate(() => window.__notifications.size())).toBe(0);

  expect(errors).toEqual([]);
});

test('Settings panel initializer: toggles flip state, notation select changes the formatter, reset wipes state', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // SettingsPanel handle is exposed after bootstrap.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__settingsPanel)))
    .toBe(true);
  // The <select> is populated from config.notation.styles — the two shipped
  // styles are present.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelectorAll('[data-settings-select="notationStyle"] option').length
      )
    )
    .toBe(2);

  // Fresh-state defaults: offlineProgress=true (switch--on + aria-checked=true),
  // sound + notifications are false, notationStyle=null (formatter uses its
  // configured default — 'standard').
  expect(await stateValue(page, 'settings.offlineProgress')).toBe(true);
  expect(await stateValue(page, 'settings.sound')).toBe(false);
  expect(await stateValue(page, 'settings.notationStyle')).toBe(null);
  expect(
    await page.evaluate(() => window.__notation.style)
  ).toBe('standard');

  // Click Offline progress → flips to false (assert state first, then DOM:
  // the renderer's switch--on class and the initializer's aria-checked both
  // follow state, so checking the attribute indirectly proves both layers
  // ran. assert state, not formatted text — see tests/README.md E2E rules).
  await page.locator('[data-settings-toggle="offlineProgress"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.offlineProgress))
    .toBe(false);
  expect(
    await page
      .locator('[data-settings-toggle="offlineProgress"]')
      .getAttribute('aria-checked')
  ).toBe('false');

  // Click again → flips back to true.
  await page.locator('[data-settings-toggle="offlineProgress"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.offlineProgress))
    .toBe(true);

  // Click Sound → false → true (the Sound switch starts off, so this is a
  // single round-trip — exercising both the off→on and on→off paths).
  await page.locator('[data-settings-toggle="sound"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.sound))
    .toBe(true);
  await page.locator('[data-settings-toggle="sound"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.sound))
    .toBe(false);

  // The Notifications switch starts off — click it once to confirm it
  // observes the same path (an unknown key would be silently ignored by
  // applyToggle).
  await page.locator('[data-settings-toggle="notifications"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.notifications))
    .toBe(true);

  // Change the notation <select> → the formatter's effective style follows
  // (assert state, not formatted text — see tests/README.md E2E rules).
  await page
    .locator('[data-settings-select="notationStyle"]')
    .selectOption('scientific');
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.notationStyle))
    .toBe('scientific');
  await expect
    .poll(() => page.evaluate(() => window.__notation.style))
    .toBe('scientific');

  // Switch back via the <select>; the setter clears notationStyle back to a
  // known id and the formatter follows.
  await page
    .locator('[data-settings-select="notationStyle"]')
    .selectOption('standard');
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.notationStyle))
    .toBe('standard');

  // Reset save: the destruct button replaces state with the canonical fresh
  // slice — settings.notationStyle goes to null and every toggle defaults
  // to its fresh-state value.
  await page.locator('[data-settings-reset]').click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.notationStyle))
    .toBe(null);
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.offlineProgress))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__game.state.settings.notifications))
    .toBe(false);
  // The formatter drops its override when notationStyle is null.
  await expect
    .poll(() => page.evaluate(() => window.__notation.style))
    .toBe('standard');

  expect(errors).toEqual([]);
});

test('Statistics: system is wired, playtime grows, panel renders the four counters', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // StatisticsSystem is exposed after bootstrap (it's a debug global
  // like __meditation / __qi).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__statistics)))
    .toBe(true);

  // The system owns playtimeMs; its public query API exposes every
  // counter in canonical shape (snapshot order is stable).
  const initial = await page.evaluate(() => window.__statistics.getAll());
  expect(initial).toEqual({
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  });

  // The fixed-timestep loop's tick — the same one that grows qi — must
  // also grow playtimeMs (assert state, not formatted text — see
  // tests/README.md E2E rules).
  await page.waitForFunction(
    () => window.__statistics && window.__statistics.get('playtimeMs') > 0,
    null,
    { timeout: 15_000 }
  );
  const playtimeAfterWait = await page.evaluate(() =>
    window.__statistics.get('playtimeMs')
  );
  expect(playtimeAfterWait).toBeGreaterThan(0);
  expect(playtimeAfterWait).toBeLessThanOrEqual(initial.playtimeMs + 60_000);

  // Snapshot's playtimeMs agrees with get() — single source of truth.
  const liveSnapshot = await page.evaluate(() => window.__statistics.getAll());
  expect(liveSnapshot.playtimeMs).toBe(playtimeAfterWait);

  // The Statistics panel renders all four counters via data-bind. Playtime
  // uses the new duration mode ("\d+s" branch on a fresh boot — relaxed
  // to catch the future "Xh Ym" branch too). The other three counters use
  // text mode; we assert their NON-EMPTY textContent (the value range is
  // 0..a-few-after-the-first-tick — far below the notation threshold).
  const panel = page.locator('[data-statistics-panel]');
  await expect(panel).toBeVisible();
  await expect(
    panel.locator('[data-bind="statistics.playtimeMs"]')
  ).toHaveText(/^\d+s$/);
  // The text-mode bindings render an integer (or an em dash for null —
  // none of these are null on a healthy fresh state). The notation
  // formatter thresholds above ~1000; a couple of seconds of qi at the
  // 2 qi/s rate stay well below that, so an integer regex is fine.
  const qiText = await panel
    .locator('[data-bind="statistics.qiGenerated"]')
    .textContent();
  expect(qiText).toMatch(/^\d+$/);
  const meditationsText = await panel
    .locator('[data-bind="statistics.meditationsCompleted"]')
    .textContent();
  expect(meditationsText).toMatch(/^\d+$/);
  const breakthroughsText = await panel
    .locator('[data-bind="statistics.breakthroughsTotal"]')
    .textContent();
  expect(breakthroughsText).toMatch(/^\d+$/);

  // The panel rendered exactly four stat bindings — guards against
  // accidental stray data-binds leaking into the new article.
  await expect(panel.locator('[data-bind]')).toHaveCount(4);

  // After more ticks the bound playtimeMs keeps advancing and the rendered
  // string reflects it.
  await page.waitForFunction(
    () => window.__statistics.get('playtimeMs') > 1000,
    null,
    { timeout: 15_000 }
  );
  // Read the rendered duration text and parse the leading digits — the
  // panel rounds to whole seconds, so "1s" → 1, "2s" → 2, … .
  const playtimeRendered = await panel
    .locator('[data-bind="statistics.playtimeMs"]')
    .textContent();
  const playtimeRenderedSeconds = Number(playtimeRendered.replace(/[^\d]/g, ''));
  expect(playtimeRenderedSeconds).toBeGreaterThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('upgrades system renders data-driven rows, buying one levels it up and grows qi', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // UpgradeSystem is exposed after bootstrap; the catalog is the data-
  // driven one from data/upgrades/upgrades.json (four entries).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__upgrades)))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__upgrades.list().length))
    .toBe(4);

  // The Upgrades panel renders a row per upgrade. Each row carries
  // data-upgrade-id (delegation anchor) — verify against the canonical
  // ids.
  await expect(page.locator('[data-upgrade-id="foundation-breathing"]')).toHaveCount(1);
  await expect(page.locator('[data-upgrade-id="qi-gathering"]')).toHaveCount(1);
  await expect(page.locator('[data-upgrade-id="meridian-cleansing"]')).toHaveCount(1);
  await expect(page.locator('[data-upgrade-id="spirit-root-enhancement"]')).toHaveCount(1);

  // Pre-state: every upgrade is at level 0, the qi aggregate slot is 0.
  expect(
    await page.evaluate(() => window.__upgrades.level('foundation-breathing'))
  ).toBe(0);
  expect(
    await stateValue(page, 'cultivation.qiSources.upgrades')
  ).toBe(0);

  // The fresh boot already carries the master's parting gift (50 stones).
  // The cheapest upgrade costs 10, level-1; subsequent costs grow
  // geometrically (10, 15, 22, 33, 49, …). Keep clicking until the
  // wallet can no longer cover the next cost — that's the first point
  // where the row goes disabled in the DOM.
  const stonesBefore = await page.evaluate(() =>
    window.__resources.get('spiritStones')
  );

  // Click through levels until either canPurchase() returns false or we
  // hit a safety cap (the geometric curve means we hit "unaffordable"
  // well before 12 clicks even from the gift baseline).
  let clickCount = 0;
  while (clickCount < 12) {
    const canBuy = await page.evaluate(() =>
      window.__upgrades.canPurchase('foundation-breathing')
    );
    if (!canBuy) break;
    const beforeLevel = await page.evaluate(() =>
      window.__upgrades.level('foundation-breathing')
    );
    await page.locator('[data-upgrade-id="foundation-breathing"]').click();
    await expect
      .poll(() => page.evaluate(() => window.__upgrades.level('foundation-breathing')))
      .toBe(beforeLevel + 1);
    clickCount += 1;
  }

  // After draining, the wallet cannot cover the next cost — the row is
  // rendered with the disabled attribute (the upgrades-panel re-renders
  // on every resource:changed emission so the DOM follows the wallet).
  expect(clickCount).toBeGreaterThan(0);
  const foundationDisabled = await page
    .locator('[data-upgrade-id="foundation-breathing"]')
    .getAttribute('disabled');
  expect(foundationDisabled).toBe('true');

  // The qi aggregate grew by level × effectPerLevel (1) on every click.
  const finalLevel = await page.evaluate(() =>
    window.__upgrades.level('foundation-breathing')
  );
  const finalQi = await page.evaluate(
    () => window.__game.state.cultivation.qiSources.upgrades
  );
  expect(finalQi).toBe(finalLevel);
  // The wallet drained (≤ starting balance - sum of geometric costs covered).
  const finalStones = await page.evaluate(() =>
    window.__resources.get('spiritStones')
  );
  expect(finalStones).toBeLessThanOrEqual(stonesBefore);
  // The original 50-stone gift is now partially spent on upgrades.
  expect(stonesBefore).toBe(50);

  expect(errors).toEqual([]);
});
