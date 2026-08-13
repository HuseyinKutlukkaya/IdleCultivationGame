# PLANS.md

## Purpose
Implementation plan for the Idle Cultivation Game — the "how" behind
ROADMAP.md (checklist) and DESIGN.md (what the game is). Read alongside
ROADMAP.md to know what to build next and how. Design content lives in
DESIGN.md; the phase checklist lives in ROADMAP.md.

## Development Order

1. Foundation — done (repo, git, landing page, initial UI, docs, modular arch, GameState)
2. Core Engine — EventBus, DataManager, GameLoop, SaveManager, Renderer, Offline Progress
3. First Gameplay — Meditation, Qi, Resources, Upgrades, Inventory, Notifications, Settings, Autosave, Number Notation, Statistics
4. Cultivation — Realms, Breakthroughs, Tribulations, Spirit Roots, Meridians, Physiques, Dantian, Bloodlines, Soul, Destiny & Luck
5. Items — Pills, Artifacts, Herbs, Spirit Stones, Alchemy, Crafting, Research
6. World — Regions, Cities, NPCs, Sects, Events, Quests, Reputation, Auction House, Daily Rewards, Exploration, Secret Realms
7. Automation — Auto Meditation, Auto Pills, Auto Alchemy, Sect Workers, Offline Automation
8. Reincarnation — Legacy, Origins, Permanent Unlocks, Collections, Achievements, Challenges
9. Late Game — Dao, Immortal Worlds, Higher Realms, Ancient Civilizations
10. Polish — Animations, Audio, Particles, Accessibility, Localization, Performance, Game Speed Controls
11. Release Candidate — Balancing, Bug Fixes, Optimization, Large Content Pass

## Engine Architecture

### High-level flow
`main.js` → Bootstrap → DataManager → GameState → EventBus → Managers → Systems → Renderer → UI

### Data flow
JSON → DataManager → GameState → Gameplay → Renderer → DOM

### Event flow
Meditation → emit("qiChanged") → EventBus → Renderer, Statistics, Achievements,
Notifications, Audio

### Module responsibilities
- **main.js** — startup only. Never contains gameplay, never owns state.
- **GameState** — single source of truth. All systems read and write here. Never
  touches UI. Never saves itself. Serializable to JSON.
- **Renderer** — reads GameState, updates DOM. Contains no gameplay.
- **Systems** — own gameplay logic. Never manipulate HTML. Communicate through EventBus.
- **Managers** — provide services (save, config, notifications, localization, audio). No gameplay.

### File ownership
Every file has one responsibility. Never mix: rendering, saving, gameplay,
configuration, networking.

### Dependency rules
Allowed: System→GameState, System→EventBus, Renderer→GameState, Manager→EventBus.
Forbidden: System→System, Renderer→System, UI→Gameplay.

### Startup sequence
Load index.html → stylesheet → main.js → config loads → static JSON loads →
GameState initializes → managers initialize → EventBus initializes → gameplay
systems register → renderer initializes → UI initial render → save loads →
offline progress calculated → game loop starts.

### Shutdown sequence
Save current state → flush pending events → persist localStorage → destroy
listeners → stop timers.

### Scalability goals
Support 1000+ techniques, artifacts, pills, NPCs, events, quests, buildings,
disciples without changing engine architecture.

### Engine principles
Small modules. Single responsibility. Loose coupling. Event driven. Data
driven. Framework free. GitHub Pages compatible.

## Core Engine Systems

### GameState
Single source of truth. Responsibilities: store all mutable game data, never
render UI, never access the DOM, never save itself directly, be serializable
to JSON.

Suggested structure: version, player, resources, cultivation, inventory,
techniques, artifacts, alchemy, sect, disciples, world, events, statistics,
settings.

Rules: all systems modify GameState, Renderer reads GameState, SaveManager
serializes GameState.

### EventBus (done — js/core/event-bus.js)
API: `subscribe(event, callback)`, `unsubscribe(event, callback)`,
`emit(event, payload)`, `clear()`.
Events describe facts, not commands. Payloads are minimal.
Event naming: `game:loaded`, `game:saved`, `game:restored`, `resource:changed`,
`qi:gained`,
`realm:breakthrough`, `inventory:changed`, `item:created`, `pill:consumed`,
`technique:learned`, `sect:joined`, `sect:created`, `disciple:recruited`,
`tribulation:started`, `tribulation:finished`, `reincarnation:started`,
`reincarnation:finished`, `ui:refresh`, `notification:add`.

### DataManager
Load every JSON definition with `fetch()`, cache it, validate it, expose
read-only APIs. Future JSON: realms, spirit-roots, physiques, bloodlines,
meridians, dao, techniques, pills, artifacts, herbs, sects, events, buildings,
quests, enemies. Never hardcode these definitions.

Future JSON folders: data/realms/, data/techniques/, data/items/, data/events/,
data/quests/, data/sects/, data/npcs/, data/world/, data/recipes/.

### GameLoop
`requestAnimationFrame`. Delta time calculation, fixed update scheduling, UI
refresh scheduling, offline accumulation. Pseudo flow: process events → update
systems → refresh UI → request next frame. Future: pause, speed multipliers,
background throttling.

### SaveManager
Save, load, autosave (interval + before unload), export, import, migration,
version compatibility. Storage: localStorage. Every save stores engine version,
content version, save version, migration version. Old saves must keep working
whenever possible. Future: compressed saves, cloud sync abstraction.

### Renderer
Owns all DOM updates. Never calculates gameplay. Reads GameState only. Batches
DOM updates, caches element references, supports partial refresh.

### Configuration
All tuning lives in JSON (tick rate, autosave interval, offline limit, starting
resources, theme defaults). Never hide tuning values in code.

### Number notation (done — js/ui/notation.js)
Large-number display is data-driven, never hardcoded. The config.notation block
({ defaultStyle, styles }) defines named styles — a threshold plus a suffix
list — and the NotationFormatter (js/ui/notation.js) applies the effective
style (the configured default, or the player's settings.notationStyle override)
to every numeric binding through the Renderer's _formatNumber delegation
("1.5K" instead of "1,500", falling back to scientific past the last suffix).
Adding a style is a data-only change (e.g. Chinese 万/亿 or Korean Hangul
variants). Future: a settings UI to pick the style; more styles.

**Decision (user-confirmed, 2026-08-10):** general English style ("1.5K",
"1.23M") is the shipped default; the Settings panel (Phase 2) exposes a
notation style picker so players can switch styles (scientific, and future
Chinese / Korean variants) — each style stays a data-only addition to
config.notation.styles.

### Notification system
Queue-based. Types: info, success, warning, error, achievement. Future:
animations, icons, history, filters.

### Offline progression
Store last timestamp. On load: calculate elapsed time → simulate production →
apply caps → display summary. Simulate qi generation (Phase 2) and growth
tasks **owned by the player** — herb patches (Phase 4+), sect stipends /
mine royalties (Phase 5+) accrue only when the player owns the producing
asset; "no ownership, no accrual" is the rule. A wanderer who has not
yet joined a sect earns nothing offline; a sect master earns sect income
while away. This keeps the offline producer pipeline lore-grounded — the
spirit-stone source ladder in DESIGN.md "Spirit Stone Acquisition" is the
authoritative reference for which assets even *can* accrue stones.

## AI Development Workflow

### Rules
- Never introduce frameworks or a build step.
- Never modify unrelated files. Never redesign the UI unless requested.
- Never hardcode gameplay content that belongs in JSON.
- Prefer extension over replacement. When uncertain, preserve backwards compatibility.
- Always think about future expansion.

### Feature workflow
Receive task → understand architecture → determine affected modules → implement
smallest complete feature → verify → commit → push.

### Review checklist (before every commit)
UI unchanged unless requested · no console errors · no network errors · no
duplicated code · no unnecessary dependencies · no dead code · no unrelated edits.

### Prompt template
Every implementation prompt contains: Goal, Requirements, Restrictions,
Acceptance criteria, Non-goals.

### Prompt library
- **Architecture:** "Refactor the application into a modular architecture while
  preserving existing behavior. Do not change the UI. Do not add gameplay.
  Keep GitHub Pages compatibility."
- **GameState:** "Create a centralized GameState singleton. Populate with
  placeholder sections. Do not implement gameplay."
- **EventBus:** "Implement subscribe(), unsubscribe(), emit(), clear(). No
  gameplay integration yet."
- **DataManager:** "Load JSON using fetch(). Cache loaded definitions. Expose
  read-only APIs."
- **GameLoop:** "Implement requestAnimationFrame loop. Provide delta time.
  Support pause later."
- **SaveManager:** "Implement save, load, autosave, export, import, migration
  hooks."
- **Meditation:** "Create first gameplay system. Meditation generates Qi. Use
  placeholder balancing. No breakthroughs."

### Git style
Small commits, one feature per commit, meaningful messages:
`feat: add event bus`, `feat: implement save manager`, `refactor: modularize
renderer`, `fix: prevent duplicate autosaves`. Always keep main deployable,
never leave broken commits. One feature, one push.

## Content Pipeline
Design → JSON definition → validation → loader → gameplay system → renderer →
balancing → testing → documentation.
Every new system must answer: what state does it own, what events does it emit
and consume, what JSON does it load, how is it rendered, how is it saved, how
can it expand.

### Design notes (current)
Dated log of design decisions committed BEFORE implementation, so the "how"
survives and each next system's integration mirrors the previous one. Format:
feature, JSON contract, owned state, multiplier/consumer slots, non-goals,
tuning, tests. Append a new dated bullet when the next feature is designed.

- **2026-08-15 — Meridians (Phase 3, next after Spirit Roots).**
  Data-driven qi-circulation ladder mirroring the SpiritRootSystem precedent
  exactly: data → system-owned state slice → multiplier slots → QiSystem
  consumes. JSON: `data/meridians/meridians.json` + a `data/manifest.json`
  collection entry (validation.requiredFields: `id`, `name`,
  `capacityMultiplier`, `flowMultiplier`; validation.uniqueField: `id`); one
  entry per DESIGN.md state, file order = the ladder Broken → Heavenly. Each
  entry: id, name, description, capacityMultiplier (qi cap), flowMultiplier
  (qi rate); `purityMultiplier` and `mutations` (Twin Network, Spiral, Dragon,
  Phoenix, Void) are reserved for later phases — no consumer yet. State:
  new `state.meridians` slice owned by the MeridianSystem (canonical shape
  `{ id, state, capacityMultiplier, flowMultiplier }`); the
  `player.meridians: 0` placeholder is replaced by `player.meridians` (the
  display-name string, default `Normal` — same precedent as player.spiritRoot).
  Multiplier slots: MeridianSystem writes `cultivation.meridianCapacityMultiplier`
  (stacks in QiSystem's `_computeQiMax` alongside realmEffects.qiMaxMultiplier)
  and `cultivation.meridianFlowMultiplier` (stacks in the aggregate per-second
  rate alongside cultivation.spiritRootMultiplier), both with the existing
  neutral-1 coercion — a missing/malformed/<=0 factor reads as 1, so a hostile
  save can never zero out the cap or rate. No events, no UI, no character-gen
  roll yet (matches Spirit Roots). Old saves stay identical: the default state
  Normal is 1.0×1.0. Tuning table (flat placeholder ladder, monotonic —
  Phase 10 Balancing retunes): Broken 0.70/0.60, Damaged 0.85/0.80,
  Normal 1.00/1.00, Wide 1.25/1.10, Perfect 1.60/1.25, Golden 2.00/1.50,
  Heavenly 2.50/1.80 (capacity/flow). Tests in the same commit:
  data-validation (manifest entry + ladder shape), MeridianSystem unit tests
  (loads ladder, writes both slots, neutral coercion, hostile-state fallback),
  qi unit tests for the two new stacking slots, game-state slice test.

- **2026-08-13 — Soul (Phase 3, next after Bloodlines).**
  Data-driven spiritual-strength ladder mirroring the BloodlineSystem precedent
  exactly: data → system-owned state slice → future-consumer multiplier slots →
  display name. JSON: `data/soul/soul.json` + a `data/manifest.json` collection
  entry (validation.requiredFields: `id`, `name`, `stabilityMultiplier`,
  `purityMultiplier`, `willpowerMultiplier`, `comprehensionMultiplier`;
  validation.uniqueField: `id`); one entry per ladder tier, file order = the
  placeholder ladder Shattered → Chaos Soul. Each entry: id, name, description,
  plus the four DESIGN.md Soul attributes as multipliers. State: new
  `state.soul` slice owned by the SoulSystem (canonical shape
  `{ id, name, stabilityMultiplier, purityMultiplier, willpowerMultiplier,
  comprehensionMultiplier }`); the `player.soul` display-name string (default
  `Stable Soul` — same precedent as player.spiritRoot / player.bloodline).
  Multiplier slots: SoulSystem writes `cultivation.soulStabilityMultiplier`,
  `cultivation.soulPurityMultiplier`, `cultivation.soulWillpowerMultiplier` and
  `cultivation.soulComprehensionMultiplier` — FUTURE-CONSUMER slots (DESIGN.md
  "Soul affects enlightenment"; Dao/technique-efficiency consumers land later,
  same precedent as dantian's density/purity/efficiency slots, which are
  written today and read by no system yet). NO existing consumer today, so
  qi.js and breakthroughs.js are deliberately NOT touched. All four slots use
  the existing neutral-1 coercion — a missing/malformed/<=0 factor reads as 1,
  so a hostile save can never poison a future consumer. No events, no UI
  beyond the cultivation-panel character readout's `player.soul` display name,
  no character-gen roll yet (matches Bloodlines). Old saves stay identical:
  the default Stable Soul state reads 1.0×1.0×1.0×1.0. Tuning table (flat
  placeholder ladder, monotonic per column — Phase 10 Balancing retunes):
  Shattered 0.70/0.70/0.60/0.70, Fragile 0.85/0.85/0.80/0.85,
  Stable 1.00/1.00/1.00/1.00, Firm 1.15/1.10/1.20/1.10,
  Radiant 1.35/1.25/1.50/1.25, Grand 1.60/1.45/1.90/1.45,
  Chaos Soul 2.00/1.70/2.50/1.70 (stability/purity/willpower/comprehension).
  Tests in the same commit: data-validation (manifest entry + ladder shape),
  SoulSystem unit tests (loads ladder, writes all four slots, neutral coercion,
  hostile-state fallback), game-state slice test, cultivation-panel readout
  test, bootstrap integration + E2E readout updates.

- **2026-08-13 — Talents / Comprehension (Phase 3, next after Soul).**
  Two sibling character systems mirroring the SoulSystem precedent exactly:
  data → system-owned state slice → FUTURE-CONSUMER multiplier slots → display
  name. DESIGN.md lists them as distinct character systems with NO explicit
  grade ladders and NO existing consumers (Dao / technique-efficiency land in
  Phase 9+), so both ship as future-consumer systems — exactly like Soul.
  JSON: `data/talents/talents.json` + a `data/manifest.json` collection entry
  (validation.requiredFields: `id`, `name`, `learningSpeedMultiplier`;
  uniqueField: `id`) and `data/comprehension/comprehension.json` + manifest
  entry (requiredFields: `id`, `name`, `daoProgressMultiplier`,
  `techniqueEfficiencyMultiplier`, `breakthroughEfficiencyMultiplier`;
  uniqueField: `id`). One entry per DESIGN.md trait tier, file order = the
  placeholder ladder (see tuning). State: new `state.talents` slice owned by
  the TalentSystem (canonical shape `{ id, name, learningSpeedMultiplier }`)
  and new `state.comprehension` slice owned by the ComprehensionSystem
  (canonical shape `{ id, name, daoProgressMultiplier,
  techniqueEfficiencyMultiplier, breakthroughEfficiencyMultiplier }`); the
  `player.talent` and `player.comprehension` display-name strings (defaults
  `Ordinary` and `Standard` — the data `name` fields, same precedent as
  player.spiritRoot / player.soul). Multiplier slots: TalentSystem writes
  `cultivation.talentLearningSpeedMultiplier`; ComprehensionSystem writes
  `cultivation.comprehensionDaoProgressMultiplier`,
  `cultivation.comprehensionTechniqueEfficiencyMultiplier` and
  `cultivation.comprehensionBreakthroughEfficiencyMultiplier` — FUTURE-CONSUMER
  slots (DESIGN.md "Talent affects learning", "Comprehension allows faster Dao
  progress, better technique efficiency, reduced breakthrough requirements";
  the consumers land in Phase 9 Dao / technique-efficiency work). NO existing
  consumer today, so qi.js, techniques.js, breakthroughs.js are deliberately
  NOT touched. All slots use the existing neutral-1 coercion — a
  missing/malformed/<=0 factor reads as 1, so a hostile save can never poison
  a future consumer. No events, no UI beyond the cultivation-panel character
  readout's `player.talent` / `player.comprehension` display names, no
  character-gen roll yet (matches Soul). Old saves stay identical: the default
  states read 1.0 for every slot. Tuning table (flat placeholder ladders,
  monotonic per column — Phase 10 Balancing retunes): Talents: Dull
  0.70, Slow 0.85, Ordinary 1.00, Bright 1.20, Gifted 1.50, Genius 1.90,
  Prodigy 2.50 (learningSpeed). Comprehension: Shallow 0.70/0.70/0.70,
  Limited 0.85/0.85/0.85, Standard 1.00/1.00/1.00, Insightful 1.15/1.10/1.10,
  Penetrating 1.35/1.25/1.20, Enlightened 1.60/1.45/1.35,
  Dao Heart 2.00/1.70/1.55 (daoProgress/techniqueEfficiency/
  breakthroughEfficiency). Tests in the same commit: data-validation (manifest
  entries + ladder shapes), TalentSystem + ComprehensionSystem unit tests
  (load ladder, write their slots, neutral coercion, hostile-state fallback),
  game-state slice tests, cultivation-panel readout tests, bootstrap
  integration + E2E readout updates.

## Testing Checklist
Application loads · no console errors · no network errors · save works ·
reload works · offline calculation works · GitHub Pages compatible.

## Milestones
- **0.1 Prototype** — UI, Meditation, Qi
- **0.2 Foundations** — Save, EventBus, DataManager
- **0.3 Cultivation** — Breakthroughs, Techniques, Realms
- **0.4 World** — NPCs, Events, Sects
- **0.5 Economy** — Alchemy, Artifacts, Auction
- **0.6 Reincarnation** — Legacy, Origins, Automation
- **0.7 Expansion** — Multiple regions, Secret realms
- **0.8 Polish** — Audio, Animation, Optimization
- **0.9 Beta** — Content balancing, Achievements
- **1.0 Release** — Complete gameplay loop

## Live Operations
- Weekly — balance changes, small content, bug fixes, seasonal events
- Monthly — new techniques, artifacts, pills, NPCs
- Quarterly — major realm, new continent, story expansion, new mechanics
- Annual — expansion, new world, major engine improvements

## Performance Targets
10,000+ items, 5,000+ NPCs, 1,000+ techniques, 500+ artifacts, 500+ pills,
200+ realms without noticeable slowdown. Avoid allocations, cache references,
batch updates, render only changed elements, avoid repeated DOM queries.

## Future Roadmap Page (planned)
The landing-page roadmap section is currently static HTML that mirrors
ROADMAP.md. Planned improvement: make it data-driven and give it its own page.

- `data/roadmap.json` — single source of truth for phases/items rendered on the page.
- Dedicated roadmap page (e.g. `roadmap.html`) listing full phase detail with statuses.
- Renderer/system reads the JSON and renders the checklist — no hardcoded roadmap markup.
- Do this as part of the Core Engine DataManager phase so it uses the same loader.

## Deferred & Optional (parked, not forgotten)
Documented decisions on mechanics that are deliberately NOT in the roadmap yet,
so the reasoning survives:
- **Cloud saves / cross-device sync** — needs an online backend. SaveManager
  already abstracts storage (localStorage today), so a cloud transport can slot
  in later without engine changes.
- **Mod support** — DESIGN.md names it as a future direction; the JSON-driven
  content pipeline (DataManager + data/) is the seam mods would plug into.
  Revisit once the content pipeline is battle-tested.
- **Active "golden click" layer** — deliberately rejected: DESIGN.md's
  philosophy is a passive cultivation idle, not a clicker. Revisit only if the
  design intent changes.
- **2026-08-11 — Realm depth & interconnected mechanics (off-the-cuff ideas, NOT a plan).**
  During a chat about the committed realm ladder (Phase 3 "Realms (JSON-driven)"),
  the user brainstormed possible directions for deepening realms — thrown out
  off the top of their head, explicitly tentative, to be discussed later, NOT a
  definite future list. Recorded here only so the conversation isn't lost. Ideas
  mentioned (none committed to, none designed, likely to change):
  - Sub-tier / quality tiers inside major realms (e.g. Foundation Establishment,
    Golden Core quality stages).
  - Tribulations having their own levels.
  - Dao-related gates and interconnected mechanics between realms and other
    systems.
  - Deeper xianxia lore flavor woven in.
  Caveat recorded per the user's instruction: this is a discussion seed, not a
  roadmap. Whatever survives the future talk must be re-evaluated against the
  existing realm JSON contract and consuming systems (Breakthroughs,
  Tribulations, Spirit Roots, Dao) — extension over rewrite, but nothing here
  is decided.

## Working Principle
Build the engine once. Expand forever. Every feature: one feature, one
responsibility, one commit, one review. Never implement five systems at once.

## Design Principles (Part 10)
Everything expandable. Everything modular. Everything data driven. Never
rewrite when extension is possible. The engine should rarely change; content
should continuously grow.
