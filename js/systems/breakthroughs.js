/**
 * systems/breakthroughs.js — BreakthroughSystem (single owner of realm
 * breakthroughs: requirements, results, bottlenecks).
 *
 * The Phase-3 breakthrough system. Every fixed simulation tick
 * ('loop:update') the system accrues cultivation.realmProgress from the
 * canonical per-second qi rate (cultivation.qiPerSecond, written by the
 * QiSystem) × config.breakthroughs.progressRate, clamped to the current
 * realm's data-driven requiredProgress (realmProgressMax). A player calls
 * attempt() to roll the current realm's weighted outcome table
 * (data/breakthroughs/breakthroughs.json via the DataManager — one entry
 * per realm id, nothing hardcoded): a SUCCESS outcome (perfect,
 * great-success, success, barely-successful) advances the ladder one tier
 * through RealmSystem.setRealm(), resets progress, and increments
 * statistics.breakthroughsTotal; a FAILURE outcome (failure, heavy-failure,
 * qi-deviation) subtracts progressLoss × realmProgressMax (never below 0)
 * and leaves the realm unchanged. Requirements gate the attempt: progress
 * met and (when the current realm imposes one) the tribulation survived —
 * in that order (progress → tribulation). The tribulation gate is read from
 * the SHARED state.tribulations slice, which the TribulationSystem
 * (js/systems/tribulations.js) owns and writes on every realm change and
 * face() — this system only READS it (via the _tribulationGate helper), so
 * a realm that imposes a pending tribulation blocks attempt() with reason
 * 'tribulation' until the player faces and survives it. Old saves without
 * the slice degrade to gate-open.
 *
 * The stone cost and item bottleneck are INFORMATIONAL ONLY (P1 playtest
 * quick fix — user decision 2026-08-11): they no longer gate the attempt
 * and nothing is spent or consumed on success. The data fields, the
 * coercion paths, the requirements() shape (cost / costMet / bottleneck /
 * bottleneckMet) and the injected ResourceSystem / InventorySystem reads
 * all stay intact for reuse — the item (bottleneck) gates return when the
 * Phase-4 item sources land. This system never writes state.resources or
 * state.inventory directly (same dependency-injection pattern as
 * UpgradeSystem receiving resourceSystem: no direct System→System imports).
 *
 * Data-driven content: the breakthrough table (realmId, requiredProgress,
 * cost, bottleneck, results) comes from dataManager.getAll('breakthroughs')
 * (data/breakthroughs/breakthroughs.json via data/manifest.json). File order
 * is tier order. A MISSING 'breakthroughs' collection degrades neutrally:
 * count 0, no state writes, attempt() rejects 'no-definition' (warned once);
 * a realm without an entry gets the fallback requiredProgress (1000), a null
 * cost (the renderer renders null as "—") and rejects 'no-definition'.
 *
 * State owned (writes): cultivation.realmProgress, cultivation.realmProgressMax,
 * cultivation.breakthroughCost, statistics.breakthroughsTotal. The max and
 * cost are SYNCED from the CURRENT realm's entry on construction (boot) and
 * after every accepted attempt; breakthroughCost is the entry's
 * cost.spiritStones (null when no entry). The sync is KEPT even though the
 * cost is informational-only (P1) — the renderer/state field contract is
 * unchanged. The tribulation gate is NOT owned
 * here — state.tribulations is read-only for this system (the
 * TribulationSystem writes it; a missing slice degrades to gate-open). All
 * paths are part of the canonical GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the cultivation/statistics slices
 * are repaired to the canonical fresh shapes when unusable (null, a
 * primitive or an array) before ANY read or write — a broken slice must
 * never abort boot or throw per tick. Definition coercion is defensive
 * (applied on every read, never mutating the deep-frozen cache):
 * requiredProgress → positive finite (fallback 1000); cost → finite >= 0
 * per id (missing spiritStones defaults 0); bottleneck entries → { id
 * non-empty string, count finite > 0 } (the rest are dropped); results →
 * non-empty { outcome canonical, weight finite > 0, progressLoss finite
 * 0..1 } (progressLoss defaults to 0 when absent — success outcomes do not
 * declare it — and present out-of-range values clamp into 0..1, so a
 * hostile value can never GAIN progress); a results table left empty falls
 * back to the default [{success 70},{failure 30}]. Every state read goes
 * through a fail-safe _asNumber / positive fallback so a malformed value can
 * never poison the math (a negative realmProgress reads as 0; a non-positive
 * realmProgressMax reads as 1000).
 *
 * Event contract (all emitted on the injected eventBus; consumed:
 * 'loop:update'):
 *   loop:update      { deltaMs, elapsedMs, tick } — subscribed in the
 *                     constructor; the fixed-timestep simulation pulse that
 *                     drives realm-progress accrual (reads the qiPerSecond
 *                     the QiSystem wrote earlier in the same tick — the
 *                     main.js construction order keeps the subscription
 *                     order stable).
 *   realm:breakthrough { realmId, realmName, tier, outcome, advanced,
 *                     nextRealm } — fired on EVERY accepted attempt (never on
 *                     a blocked one). On a success the identity is the NEW
 *                     realm (where the cultivator landed) and nextRealm the
 *                     following tier's id (null at the top); on a failure the
 *                     identity is the unchanged current realm. RealmSystem's
 *                     own 'realm:changed' fires on success too — it is never
 *                     suppressed or duplicated.
 *
 * Pure gameplay — no DOM access, no storage I/O, framework-free and GitHub
 * Pages compatible. Systems communicate through the EventBus only; this
 * module depends solely on the shared GameState and EventBus singletons
 * (both injectable for deterministic tests) plus the injected RealmSystem /
 * ResourceSystem / InventorySystem / DataManager / random source.
 *
 * Future expansion (see DESIGN.md/PLANS.md): combined tribulations (a realm
 * imposing several types at once), physiques and spirit roots stack
 * additional requirement gates and success modifiers into the entry
 * coercion + roll; bottleneck items become real drops AND rejoin the gates
 * once the Phase-4 item producers land (the informational fields already
 * keep the data paths warm); death (DESIGN.md 'future optional') adds a new
 * canonical outcome + a consequence branch in attempt().
 */

import { EventBus } from '../core/event-bus.js';
import { GameState } from '../core/game-state.js';

/** The canonical outcome ids (DESIGN.md 'Breakthroughs'; death is v1-excluded). */
const SUCCESS_OUTCOMES = new Set([
  'perfect',
  'great-success',
  'success',
  'barely-successful',
]);

/** The canonical failure outcome ids (each carries a progressLoss). */
const FAILURE_OUTCOMES = new Set(['failure', 'heavy-failure', 'qi-deviation']);

/** Every canonical outcome id. */
const CANONICAL_OUTCOMES = new Set([...SUCCESS_OUTCOMES, ...FAILURE_OUTCOMES]);

/** Fallback required progress when an entry (or a usable value) is missing. */
const FALLBACK_PROGRESS = 1000;

/** Default result table when an entry carries no usable results. */
const DEFAULT_RESULTS = [
  { outcome: 'success', weight: 70, progressLoss: 0 },
  { outcome: 'failure', weight: 30, progressLoss: 0 },
];

export class BreakthroughSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as QiSystem, RealmSystem,
   *        UpgradeSystem, OfflineProgress, GameLoop and Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {object} [options.config] — parsed contents of data/game-config.json;
   *        the `breakthroughs` block is read for progressRate. A missing
   *        block is silent (rate 1); a present but invalid progressRate
   *        warns once and falls back to 1.
   * @param {object|null} [options.realmSystem=null] — RealmSystem (or a
   *        lookalike with current()/next()/isMaxRealm/setRealm()) owning the
   *        realm ladder. When absent the current realm cannot resolve and
   *        attempt() rejects 'no-definition' (nothing is hardcoded).
   * @param {object|null} [options.resourceSystem=null] — ResourceSystem (or a
   *        lookalike with canAfford(id, amount)) owning the wallet. Read for
   *        the INFORMATIONAL costMet reporting in requirements() only (P1 —
   *        cost no longer gates); the system NEVER spends or writes
   *        state.resources directly.
   * @param {object|null} [options.inventorySystem=null] — InventorySystem (or
   *        a lookalike with has(id, amount)) owning the carried stacks. Read
   *        for the INFORMATIONAL bottleneckMet reporting in requirements()
   *        only (P1 — bottlenecks no longer gate until the Phase-4 item
   *        sources land); the system NEVER removes or writes
   *        state.inventory directly.
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the breakthrough
   *        tables from the 'breakthroughs' collection. When absent the table
   *        is empty — count 0, no state writes, attempt() rejects
   *        'no-definition'. Content is never hardcoded.
   * @param {() => number} [options.random] — uniform [0,1) source for the
   *        weighted outcome roll; defaults to Math.random (injectable for
   *        deterministic tests).
   */
  constructor(options = {}) {
    const breakthroughs = (options.config && options.config.breakthroughs) || {};

    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} realm ladder owner (current/next/setRealm). */
    this._realmSystem = options.realmSystem || null;
    /** @type {object|null} wallet owner (spend/canAfford). */
    this._resourceSystem = options.resourceSystem || null;
    /** @type {object|null} inventory owner (remove/has). */
    this._inventorySystem = options.inventorySystem || null;
    /** @type {object|null} definition resolver ('breakthroughs' collection). */
    this._dataManager = options.dataManager || null;
    /** @type {() => number} uniform [0,1) source for the weighted roll. */
    this._random = typeof options.random === 'function' ? options.random : Math.random;
    /** @type {number} realm-progress accrual multiplier (data-driven). */
    this._progressRate = _readPositiveNumber(
      breakthroughs.progressRate,
      1,
      'progressRate'
    );

    /** @type {boolean} 'no-definition' warn-once latch. */
    this._warnedNoDefinition = false;

    // Bound once so subscribe/unsubscribe always see the same function
    // identity (same pattern as QiSystem._onUpdate and GameLoop).
    this._onUpdate = this._onUpdate.bind(this);
    // Ordering assumption (main.js boot): the QiSystem is constructed first,
    // so its per-second rate write runs before this system's accrual on the
    // same tick; the accrual reads a rate that only changes synchronously
    // (meditation start/stop, upgrade purchases), so the order is stable —
    // a future reordering must keep qi's write ahead of this system's read.
    this._eventBus.subscribe('loop:update', this._onUpdate);

    // Restore-trust: a malformed cultivation/statistics slice (null, a
    // primitive or an array) restored from an attacker-shaped save must
    // never abort boot — repair both before any read/write below.
    this._ensureSlices();

    // Snapshot the breakthrough tables at construction time (file order =
    // tier order). Cached definitions are deep-frozen by the DataManager;
    // the array itself stays a reference snapshot for lookup performance.
    this._definitions = this._readDefinitions();

    /** @type {Map<string, object>} realmId → definition (O(1) lookup). */
    this._byRealm = new Map();
    this._buildIndexes();

    // Sync the current realm's max + cost into state (boot — the renderer's
    // initial flush reads the canonical values).
    this._syncFromCurrentRealm();
  }

  /**
   * @returns {number} the number of breakthrough entries (0 when the
   *          'breakthroughs' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single entry by realm id.
   *
   * @param {string} realmId — the realm id (e.g. 'qi-gathering').
   * @returns {object|null} a shallow copy of the definition, or null when
   *          the realm has no entry.
   */
  byRealm(realmId) {
    const definition = this._byRealm.get(realmId);
    return definition ? { ...definition } : null;
  }

  /**
   * Read-only snapshot of the CURRENT realm's breakthrough requirements —
   * never mutates state. Every field is coerced defensively: a missing entry
   * reports the fallback requiredProgress (1000), a zero cost and an empty
   * bottleneck, with canAttempt false. The tribulation gate (read from the
   * shared state.tribulations slice owned by the TribulationSystem — a
   * malformed slice degrades to gate-open) is reported as
   * tribulationRequired / tribulationMet. The returned cost/bottleneck are
   * fresh copies — mutating them never leaks into the system.
   *
   * Cost and bottleneck are INFORMATIONAL ONLY (P1 playtest fix, user
   * decision 2026-08-11): costMet / bottleneckMet still report whether the
   * wallet/inventory COULD cover the entry, but neither affects canAttempt
   * (entry && !atTop && progressMet && tribulationMet). The data fields
   * stay intact for reuse when item sources land (P4).
   *
   * @returns {{ realmId: string|null, requiredProgress: number, progress: number,
   *            progressMet: boolean, cost: object, costMet: boolean,
   *            bottleneck: Array<{id: string, count: number}>, bottleneckMet: boolean,
   *            tribulationRequired: boolean, tribulationMet: boolean,
   *            canAttempt: boolean }} the current requirement snapshot
   *            (cost/bottleneck informational, not gates).
   */
  requirements() {
    this._ensureSlices();
    const realmId = this._currentRealmId();
    const definition = realmId ? this._byRealm.get(realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;

    const requiredProgress = entry ? entry.requiredProgress : FALLBACK_PROGRESS;
    const progress = this._readProgress();
    const cost = entry ? { ...entry.cost } : { spiritStones: 0 };
    const bottleneck = entry ? entry.bottleneck.map((item) => ({ ...item })) : [];

    const progressMet = progress >= requiredProgress;
    // Informational only (P1 — user decision 2026-08-11): the affordability
    // flags are still reported but never gate the attempt.
    const costMet = this._costMet(cost);
    const bottleneckMet = this._bottleneckMet(bottleneck);
    const tribulation = this._tribulationGate();

    return {
      realmId,
      requiredProgress,
      progress,
      progressMet,
      cost,
      costMet,
      bottleneck,
      bottleneckMet,
      tribulationRequired: tribulation.required,
      tribulationMet: tribulation.met,
      canAttempt:
        Boolean(entry) &&
        !this._atTopRealm() &&
        progressMet &&
        tribulation.met,
    };
  }

  /**
   * Whether an attempt would be accepted RIGHT NOW (same gates as attempt,
   * no consumption, no event).
   *
   * @returns {boolean} true when attempt() would proceed to the roll.
   */
  canAttempt() {
    return this.requirements().canAttempt;
  }

  /**
   * Attempt a breakthrough against the current realm's data-driven table.
   *
   * Blocked (returns { outcome: null, advanced: false, reason } with no
   * state mutation, no spend, no event):
   *   - 'no-definition' — no 'breakthroughs' collection, or no entry for the
   *     current realm (warned ONCE per system instance);
   *   - 'max-realm' — the current realm is the top of the ladder;
   *   - 'progress' — cultivation.realmProgress < the entry's requiredProgress;
   *   - 'tribulation' — the current realm imposes a tribulation that is
   *     still pending (state.tribulations.pending true and survived false —
   *     written by the TribulationSystem on realm changes / face(); old
   *     saves without the slice degrade to gate-open).
   *
   * The order above is canonical: entry → max-realm → progress → tribulation.
   *
   * Accepted: nothing is spent or consumed — the entry's stone cost and item
   * bottleneck are INFORMATIONAL ONLY (P1 playtest fix, user decision
   * 2026-08-11; the data fields and code paths stay intact for reuse when
   * item sources land in P4). Weighted-roll an outcome via the injected
   * random source, then:
   *   - SUCCESS outcome → RealmSystem.setRealm(next tier) (its own
   *     'realm:changed' fires — never suppressed), realmProgress = 0, the
   *     max/cost sync pulls the NEW realm's entry, statistics.
   *     breakthroughsTotal += 1;
   *   - FAILURE outcome → realmProgress -= progressLoss × realmProgressMax
   *     (never below 0), realm unchanged.
   * Every accepted attempt emits 'realm:breakthrough' and re-syncs the
   * current realm's max/cost.
   *
   * @returns {{ outcome: string|null, advanced: boolean, reason?: string }}
   *          the rolled outcome id (null when blocked) + whether the realm
   *          advanced + the blocked reason (accepted attempts carry none).
   */
  attempt() {
    this._ensureSlices();

    const realmId = this._currentRealmId();
    const definition = realmId ? this._byRealm.get(realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;

    if (!entry) {
      this._warnNoDefinition(realmId);
      return { outcome: null, advanced: false, reason: 'no-definition' };
    }
    if (this._atTopRealm()) {
      return { outcome: null, advanced: false, reason: 'max-realm' };
    }

    const progress = this._readProgress();
    if (progress < entry.requiredProgress) {
      return { outcome: null, advanced: false, reason: 'progress' };
    }

    // The tribulation gate (read-only, after every other gate — the order of
    // the existing reasons is preserved): a pending tribulation on the
    // current realm blocks the attempt until the player faces and survives
    // it through the TribulationSystem.
    const tribulation = this._tribulationGate();
    if (tribulation.required && !tribulation.met) {
      return { outcome: null, advanced: false, reason: 'tribulation' };
    }

    // Accepted: nothing is spent or consumed — cost and bottleneck are
    // INFORMATIONAL ONLY (P1 playtest fix, user decision 2026-08-11; the
    // data fields and code paths stay intact for reuse when item sources
    // land in P4). Roll the weighted outcome directly.

    const outcome = this._rollOutcome(entry.results);
    const advanced = SUCCESS_OUTCOMES.has(outcome.outcome);

    if (advanced) {
      // The max-realm gate already guaranteed a next tier; a hostile
      // realmSystem returning none is treated as blocked (defense).
      const next = this._realmSystem.next();
      if (!next) {
        return { outcome: null, advanced: false, reason: 'max-realm' };
      }
      this._realmSystem.setRealm(next.tier);
      this._state.cultivation.realmProgress = 0;
      this._state.statistics.breakthroughsTotal =
        _asNumber(this._state.statistics.breakthroughsTotal) + 1;
    } else {
      const loss = outcome.progressLoss * this._readRealmProgressMax();
      this._state.cultivation.realmProgress = Math.max(progress - loss, 0);
    }

    // Every accepted attempt re-syncs max/cost from the (possibly new)
    // current realm's entry (a no-op write-wise when nothing changed).
    this._syncFromCurrentRealm();

    const current = this._realmSystem.current();
    const next = current ? this._realmSystem.next() : null;
    this._eventBus.emit('realm:breakthrough', {
      realmId: current && typeof current.id === 'string' ? current.id : realmId,
      realmName: current && typeof current.name === 'string' ? current.name : null,
      tier: current ? current.tier : null,
      outcome: outcome.outcome,
      advanced,
      nextRealm: next ? next.id : null,
    });

    return { outcome: outcome.outcome, advanced };
  }

  /**
   * Tear down the system: unsubscribe the tick handler so 'loop:update'
   * events no longer mutate state (shutdown-sequence future-proofing; the
   * system must not be reused after this call).
   *
   * @returns {void}
   */
  destroy() {
    this._eventBus.unsubscribe('loop:update', this._onUpdate);
  }

  /**
   * Fixed-timestep tick handler (bound; invoked via 'loop:update'). Accrues
   * cultivation.realmProgress from the canonical per-second qi rate ×
   * config.breakthroughs.progressRate × deltaMs/1000, clamped to the
   * current realm's realmProgressMax. Skipped entirely when the cultivator
   * is at the top realm (nothing to break through to), when the qi rate is
   * 0, or when the payload's deltaMs is unusable (a malformed payload can
   * never produce a bogus gain). Writes only when the value actually
   * changed (keeps renderer partial-refresh comparisons stable). Before any
   * read/write the malformed top-level slices are repaired (restore-trust).
   *
   * @param {object} [payload] — the 'loop:update' payload
   *        ({ deltaMs, elapsedMs, tick }).
   * @returns {void}
   */
  _onUpdate(payload) {
    this._ensureSlices();
    if (this._atTopRealm()) return;

    const qiPerSecond = _asNumber(this._state.cultivation.qiPerSecond);
    if (qiPerSecond <= 0) return;

    const deltaMs = _asNumber(payload && payload.deltaMs);
    if (deltaMs <= 0) return;

    const gain = (qiPerSecond * this._progressRate * deltaMs) / 1000;
    if (gain <= 0) return;

    const max = this._readRealmProgressMax();
    const progress = Math.min(this._readProgress() + gain, max);
    if (this._state.cultivation.realmProgress !== progress) {
      this._state.cultivation.realmProgress = progress;
    }
  }

  /**
   * Read the breakthrough tables from the injected DataManager. Returns an
   * empty array when no DataManager was injected or it lacks getAll() —
   * count 0, no state writes, attempt() rejects 'no-definition'. Entries
   * that are not plain objects are skipped defensively (a hostile lookalike
   * must not poison the indexes). No throw, no fallback to hardcoded
   * defaults (the data-driven philosophy forbids that).
   *
   * @returns {Array<object>} the tables (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('breakthroughs');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (definition) =>
        definition !== null &&
        typeof definition === 'object' &&
        !Array.isArray(definition)
    );
  }

  /**
   * Build the realmId lookup index over the snapshot. First occurrence wins
   * on any collision (defensive — the data tests already guarantee
   * uniqueness). Entries without a usable realmId stay unindexed (they can
   * never resolve for the current realm).
   *
   * @returns {void}
   */
  _buildIndexes() {
    for (const definition of this._definitions) {
      const realmId = definition.realmId;
      if (
        typeof realmId === 'string' &&
        realmId !== '' &&
        !this._byRealm.has(realmId)
      ) {
        this._byRealm.set(realmId, definition);
      }
    }
  }

  /**
   * Resolve the current realm's id through the injected RealmSystem. Null
   * when no realmSystem was injected or its current() yields no usable id —
   * the current realm is then unresolvable and attempt() rejects
   * 'no-definition'.
   *
   * @returns {string|null} the current realm's id, or null.
   */
  _currentRealmId() {
    if (!this._realmSystem || typeof this._realmSystem.current !== 'function') {
      return null;
    }
    const current = this._realmSystem.current();
    return current && typeof current.id === 'string' && current.id !== ''
      ? current.id
      : null;
  }

  /**
   * @returns {boolean} true when the current realm is the top of the ladder.
   *          False when no realmSystem is injected (nothing is "maxed" —
   *          canAttempt stays false via the missing entry gate anyway).
   */
  _atTopRealm() {
    if (!this._realmSystem) return false;
    return this._realmSystem.isMaxRealm === true;
  }

  /**
   * Coerce a cached breakthrough definition into the canonical internal
   * shape (fresh objects — never the deep-frozen cache). A definition that
   * is not a plain object coerces to null (unusable).
   *
   * @param {object} definition — a cached (frozen) breakthrough definition.
   * @returns {{ realmId: string, requiredProgress: number, cost: object,
   *            bottleneck: Array<{id: string, count: number}>, results: Array<object> }|null}
   *          the coerced entry, or null.
   */
  _coerceEntry(definition) {
    if (
      definition === null ||
      typeof definition !== 'object' ||
      Array.isArray(definition)
    ) {
      return null;
    }
    return {
      realmId: typeof definition.realmId === 'string' ? definition.realmId : '',
      requiredProgress: _coerceRequiredProgress(definition.requiredProgress),
      cost: _coerceCost(definition.cost),
      bottleneck: _coerceBottleneck(definition.bottleneck),
      results: _coerceResults(definition.results),
    };
  }

  /**
   * Whether every positive cost entry is affordable through the injected
   * ResourceSystem right now. Zero/non-positive amounts are always met;
   * with no resourceSystem injected a positive amount is never met.
   *
   * @param {object} cost — coerced cost map ({ id: amount }).
   * @returns {boolean} true when every entry is affordable.
   */
  _costMet(cost) {
    for (const [id, amount] of Object.entries(cost)) {
      if (amount <= 0) continue;
      if (
        !this._resourceSystem ||
        typeof this._resourceSystem.canAfford !== 'function'
      ) {
        return false;
      }
      if (!this._resourceSystem.canAfford(id, amount)) return false;
    }
    return true;
  }

  /**
   * Whether every bottleneck item is carried in the injected InventorySystem
   * right now. An empty bottleneck is always met; with no inventorySystem
   * injected a non-empty bottleneck is never met.
   *
   * @param {Array<{id: string, count: number}>} bottleneck — coerced list.
   * @returns {boolean} true when every item is carried in sufficient count.
   */
  _bottleneckMet(bottleneck) {
    for (const item of bottleneck) {
      if (
        !this._inventorySystem ||
        typeof this._inventorySystem.has !== 'function'
      ) {
        return false;
      }
      if (!this._inventorySystem.has(item.id, item.count)) return false;
    }
    return true;
  }

  /**
   * Read the tribulation gate off the SHARED state.tribulations slice (owned
   * and written by the TribulationSystem — js/systems/tribulations.js). The
   * gate is required while a tribulation is pending and met once it has been
   * survived (or nothing is pending). Restore-trust: a malformed slice
   * (null, a primitive, an array or a missing key) degrades to gate-open —
   * an old save without the slice must never block a breakthrough or throw.
   *
   * @returns {{ required: boolean, met: boolean }} the gate state.
   */
  _tribulationGate() {
    const slice = this._state.tribulations;
    if (slice === null || typeof slice !== 'object' || Array.isArray(slice)) {
      return { required: false, met: true };
    }
    const pending = slice.pending === true;
    const survived = slice.survived === true;
    return { required: pending, met: !pending || survived };
  }

  /**
   * Weighted-roll an outcome from a coerced results table via the injected
   * random source: roll = random() × totalWeight, walked cumulatively
   * against the per-outcome weights (a larger weight = a wider bucket).
   * Coercion guarantees a non-empty table of positive weights, so the walk
   * always lands; the defensive fallbacks (zero total weight, roll at/past
   * the cumulative end — a hostile random source) return the first default
   * / last entry respectively.
   *
   * @param {Array<{outcome: string, weight: number, progressLoss: number}>} results —
   *        coerced results table.
   * @returns {{outcome: string, weight: number, progressLoss: number}} the
   *          rolled outcome (a fresh copy).
   */
  _rollOutcome(results) {
    const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
    if (totalWeight <= 0) return { ...DEFAULT_RESULTS[0] };
    const roll = this._random() * totalWeight;
    let cumulative = 0;
    for (const result of results) {
      cumulative += result.weight;
      if (roll < cumulative) return { ...result };
    }
    return { ...results[results.length - 1] };
  }

  /**
   * Sync cultivation.realmProgressMax and cultivation.breakthroughCost from
   * the CURRENT realm's entry (construction boot + after every accepted
   * attempt). No entry for the current realm → the fallback max (1000) and
   * a null cost (the renderer renders null as "—"). A missing collection
   * leaves state untouched entirely (neutral degradation). Writes only when
   * a value actually differs (keeps renderer partial-refresh comparisons
   * stable).
   *
   * @returns {void}
   */
  _syncFromCurrentRealm() {
    if (this._definitions.length === 0) return;

    const realmId = this._currentRealmId();
    const definition = realmId ? this._byRealm.get(realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;

    const max = entry ? entry.requiredProgress : FALLBACK_PROGRESS;
    const cost = entry ? entry.cost.spiritStones : null;

    if (this._state.cultivation.realmProgressMax !== max) {
      this._state.cultivation.realmProgressMax = max;
    }
    if (this._state.cultivation.breakthroughCost !== cost) {
      this._state.cultivation.breakthroughCost = cost;
    }
  }

  /**
   * Coerced current realm progress (never negative — a hostile restored
   * value reads as 0).
   *
   * @returns {number} the progress value (>= 0).
   */
  _readProgress() {
    return Math.max(_asNumber(this._state.cultivation.realmProgress), 0);
  }

  /**
   * Coerced current realm-progress cap: a missing, non-positive or
   * non-finite value reads as the fallback 1000 (a hostile value can never
   * produce a negative loss or a zero cap).
   *
   * @returns {number} the cap value (> 0).
   */
  _readRealmProgressMax() {
    const parsed = Number(this._state.cultivation.realmProgressMax);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_PROGRESS;
  }

  /**
   * Warn once (per system instance) when an attempt is rejected because no
   * definition resolves for the current realm — an empty collection and a
   * realm without an entry share the latch so a hostile save cannot spam
   * the console.
   *
   * @param {string|null} realmId — the realm that failed to resolve.
   * @returns {void}
   */
  _warnNoDefinition(realmId) {
    if (this._warnedNoDefinition) return;
    this._warnedNoDefinition = true;
    if (this._definitions.length === 0) {
      console.warn(
        'BreakthroughSystem: no breakthrough definitions loaded — attempt rejected.'
      );
    } else {
      console.warn(
        `BreakthroughSystem: no breakthrough definition for realm "${String(realmId)}" — attempt rejected.`
      );
    }
  }

  /**
   * Make sure the cultivation and statistics slices are plain objects before
   * any read/write against them. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with
   * the canonical fresh slice — restore-trust: a broken top-level slice must
   * never abort boot or throw per tick. A healthy restored slice (even one
   * with extra or missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('cultivation', _freshCultivationSlice);
    this._ensureSlice('statistics', _freshStatisticsSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'cultivation').
   * @param {() => object} fallback — factory returning the canonical fresh slice.
   * @returns {object} the (possibly repaired) slice.
   */
  _ensureSlice(name, fallback) {
    const current = this._state[name];
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      this._state[name] = fallback();
    }
    return this._state[name];
  }
}

/**
 * The canonical fresh cultivation slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored cultivation slice is
 * unusable (null, a primitive or an array) — a broken top-level slice must
 * never abort boot or throw per tick.
 *
 * @returns {object} the canonical cultivation slice.
 */
function _freshCultivationSlice() {
  return {
    realm: 'Mortal',
    realmTier: 0,
    realmStage: 1,
    nextRealm: 'Qi Gathering',
    breakthroughCost: null,
    realmProgress: 0,
    realmProgressMax: 1000,
    realmEffects: {
      qiMaxMultiplier: 1,
      cultivationSpeedMultiplier: 1,
      powerMultiplier: 1,
      lifespanYears: 100,
    },
    qi: 0,
    qiMax: 100,
    qiPerSecond: 0,
    qiSources: { meditation: 0, upgrades: 0 },
    breakthroughs: 0,
  };
}

/**
 * The canonical fresh statistics slice (mirrors core/game-state.js). Used as
 * the restore-trust fallback when a restored statistics slice is unusable
 * (null, a primitive or an array).
 *
 * @returns {object} the canonical statistics slice.
 */
function _freshStatisticsSlice() {
  return {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 0,
  };
}

/**
 * Coerce a requiredProgress value: a missing, non-positive or non-finite
 * value falls back to 1000 (the canonical early-realm placeholder).
 *
 * @param {*} value — raw requiredProgress from the definition.
 * @returns {number} the validated value (> 0).
 */
function _coerceRequiredProgress(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_PROGRESS;
}

/**
 * Coerce a cost map: entries with a finite non-negative amount are kept
 * (anything else is dropped) and a missing spiritStones key defaults to 0 —
 * every coerced cost exposes a numeric spiritStones (the sync writes it as
 * breakthroughCost).
 *
 * @param {*} raw — raw cost value from the definition.
 * @returns {object} the coerced cost map ({ id: amount >= 0 }).
 */
function _coerceCost(raw) {
  const cost = {};
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, amount] of Object.entries(raw)) {
      const parsed = _asNumber(amount);
      if (parsed >= 0) cost[id] = parsed;
    }
  }
  if (typeof cost.spiritStones !== 'number') cost.spiritStones = 0;
  return cost;
}

/**
 * Coerce a bottleneck list: entries that are not { id: non-empty string,
 * count finite > 0 } are dropped (a hostile entry can never demand a
 * phantom item). Numeric-string counts coerce to numbers.
 *
 * @param {*} raw — raw bottleneck value from the definition.
 * @returns {Array<{id: string, count: number}>} the coerced list.
 */
function _coerceBottleneck(raw) {
  if (!Array.isArray(raw)) return [];
  const bottleneck = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    const count = _asNumber(entry.count);
    if (count <= 0) continue;
    bottleneck.push({ id: entry.id, count });
  }
  return bottleneck;
}

/**
 * Coerce a results table: entries must carry a canonical outcome id
 * (death is NOT canonical in v1 — DESIGN.md marks it 'future optional'), a
 * finite weight > 0 and a progressLoss clamped into 0..1 (absent defaults
 * to 0 — success outcomes never declare it). An empty result (or a table
 * whose entries all failed coercion) falls back to the default table
 * [{success 70},{failure 30}].
 *
 * @param {*} raw — raw results value from the definition.
 * @returns {Array<{outcome: string, weight: number, progressLoss: number}>}
 *          the coerced (non-empty) table.
 */
function _coerceResults(raw) {
  if (!Array.isArray(raw)) return _defaultResults();
  const results = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    if (!CANONICAL_OUTCOMES.has(entry.outcome)) continue;
    const weight = _asNumber(entry.weight);
    if (weight <= 0) continue;
    results.push({
      outcome: entry.outcome,
      weight,
      progressLoss: _coerceProgressLoss(entry.progressLoss),
    });
  }
  return results.length > 0 ? results : _defaultResults();
}

/**
 * Coerce a progressLoss: missing/non-finite → 0 (success outcomes never
 * declare it); present values clamp into 0..1 so a hostile value can never
 * produce a negative loss (progress would GAIN) or a loss above 100%.
 *
 * @param {*} value — raw progressLoss from the definition.
 * @returns {number} the validated loss (0..1).
 */
function _coerceProgressLoss(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

/**
 * @returns {Array<{outcome: string, weight: number, progressLoss: number}>}
 *          the default results table (fresh array of fresh objects).
 */
function _defaultResults() {
  return DEFAULT_RESULTS.map((result) => ({ ...result }));
}

/**
 * Read a positive finite tuning option, falling back to a default. A
 * missing value falls back silently (a partial config is not an error); a
 * present but invalid value warns once.
 *
 * @param {*} value — raw option value.
 * @param {number} fallback — default to use when value is not usable.
 * @param {string} name — option name for the warning message.
 * @returns {number} the validated value, or the fallback.
 */
function _readPositiveNumber(value, fallback, name) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (value !== undefined) {
    console.warn(
      `BreakthroughSystem: invalid "${name}" (${String(value)}) — using the default.`
    );
  }
  return fallback;
}

/**
 * Coerce a value to a finite number, treating anything unusable as 0 (the
 * neutral "no effect" value — never a tuning number).
 *
 * @param {*} value — raw number-ish value.
 * @returns {number} the numeric value, or 0.
 */
function _asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
