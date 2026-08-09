# tests/ — automated regression suite

The project's automated test suite. It runs with **Node's built-in test runner**
(`node:test`) — zero dependencies, no build step, never shipped to GitHub Pages.
The suite grows with the game: every feature ships its tests, and the full suite
is run at the end of every feature cycle. Current coverage: **120 tests** across
every existing `js/` module (see the Coverage map below).

## How to run

```bash
node --test "tests/**/*.test.mjs"
```

> Note: `node --test tests/` (a bare directory argument) hits a known Node v21+
> test-runner regression (nodejs/node#64555) and fails; use the glob form above
> until that is fixed. `node --test` (no arguments, auto-discovery) also works.

## Structure (mirrors the module zones)

| Folder | Covers | Owned by |
|---|---|---|
| `tests/unit/` | pure logic: `js/core/*`, `js/systems/*`, `js/managers/*` | Core Engineer, Gameplay Engineer |
| `tests/dom/` | renderer / UI bindings (fake DOM, no jsdom) | UI Renderer |
| `tests/data/` | content validation of every `data/` JSON collection | Data Author |
| `tests/integration/` | cross-system contracts (EventBus pipelines) | whoever owns the systems involved |
| `tests/perf/` | scalability smoke checks (1,000+ definitions) | Core Engineer |
| `tests/fixtures/` | canned data: legacy saves, exports, event streams | Core Engineer |
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
| SaveManager (`js/managers/save-manager.js`) | `tests/unit/save-manager.test.mjs` + `tests/fixtures/saves/` | done |
| Bootstrap (`js/main.js`) | `tests/integration/bootstrap.test.mjs` | done |
| Renderer (`js/ui/renderer.js`) | `tests/dom/renderer.test.mjs` | done |
| Footer (`js/ui/footer.js`) | `tests/dom/footer.test.mjs` | done |
| Scroll reveal (`js/ui/reveal.js`) | `tests/dom/reveal.test.mjs` | done |
| Offline progress (`js/core/offline-progress.js`) | `tests/unit/offline-progress.test.mjs` | done |
| Game config (`data/game-config.json`) | `tests/data/game-config.test.mjs` | done |
| Path portability (repo hygiene) | `tests/unit/path-portability.test.mjs` | done |
| Meditation, Qi | `tests/unit/meditation.test.mjs`, `tests/unit/qi.test.mjs` | pending |
| Resources, Inventory, Notifications, Settings | `tests/unit/*` | pending |
| Realms, Breakthroughs, Tribulations | `tests/unit/realms.test.mjs`, `tests/unit/breakthroughs.test.mjs` | pending |
| Spirit roots, Meridians, Physiques, Bloodlines | `tests/unit/character-gen.test.mjs` | pending |
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
   `node:assert/strict`. DOM tests use the fake DOM in `tests/helpers/` (no
   jsdom, no frameworks).
6. **Portable paths only.** Module imports and data reads are relative (`./`,
   `../`) or `import.meta.url`-based. Never write machine-specific absolute
   paths (drive letters, user homes, OS temp dirs, repo-folder-as-absolute-
   location) into any file — the suite fails on them via
   `tests/unit/path-portability.test.mjs`.

## Writing a new test

1. Follow the zone: put it in the folder matching the module's zone and name it
   `<module>.test.mjs`.
2. Import the real module with a relative path (e.g. `'../../js/core/event-bus.js'`).
3. Add a JSDoc header describing the module under test.
4. Keep it deterministic and synchronous where possible; use the fake-DOM/raf
   helpers for anything DOM-touching.
5. Run the full suite and make sure everything is still green.
