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
 *      queue; the activity log re-renders the entries; the popup stack
 *      surfaces every popup:true entry as a transient top-right toast
 *      (the master's parting gift, realm breakthroughs, and tribulation
 *      outcomes — the P2 Event Popup & Log Pipeline visual half).
 *   6. the Settings panel initializer is wired — the three boolean
 *      switches toggle state on click, the notation style <select>
 *      changes the formatter via NotationFormatter.setStyle(), and the
 *      Reset save button replaces the state with a fresh slice;
 *   7. the upgrades system renders data-driven rows in the Upgrades
 *      panel, a click on the cheapest upgrade deducts spirit stones,
 *      bumps the level, and lets the qi aggregate grow.
 *   8. the breakthrough system is wired — the data-driven tables load
 *      for the full ladder, the boot sync lands the current realm's
 *      gates, a blocked attempt mutates nothing, and a full-progress
 *      attempt advances the realm through RealmSystem with the post-
 *      success sync pulling the new realm's entry.
 *   9. the tribulation system is wired — entering a tribulation-bearing
 *      realm (Core Formation) opens the gate and blocks the breakthrough
 *      until a survived face() clears it; the cleared gate survives a
 *      save round-trip.
 *  10. the spirit roots system is wired — the ladder loads for the full
 *      10-type progression, the fresh boot keeps the neutral unawakened
 *      root, and a console roll() writes the rolled root into state
 *      (spiritRoot slice, cultivation.spiritRootMultiplier,
 *      player.spiritRoot).
 *  11. the cultivation panel is wired — the character readout renders the
 *      fresh-state cultivator, the Breakthrough button enables live as
 *      realm progress accrues, a click drives the real BreakthroughSystem
 *      through the delegation, and entering a tribulation realm renders
 *      the Face button whose click opens the gate and un-blocks the
 *      breakthrough.
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

  // The realm system is wired: the current realm resolves from state and the
  // DOM binding renders the realm name through its "{0} Realm" format
  // template (the realm-name rendering is exactly what this feature proves
  // in a real browser).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__realms)))
    .toBe(true);
  expect(await page.evaluate(() => window.__realms.current().id)).toBe('mortal');
  expect(await stateValue(page, 'cultivation.realmTier')).toBe(0);
  const realmName = page.locator('.realm-name');
  await expect(realmName).toBeVisible();
  await expect(realmName).toHaveText('Mortal Realm');

  // A setRealm round-trip — the mutation the future BreakthroughSystem will
  // call: the ladder advances in state (name + tier + next realm) with the
  // real data-driven effects (qiMaxMultiplier 2) and the rendered realm name
  // follows (the renderer's next loop:uiRefresh paints the new identity).
  expect(
    await page.evaluate(() => window.__realms.setRealm('qi-gathering'))
  ).toBe(true);
  expect(await stateValue(page, 'cultivation.realm')).toBe('Qi Gathering');
  expect(await stateValue(page, 'cultivation.realmTier')).toBe(1);
  expect(await stateValue(page, 'cultivation.nextRealm')).toBe(
    'Foundation Establishment'
  );
  expect(await stateValue(page, 'cultivation.realmEffects.qiMaxMultiplier')).toBe(
    2
  );
  await expect(realmName).toHaveText('Qi Gathering Realm');

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
  expect(await stateValue(page, 'cultivation.qiSources.meditation')).toBe(20);

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

  // The Inventory panel's grid renders the surviving stack. Navigate to the
  // Inventory tab and verify the grid shows one item card (spirit-herb with
  // count 6) matching the surviving state.
  await page.locator('[data-tab="inventory"]').click();
  await expect(page.locator('#tab-inventory')).toBeVisible();
  const cards = page.locator('.inventory-item');
  await expect(cards).toHaveCount(1);
  await expect(cards.nth(0).locator('.inventory-item__name')).toHaveText('Spirit Herb');
  await expect(cards.nth(0).locator('.inventory-item__count')).toHaveText('\u00d76');

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
  // P2 — the parting gift is enqueued with { popup: true }, so the popup
  // stack surfaces it as a transient top-right toast (asserting state plus
  // the visible popup, never formatted text — see tests/README.md E2E rules).
  expect(await page.evaluate(() => window.__notifications.queue[0].popup)).toBe(true);
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__popupStack)))
    .toBe(true);
  await expect(page.locator('[data-popup-root] [data-popup]')).toHaveCount(1);
  await expect(
    page.locator('[data-popup-root] [data-popup-type="info"]')
  ).toHaveCount(1);
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
  // Reset confirmation uses the in-game modal.
  await page.goto('/');

  // Navigate to the Settings tab (settings panel is inside it, hidden by default).
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator('[data-settings-panel]')).toBeVisible();
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
   await expect(page.locator('[data-modal-panel]')).toBeVisible();
   await page.locator('[data-modal-confirm]').click();
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
  // 20 qi/s rate stay well below that, so an integer regex is fine.
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

test('milestones system is wired: crossing a lifetime counter threshold grants the milestone and surfaces a notification', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // MilestoneSystem is exposed after bootstrap; the catalog is the data-
  // driven one from data/milestones/milestones.json (8 starter milestones).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__milestones)))
    .toBe(true);
  expect(
    await page.evaluate(() => window.__milestones.list().length)
  ).toBeGreaterThan(0);

  // Fresh boot: no threshold crossed yet — the reached map is empty. The
  // default-active meditation accrues 20 qi/s, so the first-qi threshold
  // (100 qiGenerated) WOULD be crossed within seconds — stop meditation at
  // boot so the reads below are deterministic (assert state, not formatted
  // text — see tests/README.md E2E rules).
  await page.waitForFunction(() => Boolean(window.__meditation));
  await page.evaluate(() => window.__meditation.stop());
  expect(await page.evaluate(() => window.__milestones.reached())).toEqual({});
  expect(
    await page.evaluate(() => window.__milestones.isReached('first-qi'))
  ).toBe(false);

  // Cross the first-qi threshold by writing the lifetime counter directly
  // (the StatisticsSystem picks it up on the next loop tick and emits
  // 'statistics:changed'; the MilestoneSystem grants on that emission —
  // the same path a real player's qi gains take).
  await page.evaluate(() => {
    window.__game.state.statistics.qiGenerated = 5000;
  });

  // The grant lands in the reached map with an epoch-ms stamp (the write
  // also crosses qi-generation-1000 at 1000 — the reached map guards the
  // once-ever semantics either way).
  await expect
    .poll(() => page.evaluate(() => window.__milestones.reached()))
    .toMatchObject({ 'first-qi': expect.any(Number) });
  expect(
    await page.evaluate(() => window.__milestones.isReached('first-qi'))
  ).toBe(true);

  // The milestone:reached → notification translation (main.js) surfaced an
  // achievement popup entry for the milestone in the notification queue.
  await expect
    .poll(() => page.evaluate(() => window.__notifications.queue.find(
      (e) => e && typeof e.message === 'string' && e.message.startsWith('Milestone reached: ')
    )))
    .toMatchObject({ type: 'achievement', popup: true });

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

  // Navigate to the Techniques tab (upgrades panel is inside it, hidden by default).
  await page.locator('[data-tab="techniques"]').click();
  await expect(page.locator('[data-upgrade-id="foundation-breathing"]')).toBeVisible();

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

test('breakthrough system is wired: gates block, a synced attempt advances the realm', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Determinism: the shipped JS uses Math.random for the breakthrough
  // weighted roll (js/systems/breakthroughs.js) and for the tribulation
  // outcome roll in face() (js/systems/tribulations.js) — both verified by
  // grep; their injectable `random` options default to Math.random. Seeding
  // it here via a page-scoped addInitScript affects no other test and
  // nothing else at boot. With Math.random → 0 the roll = 0 × totalWeight
  // lands in the FIRST bucket of the Mortal results table ('perfect' — a
  // SUCCESS outcome), so the success path below is deterministic instead of
  // the real 80/20 dice (~1-in-5 runs used to roll a failure and fail the
  // `advanced === true` assertion).
  page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto('/');

  // Determinism hardening: stop the default-active meditation session so the
  // loop's realm-progress accrual (qiPerSecond → realmProgress on every
  // loop:update) can never race the strict `realmProgress === 0` reads below
  // (a tick landing between the attempt's synchronous reset and a single-shot
  // read used to be able to accrue progress). Every progress value in this
  // test is set manually, so nothing depends on active qi.
  await page.waitForFunction(() => Boolean(window.__meditation));
  await page.evaluate(() => window.__meditation.stop());

  // BreakthroughSystem is exposed after bootstrap; the tables come from the
  // data-driven 'breakthroughs' collection — one entry per realm id across
  // the full 15-tier ladder (data/breakthroughs/breakthroughs.json).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__breakthroughs)))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__breakthroughs.count))
    .toBe(15);

  // Boot sync wrote the current (Mortal) realm's entry gates into the
  // cultivation slice: required progress 125, zero-cost breakthrough.
  expect(await stateValue(page, 'cultivation.realmProgressMax')).toBe(125);
  expect(await stateValue(page, 'cultivation.breakthroughCost')).toBe(0);
  expect(await stateValue(page, 'cultivation.realmProgress')).toBe(0);

  // With zero progress the gate blocks deterministically and mutates
  // nothing (assert state, not formatted text — see tests/README.md E2E
  // rules).
  expect(
    await page.evaluate(() => window.__breakthroughs.attempt())
  ).toEqual({ outcome: null, advanced: false, reason: 'progress' });
  expect(await stateValue(page, 'cultivation.realm')).toBe('Mortal');
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(0);

  // A manually-synced qi rate flows into realm progress on real ticks: the
  // mortal entry requires 125 progress; at 20 qi/s it clears in ~6s, but
  // the E2E exercises the attempt path directly with the gate satisfied
  // (as the player's click would once progress accrues) — the real
  // per-second accrual curve is covered by the unit suite, which drives
  // fake loop:update emissions.
  await page.evaluate(() => {
    window.__game.state.cultivation.realmProgress = 125;
    window.__game.state.cultivation.realmLayer = 9; // P4: must be at final layer
  });

  // A full-progress attempt on Mortal costs 0 stones, so no wallet spend —
  // the attempt consumes the entry's cost through the real ResourceSystem.
  const result = await page.evaluate(() => window.__breakthroughs.attempt());
  expect(result.advanced).toBe(true);
  expect(['perfect', 'great-success', 'success', 'barely-successful']).toContain(
    result.outcome
  );

  // The realm advanced through RealmSystem, progress reset, and the post-
  // success sync pulled the NEW realm's entry (Qi Gathering: 250 progress
  // cost 50 stones — matching data/breakthroughs/breakthroughs.json).
  expect(await stateValue(page, 'cultivation.realm')).toBe('Qi Gathering');
  expect(await stateValue(page, 'cultivation.realmTier')).toBe(1);
  expect(await stateValue(page, 'cultivation.realmProgress')).toBe(0);
  expect(await stateValue(page, 'cultivation.realmProgressMax')).toBe(250);
  expect(await stateValue(page, 'cultivation.breakthroughCost')).toBe(50);
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(1);
  // The realm-name DOM binding follows the state (rendered through its
  // "{0} Realm" format template).
  const realmName = page.locator('.realm-name');
  await expect(realmName).toHaveText('Qi Gathering Realm');

  // A second attempt is now blocked by the progress gate (the fresh
  // qi-gathering entry demands 250 progress and 50 stones, but the wallet
  // still holds 50 — so it CAN afford the cost; progress is 0 < 250 → the
  // progress gate blocks first). Verify the deterministic reason with zero
  // mutation.
  expect(
    await page.evaluate(() => window.__breakthroughs.attempt())
  ).toEqual({ outcome: null, advanced: false, reason: 'progress' });
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(1);

  expect(errors).toEqual([]);
});

test('tribulation system is wired: entering a gated realm blocks the breakthrough until the tribulation is faced', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Determinism: face() rolls with the same injected Math.random source as
  // the breakthrough roll (js/systems/tribulations.js, verified by grep —
  // the injectable `random` option defaults to Math.random). With
  // Math.random → 0 the roll = 0 × totalWeight lands in the FIRST bucket of
  // the Core Formation results table ('survived' — a SUCCESS outcome), so
  // the gate opens deterministically below.
  page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto('/');

  // TribulationSystem is exposed after bootstrap; the table comes from the
  // data-driven 'tribulations' collection — one entry per realm id across
  // the full 15-tier ladder (data/tribulations/tribulations.json), with the
  // first tribulation-bearing realm being Core Formation (lightning).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__tribulations)))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__tribulations.count))
    .toBe(15);
  expect(
    await page.evaluate(
      () => window.__tribulations.byRealm('core-formation').tribulationType
    )
  ).toBe('lightning');

  // Fresh boot at Mortal (ungated): the neutral gate (assert state, not
  // formatted text — see tests/README.md E2E rules).
  const mortalRequirements = await page.evaluate(() =>
    window.__tribulations.requirements()
  );
  expect(mortalRequirements.type).toBe(null);
  expect(mortalRequirements.pending).toBe(false);
  expect(mortalRequirements.canFace).toBe(false);

  // Enter Core Formation — the first tribulation-bearing realm: the gate
  // opens (pending) and stays open until the tribulation is faced.
  expect(
    await page.evaluate(() => window.__realms.setRealm('core-formation'))
  ).toBe(true);
  expect(await stateValue(page, 'tribulations')).toEqual({
    type: 'lightning',
    pending: true,
    survived: false,
  });

  // Satisfy every non-tribulation gate of the core-formation entry
  // (requiredProgress 1200, cost 400 stones, 2 spirit-herb bottleneck) and
  // attempt: the tribulation gate blocks with the dedicated reason and
  // mutates nothing.
  await page.evaluate(() => {
    window.__game.state.cultivation.realmProgress = 1200;
    window.__resources.add('spiritStones', 400);
    window.__inventory.add('spirit-herb', 2);
    window.__game.state.cultivation.realmLayer = 9; // P4: must be at final layer
  });
  expect(await page.evaluate(() => window.__breakthroughs.attempt())).toEqual({
    outcome: null,
    advanced: false,
    reason: 'tribulation',
  });
  expect(await stateValue(page, 'cultivation.realm')).toBe('Core Formation');
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(0);
  const blocked = await page.evaluate(() =>
    window.__breakthroughs.requirements()
  );
  expect(blocked.tribulationRequired).toBe(true);
  expect(blocked.tribulationMet).toBe(false);

  // Face the tribulation: Math.random → 0 rolls 'survived' (the first
  // bucket) — the gate opens.
  expect(await page.evaluate(() => window.__tribulations.face())).toEqual({
    outcome: 'survived',
    survived: true,
  });
  expect(await stateValue(page, 'tribulations')).toEqual({
    type: 'lightning',
    pending: false,
    survived: true,
  });
  const open = await page.evaluate(() => window.__breakthroughs.requirements());
  expect(open.tribulationMet).toBe(true);

  // Save round-trip (save path): a reload mid-stay must keep the cleared
  // gate open — the boot re-syncs the current realm's gate with
  // preserveSurvived (state.tribulations.survived survives the boot).
  const saved = await page.evaluate(() => window.__saveManager.save());
  expect(saved).toBe(true);
  await page.reload();
  await expect(page.locator('#status-text')).toContainText('Save restored.');
  expect(await stateValue(page, 'tribulations')).toEqual({
    type: 'lightning',
    pending: false,
    survived: true,
  });
  // The breakthrough gate is still open after the reload.
  const afterReload = await page.evaluate(() =>
    window.__breakthroughs.requirements()
  );
  expect(afterReload.tribulationMet).toBe(true);

  expect(errors).toEqual([]);
});

test('spirit roots system is wired and roll() writes a rolled root into state', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Determinism: roll() uses the injectable random source defaulting to
  // Math.random (js/systems/spirit-roots.js, verified by grep). With
  // Math.random → 0 the roll = 0 × totalWeight lands in the FIRST bucket of
  // the ladder ('no-root' — the worst tier), so the rolled root below is
  // deterministic.
  page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto('/');

  // SpiritRootSystem is exposed after bootstrap; the ladder comes from the
  // data-driven 'spirit-roots' collection — the canonical 10-tier DESIGN.md
  // progression (data/spirit-roots/spirit-roots.json).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__spiritRoots)))
    .toBe(true);
  expect(await page.evaluate(() => window.__spiritRoots.count)).toBe(10);

  // Fresh boot: the canonical neutral pre-roll state — unawakened root,
  // cultivation slot at 1, display name 'Unawakened' (assert state, not
  // formatted text — see tests/README.md E2E rules).
  expect(await stateValue(page, 'spiritRoot.id')).toBe('unawakened');
  expect(await stateValue(page, 'spiritRoot.name')).toBe('Unawakened');
  expect(await stateValue(page, 'cultivation.spiritRootMultiplier')).toBe(1);

  // roll() via the console mutates state: the rolled root lands in the
  // spiritRoot slice, the cultivation-speed slot and player.spiritRoot.
  const rolled = await page.evaluate(() => window.__spiritRoots.roll());
  expect(rolled).toEqual({
    id: 'no-root',
    name: 'No Root',
    tier: 0,
    speedMultiplier: 0.85,
  });
  expect(await stateValue(page, 'spiritRoot.id')).toBe('no-root');
  expect(await stateValue(page, 'spiritRoot.name')).toBe('No Root');
  expect(await stateValue(page, 'spiritRoot.tier')).toBe(0);
  expect(await stateValue(page, 'cultivation.spiritRootMultiplier')).toBe(0.85);
  expect(await stateValue(page, 'player.spiritRoot')).toBe('No Root');

  expect(errors).toEqual([]);
});

test('human playability: a real player can complete the core loop through the UI', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // This is the STANDING human-playability spec (ROADMAP "Cross-Cutting
  // Gates"): it proves the game's current core loop is completable by a
  // real player through actual UI interactions — real buttons, visible
  // feedback, no dead-ends, no console errors. It is NOT a Phase-3
  // deliverable: as the loop grows (items, sects, reincarnation, ...) this
  // spec extends with each new playable action, never shrinks.
  //
  // Today the core loop IS the cultivation loop: meditate (qi accrues) →
  // progress fills → Breakthrough button lights up → click it → the realm
  // advances → on tribulation-bearing realms the gate opens and the Face
  // Tribulation button appears → click it → breakthrough again. The clicks
  // below drive the REAL systems through the Cultivation panel's delegated
  // listeners (js/ui/cultivation-panel.js), exactly as a player would.
  //
  // Determinism: face() and the breakthrough attempt share the injected
  // Math.random source (js/systems/tribulations.js + js/systems/breakthroughs.js,
  // verified by grep). With Math.random → 0 the roll lands in the FIRST
  // bucket of each results table ('perfect' / 'survived' — both successes),
  // so the success paths below are deterministic.
  page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto('/');

  // The panel initializer is exposed after bootstrap.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__cultivationPanel)))
    .toBe(true);

  const panel = page.locator('[data-cultivation-panel]');
  await expect(panel).toBeVisible();

  // The character readout renders the fresh-state cultivator: the canonical
  // pre-roll display name 'Unawakened' from player.spiritRoot, the physique
  // name from player.physique, the meridian name from player.meridians, the
  // dantian name from player.dantian, the bloodline name from
  // player.bloodline, the soul name from player.soul, the talent name from
  // player.talent, the comprehension name from player.comprehension, the
  // destiny name from player.destiny and the luck name from player.luck
  // (assert state-derived text, not Intl-formatted numbers — see
  // tests/README.md E2E rules).
  await expect(panel.locator('[data-cultivation-character]')).toHaveText(
    'Spirit Root: Unawakened · Physique: Ordinary Body · Meridians: Normal · Dantian: Normal Dantian · Bloodline: Ancient Human · Soul: Stable Soul · Talent: Ordinary · Comprehension: Standard · Destiny: Mundane · Luck: Average'
  );

  // Fresh boot at Mortal with zero realm progress: the Breakthrough button
  // renders disabled and the reason line names the progress gate.
  const breakthrough = panel.locator('[data-cultivation-breakthrough]');
  await expect(breakthrough).toBeDisabled();
  await expect(panel.locator('[data-cultivation-reason]')).toContainText(
    'Progress required:'
  );

  // Mortal has no tribulation, so the permanently mounted block stays hidden.
  await expect(panel.locator('[data-cultivation-tribulation]')).toHaveCount(1);
  await expect(panel.locator('[data-cultivation-tribulation]')).toBeHidden();

  // The panel re-renders on every loop:uiRefresh pulse, so the Breakthrough
  // button enables LIVE as realm progress accrues on real ticks. Set the
  // progress directly and wait for the next loop pulse to repaint. Stop the
  // default-active meditation session in the same evaluate so the loop's
  // accrual (qiPerSecond → realmProgress per loop:update) can never race the
  // strict `realmProgress === 0` reads after each breakthrough click below —
  // a tick landing between the click's synchronous reset and a single-shot
  // read used to be able to accrue progress. Nothing in this test depends on
  // active qi (every progress value is set manually).
  await page.evaluate(() => {
    window.__meditation.stop();
    window.__game.state.cultivation.realmProgress = 125;
    window.__game.state.cultivation.realmLayer = 9; // P4: must be at final layer to attempt
  });
  await expect(breakthrough).toBeEnabled();

  // A player-like click on the button drives the REAL BreakthroughSystem
  // through the panel's delegated listener: the realm advances to Qi
  // Gathering, the lifetime counter ticks, and the panel repaints the button
  // disabled (progress reset to 0). The feedback line reports the jump.
  await breakthrough.click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.cultivation.realm))
    .toBe('Qi Gathering');
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(1);
  expect(await stateValue(page, 'cultivation.realmProgress')).toBe(0);
  await expect(breakthrough).toBeDisabled();
  await expect(panel.locator('[data-cultivation-feedback]')).toHaveText(
    'Breakthrough to Qi Gathering!'
  );

  // P2 — the breakthrough's success path surfaces a popup: the main.js
  // subscription on 'realm:breakthrough' translates the success outcome
  // into an `achievement`-typed notification with popup:true, and the
  // popup-stack UI mounts it into [data-popup-root]. Assert on state
  // plus the visible DOM shape (the [data-popup-type] attribute matches
  // the notification type so CSS can color-code it).
  await expect
    .poll(() => page.evaluate(() => window.__notifications.queue.find(
      (e) => e && typeof e.message === 'string' && e.message.startsWith('Breakthrough to ')
    )))
    .toMatchObject({ type: 'achievement', popup: true });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-popup-root] [data-popup]')).map((node) => ({
            type: node.getAttribute('data-popup-type'),
            text: node.querySelector('[data-popup-message]').textContent,
          }))
        )
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'achievement',
          text: expect.stringContaining('Breakthrough to Qi Gathering!'),
        }),
      ])
    );

  // Reach the first tribulation-bearing realm (Core Formation — tier 3) the
  // way a player actually would: two more panel breakthroughs. Each accepted
  // attempt advances exactly one tier, so the ladder runs Qi Gathering →
  // Foundation Establishment → Core Formation. (A manual setRealm() shortcut
  // would leave the breakthrough system's realmProgressMax stale at the
  // previous realm's cap, and the loop's accrual clamp would fight the
  // progress we set below.)

  // Qi Gathering → Foundation Establishment (gates: 250 progress, 150
  // stones, 1 qi-condensation-pill). Mortal's breakthrough is free (cost 0
  // in data/breakthroughs/breakthroughs.json); the Qi Gathering attempt
  // just spent the 50-stone wallet, so top the stones back up for the next
  // entry's 150-stone cost.
  await page.evaluate(() => {
    window.__game.state.cultivation.realmProgress = 250;
    window.__resources.add('spiritStones', 150);
    window.__inventory.add('qi-condensation-pill', 1);
    window.__game.state.cultivation.realmLayer = 9; // P4: must be at final layer
  });
  await expect(breakthrough).toBeEnabled();
  await breakthrough.click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.cultivation.realm))
    .toBe('Foundation Establishment');
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(2);
  expect(await stateValue(page, 'cultivation.realmProgress')).toBe(0);
  await expect(breakthrough).toBeDisabled();

  // Foundation Establishment → Core Formation (gates: 600 progress, 400
  // stones, 2 spirit-herb). The post-success sync pulls the Core Formation
  // entry (max 1200, cost 400) and the tribulation gate opens.
  await page.evaluate(() => {
    window.__game.state.cultivation.realmProgress = 600;
    window.__resources.add('spiritStones', 400);
    window.__inventory.add('spirit-herb', 2);
    window.__game.state.cultivation.realmLayer = 9; // P4: must be at final layer
  });
  await expect(breakthrough).toBeEnabled();
  await breakthrough.click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.cultivation.realm))
    .toBe('Core Formation');
  expect(await stateValue(page, 'statistics.breakthroughsTotal')).toBe(3);
  expect(await stateValue(page, 'cultivation.realmProgressMax')).toBe(1200);
  expect(await stateValue(page, 'cultivation.realmProgress')).toBe(0);
  await expect(breakthrough).toBeDisabled();

  // The new realm's tribulation gate opened: the panel renders the
  // tribulation block with the enabled Face button, and the breakthrough
  // gate stays closed (progress reset to 0).
  await expect(panel.locator('[data-cultivation-tribulation]')).toHaveCount(1);
  await expect(panel.locator('[data-cultivation-tribulation-name]')).toHaveText(
    'Tribulation: lightning'
  );
  const face = panel.locator('[data-cultivation-face]');
  await expect(face).toBeEnabled();
  await expect(breakthrough).toBeDisabled();

  // Satisfy every non-tribulation gate of the core-formation entry — the
  // successful attempt consumed its stones + herbs, so re-supply them. The
  // ONLY unmet gate left is the pending tribulation, and the reason line
  // (re-rendered from the systems on the next loop pulse) names it.
  await page.evaluate(() => {
    window.__game.state.cultivation.realmProgress = 1200;
    window.__resources.add('spiritStones', 400);
    window.__inventory.add('spirit-herb', 2);
    window.__game.state.cultivation.realmLayer = 9; // P4: must be at final layer
  });
  await expect(panel.locator('[data-cultivation-reason]')).toHaveText(
    'Face the tribulation first'
  );
  await expect(breakthrough).toBeDisabled();

  // A player-like click on the Face button drives the REAL TribulationSystem
  // through the delegated listener: Math.random → 0 rolls 'survived', the
  // gate opens, and the breakthrough button enables.
  await face.click();
  await expect
    .poll(() => page.evaluate(() => window.__game.state.tribulations.survived))
    .toBe(true);
  await expect(breakthrough).toBeEnabled();
  await expect(panel.locator('[data-cultivation-feedback]')).toHaveText(
    'Tribulation survived!'
  );

  // P2 — the tribulation survival path also surfaces a popup:
  // main.js subscribes to 'tribulation:finished' and translates the
  // survived:true outcome into an `achievement`-typed notification
  // with popup:true. Assert on the queue + the visible popup shape.
  await expect
    .poll(() => page.evaluate(() => window.__notifications.queue.find(
      (e) => e && typeof e.message === 'string' && e.message.startsWith('Tribulation survived')
    )))
    .toMatchObject({ type: 'achievement', popup: true });

  expect(errors).toEqual([]);
});

// ===========================================================================
// P1 Playtest quick fixes (#1 Reset Save confirm + success popup,
// #3 actionable progress bar, #4 instant blocked-attempt feedback,
// #5 remove cost / items gating copy).
// ===========================================================================

test('Settings → Reset Save: confirm modal must be accepted, success notification surfaces (#1)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // No native confirm() dialog handler — the in-game modal (js/ui/modal.js)
  // replaces window.confirm for the destructive path. Any native dialog
  // would be a regression (P1 #1).

  await page.goto('/');

  // Navigate to the Settings tab first (panel is hidden by default).
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator('[data-settings-panel]')).toBeVisible();

  // Baseline state: the boot seeds the master's parting gift (one info
  // notification). The reset success notification must add an entry on top.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__notifications)))
    .toBe(true);
  const sizeBefore = await page.evaluate(() => window.__notifications.size());

  // Click the destructive Reset Save button. The in-game modal mounts
  // into [data-modal-root] — wait for it, then click the confirm button
  // to accept the destructive action. The destructive path runs and the
  // success notification lands in the queue.
  await page.locator('[data-settings-reset]').click();
  const modalPanel = page.locator('[data-modal-panel]');
  await expect(modalPanel).toBeVisible();
  await page.locator('[data-modal-confirm]').click();

  await expect
    .poll(() => page.evaluate(() => window.__notifications.size()))
    .toBeGreaterThan(sizeBefore);
  const lastEntry = await page.evaluate(
    () => window.__notifications.queue[window.__notifications.queue.length - 1]
  );
  expect(lastEntry.type).toBe('success');
  // Success copy is the panel's canonical lore-canonical reset message.
  expect(String(lastEntry.message)).toMatch(/save wiped|reset|new path/i);

  // The activity log reflects the new entry (the queue mutation triggers
  // a 'notification:changed' emission that the renderer repaints).
  await expect(page.locator('#activity-log .log__item--success')).toHaveCount(1);

  // The modal was cleaned up after the user accepted.
  await expect(page.locator('[data-modal-dialog]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('Settings → Reset Save: dismissing the confirm modal aborts the destructive path (#1)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // No native confirm() dialog handler — the in-game modal replaces it.
  // Any native dialog would be a regression.

  await page.goto('/');

  // Navigate to the Settings tab first (panel is hidden by default).
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator('[data-settings-panel]')).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => Boolean(window.__notifications)))
    .toBe(true);
  const sizeBefore = await page.evaluate(() => window.__notifications.size());

  await page.locator('[data-settings-reset]').click();
  const modalPanel = page.locator('[data-modal-panel]');
  await expect(modalPanel).toBeVisible();
  // Click the cancel button — the destructive path MUST NOT run.
  await page.locator('[data-modal-cancel]').click();

  // The modal cleaned up after cancel.
  await expect(page.locator('[data-modal-dialog]')).toHaveCount(0);

  // No notification was added (the destructive path aborted). Give the
  // page a tick to settle so any straggling mutation would have surfaced.
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__notifications.size())).toBe(
    sizeBefore
  );

  // The spirit-stones wallet is intact (the boot seed stayed at 50).
  expect(await stateValue(page, 'resources.spiritStones')).toBe(50);

  expect(errors).toEqual([]);
});

test('Cultivation Realm progress bar at full: clicking it rolls a breakthrough and surfaces feedback (#3, #4)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Determinism: the breakthrough attempt's weighted roll lands in the
  // FIRST bucket of the Mortal results table ('perfect' — a SUCCESS
  // outcome) with Math.random → 0, so the realm advances deterministically
  // and the feedback line is "Breakthrough to Qi Gathering!".
  page.addInitScript(() => {
    Math.random = () => 0;
  });
  await page.goto('/');

  // Stop the default-active meditation so the per-second accrual cannot
  // race the strict `realmProgress === 0` reads below.
  await page.waitForFunction(() => Boolean(window.__meditation));
  await page.evaluate(() => window.__meditation.stop());

  // The progress bar lives in the Cultivation Realm panel and carries the
  // new data-cultivation-progress-action attribute (P1 #3).
  const bar = page.locator('[data-cultivation-progress-action]');
  await expect(bar).toBeVisible();

  // P4: must be at the final layer to attempt breakthrough.
  // Set progress to the realm max so the gate is open.
  await page.evaluate(() => {
    window.__game.state.cultivation.realmLayer = 9;
    window.__game.state.cultivation.realmProgress = 125;
  });

  // Wait for the loop:uiRefresh repaint so the bar carries the actionable
  // class + the hint becomes visible.
  await expect(page.locator('[data-cultivation-progress-hint]')).toBeVisible();

  // Click the bar — the panel's delegated listener routes it to the
  // standard applyBreakthrough() path (same as the dedicated button).
  await bar.click();
  await expect
    .poll(() => stateValue(page, 'cultivation.realm'))
    .toBe('Qi Gathering');

  // Instant feedback (#4): the inline feedback line carries the success
  // message — a player clicking the bar (or the button) always sees what
  // happened.
  await expect(page.locator('[data-cultivation-feedback]')).toHaveText(
    'Breakthrough to Qi Gathering!'
  );

  // After the realm advances the progress resets and the bar drops the
  // actionable class on the next render — the affordance follows the gate.
  await expect(page.locator('[data-cultivation-progress-hint]')).toBeHidden();

  expect(errors).toEqual([]);
});

test('Cultivation Realm panel: no "Breakthrough cost" stat, no cost / items reason anywhere (#5)', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/');

  await page.waitForFunction(() => Boolean(window.__meditation));
  await page.evaluate(() => {
    window.__meditation.stop();
    // Wipe the wallet + every bottleneck item so the (now-informational)
    // costMet / bottleneckMet flags are false — if the panel still surfaced
    // them as gate text, this test would catch it.
    //
    // Drain the boot seed of 50 spirit stones through the real Resource
    // API. set(...) does not exist; add(id, -amount) is a silent no-op
    // (ResourceSystem.add rejects non-positive amounts), so spend(id, n)
    // is the canonical way to deduct a positive amount from a wallet.
    window.__resources.spend('spiritStones', 50);
    // remove() is safe on items not carried (it removes everything
    // available and returns that actual amount — never an error, never a
    // negative count), so these calls cover every realm-entry bottleneck id
    // regardless of boot inventory state.
    window.__inventory.remove('spirit-herb', 9999);
    window.__inventory.remove('qi-condensation-pill', 9999);
    window.__inventory.remove('jade', 9999);
  });

  // The Cultivation Realm panel must NOT render the misleading "Breakthrough
  // cost" stat anymore (the cost no longer charges — showing the number
  // misleads).
  await expect(page.locator('text=Breakthrough cost')).toHaveCount(0);
  // The breakthroughCost data-bind is still in state (the field stays for
  // informational / future use) but the markup no longer renders it.

  // The reason line at zero progress must surface the progress gate ONLY,
  // never cost / items / "Missing items" / "Cost not met".
  const reason = page.locator('[data-cultivation-reason]');
  await expect(reason).toContainText('Progress required:');
  await expect(reason).not.toContainText('Cost not met');
  await expect(reason).not.toContainText('Missing items');

  // The panel body as a whole (rendered text) does not include any cost /
  // items block reason — only the four canonical gating reasons may appear.
  const panelText = await page.locator('[data-cultivation-panel]').textContent();
  expect(panelText).not.toMatch(/Cost not met|Missing items|Breakthrough cost/);

  expect(errors).toEqual([]);
});

test('tab navigation: clicking tabs shows and hides panels', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // Cultivation tab is the default — its panel should be visible, others hidden.
  await expect(page.locator('#tab-cultivation')).toBeVisible();
  await expect(page.locator('#tab-techniques')).toBeHidden();
  await expect(page.locator('#tab-inventory')).toBeHidden();
  await expect(page.locator('#tab-log')).toBeHidden();
  await expect(page.locator('#tab-settings')).toBeHidden();

  // The cultivation tab button has aria-selected true.
  await expect(page.locator('[data-tab="cultivation"]')).toHaveAttribute('aria-selected', 'true');

  // Click the Techniques tab.
  await page.locator('[data-tab="techniques"]').click();
  await expect(page.locator('#tab-cultivation')).toBeHidden();
  await expect(page.locator('#tab-techniques')).toBeVisible();
  await expect(page.locator('[data-tab="techniques"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-tab="cultivation"]')).toHaveAttribute('aria-selected', 'false');

  // The upgrades panel is inside the Techniques tab and should be visible now.
  await expect(page.locator('[data-upgrade-id="foundation-breathing"]')).toBeVisible();

  // Click the Inventory tab.
  await page.locator('[data-tab="inventory"]').click();
  await expect(page.locator('#tab-inventory')).toBeVisible();
  await expect(page.locator('#tab-techniques')).toBeHidden();

  // Click the Log tab.
  await page.locator('[data-tab="log"]').click();
  await expect(page.locator('#tab-log')).toBeVisible();
  await expect(page.locator('#activity-log')).toBeVisible();

  // Click the Settings tab.
  await page.locator('[data-tab="settings"]').click();
  await expect(page.locator('#tab-settings')).toBeVisible();
  await expect(page.locator('[data-settings-panel]')).toBeVisible();

  expect(errors).toEqual([]);
});

test('inventory grid: add items and verify grid rendering', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // InventorySystem is exposed after bootstrap.
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__inventory)))
    .toBe(true);

  // Inject items into the inventory.
  await page.evaluate(() => {
    window.__inventory.add('qi-condensation-pill', 5);
    window.__inventory.add('spirit-herb', 3);
    window.__inventory.add('iron-ore', 12);
  });

  // Navigate to the Inventory tab.
  await page.locator('[data-tab="inventory"]').click();
  await expect(page.locator('#tab-inventory')).toBeVisible();

  // The inventory grid should render item cards.
  const grid = page.locator('[data-inventory-grid]');
  await expect(grid).toBeVisible();

  // Three item cards.
  const cards = page.locator('.inventory-item');
  await expect(cards).toHaveCount(3);

  // First card: Qi Condensation Pill.
  const firstCard = cards.nth(0);
  await expect(firstCard.locator('.inventory-item__name')).toHaveText('Qi Condensation Pill');
  await expect(firstCard.locator('.inventory-item__count')).toHaveText('\u00d75');
  await expect(firstCard.locator('.inventory-item__category')).toHaveText('pill');
  await expect(firstCard.locator('.inventory-item__grade')).toHaveText('Mortal');

  // Second card: Spirit Herb.
  const secondCard = cards.nth(1);
  await expect(secondCard.locator('.inventory-item__name')).toHaveText('Spirit Herb');
  await expect(secondCard.locator('.inventory-item__count')).toHaveText('\u00d73');

  // Third card: Iron Ore.
  const thirdCard = cards.nth(2);
  await expect(thirdCard.locator('.inventory-item__name')).toHaveText('Iron Ore');
  await expect(thirdCard.locator('.inventory-item__count')).toHaveText('\u00d712');

  // Remove items to verify re-render on inventory:changed.
  await page.evaluate(() => {
    window.__inventory.remove('spirit-herb', 2);
  });

  // The DOM re-renders after the emit — spirit herb count should change.
  await expect(page.locator('.inventory-item').nth(1).locator('.inventory-item__count')).toHaveText('\u00d71');

  expect(errors).toEqual([]);
});

// ===========================================================================
// P5 Technique generators & proficiency — technique shop buy/upgrade flow.
// ===========================================================================

test('technique panel renders after bootstrap', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  // TechniqueSystem is exposed after bootstrap; the catalog comes from
  // data/techniques/techniques.json (5 starter techniques).
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__techniques)))
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__techniques.list().length))
    .toBe(5);

  // Navigate to the Techniques tab (techniques panel + upgrades panel).
  await page.locator('[data-tab="techniques"]').click();
  await expect(page.locator('#tab-techniques')).toBeVisible();

  // The techniques panel is present in the tab and renders rows.
  await expect(page.locator('[data-techniques-panel]')).toBeVisible();
  await expect(page.locator('[data-technique-id]')).toHaveCount(5);

  // The count tag shows "0 owned".
  await expect(page.locator('[data-techniques-count]')).toHaveText('0 owned');

  // Every technique row carries data-technique-id. Verify the canonical ids.
  await expect(page.locator('[data-technique-id="breath-control"]')).toHaveCount(1);
  await expect(page.locator('[data-technique-id="circulating-qi"]')).toHaveCount(1);
  await expect(page.locator('[data-technique-id="meridian-channeling"]')).toHaveCount(1);
  await expect(page.locator('[data-technique-id="dantian-cultivation"]')).toHaveCount(1);
  await expect(page.locator('[data-technique-id="spirit-resonance"]')).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('buy a technique, verify level 1 and stones deducted', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  await page.locator('[data-tab="techniques"]').click();
  await expect(page.locator('#tab-techniques')).toBeVisible();

  // Pre-buy state: breath-control not owned.
  expect(
    await page.evaluate(() => window.__techniques.level('breath-control'))
  ).toBe(0);
  const stonesBefore = await page.evaluate(() =>
    window.__resources.get('spiritStones')
  );
  expect(stonesBefore).toBe(50);

  // Click the Buy button on the cheapest technique (breath-control, cost 50).
  const buyBtn = page.locator('[data-technique-id="breath-control"] [data-technique-buy]');
  await expect(buyBtn).toBeVisible();
  await buyBtn.click();

  // Level 1, stones deducted by 50.
  await expect
    .poll(() => page.evaluate(() => window.__techniques.level('breath-control')))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__resources.get('spiritStones')))
    .toBe(0);

  // Count tag updated.
  await expect(page.locator('[data-techniques-count]')).toHaveText('1 owned');

  // The row now shows Lv.1, not "Not owned".
  const row = page.locator('[data-technique-id="breath-control"]');
  await expect(row.locator('.technique__level')).toHaveText('Lv.1');

  // The buy button is gone, replaced by an Upgrade button.
  await expect(
    page.locator('[data-technique-id="breath-control"] [data-technique-upgrade]')
  ).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('upgrade a technique, verify level increases', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');

  await page.locator('[data-tab="techniques"]').click();

  // Top up stones to afford both buy + upgrade.
  await page.evaluate(() => window.__resources.add('spiritStones', 200));

  // Buy breath-control.
  await page.locator('[data-technique-id="breath-control"] [data-technique-buy]').click();
  await expect
    .poll(() => page.evaluate(() => window.__techniques.level('breath-control')))
    .toBe(1);

  // Upgrade once.
  const upgradeBtn = page.locator('[data-technique-id="breath-control"] [data-technique-upgrade]');
  await expect(upgradeBtn).toBeVisible();
  await upgradeBtn.click();

  // Level 2.
  await expect
    .poll(() => page.evaluate(() => window.__techniques.level('breath-control')))
    .toBe(2);
  await expect(
    page.locator('[data-technique-id="breath-control"] .technique__level')
  ).toHaveText('Lv.2');

  expect(errors).toEqual([]);
});
