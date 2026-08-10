# DESIGN.md

## Vision
A long-term browser-based idle cultivation simulator inspired by xianxia.
The project is designed to grow for years without requiring architectural
rewrites. Cultivation is the primary progression system; reincarnation is the
central long-term mechanic. This is not a small idle game — it should
eventually become a complete cultivation sandbox that can be expanded
indefinitely.

## Core Pillars
- Cultivation first
- Data-driven design
- Modular architecture
- GitHub Pages compatible
- Vanilla HTML/CSS/JavaScript (no frameworks)
- Long-term maintainability

## Universal Rule
Everything important supports Grade, Quality and Compatibility. Future
systems automatically inherit these properties plus: ID, name, description,
affinity, level, experience, mastery, age, durability, purity, potential, tags,
metadata and lore.

## Project Philosophy
- Every gameplay system should be independent.
- Nothing should be hardcoded if it can be represented as data.
- Reincarnation is a core mechanic.
- The engine should allow hundreds of techniques, pills, sects, realms, events
  and future expansions without redesigning the architecture.
- The codebase should stabilize; content should never stop growing.
- Whenever adding content ask: Can this be added through data? Can this be
  expanded later? Will this break old saves? Can AI safely implement it?

## Core Systems

### Character
A character is defined by many interacting systems instead of a single level.
Each reincarnation creates a new character; no two lives should feel identical.

- Spirit Roots — primary cultivation affinity (speed, elements, compatibility)
- Physiques — body quality (health, lifespan, breakthrough success)
- Meridians — qi circulation (capacity, flow, purity, states, mutations)
- Dantian — stores cultivation energy (capacity, density, purity, grades)
- Bloodlines — passive bonuses; can awaken, evolve, mutate
- Soul — spiritual strength (stability, purity, willpower, comprehension)
- Destiny — hidden luck (fortunate encounters vs. calamities)
- Luck — critical crafting, rare drops, secret realms, event quality
- Talent — global learning speed
- Comprehension — understanding (Dao progress, technique efficiency)

#### Character Generation (New Life Flow)
1. Birth
2. Origin Selection (future unlock)
3. Random Destiny
4. Spirit Root Roll
5. Physique Roll
6. Bloodline Roll
7. Meridians
8. Dantian
9. Soul Talent
10. Starting Location
11. Starting Technique
12. Initial Resources

Future systems can inject modifiers during generation.

#### Spirit Roots
Primary cultivation affinity. Determines cultivation speed, elemental affinity,
future techniques, sect compatibility and Dao compatibility.

- Types: No Root, Pseudo Root, Mixed Root, Three Element, Dual Element, Single
  Element, Mutated, Heavenly, Divine, Chaos
- Elements: Fire, Water, Earth, Metal, Wood, Lightning, Ice, Wind, Light, Dark,
  Space, Time
- Attributes: purity, stability, growth, mutation, compatibility

#### Physiques
Physical body quality. Influences health, lifespan, body cultivation, damage
resistance and breakthrough success.

- Grades: Ordinary, Iron Body, Jade Body, Saint Body, Immortal Body, Chaos Body
- Each physique has: grade, quality, traits, special effects, upgrade paths

#### Meridians
Qi circulation. Properties: capacity, flow rate, purity, damage, blockages.

- States: Broken, Damaged, Normal, Wide, Perfect, Golden, Heavenly
- Mutations: Twin Network, Spiral, Dragon, Phoenix, Void

#### Dantian
Stores cultivation energy. Properties: capacity, density, purity, efficiency.

- Grades: Cracked, Small, Normal, Large, Perfect, Golden, Universe, Void

#### Bloodlines
Provide passive bonuses. Can awaken through progression, can evolve, can mutate.

- Examples: Dragon, Phoenix, Tiger, Qilin, Turtle, Sword, Chaos, Celestial,
  Ancient Human

#### Soul
Represents spiritual strength. Properties: stability, purity, willpower,
comprehension, resistance.

- Future mechanics: Soul combat, Soul refinement, Soul damage, Soul inheritance

#### Destiny
Controls hidden luck.
- Positive: fortunate encounters, rare teachers, hidden treasures
- Negative: calamities, betrayals, poor opportunities

#### Luck
Affects critical crafting, rare drops, secret realms, events, NPC encounters,
treasure quality.

#### Talent
Global learning speed. Influences techniques, alchemy, formation mastery,
artifact crafting, Dao comprehension.

#### Comprehension
Represents understanding. Higher comprehension allows faster Dao progress,
better technique efficiency, reduced breakthrough requirements.

#### Universal Attribute Model
Every important object supports: ID, Name, Description, Grade, Quality,
Compatibility, Affinity, Level, Experience, Mastery, Age, Durability, Purity,
Potential, Tags, Metadata.

#### Interactions
- Spirit Root affects cultivation
- Meridians affect circulation
- Dantian affects storage
- Bloodline affects passive bonuses
- Physique affects body
- Soul affects enlightenment
- Luck affects events
- Destiny affects the world
- Talent affects learning

Every system should influence several others instead of existing in isolation.

### Cultivation
Primary loop: Meditate → Gather Qi → Refine Qi → Increase Base → Reach
Bottleneck → Prepare Resources → Attempt Breakthrough → Advance Realm → Unlock.

Cultivation is the primary progression system. Every breakthrough should feel
meaningful.

#### Qi
Qi is the universal cultivation resource.

- Properties: Current, Maximum, Purity, Density, Element, Source, Efficiency
- Sources: Meditation, Spirit Stones, Spirit Veins, Treasures, Pills,
  Artifacts, Sect Buildings, Events

#### Qi Gathering
Factors: Spirit Root, Realm, Technique, Environment, Weather, Sect Bonus,
Artifact Bonus, Formation Bonus, Offline Bonus.

#### Realms
15-tier progression (Mortal → Beyond Heaven): Mortal, Qi Gathering, Foundation
Establishment, Core Formation, Nascent Soul, Soul Transformation, Void
Refinement, Body Integration, Great Ascension, True Immortal, Celestial
Immortal, Golden Immortal, Dao Lord, Heavenly Sovereign, Beyond Heaven. Each
realm raises max qi, lifespan, efficiency, unlocks and power.

#### Breakthroughs
Requirements: required Qi, stable foundation, mental state, resources, optional
pills, possible mentor bonus, possible formation bonus.

Results: Perfect, Great Success, Success, Barely Successful, Failure, Heavy
Failure, Qi Deviation, Death (future optional).

#### Bottlenecks
Some realms create bottlenecks. Player may require rare herbs, rare pills,
special locations, secret realms, comprehension, tribulations.

#### Tribulations
Types: Lightning, Heart Devil, Karma, Heavenly Fire, Void, Soul, Body.
Future: combined tribulations.

#### Dao
Long-term specialization. Examples: Sword, Fire, Water, Earth, Wood, Metal,
Space, Time, Life, Death, Chaos. Each Dao has level, comprehension, affinity,
techniques, passives.

#### Techniques
- Categories: Cultivation, Movement, Attack, Defense, Body, Soul, Support,
  Passive
- Properties: Grade, Quality, Affinity, Required Realm, Mastery, Experience,
  Cooldown (future)

#### Cultivation Speed
Affected by: Spirit Root, Physique, Technique, Sect, Artifacts, Weather,
Environment, Offline bonus, Reincarnation bonus.

#### Meditation
The first gameplay system. Produces Qi every tick. Upgradeable. Can later
support: Focused Meditation, Deep Meditation, Dual Cultivation, Guided
Meditation, Automatic Meditation.

#### Lifespan
Every realm extends lifespan. Failure to progress eventually causes death.
Death enables reincarnation.

#### Resource Loop
Qi → Breakthrough → New Realm → Better Techniques → Higher Efficiency → More Qi

#### Future Expansions
Inner Demons, Karma, Heavenly Mandate, World Suppression, Immortal Wars,
Ancient Ruins, Heavenly Courts, Multiple Worlds.

### World
The world should feel alive without requiring constant player input. Factions
rise and fall; NPCs cultivate, trade, die and create opportunities while the
player meditates. The world should continue progressing while the player
meditates.

- Structure — Universe → Realms → Continents → Regions → Cities/Villages/
  Forests/Mountains/Spirit Veins/Secret Realms/Dungeons
- Every location may contain: Spirit Qi Density, Climate, Resources, Danger
  Level, Dominant Sect, Available NPCs, Events, Unique Treasures

#### Sects
Progression: Early Game join an existing sect → Mid Game become Elder → Late
Game become Sect Master → End Game create your own sect.

- Attributes: Name, Grade, Influence, Prestige, Treasury, Library, Buildings,
  Members, Disciples, Allies, Enemies, Resources
- Buildings: Cultivation Hall, Library, Alchemy Hall, Forge, Treasure Vault,
  Spirit Garden, Spirit Beast Stable, Formation Hall, Mission Hall, Marketplace,
  Guest Hall, Elder Pavilion, Hidden Realm. Buildings increase automation and
  unlock mechanics.

#### Disciples
Every disciple has: Name, Age, Realm, Talent, Spirit Root, Physique, Loyalty,
Potential, Occupation.

Possible roles: Cultivator, Alchemist, Blacksmith, Explorer, Trader, Guard,
Teacher, Researcher.

#### NPCs
NPCs are persistent; they cultivate. They can trade, teach, fight, recruit,
challenge, betray, assist. Future relationships: Friend, Enemy, Master,
Disciple, Family, Rival.

#### Reputation
Tracked separately with sects, cities, kingdoms, NPCs, merchants. High
reputation unlocks discounts, quests and invitations.

#### Events
Events should be data-driven. Categories: Random, Scheduled, Story, Seasonal,
Sect, World, NPC, Exploration, Disaster.

Event examples: Meteor falls, Ancient cave discovered, Auction announced,
Spirit beast invasion, Heavenly tribulation nearby, Merchant caravan arrives,
Lost disciple requests help, Rare herb blooms, Hidden inheritance appears.

#### Secret Realms
Temporary locations. Contain treasures, bosses, artifacts, rare herbs, ancient
techniques. Disappear after completion.

#### Quests
Quest types: Story, Daily, Sect, NPC, Exploration, Treasure, Escort,
Investigation. Rewards: Qi, Items, Techniques, Reputation, Artifacts, Spirit
Stones.

#### Auction House
Players may buy, sell, bid. Future: NPC bidding, limited inventory, rare
appearances.

#### World Progression
The world evolves: new sects appear, old sects collapse, wars begin, treasures
emerge, world bosses awaken, new continents unlock.

### Items & Economy
Every item is data-driven with ID, name, description, grade, quality, value,
tags, stack size, icon and optional lore.

- Categories — consumables, herbs, ores, wood, essences, spirit stones, pills,
  artifacts, weapons, armor, accessories, quest items, treasures, formation
  materials, crafting components
- Grades — Mortal, Common, Earth, Heaven, Spirit, King, Saint, Immortal,
  Celestial, Divine, Chaos (11 tiers)
- Quality — Broken, Poor, Normal, Fine, Excellent, Perfect, Legendary (7 tiers)
- Herbs — properties: growth time, region, qi affinity, rarity, alchemy uses.
  Examples: Spirit Grass, Moon Lotus, Flame Orchid, Ice Ginseng, Dragon Vine,
  Void Flower
- Pills — categories: cultivation, healing, body, soul, breakthrough, longevity,
  poison, support. Attributes: recipe, grade, success rate, cooldown, side effects
- Alchemy — flow: collect herbs → learn recipe → refine → evaluate quality →
  store or consume. Stats: alchemy level, mastery, success chance, purity,
  efficiency
- Artifacts — types: sword, spear, ring, necklace, seal, banner, mirror,
  cauldron. Attributes: spirit, durability, growth, owner bond, affinity.
  Artifacts may evolve with the player
- Spirit Stones — primary currency. Grades: Low, Medium, High, Supreme,
  Immortal. Uses: trading, sect upgrades, alchemy, breakthroughs, formation fuel
- Crafting — future systems: Forging, Enchanting, Formation Engraving, Artifact
  Fusion, Artifact Evolution
- Currencies — spirit stones, sect contribution, reputation, ancient tokens,
  merit. Sinks: buildings, recipes, artifacts, upgrades, auction, research

#### Spirit Stone Acquisition

Spirit stones are a *salary from the world*, never a personal-cultivation
output. Meditation produces qi, not stones. The canonical source ladder:

| Tier              | Source                                                | Phase |
|-------------------|-------------------------------------------------------|-------|
| Origin endowment  | Master's parting gift / family heirloom / roadside  | 2     |
|                   | find — a one-shot narrative event on first boot only.  |       |
| Outer disciple    | Sect daily stipend + mission pay                       | 5     |
| Inner disciple    | Stipend scales up; sect contribution redemption        | 5     |
| Core disciple     | Sect subsidizes techniques / pills / breakthroughs    | 5     |
| Legacy disciple   | Sect-funded endowment; quests pay better              | 5     |
| Elder / Master    | Mine royalties, treasury rights, sect tax income       | 7+    |

No per-second "stones from meditation" producer exists at any tier. The
Phase-2 wallet starts at 50 spirit stones — the master's parting gift, a
lore-canonical value (config-driven via `data/game-config.json`'s
`startingState.spiritStones`, fallback 50). Phase 5 sects replace this
endowment with sustainable income from the ladder above.

#### Sect ranks (income)

Every sect-affiliated disciple receives a daily stipend scaled by rank.
The earlier ranks *feel* scarce on purpose — the player is meant to
climb the ladder. Stipends live in `data/sects/` JSON (Phase 5) and are
declared per rank tier; the player never invents a new stipend in code.

- **Outer disciple**: a pittance, forces mission pay to complement.
- **Inner disciple**: sustainable; covers basic cultivation.
- **Core disciple**: comfortable; meaningful technique investment.
- **Legacy disciple**: attributed endowment; sect funds projects.
- **Elder**: paid from sect coffers (mines, treasury, taxes).

See DESIGN.md "Sects" and ROADMAP.md Phase 5 for the sect system itself.
- Inventory — filtering, sorting, search, favorites, auto stack, auto sell, lock
- Collections — artifacts, techniques, pills, herbs, NPCs, secret realms,
  achievements; completion bonuses unlock over multiple reincarnations

### Reincarnation & Legacy
A single life should never allow the player to experience everything. Each
reincarnation is a new beginning with accumulated wisdom and selective
permanent progression. Goals: encourage experimentation, prevent permanent bad
builds, unlock new origins, increase replayability, provide endless progression.

- Life cycle — Birth → Growth → Cultivation → Peak → Old Age/Death/Ascension →
  Legacy Evaluation → Permanent Rewards → Reincarnation → New Character
- Legacy — every life records name, highest realm, age, cause of death,
  techniques mastered, artifacts owned, Dao progress, sect history, achievements.
  Players can browse previous incarnations
- Permanent progression — legacy points, origin unlocks, new starting techniques,
  artifact inheritance, sect reputation, collection bonuses, cosmetics,
  achievement rewards, research, knowledge
- Origins — Village Child, Merchant Family, Minor Noble, Sect Disciple, Ancient
  Clan, Dragon Descendant, Phoenix Descendant, Forgotten Immortal, Heaven
  Chosen; modify starting conditions
- Automation — unlocks gradually: auto meditation, auto consume pills, auto
  breakthrough preparation, auto herb harvest, auto alchemy, auto equipment,
  auto sect management, auto disciple assignment, auto exploration. Automation
  should never replace progression decisions
- Achievements — categories: cultivation, exploration, alchemy, collection,
  combat, sect, reincarnation, economy. Unlock: titles, cosmetics, legacy
  bonuses, permanent upgrades

### Balance & Progression (Part 10)
- Balance rewards planning rather than constant clicking
- Early game teaches mechanics; mid game introduces specialization; late game
  emphasizes automation; end game focuses on optimization and reincarnation
- Progression curve stages: Tutorial, Early Cultivation, Sect Life, Regional
  Influence, World Influence, Immortal Journey, Cosmic Expansion, Endless
  Progression. Each stage introduces new mechanics instead of merely increasing
  numbers
- Resource design: Primary — Qi, Spirit Stones. Secondary — Contribution,
  Reputation, Legacy Points. Rare — Immortal Essence, Chaos Crystal, Origin
  Fragment
- Avoid artificial difficulty. Challenge should come from preparation, planning,
  resource management, build diversity, risk versus reward

### Content Design (Part 11)
- The engine answers "how does it work / when does it happen"; JSON answers
  "what exists / values / rewards / requirements"
- Rarity system — Broken, Common, Uncommon, Rare, Epic, Legendary, Mythic,
  Saint, Immortal, Celestial, Divine, Chaos, Origin (13 tiers). Influences drop
  chance, auction value, research value, crafting ingredients, NPC reactions,
  collection score
- Tag system — instead of hardcoded categories use tags: fire, water, wood,
  metal, earth, lightning, ice, wind, space, time, holy, demonic, body, soul,
  dao, artifact, alchemy, formation, beast, sect, merchant, rare, legendary,
  boss, quest. This makes searching and balancing easier
- Build diversity — Body Cultivator, Soul Cultivator, Sword Cultivator, Pill
  Master, Formation Master, Artifact Collector, Merchant, Beast Tamer, Sect
  Master, Poison Specialist, Support Cultivator, Balanced Cultivator, Chaos
  Cultivator. Each archetype should remain viable. No single optimal build
- Progression design — every mechanic should answer: What unlocks it? How does
  it scale? What resources does it consume? Can it automate? Does reincarnation
  improve it? Can future DLC expand it?
- Content creation checklist — every new object requires: internal ID, display
  name, description, icon, grade, quality, lore, requirements, rewards, JSON
  definition, localization key, balance values
- Localization — every displayed string eventually from lang/en.json, tr.json,
  zh.json, ja.json. Never hardcode user-facing text
- Mod support — future mods/ dir with manifest.json, assets/, data/; mods add
  content instead of replacing engine code
- Save compatibility — old saves keep working whenever possible; every save
  stores engine version, content version, save version, migration version

## Art Direction & UI

### Overall Feel
Dark fantasy xianxia with elegant minimalism. The UI should make the player
feel like they are reading an immortal's cultivation journal rather than
playing a flashy mobile game. Not anime, not cartoon, not pixel art, not
realistic.

### Visual Style
Heavy inspiration from: Amazing Cultivation Simulator, Tale of Immortal,
Path of Achra (minimal UI philosophy), cultivation novels, ancient Chinese
paintings, ink wash (Shui-mo), Taoist manuscripts.

Avoid: neon UI, mobile-game shiny buttons, oversaturated colors, anime
character portraits everywhere.

### General Design Philosophy
Information density over giant buttons. Closer to an RPG management game than
a mobile idle clicker. Clean, readable, timeless. The visuals should age well
instead of chasing current mobile UI trends.

### Color Palette
- Background: `#101214`
- Panels: `#181B1F`
- Borders: `#2E343A`
- Primary Text: `#E8E6E3`
- Secondary Text: `#A5A7AA`
- Success: `#5FAF5F`
- Warning: `#C8A84E`
- Danger: `#B24D4D`

Element colors: Fire (deep crimson), Water (azure), Wood (emerald), Metal
(silver), Earth (golden brown), Lightning (purple), Ice (pale blue), Space
(dark indigo), Time (gold + white), Chaos (black + purple).

### Typography
No fantasy fonts. Clean fonts: Inter, Noto Sans, Source Sans. JetBrains Mono
only for numbers. Headers slightly larger. Prioritize readability.

### UI Theme
Resembles an ancient cultivation manual — elegant, minimal, dark, organized,
dense, readable. Never flashy.

### Layout
Dashboard-like: Realm, Resources and Character across the top; Cultivation
Progress; then panels for Meditation, Techniques, Dao, Inventory, Artifacts,
Pills, Sect, World, Activity Log; Bottom Bar. Initial implementation shows
placeholder panels only — no gameplay logic, responsive layout, maintain
existing visual style.

### HUD Philosophy
Information should always be visible. Players should not constantly switch
screens. Major progression systems remain accessible.

### Buttons
Flat, rounded (~8px), hover glow, small animation. No glossy gradients, no
mobile-game style buttons.

### Icons
Eventually every system receives its own icon (meditation, fire, lightning,
technique, pill, artifact, sect, herb, world). Initially placeholders before
proper SVG assets exist.

### Character Presentation
No full-screen anime portraits. Eventually: small illustrated portrait,
equipment silhouette, cultivation aura, realm visual effects.

### Realm Visual Effects
Every breakthrough changes visuals: Qi Gathering (small blue aura), Foundation
(golden particles), Core Formation (rotating golden core), Nascent Soul (tiny
spirit behind character), Immortal (clouds, lightning, lotus bloom), Dao Lord
(reality distortion).

### Background Art Direction
Slow cloud movement, fog, stars, leaves, snow, rain, spirit particles,
day/night cycle, seasonal atmosphere. The world itself should feel alive.

### Environment Art
Landscape-focused: ancient mountains, floating islands, spirit rivers, pagodas,
immortal palaces, cloud seas, massive ancient trees, ancient ruins, spirit
beasts, moonlight, fog. Nature is more important than characters.

### Character Art Direction
Avoid anime waifus and large hero portraits. Prefer small portraits, stylized
silhouettes, aura effects, equipment visuals.

### Rarity Colors
Common (gray), Uncommon (green), Rare (blue), Epic (purple), Legendary
(orange), Immortal (gold), Celestial (white + gold), Divine (rainbow glow),
Chaos (black + purple), Origin (white).

### Animations
Very subtle: progress bars, number counting, small particles, glow, pulse.
Avoid excessive and flashy animations.

### Audio Direction
Calm: bamboo flute, guqin, wind, water, temple bells, thunder during
tribulations, birds. No constant music loops; ambient atmosphere preferred
over continuous soundtrack.

### Asset Organization
`assets/` holds images, sprites, audio, future SVG icons, illustrations,
backgrounds. Planned categories: backgrounds, icons, sprites, illustrations,
audio, future effects.

### Cosmetics & Visual Rewards
Achievements unlock titles, cosmetics, permanent bonuses. Future cosmetic
unlocks through reincarnation; collection bonuses unlock over multiple
reincarnations; legacy bonuses may include cosmetics.

### Reincarnation Visual Progression
Mortal: simple wooden frames, muted colors. Qi Gathering → Core Formation:
stone and bronze accents, subtle glow. Nascent Soul: animated spiritual mist,
lotus motifs. Immortal Realms: elegant jade, gold, celestial effects.
Dao Lord+: cosmic backgrounds, reality distortion, animated constellations.
The player should feel stronger through presentation, not only numerical
progression.

### Theme Defaults
Configuration is intended to support theme defaults through configuration
data rather than hardcoded values; configuration values live in JSON whenever
practical.

### Overall Visual Goal
"Opening an ancient cultivation manual" — not "another idle clicker".

## Endgame
Goals: multiple worlds, higher dimensions, ancient civilizations, world trees,
infinite secret realms, heavenly wars, universe creation, custom sects,
procedural continents.

Endless progression: infinite Dao mastery, infinite technique mastery, artifact
evolution, sect expansion, world discovery, legend collection, procedural
challenges.

The player eventually creates civilizations, builds immortal sects, shapes
continents, creates worlds and universes, and leaves eternal legacies that
affect every future reincarnation — transitioning from cultivator to creator
of the cultivation universe itself. That is the true final destination.

## Future Game Systems
Marriage, Children, Clan System, Dynasty, Territory Control, Kingdom Politics,
Immortal Court, Outer Gods, Divine Beasts, Artifact Spirits, Pet Evolution,
World Bosses, Faction Wars, Dungeon Generation, Procedural Ancient Ruins,
Treasure Hunting, Fishing, Mining, Smithing, Cooking, Medicine, Trading Company,
Caravans, Ships, Airships, Flying Swords, Teleportation Arrays, Constellation
System, Star Refinement, Moon Cultivation, Sun Cultivation, Elemental Fusion,
Chaos Cultivation, Void Cultivation.

## Future Content Ideas (Backlog)
Underworld Expansion, Ocean Realm, Machine Cultivation, Spirit Beast Kingdom,
Ancient Gods, Outer Cosmos, Time Travel, World Builder Mode, Celestial War,
Ancient Era, Outer Void, Time River, Infinite Tower, Player Created Sects,
Seasonal Events.

Backlog: hundreds of techniques, thousands of items, procedural NPC stories,
relationship system, marriage, children, inheritance, season system, weather,
dynamic economy, world boss events, daily challenges, speedrun mode, mod
support, localization, cloud saves abstraction.

## Online Features (Optional)
Global rankings, leaderboard, shared market, world events, community
challenges, cloud saves, guild competition. Never require multiplayer;
everything should remain playable offline.

## Content Targets
Eventually support: 100 Realms, 1000 Techniques, 1000 Pills, 1000 Artifacts,
500 Buildings, 5000 NPCs, 500 Sects, 10000 Items, 10000 Events, Infinite
Procedural Content.

## Success Criteria
Player opens game, understands mechanics quickly, always has something
meaningful to unlock, never reaches permanent dead end, every reincarnation
feels different, every few hours something new unlocks, after hundreds of
hours there is still meaningful progression.

## Project Motto
Build once. Expand forever. Data over code. Systems over scripts. Content over
rewrites. Small commits. Modular architecture. Endless cultivation.
