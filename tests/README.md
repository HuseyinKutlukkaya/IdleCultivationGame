# tests/ — automated regression suite

The project's automated test suite. It runs with **Node's built-in test runner**
(`node:test`) — no build step, never shipped to GitHub Pages. The suite grows
with the game: testing is mandatory for every feature (never skipped or
deferred), and the full suite is run at the end of every feature cycle. Current
coverage: **991 tests** across every existing `js/` module (see `Coverage map`
below).

The **shipped game stays zero-runtime-dependency, framework-free and static**
(GitHub Pages compatible). That stance applies to what ships, not to how tests
run: dev-only test tooling (e.g. a real-browser E2E runner) is welcome when it
materially improves coverage. See "Testing decisions" below.

## How to run

Logic / DOM / data / integration suite (Node's built-in runner):

```bash
node --test "tests/**/*.test.mjs"
```

> Note: `node --test tests/` (a bare directory argument) hits a known Node v21+
> test-runner regression (nodejs/node#64555) and fails; use the glob form above
> until that is fixed. `node --test` (no arguments, auto-discovery) also works.

**Compact output.** `npm test` runs the suite through a custom reporter
(`tests/reporters/compact.mjs`) so a successful run prints ~4 lines instead of
one line per test — this keeps agent/human context small (a token-cost
optimization, since the suite itself is fast). Failures print full details plus
a hint; for the verbose spec output run:

```bash
node --test --test-reporter=spec "tests/**/*.test.mjs"
```

Coverage gate (same suite, Node's built-in coverage, fails below the committed
93% line baseline — see `tests/coverage-gate.mjs`):

```bash
npm run test:coverage
```

Real-browser E2E smoke tests (Playwright, dev-only — uses the installed Chrome,
no browser download):

```bash
npm run test:e2e        # or: npx playwright test
```

> The full flow is: the E2E suite must be green before a feature that touches
> the bootstrap/renderer/save paths is reported done (see Testing decisions).

## Structure (mirrors the module zones)

| Folder | Covers | Owned by |
|---|---|---|
| `tests/unit/` | pure logic: `js/core/*`, `js/systems/*`, `js/managers/*` | Core Engineer, Gameplay Engineer |
| `tests/dom/` | renderer / UI bindings (fake DOM, no jsdom) | UI Renderer |
| `tests/data/` | content validation of every `data/` JSON collection | Data Author |
| `tests/integration/` | cross-system contracts (EventBus pipelines) | whoever owns the systems involved |
| `tests/e2e/` | real-browser smoke tests (Playwright, dev-only): boot, live Qi, save round-trip, standing human-playability spec | shared |
| `tests/perf/` | scalability smoke checks (1,000+ definitions) + pacing guards (headless playthrough sims) | Core Engineer |
| `tests/fixtures/` | canned data: legacy saves, exports, event streams | Core Engineer |
| `tests/reporters/` | custom node:test reporters (compact output; dev-only) | Architect |
| `tests/helpers/` | shared test doubles (fake DOM, raf stub, intersection-observer stub; more to come) | shared |
| `tests/unit/path-portability.test.mjs` | repo hygiene guard: no machine-specific absolute paths in committed code/data/tests | Architect |

The **Coverage map** below tracks which system maps to which test file so a
feature touching a system knows exactly which tests to run and update.

## Coverage map (system → test file)

| System / module | Test file | Status |
|---|---|---|
| EventBus (`js/core/event-bus.js`) | `tests/unit/event-bus.test.mjs` | done |
| Config loader (`js/core/config.js`) | `tests/unit/config.test.mjs` | done |
| DataManager (`js/core/data-manager.js`) | `tests/unit/data-manager.test.mjs` + `tests/data/*` | pending |
| GameLoop (`js/core/game-loop.js`) | `tests/unit/game-loop.test.mjs` | done |
| GameState (`js/core/game-state.js`) | `tests/unit/game-state.test.mjs` | done |
| Game (`js/core/game.js`) | `tests/unit/game.test.mjs` | done |
| Storage (`js/core/storage.js`) | `tests/unit/storage.test.mjs` | done |
| deepMerge (`js/utils/deep-merge.js`) | `tests/unit/deep-merge.test.mjs` | done |
| Project paths (`js/utils/paths.js`) | `tests/unit/paths.test.mjs` | done |
| SaveManager (`js/managers/save-manager.js`) | `tests/unit/save-manager.test.mjs` + `tests/fixtures/saves/` | done |
| NotificationManager (`js/managers/notification-manager.js`) | `tests/unit/notification-manager.test.mjs` | done |
| Bootstrap (`js/main.js`) | `tests/integration/bootstrap.test.mjs` | done |
| Renderer (`js/ui/renderer.js`) | `tests/dom/renderer.test.mjs` | done |
| Footer (`js/ui/footer.js`) | `tests/dom/footer.test.mjs` | done |
| Scroll reveal (`js/ui/reveal.js`) | `tests/dom/reveal.test.mjs` | done |
| Offline progress (`js/core/offline-progress.js`) | `tests/unit/offline-progress.test.mjs` | done |
| Game config (`data/game-config.json`) | `tests/data/game-config.test.mjs` | done |
| Path portability (repo hygiene) | `tests/unit/path-portability.test.mjs` | done |
| Meditation | `tests/unit/meditation.test.mjs` | done |
| Bootstrap + renderer + save (real browser) | `tests/e2e/game.spec.mjs` | done |
| Qi | `tests/unit/qi.test.mjs` | done |
| Statistics | `tests/unit/statistics.test.mjs` + `tests/dom/renderer.test.mjs` (duration mode) | done |
| Resources | `tests/unit/resources.test.mjs` | done |
| Notation (`js/ui/notation.js`) | `tests/unit/notation.test.mjs` | done |
| Inventory | `tests/unit/inventory.test.mjs` | done |
| Item content (`data/items/items.json`) | `tests/data/items.test.mjs` | done |
| Upgrade content (`data/upgrades/upgrades.json`) | `tests/data/upgrades.test.mjs` | done |
| Realm content (`data/realms/realms.json`) | `tests/data/realms.test.mjs` | done |
| Upgrade system | `tests/unit/upgrades.test.mjs` | done |
| Upgrades panel (DOM) | `tests/unit/upgrades-panel.test.mjs` | done |
| Notifications (queue) | `tests/unit/notification-manager.test.mjs` + `tests/dom/activity-log.test.mjs` | done |
| Activity Log (DOM) | `tests/dom/activity-log.test.mjs` | done |
| Settings panel | `tests/unit/settings-panel.test.mjs` | done |
| Cultivation panel (awaken button + next-step guidance) | `tests/unit/cultivation-panel.test.mjs` + `tests/e2e/game.spec.mjs` | done |
| Realms, Breakthroughs, Tribulations | `tests/unit/realms.test.mjs`, `tests/unit/breakthroughs.test.mjs` | pending |
| Spirit roots, Meridians, Physiques, Bloodlines | `tests/unit/character-gen.test.mjs` | pending |
| Game pacing (playability in minutes) | `tests/perf/pacing.test.mjs` | done |
| Pills, Alchemy, Artifacts, Crafting | `tests/unit/items.test.mjs` | pending |
| Sects, NPCs, Events, Exploration | `tests/unit/world.test.mjs` | pending |
| Automation | `tests/unit/automation.test.mjs` | pending |
| Reincarnation, Legacy, Achievements | `tests/unit/reincarnation.test.mjs` | pending |
| Localization | `tests/data/localization.test.mjs` | pending |
| Full game pipeline (integration) | `tests/integration/game-pipeline.test.mjs` | pending |

## Rules (every agent must follow)

1. **Every feature ships with its tests, in the same commit** — written by the
   same agent that builds the feature.
2. **Changing a module's behavior means updating that module's existing tests**
   to the new contract, in the same commit.
3. **A failing test is never deleted** to make the suite pass — either the
   change is intentional (update the test) or it is a bug (fix the code).
4. The full suite must be **green before a feature is reported done**. The
   Architect runs it at the end of every feature cycle and loops failures back
   to the responsible agent.
5. Tests import the **real modules** and use Node's built-in `node:test` +
   `node:assert/strict`. DOM tests use the fake DOM in `tests/helpers/`; the
   real-browser E2E suite lives in `tests/e2e/` (Playwright, dev-only — see
   "Testing decisions").
6. **Portable paths only.** Module imports and data reads are relative (`./`,
   `../`) or `import.meta.url`-based. Never write machine-specific absolute
   paths (drive letters, user homes, OS temp dirs, repo-folder-as-absolute-
   location) into any file — the suite fails on them via
   `tests/unit/path-portability.test.mjs`.
7. **Human playability is a standing E2E contract — not a per-phase
   deliverable.** The E2E suite always contains a spec proving a real player
   can complete the game's current core loop through actual UI interactions
   (real buttons, visible feedback, no console errors, no dead-ends) —
   `tests/e2e/game.spec.mjs`. Every feature that touches the bootstrap,
   renderer, UI or game loop extends or keeps that spec green as the loop
   grows; it never shrinks.

## Testing decisions (dated project decisions)

- **2026-08-10 — Testing is mandatory; dev-only tooling allowed; ask first.**
  Testing is never skipped or deferred for feature work. The zero-dependency
  rule applies only to the shipped product (static, framework-free, GitHub
  Pages compatible). Dependencies are acceptable when they provide a major
  improvement, and dev-only test tooling (e.g. a real-browser E2E runner such
  as Playwright, or a headless-browser smoke test) may be adopted when it
  materially improves coverage — but, per AGENTS.md (AI Guidelines), any
  clearly good or drastically-improving option must be surfaced to the user
  for approval before adoption, testing-related or not. Do not add major
  tooling silently, even when it is an obvious improvement.
- **2026-08-10 — Deployment & CI.** GitHub Pages auto-deploys on every push
  to `main`, so the shipped site needs no build or deploy step. No CI
  workflow is currently needed; if one is ever added it would be test-only
  and never touch deployment.
- **2026-08-10 — Playwright E2E adopted (dev-only, user-approved).** The
  real-browser E2E suite (`tests/e2e/`, `npm run test:e2e`) was added as
  dev-only tooling after user approval: it uses the system-installed Chrome
  (`channel: 'chrome'`, no browser download) and a dependency-free static
  server, so the game runs over HTTP exactly like on GitHub Pages. It covers
  what unit/integration tests cannot: page boot, live Qi production in the
  DOM, and the save round-trip. Specs use `*.spec.mjs` (not `*.test.mjs`) so
  the node:test glob never executes them. `package.json` is dev-only and is
  never deployed; on machines without Chrome, run
  `npx playwright install chromium` and switch `channel` to `'chromium'`.
- **2026-08-10 — Coverage gate + Feature Gate checklist (user-approved).**
  Two things the user had been finding "by accident" — untested code paths and
  machine-dependent behavior — became standing gates: `npm run test:coverage`
  fails if total line coverage drops below 93% (`tests/coverage-gate.mjs`,
  Node's built-in coverage, zero dependencies), and AGENTS.md gained a
  "Feature Gate" checklist every feature must clear (tests, coverage, E2E when
  applicable, automation audit, machine-independence audit, fresh-clone
  smoke, security review). Adopted together with the **incident → guard
  loop**: any bug/gap found by accident becomes an automated guard + checklist
  item + this dated note, so it can never be discovered twice.
- **2026-08-11 — E2E: manual `setRealm()` leaves `realmProgressMax` stale —
  drive realm changes through real breakthroughs instead.** Found by accident
  while writing the cultivation-panel E2E test: the BreakthroughSystem syncs
  `cultivation.realmProgressMax`/`breakthroughCost` only at boot and after
  accepted attempts (it has no `realm:changed` subscription), so after a
  console/debug `setRealm()` the loop's accrual clamp keeps clamping progress
  to the PREVIOUS realm's cap. In a test that waits/asserts over real time
  (Playwright), manually-set progress gets silently fought back down (2000 →
  1000), which surfaces as a "button never enables" failure. In shipped
  gameplay realm changes only happen through accepted breakthroughs, so this
  is a test-design pitfall, not a game bug. Guard: E2E specs that exercise
  multi-realm flows must advance through the panel/`attempt()` (the realistic
  ladder: Mortal → Qi Gathering → Foundation Establishment → Core Formation),
  never `setRealm()` + manual progress across waits. The cultivation-panel
  spec follows this and documents it in a comment; the existing tribulation
  spec may keep its synchronous `setRealm()` shortcut only because its attempt
  happens in the same `page.evaluate` as the progress write (no loop tick in
   between).
- **2026-08-12 — P2 popup stack: auto‑dismissed and cap‑evicted popups resurrect
   on later emits (sticky‑dismissal gap).** Found by code review during the
   Revision Cycle 1 check (Architect reading `js/ui/popup-stack.js`): the
   `removePopup()` helper tore down a popup but never added its id to the
   `dismissed` set — only the click‑handler path did that. The auto‑dismiss
   timer and the cap‑eviction loop in `renderQueue()` both called `removePopup`
   without adding the id to `dismissed`, so a later `notification:changed` emit
   re‑walked the queue and re‑rendered the entry (it was still in the
   NotificationManager FIFO). In production the 50‑stone gift popup would
   silently reappear the next time a breakthrough fires. Guard: `dismissed.add`
   moved into `removePopup` so every removal path marks the entry as handled;
   two regression tests in `tests/unit/popup-stack.test.mjs` assert that an
   auto‑dismissed popup stays gone after a re‑emit and that a cap‑evicted
   popup never re‑appears (both tagged “incident → guard”).
- **2026-08-15 — P0 rebalance: the shipped numbers made the first breakthrough
   take ~2 HOURS, not minutes (pacing gap).** Found by gameplay review after
   the user reported the first minutes of play feel dead: with `baseQiPerSecond
   2` and Mortal `requiredProgress 1000`, each realm takes 9 sub-layer fills
   (layer N max = base × (1 + 0.15 × (N−1))), so the first breakthrough needed
   1000 × 14.4 = 14,400 realm progress at 2/s ≈ 2h. The data tests could NOT
   catch this — the values were finite, positive and monotonic, so the curve
   looked healthy. Guard: a data shape test is no longer enough for pacing —
   `tests/perf/pacing.test.mjs` now simulates a headless playthrough of the
   REAL systems (MeditationSystem → RealmSystem → QiSystem →
   BreakthroughSystem) against the REAL shipped config + data and asserts the
   first breakthrough lands in under 2 minutes. The rebalance itself (raised
   `baseQiPerSecond` 2 → 20, `baseMaxQi` 100 → 2000, retuned the
   `requiredProgress` ladder 125 → 800,000) is documented in the config and
   breakthroughs meta comments. Any future retune that pushes the first
   breakthrough past 2 minutes fails here.

## Writing a new test

1. Follow the zone: put it in the folder matching the module's zone and name it
   `<module>.test.mjs`.
2. Import the real module with a relative path (e.g. `'../../js/core/event-bus.js'`).
3. Add a JSDoc header describing the module under test.
4. Keep it deterministic and synchronous where possible; use the fake-DOM/raf
   helpers for anything DOM-touching.
5. Run the full suite and make sure everything is still green.

## Writing a new E2E test (Playwright, real browser)

Real-browser scenarios live in `tests/e2e/` and run via `npm run test:e2e`.
They are NOT node:test files — different runner, different rules:

1. **Name it `<scenario>.spec.mjs`** — the `.spec.mjs` suffix is what keeps it
   out of the `node --test "tests/**/*.test.mjs"` glob (which matches only
   `.test.mjs` files). Never name an E2E spec with `.test.mjs`.
2. **Import from Playwright**, not from the repo:
   `import { test, expect } from '@playwright/test';` — the browser loads the
   game, so there are no relative `../../js/...` imports here.
3. **Assert on state, not formatted text.** Use the exposed debug globals —
   `window.__game.state`, `window.__saveManager`, `window.__meditation`,
   `window.__qi`, `window.__notation`, `window.__offlineProgress` — via
   `page.evaluate(...)`. Formatted DOM text goes through `Intl` and is
   locale-dependent (e.g. `2.0` vs `2,0`); raw state values are stable.
   Spot-check the DOM only with locale-safe matchers.
4. **Wait for the async world.** The bootstrap and game loop are asynchronous —
   never assume the page is settled right after `page.goto('/')`. Use
   `await expect(page.locator(...)).toContainText(...)`, `expect.poll(...)`,
   or `page.waitForFunction(...)`.
5. **Always `page.goto('/')` against the static server.** The config starts
   `tests/e2e/static-server.mjs` automatically; never open `file://` URLs
   (module scripts and `fetch()` are blocked over `file://` in Chrome).
6. **When do I write one?** Every feature that touches the bootstrap
   (`js/main.js`), the renderer, or the save path ships (or extends) a spec in
   `tests/e2e/` in the same commit — pure logic features rely on node:test
   only. And whenever a feature makes the game loop playable in a new way
   (a new action, panel, or automation), the **standing human-playability
   spec** grows with it: extend `game.spec.mjs` so a real player can still
   complete the loop through the UI.
7. **Keep them small and deterministic.** A spec is a smoke test of a real
   user-visible flow (boot, live numbers, save round-trip), not a logic
   re-run of unit tests. If a spec starts needing timing hacks or long
   `waitForTimeout`, the assertion is probably in the wrong layer.
8. **Run and watch:** `npm run test:e2e` (headless, installed Chrome);
   `npx playwright test --headed` to watch it in a visible browser; failed
   runs leave a trace under `test-results/`.
