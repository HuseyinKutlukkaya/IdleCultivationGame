/**
 * playwright.config.mjs — real-browser end-to-end smoke tests (dev-only).
 *
 * These tests are never shipped to GitHub Pages. They verify the bootstrap
 * paths that unit/integration tests cannot: the page actually booting in a
 * real browser, the game loop producing visible Qi, and the save round-trip.
 *
 * - Browsers: uses the system-installed Chrome (`channel: 'chrome'`) so no
 *   browser binaries are downloaded. On a machine without Chrome, run
 *   `npx playwright install chromium` and change `channel` to `'chromium'`.
 * - Web server: the game is a static site whose modules/data are fetched over
 *   HTTP, so Playwright auto-starts a tiny dependency-free static server
 *   (see tests/e2e/static-server.mjs) before the first test.
 * - Naming: specs use `*.spec.mjs` — NOT `*.test.mjs` — so the node:test
 *   glob (which matches only dot-test-dot-mjs files) never picks them up.
 */
import { defineConfig } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/static-server.mjs',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
