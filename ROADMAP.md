# ROADMAP.md

Development roadmap from the master plan (see PLANS.md for the full plan).
`[x]` = done, `[ ]` = pending. Tick boxes as phases complete.

## Cross-Cutting Gates
Standing quality gates that apply to the whole project — not to a single phase.

**Human playability is a standing E2E contract, not a per-phase deliverable.**
The E2E suite always contains a spec proving a real player can complete the
game's current core loop through actual UI interactions (real buttons, visible
feedback, no console errors, no dead-ends) — see `tests/e2e/game.spec.mjs`.
Every feature that touches the bootstrap, renderer, UI or game loop extends or
keeps that spec green as the loop grows. A playtest + revision cycle (collect
bugs + lore/balance feedback, fix, re-gate) runs after every playable slice —
the first cycle lands before Meridians (Phase 3).

- [ ] First human playtest + revision cycle — play the current loop end-to-end
      as a real player, collect bugs and lore/balance feedback, fix, re-gate.

### Revision Cycle 1 (from the first human playtest — 10 findings, 5 packages)

**Confirmed design decisions (user, 2026-08-11):**
- Breakthroughs no longer gate on spirit stones — the stone-cost data fields and
  code paths stay intact for reuse in a different way later; only the gating
  changes. Item (bottleneck) gates get the same treatment until item sources
  exist (P4).
- Realm sub-levels (9 per realm): layer-up is **manual** — every one of the 9
  layers is an explicit player action; realm breakthrough (+ tribulation where
  applicable) happens at the 9th layer. Rising difficulty per layer.
- Technique generators produce **qi** (and technique proficiency XP), never
  spirit stones — stones remain world-salary (AGENTS.md lore rule).

| Pkg | Scope | Playtest findings | Type |
|---|---|---|---|
| P1 | Playtest quick fixes | #1 Reset Save confirm dialog + success popup; #3 full progress bar becomes actionable; #4 instant feedback when a breakthrough attempt fails (no silent dead button); #5 show exact missing requirements — stones/items removed from gates per decision above | UX + save |
| P2 | Event popup & log pipeline | #2 initial 50-stone gift logs to Activity Log; generic event → popup (message + reward) + same message to log; #9 breakthroughs and major events announce as popups AND log entries | Feature |
| P3 | Tab UI + inventory grid | #10 tab-style layout (Cultivation / Techniques / Inventory / Log / Settings); #8 inventory as box grid with pagination, built once inside its tab | Rework |
| P4 | Nine sub-levels per realm | #6 manual 9-layer progression per realm, rising qi cost per layer, save-format bump + migration | Major system |
| P5 | Technique generators & proficiency | #7 idle-style technique shop (classic idle logic: cooldown per producer, levels with geometric price rise, milestone bonuses at 5/10/25/50/100/150/200 — cooldown reduction or revenue bonus, self or global); proficiency ladder: Beginner / Minor / Greater / Complete / Mastered / Assimilated / Transcendence; producers generate qi (lore-safe) | Major system |

Execution order P1 → P2 → P3 → P4 → P5. Each package = its own commit(s) with
tests in the same commit, full Feature Gate per package. Security review on P1
(save/reset), P2 (data-driven popup rendering) and P4 (save-format migration).
E2E updates on every package (renderer/save paths touched throughout).

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
- [x] Meditation (first gameplay system, produces Qi) — done (js/systems/meditation.js)
- [x] Qi (gathering, max, per-second) — done (js/systems/qi.js)
- [x] Resources (spirit stones, herbs) — done (js/systems/resources.js)
- [x] Inventory (basic) — done (js/systems/inventory.js)
- [x] Notifications (queue-based) — done (js/managers/notification-manager.js + js/ui/activity-log.js)
- [x] Settings (incl. notation style picker — general English suffix default with selectable styles) — done (js/ui/settings-panel.js)
- [x] Autosave (interval + on unload) — done in SaveManager (js/managers/save-manager.js)
- [x] Number notation (abbreviated/scientific display, data-driven styles) — done (js/ui/notation.js)
- [x] Upgrades (basic purchasable boosts — spend resources for passive gains) — done (js/systems/upgrades.js + js/ui/upgrades-panel.js + data/upgrades/upgrades.json)
- [x] **Spirit stones origin endowment** (Phase 2: 50 stones — the master's parting gift on first boot, narratively framed as a one-shot endowment; Phase 5 sects replace with stipends per DESIGN.md "Spirit Stone Acquisition")
- [x] Statistics (lifetime counters: playtime, qi generated, breakthroughs, meditations)

## Phase 3 — Cultivation
- [x] Realms (JSON-driven) — done (js/systems/realms.js + data/realms/realms.json)
- [x] Breakthroughs (requirements, results, bottlenecks) — done (js/systems/breakthroughs.js + data/breakthroughs/breakthroughs.json)
- [x] Tribulations — done (js/systems/tribulations.js + data/tribulations/tribulations.json)
- [x] Spirit Roots — done (js/systems/spirit-roots.js + data/spirit-roots/spirit-roots.json)
- [x] Meridians — done (js/systems/meridians.js + data/meridians/meridians.json)
- [x] Physiques — done (js/systems/physiques.js + data/physiques/physiques.json)
- [x] Dantian — done (js/systems/dantian.js + data/dantian/dantian.json)
- [x] Bloodlines — done (js/systems/bloodlines.js + data/bloodlines/bloodlines.json)
- [ ] Soul (stability, purity, willpower, comprehension — DESIGN.md character system)
- [ ] Talents / Comprehension
- [ ] Destiny & Luck (hidden luck, calamities vs. fortunate encounters — DESIGN.md character systems)
- [ ] Milestones (threshold rewards: first X qi, first breakthrough, ...)

## Phase 4 — Items
- [ ] Inventory (full: filter/sort/search)
- [ ] Pills
- [ ] Artifacts
- [ ] Herbs
- [ ] Spirit Stones (grades)
- [ ] Crafting
- [ ] Alchemy
- [ ] Research (permanent upgrade tree — spend resources on lasting multipliers)
- [ ] Buy amounts (×1, ×10, ×100, Max for purchases)

## Phase 5 — World
- [ ] Regions
- [ ] Cities
- [ ] NPCs
- [ ] Sects
- [ ] Events (data-driven)
- [ ] Quests (story / daily / sect / NPC — data-driven, see DESIGN.md)
- [ ] Reputation (with sects, cities, kingdoms, NPCs, merchants — DESIGN.md)
- [ ] Auction House (buy / sell / bid — DESIGN.md)
- [ ] Daily rewards (login bonuses — retention)
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
- [ ] Challenges (special-rule runs with permanent rewards — classic prestige-adjacent mechanic)

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
- [ ] Game speed controls (pause, ×1/×2/×4 — GameLoop future in PLANS.md)

## Phase 10 — Release Candidate
- [ ] Balancing
- [ ] Bug Fixes
- [ ] Optimization
- [ ] Large Content Pass
- [ ] Growth curves & soft caps (data-driven tuning to keep numbers readable)
