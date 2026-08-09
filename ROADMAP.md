# ROADMAP.md

Development roadmap from the master plan (see PLANS.md for the full plan).
`[x]` = done, `[ ]` = pending. Tick boxes as phases complete.

## Phase 0 — Foundation
- [x] Repository
- [x] Git
- [x] Landing page
- [x] Initial UI
- [x] Documentation (AGENTS.md, DESIGN.md, ROADMAP.md, PLANS.md)
- [x] GitHub Pages (static, no build step)
- [x] Modular architecture (core/systems/managers/ui/utils)
- [x] GameState (placeholder singleton)

## Phase 1 — Core Engine
- [x] EventBus — done (js/core/event-bus.js)
- [x] Config loader (js/core/config.js)
- [x] DataManager (load + cache + validate JSON definitions) — done (js/core/data-manager.js)
- [x] GameLoop (requestAnimationFrame ticker, delta time) — done (js/core/game-loop.js)
- [x] SaveManager (save/load/autosave/export/import/migration) — done (js/managers/save-manager.js)
- [x] Renderer (state → DOM, batch updates, no gameplay) — done (js/ui/renderer.js)
- [x] Offline progress (last timestamp, elapsed calc, caps, summary) — done (js/core/offline-progress.js)

## Phase 2 — First Gameplay
- [ ] Meditation (first gameplay system, produces Qi)
- [ ] Qi (gathering, max, per-second)
- [ ] Resources (spirit stones, herbs)
- [ ] Inventory (basic)
- [ ] Notifications (queue-based)
- [ ] Settings
- [x] Autosave (interval + on unload) — done in SaveManager (js/managers/save-manager.js)

## Phase 3 — Cultivation
- [ ] Realms (JSON-driven)
- [ ] Breakthroughs (requirements, results, bottlenecks)
- [ ] Tribulations
- [ ] Spirit Roots
- [ ] Meridians
- [ ] Physiques
- [ ] Bloodlines
- [ ] Talents / Comprehension

## Phase 4 — Items
- [ ] Inventory (full: filter/sort/search)
- [ ] Pills
- [ ] Artifacts
- [ ] Herbs
- [ ] Spirit Stones (grades)
- [ ] Crafting
- [ ] Alchemy

## Phase 5 — World
- [ ] Regions
- [ ] Cities
- [ ] NPCs
- [ ] Sects
- [ ] Events (data-driven)
- [ ] Exploration
- [ ] Secret Realms

## Phase 6 — Automation
- [ ] Auto Meditation
- [ ] Auto Pills
- [ ] Auto Alchemy
- [ ] Sect Workers
- [ ] Offline Automation
- [ ] Task Scheduling

## Phase 7 — Reincarnation
- [ ] Legacy
- [ ] Origins
- [ ] Permanent Unlocks
- [ ] Collections
- [ ] Achievements

## Phase 8 — Late Game
- [ ] Dao
- [ ] Immortal Worlds
- [ ] Higher Realms
- [ ] Ancient Civilizations
- [ ] Legendary Artifacts

## Phase 9 — Polish
- [ ] Animations
- [ ] Audio / Music
- [ ] Particles
- [ ] Accessibility
- [ ] Localization (lang/en.json, tr.json, zh.json, ja.json)
- [ ] Performance

## Phase 10 — Release Candidate
- [ ] Balancing
- [ ] Bug Fixes
- [ ] Optimization
- [ ] Large Content Pass
