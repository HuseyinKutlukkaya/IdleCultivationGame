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
- [ ] DataManager (load + cache + validate JSON definitions)
- [ ] GameLoop (requestAnimationFrame ticker, delta time)
- [ ] SaveManager (save/load/autosave/export/import/migration)
- [ ] Renderer (state → DOM, batch updates, no gameplay)
- [ ] Offline progress (last timestamp, elapsed calc, caps, summary)

## Phase 2 — First Gameplay
- [ ] Meditation (first gameplay system, produces Qi)
- [ ] Qi (gathering, max, per-second)
- [ ] Resources (spirit stones, herbs)
- [ ] Inventory (basic)
- [ ] Notifications (queue-based)
- [ ] Settings
- [ ] Autosave (interval + on unload)

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
