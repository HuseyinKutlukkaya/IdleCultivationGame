/**
 * main.js — application entry point (ES6 module).
 *
 * Responsibilities:
 *   - Bootstrap the app once the DOM is ready.
 *   - Wire placeholder landing-page behaviors.
 *   - Start the game simulation loop and set the boot status in the status bar.
 *
 * Future system plug-in: attach gameplay systems (meditation, qi, ...) here
 * or via the EventBus as they are implemented.
 */

import { loadConfig } from './core/config.js';
import { DataManager } from './core/data-manager.js';
import { EventBus } from './core/event-bus.js';
import { Game } from './core/game.js';
import { OfflineProgress } from './core/offline-progress.js';
import { Storage } from './core/storage.js';
import { NotificationManager } from './managers/notification-manager.js';
import { SaveManager } from './managers/save-manager.js';
import { MeditationSystem } from './systems/meditation.js';
import { QiSystem } from './systems/qi.js';
import { RealmSystem } from './systems/realms.js';
import { ResourceSystem } from './systems/resources.js';
import { InventorySystem } from './systems/inventory.js';
import { BreakthroughSystem } from './systems/breakthroughs.js';
import { TribulationSystem } from './systems/tribulations.js';
import { SpiritRootSystem } from './systems/spirit-roots.js';
import { MeridianSystem } from './systems/meridians.js';
import { PhysiqueSystem } from './systems/physiques.js';
import { DantianSystem } from './systems/dantian.js';
import { BloodlineSystem } from './systems/bloodlines.js';
import { SoulSystem } from './systems/soul.js';
import { TalentSystem } from './systems/talents.js';
import { ComprehensionSystem } from './systems/comprehension.js';
import { DestinySystem } from './systems/destiny.js';
import { LuckSystem } from './systems/luck.js';
import { StatisticsSystem } from './systems/statistics.js';
import { UpgradeSystem } from './systems/upgrades.js';
import { TechniqueSystem } from './systems/techniques.js';
import { NotationFormatter } from './ui/notation.js';
import { Renderer } from './ui/renderer.js';
import { initActivityLog } from './ui/activity-log.js';
import { initFooter } from './ui/footer.js';
import { initPopupStack } from './ui/popup-stack.js';
import { initScrollReveal } from './ui/reveal.js';
import { initCultivationPanel } from './ui/cultivation-panel.js';
import { initSettingsPanel } from './ui/settings-panel.js';
import { initUpgradesPanel } from './ui/upgrades-panel.js';
import { initTechniquesPanel } from './ui/techniques-panel.js';
import { initTabs } from './ui/tabs.js';
import { initInventoryPanel } from './ui/inventory-panel.js';

/**
 * Small boot orchestrator.
 * Each future system (audio, input, network) can be added to this list
 * and awaited before the game UI is revealed.
 */
async function bootstrap() {
  const statusText = document.getElementById('status-text');

  const setStatus = (message) => {
    if (statusText) statusText.textContent = message;
  };

  setStatus('Loading…');

  // Presentation-layer wiring (scroll reveal, footer year, etc.).
  initScrollReveal();
  initFooter();

  try {
    // Load central game config (rates, starting values, tuning).
    const config = await loadConfig();
    if (!config) {
      throw new Error('game-config.json failed to load.');
    }

    // Load content definitions (realms, techniques, pills, ...) from data/.
    const dataManager = new DataManager({ eventBus: EventBus });
    await dataManager.loadAll();

    // Instantiate the core game object.
    const game = new Game(config);

    // Offline progress: simulates production for the time spent away. It
    // owns the state.meta.lastSeenAt timestamp — stamped on every save
    // (below) and measured right after a save is restored (later), before
    // the game loop starts (per the startup sequence in PLANS.md).
    const offlineProgress = new OfflineProgress({
      config,
      eventBus: EventBus,
    });

    // Persistence: restore any previous save, then autosave. Per the
    // startup sequence the save loads before the game loop starts. The
    // serialize hook stamps the last-seen timestamp first so every save
    // carries the reference point the next boot measures offline time from.
    const manifest = dataManager.getManifest();
    const saveManager = new SaveManager({
      eventBus: EventBus,
      storage: Storage,
      serialize: () => {
        offlineProgress.stamp();
        return game.serialize();
      },
      restore: (state) => game.restore(state),
      engineVersion: (config.meta && config.meta.version) || '0.0.0',
      contentVersion: (manifest && manifest.version) || 0,
      autosaveIntervalMs: (config.save && config.save.autosaveIntervalMs) || 0,
      saveOnUnload: config.save ? config.save.saveOnUnload !== false : true,
    });

    // Renderer: scan and cache DOM bindings, subscribe to refresh events,
    // and render the current state (per the startup sequence: renderer
    // initializes → initial render → save loads → loop starts). The number
    // notation formatter reads config.notation (data-driven styles) and the
    // restored settings.notationStyle override (if any) and is injected so
    // every numeric binding formats through it ("1.5K" instead of "1,500").
    const notation = new NotationFormatter({
      config: config.notation || {},
    });
    const renderer = new Renderer({ notation });
    renderer.init();

    // Tab navigation: find tab buttons and panels, set up click delegation.
    // Initialized BEFORE any panel initializers so the DOM structure is
    // already wired when they query their selectors and the initial tab
    // (cultivation) is the only visible panel from the start.
    const tabHandle = initTabs({ initialTab: 'cultivation' });

    const restored = saveManager.load();

    // Simulate the time spent away since the last save, then persist the
    // gains immediately. The serialize hook stamps the reference timestamp
    // to now, so a crash before the next autosave can neither lose the gains
    // nor re-simulate the same away-period on the next boot. The gains are
    // then reflected in the DOM right away (the next loop:uiRefresh would do
    // it anyway, but the state changed before the loop started).
    const offlineSummary = offlineProgress.apply({ now: Date.now() });
    if (offlineSummary.applied) {
      saveManager.save();
      renderer.refresh();
    }

    // Meditation: first Phase-2 gameplay system — owns the meditation
    // session and its qi rate-contribution slot (cultivation.qiSources.
    // meditation). Constructed AFTER the save restore and offline-progress
    // apply (so it starts from the restored active flag and the away-gains
    // are already in state) and BEFORE the game loop starts (so the very
    // first tick finds it subscribed). It reads its per-second rate from
    // config.meditation (data-driven, placeholder balancing).
    const meditation = new MeditationSystem({
      config,
      eventBus: EventBus,
    });

    // Realms: single owner of the realm ladder and its applied effects
    // (data/realms/realms.json via the DataManager). Constructed AFTER the
    // save restore + offline apply (so it resolves the restored realm and
    // writes the canonical identity + effect slots into state) and
    // IMMEDIATELY BEFORE the QiSystem — the realm's qiMaxMultiplier and
    // cultivationSpeedMultiplier must already be in cultivation.realmEffects
    // when QiSystem's constructor syncs the cap and rate, or the realm
    // factor would be missing from the first sync (the next realm:changed
    // would pick it up, but boot should be right on the first tick).
    const realms = new RealmSystem({
      eventBus: EventBus,
      dataManager,
      config,
    });

    // Qi: single owner of the qi resource. Constructed AFTER the meditation
    // system so the contribution slot already exists when this constructor
    // syncs the aggregate rate (a restored session shows the right cap/rate
    // before the first tick), and AFTER the RealmSystem so the realm effect
    // multipliers are already in state for the cap/rate sync. Every qi source
    // is declared in config.qi.sources (ratePath = that source's own state
    // slot); this system owns the resource math — aggregation, cap clamping,
    // statistics and 'qi:gained'.
    const qi = new QiSystem({
      config,
      eventBus: EventBus,
    });

    // Statistics: single owner of state.statistics.playtimeMs and the read-
    // only query API for the four lifetime counters (playtimeMs,
    // meditationsCompleted, breakthroughsTotal, qiGenerated). The other
    // three counters stay where they are written today (meditationsCompleted
    // in MeditationSystem.stop, qiGenerated in QiSystem._onUpdate,
    // breakthroughsTotal in the future BreakthroughSystem) — the system only
    // READS them for its snapshot/snapshot-equality emit, so adding a new
    // writer never requires touching this system. Constructed AFTER qi so
    // the same 'loop:update' subscription order is meditation → qi →
    // statistics, and BEFORE game.start() so the very first tick finds it
    // subscribed.
    const statistics = new StatisticsSystem({
      eventBus: EventBus,
    });

    // Resources: single owner of the wallet resources (spirit stones, herbs,
    // jade, qi-condensation pills). Constructed AFTER the save restore and
    // offline apply so it starts from the restored balances. It reads its
    // managed resources from config.resources (data-driven, placeholder
    // balancing) and exposes the wallet primitives (get/canAfford/add/spend)
    // that future producers and consumers call; it has no loop subscription —
    // per-second resource production arrives with the first resource producer.
    const resources = new ResourceSystem({
      config,
      eventBus: EventBus,
    });

    // Inventory: single owner of the carried item stacks (state.inventory.
    // items — each stack is { id, count } and occupies one slot) and the slot
    // accounting (slots.used = number of distinct stacks). Constructed AFTER
    // the save restore and offline apply so it starts from the restored
    // stacks, and AFTER the DataManager load so item definitions resolve via
    // dataManager.get('items', id) (stackSize etc. — never hardcoded). It has
    // no loop subscription — items arrive by calling add() and leave by
    // calling remove(); the full Phase-4 inventory (filter/sort/search) reads
    // the same stacks.
    const inventory = new InventorySystem({
      config,
      eventBus: EventBus,
      dataManager,
    });

    // Upgrades: single owner of the purchasable boosts. Reads the catalog
    // from dataManager.getAll('upgrades') (data/upgrades/upgrades.json via
    // data/manifest.json — id, name, description, category, costResource,
    // baseCost, costGrowth, effectPerLevel, optional maxLevel) and writes
    // state.upgrades.purchased[id] on every level bought, plus the aggregate
    // cultivation.qiSources.upgrades slot the QiSystem reads through
    // config.qi.sources. Cost deduction is delegated to ResourceSystem.spend
    // (the wallet — no system writes state.resources directly). Constructed
    // AFTER save restore + offline apply so a restored purchased map flows
    // straight into the seed, and AFTER ResourceSystem + DataManager so the
    // catalog is available and the wallet accepts the spend. It has no
    // loop subscription — upgrades arrive by calling purchase() (UI click or
    // future automation), and the aggregate flows into qi on the next tick.
    const upgrades = new UpgradeSystem({
      config,
      eventBus: EventBus,
      state: game.state,
      dataManager,
      resourceSystem: resources,
    });
    initUpgradesPanel({
      eventBus: EventBus,
      upgrades,
      notation,
    });

    // Techniques: single owner of the P5 idle-style technique generators.
    // Reads the catalog from dataManager.getAll('techniques')
    // (data/techniques/techniques.json via data/manifest.json — id, name,
    // baseCost, costMultiplier, baseRevenue, revenuePerLevel, cooldownMs,
    // milestones, proficiency) and writes state.techniques.owned[id] plus
    // cultivation.qiSources.techniques (the aggregate qi/s rate the QiSystem
    // picks up through config.qi.sources). Cost deduction goes through
    // ResourceSystem.spend('spiritStones', ...) — never writes the wallet
    // directly. Constructed AFTER save restore + offline apply (a restored
    // owned map seeds the tick state), AFTER ResourceSystem + DataManager
    // (the catalog and wallet are available), and BEFORE game.start() so the
    // first tick finds its 'loop:update' subscription active.
    const techniques = new TechniqueSystem({
      config,
      eventBus: EventBus,
      state: game.state,
      dataManager,
      resourceSystem: resources,
    });
    initTechniquesPanel({
      eventBus: EventBus,
      techniqueSystem: techniques,
      formatter: notation,
    });

    // NotificationManager: the queue-based notification service. Tuning
    // (queue cap, type whitelist) comes from config.notifications and is
    // already validated by tests/data/game-config.test.mjs — never hardcode.
    // Constructed AFTER the save restore and offline apply so future
    // post-boot systems (achievements, sect events, ...) can announce gains
    // through the same queue once they land; today's bootstrap does not push
    // any notification itself (initial state is an empty queue). The
    // activity-log UI subscribes to 'notification:changed' and re-renders on
    // every add/dismiss/clear, so the very first real notification will light
    // up the existing #activity-log panel automatically. No DOM access, no
    // GameState mutation, no loop subscription — pure manager service (same
    // shape as SaveManager, js/managers/save-manager.js).
    const notifications = new NotificationManager({
      config,
      eventBus: EventBus,
    });
    initActivityLog({ eventBus: EventBus, notifications });

    // Popup stack: the visual half of the P2 Event Popup & Log Pipeline.
    // Listens on the SAME 'notification:changed' event as the activity log
    // and surfaces entries whose `popup: true` flag is set as transient
    // top-right toasts (slide in, auto-dismiss after
    // config.notifications.popupDurationMs, click to dismiss immediately,
    // capped at config.notifications.popupMaxVisible). Constructed AFTER
    // NotificationManager (it needs the queue) and AFTER the activity log
    // (same bus event — order doesn't matter because both listeners are
    // independent and EventBus dispatches synchronously to all of them).
    // Passes `config` so it can read the popup tunables defensively
    // (missing block → shipped defaults; present-but-invalid → warn once).
    // The handle is exposed as window.__popupStack for debugging.
    const popupStack = initPopupStack({
      eventBus: EventBus,
      notifications,
      config,
    });

    // Realm-breakthrough → notification. The BreakthroughSystem already
    // emits 'realm:breakthrough' on every accepted attempt (successes and
    // failures); we translate that single stream into one popup + log entry
    // here so gameplay systems stay free of notification concerns. The
    // outcome strings are the canonical ids defined in
    // js/systems/breakthroughs.js (SUCCESS_OUTCOMES / FAILURE_OUTCOMES).
    // Subscribed BEFORE game.start() so the very first breakthrough (a
    // fast-forward playtest lands one within the first second) is captured.
    EventBus.subscribe('realm:breakthrough', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const realmName =
        typeof payload.realmName === 'string' && payload.realmName !== ''
          ? payload.realmName
          : 'a new realm';
      const outcome = typeof payload.outcome === 'string' ? payload.outcome : '';
      const SUCCESS_OUTCOMES = new Set([
        'perfect',
        'great-success',
        'success',
        'barely-successful',
      ]);
      if (SUCCESS_OUTCOMES.has(outcome)) {
        notifications.add(`Breakthrough to ${realmName}!`, {
          type: 'achievement',
          popup: true,
        });
      } else {
        notifications.add(`Breakthrough failed — you remain at ${realmName}.`, {
          type: 'warning',
          popup: true,
        });
      }
    });

    // Tribulation → notification. The TribulationSystem already emits
    // 'tribulation:finished' on every accepted face(); we translate that
    // single stream into one popup + log entry here. Subscribed BEFORE
    // game.start() for the same reason as realm:breakthrough above.
    EventBus.subscribe('tribulation:finished', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const type =
        typeof payload.type === 'string' && payload.type !== '' ? payload.type : 'tribulation';
      const survived = payload.survived === true;
      if (survived) {
        notifications.add(`Tribulation survived — ${type}.`, {
          type: 'achievement',
          popup: true,
        });
      } else {
        notifications.add(`The ${type} tribulation overwhelms you.`, {
          type: 'error',
          popup: true,
        });
      }
    });

    // Settings panel: wires the three boolean switches (offlineProgress,
    // sound, notifications), the notation-style <select> and the
    // destructive Reset save button inside the Settings game panel. The
    // renderer is read-only state→DOM and does NOT touch interactions, so
    // this dedicated initializer owns every click/change event. It's
    // constructed AFTER the renderer init() (so the panel is in the DOM
    // and the renderer's initial flush has already painted the switch
    // states from the restored/fresh settings) and AFTER the notation
    // formatter is built (so applyNotationStyle can delegate to
    // notation.setStyle, which owns the whitelist). The notifications
    // manager is now wired in so the destructive reset can post a
    // 'success' notification (P1 #1, forward-compatible with the P2
    // pipeline) — the constructor must therefore run AFTER
    // NotificationManager is created. The handle exposes apply* methods
    // for tests and stays intact for the lifetime of the page; its
    // destroy() is the future shutdown hook.
    const settingsPanel = initSettingsPanel({
      eventBus: EventBus,
      state: game.state,
      notation,
      saveManager,
      config,
      notifications,
    });

    // Breakthroughs: single owner of realm breakthrough attempts
    // (requirements, results, bottlenecks — data/breakthroughs/
    // breakthroughs.json via the DataManager, one entry per realm id).
    // Constructed AFTER realms, qi, resources and inventory (it advances the
    // ladder through RealmSystem.setRealm(), spends the entry's cost through
    // ResourceSystem.spend and removes bottleneck items through
    // InventorySystem.remove — no system writes another system's state
    // directly) and BEFORE game.start() so the very first tick finds its
    // 'loop:update' subscription. The subscription order (qi before
    // breakthroughs) is deliberate: on every tick the QiSystem writes
    // cultivation.qiPerSecond first and this system's accrual reads it. It
    // owns cultivation.realmProgress / realmProgressMax / breakthroughCost
    // and emits 'realm:breakthrough' on every accepted attempt.
    const breakthroughs = new BreakthroughSystem({
      config,
      eventBus: EventBus,
      realmSystem: realms,
      resourceSystem: resources,
      inventorySystem: inventory,
      dataManager,
    });

    // Tribulations: single owner of the tribulation gate on the current
    // realm's breakthrough (data/tribulations/tribulations.json via the
    // DataManager — type + weighted outcome table per realm id). Constructed
    // AFTER the BreakthroughSystem (its boot sync reads the realm the
    // RealmSystem already resolved, and the gate it writes is what the
    // BreakthroughSystem reads through the shared state.tribulations slice)
    // and BEFORE game.start() so the very first 'realm:changed' (a
    // breakthrough success or a manual setRealm) opens/closes the gate from
    // the first tick. It has NO loop subscription — tribulations only change
    // through realm changes and the player's face().
    const tribulations = new TribulationSystem({
      eventBus: EventBus,
      realmSystem: realms,
      dataManager,
    });

    // Spirit Roots: single owner of the cultivator's spirit root and its
    // cultivation-speed slot (data/spirit-roots/spirit-roots.json via the
    // DataManager — the canonical 10-type ladder, weighted Spirit Root Roll
    // per DESIGN.md Character Generation step 4). Constructed AFTER the
    // DataManager load (the ladder must resolve) and AFTER the QiSystem and
    // the TribulationSystem: the constructor sync writes
    // cultivation.spiritRootMultiplier from the restored root's
    // speedMultiplier, and the QiSystem stacks that slot into the
    // per-second rate from the first tick. It has NO loop subscription —
    // the spirit root only changes through roll() (the future character-gen
    // flow, the console and tests), never on a tick.
    const spiritRoots = new SpiritRootSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Meridians: single owner of the cultivator's meridian state and its
    // qi-circulation multiplier slots (data/meridians/meridians.json via the
    // DataManager — the canonical 7-state ladder Broken → Heavenly).
    // Constructed AFTER the DataManager load (the ladder must resolve) and
    // AFTER the QiSystem: the constructor sync writes
    // cultivation.meridianCapacityMultiplier and
    // cultivation.meridianFlowMultiplier from the restored meridian's
    // factors, and the QiSystem stacks both slots into the cap and
    // per-second rate from the first tick. It has NO loop subscription —
    // meridians only change through setState() (the future character-gen
    // flow, the console and tests), never on a tick.
    const meridians = new MeridianSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Physiques: single owner of the cultivator's physique and its
    // breakthrough-success bonus slot (data/physiques/physiques.json via the
    // DataManager — the canonical 6-state ladder Ordinary → Chaos).
    // Constructed AFTER the DataManager load (the ladder must resolve) and
    // AFTER the BreakthroughSystem: the constructor sync writes
    // cultivation.physiqueBreakthroughBonus from the restored physique's
    // bonus, and the BreakthroughSystem stacks that slot into the outcome
    // roll. It has NO loop subscription — physiques only change through
    // setPhysique() (the future character-gen flow, the console and tests),
    // never on a tick.
    const physiques = new PhysiqueSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Dantian: single owner of the cultivator's dantian and its qi-storage
    // multiplier slots (data/dantian/dantian.json via the DataManager — the
    // canonical 8-state ladder Cracked → Void). Constructed AFTER the
    // DataManager load (the ladder must resolve) and AFTER the QiSystem: the
    // constructor sync writes cultivation.dantianCapacityMultiplier (plus the
    // three future-consumer slots) from the restored dantian's factors, and
    // the QiSystem stacks the capacity multiplier into the qi cap alongside
    // the meridian and realm factors. It has NO loop subscription — dantian
    // only changes through setDantian() (the future character-gen flow, the
    // console and tests), never on a tick.
    const dantian = new DantianSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Bloodline: single owner of the cultivator's bloodline and its
    // cultivation-speed + qi-cap multiplier slots (data/bloodlines/
    // bloodlines.json via the DataManager — the canonical 8-state ladder
    // Ancient Human → Chaos Blood). Constructed AFTER the DataManager load
    // (the ladder must resolve) and AFTER the QiSystem: the constructor sync
    // writes cultivation.bloodlineSpeedMultiplier and
    // cultivation.bloodlineQiMaxMultiplier from the restored bloodline's
    // factors, and the QiSystem stacks both slots into the rate aggregate
    // and the qi cap from the first tick. It has NO loop subscription —
    // bloodlines only change through setBloodline() (the future character-gen
    // flow, the console and tests), never on a tick.
    const bloodlines = new BloodlineSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Soul: single owner of the cultivator's soul and its four
    // future-consumer multiplier slots (data/soul/soul.json via the
    // DataManager — the canonical 7-state ladder Shattered → Chaos Soul).
    // Constructed AFTER the DataManager load (the ladder must resolve): the
    // constructor sync writes cultivation.soulStabilityMultiplier /
    // cultivation.soulPurityMultiplier / cultivation.soulWillpowerMultiplier /
    // cultivation.soulComprehensionMultiplier from the restored soul's
    // factors. NO system reads those slots yet (DESIGN.md "Soul affects
    // enlightenment"; the Dao/technique-efficiency consumers land later) —
    // qi.js is deliberately untouched, unlike bloodlines. It has NO loop
    // subscription — souls only change through setSoul() (the future
    // character-gen flow, the console and tests), never on a tick.
    const soul = new SoulSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Talent: single owner of the cultivator's talent and its future-consumer
    // learning-speed slot (data/talents/talents.json via the DataManager —
    // the canonical 7-state ladder Dull → Prodigy). Constructed AFTER the
    // DataManager load (the ladder must resolve): the constructor sync writes
    // cultivation.talentLearningSpeedMultiplier from the restored talent's
    // learningSpeedMultiplier. NO system reads that slot yet (DESIGN.md
    // "Talent affects learning"; the technique/alchemy/formation/Dao
    // consumers land later) — qi.js, techniques.js and breakthroughs.js are
    // deliberately untouched, unlike bloodlines. It has NO loop subscription —
    // talents only change through setTalent() (the future character-gen flow,
    // the console and tests), never on a tick.
    const talents = new TalentSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Comprehension: single owner of the cultivator's comprehension and its
    // three future-consumer multiplier slots (data/comprehension/
    // comprehension.json via the DataManager — the canonical 7-state ladder
    // Shallow → Dao Heart). Constructed AFTER the DataManager load (the
    // ladder must resolve): the constructor sync writes
    // cultivation.comprehensionDaoProgressMultiplier /
    // cultivation.comprehensionTechniqueEfficiencyMultiplier /
    // cultivation.comprehensionBreakthroughEfficiencyMultiplier from the
    // restored comprehension's factors. NO system reads those slots yet
    // (DESIGN.md "Comprehension allows faster Dao progress, better technique
    // efficiency, reduced breakthrough requirements"; the Dao/technique-
    // efficiency consumers land later) — qi.js, techniques.js and
    // breakthroughs.js are deliberately untouched. It has NO loop
    // subscription — comprehension only changes through setComprehension()
    // (the future character-gen flow, the console and tests), never on a tick.
    const comprehension = new ComprehensionSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Destiny: single owner of the cultivator's destiny and its two
    // future-consumer multiplier slots (data/destiny/destiny.json via the
    // DataManager — the canonical 7-state ladder Doomed → Son of Heaven).
    // Constructed AFTER the DataManager load (the ladder must resolve): the
    // constructor sync writes cultivation.destinyFortuneMultiplier /
    // cultivation.destinyCalamityMultiplier from the restored destiny's
    // factors. NO system reads those slots yet (DESIGN.md "Destiny affects
    // the world"; the encounter/calamity consumers land later) — qi.js,
    // techniques.js and breakthroughs.js are deliberately untouched. It has
    // NO loop subscription — destiny only changes through setDestiny() (the
    // future character-gen flow, the console and tests), never on a tick.
    const destiny = new DestinySystem({
      eventBus: EventBus,
      dataManager,
    });

    // Luck: single owner of the cultivator's luck and its two future-consumer
    // multiplier slots (data/luck/luck.json via the DataManager — the
    // canonical 7-state ladder Jinxed → Fortune's Darling). Constructed AFTER
    // the DataManager load (the ladder must resolve): the constructor sync
    // writes cultivation.luckCraftingMultiplier / cultivation.luckDropMultiplier
    // from the restored luck's factors. NO system reads those slots yet
    // (DESIGN.md "Luck affects events"; the crafting/drop/secret-realm
    // consumers land later) — qi.js, techniques.js and breakthroughs.js are
    // deliberately untouched. It has NO loop subscription — luck only changes
    // through setLuck() (the future character-gen flow, the console and
    // tests), never on a tick.
    const luck = new LuckSystem({
      eventBus: EventBus,
      dataManager,
    });

    // Cultivation panel: the Phase-3 play-test surface — the human player's
    // Breakthrough / Face Tribulation buttons plus the character readout.
    // The "Cultivation Realm" panel shows the realm/progress/cost bindings
    // read-only; THIS panel is where the loop is actually driven, through the
    // injected system primitives (breakthroughs.attempt() /
    // tribulations.face()) — the panel never mutates state directly.
    // Constructed AFTER the Breakthrough, Tribulation and Spirit Root systems
    // (it only consumes their public APIs — requirements()/attempt()/face() —
    // and the SpiritRootSystem is the writer of player.spiritRoot) and BEFORE
    // game.start() so the very first tick finds it subscribed to
    // 'loop:uiRefresh' (the Breakthrough button's enabled state follows
    // accrued realm progress live).
    const cultivationPanel = initCultivationPanel({
      eventBus: EventBus,
      state: game.state,
      breakthroughs,
      tribulations,
      notation,
      realms,
    });

    // Inventory panel: renders the carried item stacks as a box grid with
    // pagination in the Inventory tab. Wired to the real InventorySystem and
    // DataManager — the panel reads state only through the injected systems.
    // Subscribes to 'inventory:changed' and 'ui:refresh' for live re-renders.
    // Initialized AFTER the InventorySystem and DataManager are built and
    // BEFORE game.start() so the first tick's 'ui:refresh' reaches a
    // subscribed listener.
    const inventoryPanel = initInventoryPanel({
      inventorySystem: inventory,
      dataManager,
      eventBus: EventBus,
    });

    // Master's parting gift: on a FRESH game (no save to restore), narrate
    // the origin endowment that matches state.resources.spiritStones === 50
    // (the only spirit-stone source until Phase 5 introduces sects + stipends).
    // The notification is fire-once-per-game: a restored save has already
    // heard the story on its original boot. Capture-once is a soft guarantee
    // — a hostile restored save without the queued notification still gets
    // its 50 stones (the gift is in state, not the queue). `popup: true`
    // surfaces it as a transient top-right toast (the popup-stack UI,
    // js/ui/popup-stack.js, reads the flag off the emitted payload).
    if (!restored) {
      notifications.add(
        'Your shifu gave you his last pouch before setting off on his final tribulation. 50 spirit stones — spend them wisely.',
        { type: 'info', popup: true }
      );
    }

    // Start the simulation loop, then begin autosave.
    game.start();
    saveManager.start();
    if (restored) {
      setStatus('Save found — resuming…');
    }

    // Expose the game instances for debugging.
    window.__game = game;
    window.__dataManager = dataManager;
    window.__saveManager = saveManager;
    window.__renderer = renderer;
    window.__offlineProgress = offlineProgress;
    window.__meditation = meditation;
    window.__realms = realms;
    window.__qi = qi;
    window.__resources = resources;
    window.__inventory = inventory;
    window.__statistics = statistics;
    window.__notation = notation;
    window.__notifications = notifications;
    window.__popupStack = popupStack;
    window.__settingsPanel = settingsPanel;
    window.__upgrades = upgrades;
    window.__techniques = techniques;
    window.__breakthroughs = breakthroughs;
    window.__tribulations = tribulations;
    window.__spiritRoots = spiritRoots;
    window.__meridians = meridians;
    window.__physiques = physiques;
    window.__dantian = dantian;
    window.__bloodlines = bloodlines;
    window.__soul = soul;
    window.__talents = talents;
    window.__comprehension = comprehension;
    window.__destiny = destiny;
    window.__luck = luck;
    window.__cultivationPanel = cultivationPanel;
    window.__inventoryPanel = inventoryPanel;

    const offlineNote =
      restored && offlineSummary.applied && hasGains(offlineSummary)
        ? ` ${formatOfflineSummary(offlineSummary)}`
        : '';

    setStatus(
      `Scaffold ready — ${dataManager.totalDefinitions()} definitions loaded. Game loop running.` +
        (restored ? ' Save restored.' : '') +
        offlineNote
    );
  } catch (error) {
    console.error('Bootstrap failed:', error);
    setStatus('Failed to load. See console for details.');
  }
}

/**
 * Whether an offline summary produced any actual gains (amount > 0 for at
 * least one producer). Gates the status-bar note so a restored session that
 * produced nothing (e.g. before any per-second system exists) stays silent.
 *
 * @param {object} summary — the summary returned by OfflineProgress.apply().
 * @returns {boolean} true when at least one producer gained resources.
 */
function hasGains(summary) {
  return summary.producers.some((producer) => producer.amount > 0);
}

/**
 * Human-readable one-line summary of an offline-progress result for the
 * status bar, e.g. "Offline gains: 8h (Qi: +28800)".
 *
 * @param {object} summary — the summary returned by OfflineProgress.apply().
 * @returns {string} the formatted gains line.
 */
function formatOfflineSummary(summary) {
  const gains = summary.producers
    .filter((producer) => producer.amount > 0)
    .map((producer) => `${producer.label}: +${producer.amount}`);
  return `Offline gains: ${formatDuration(summary.effectiveMs)} (${gains.join(', ')})`;
}

/**
 * Compact duration formatting for the status bar: "8h", "2h 15m", "45m",
 * "30s". Follows the bootstrap's plain-English convention; localization is a
 * later phase (see DESIGN.md).
 *
 * @param {number} ms — duration in milliseconds.
 * @returns {string} the formatted duration.
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

document.addEventListener('DOMContentLoaded', bootstrap);
