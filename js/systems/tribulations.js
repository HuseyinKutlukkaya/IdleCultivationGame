/**
 * systems/tribulations.js — TribulationSystem (single owner of the
 * tribulation gate on the current realm's breakthrough).
 *
 * The Phase-3 tribulation system (DESIGN.md 'Bottlenecks' — "some realms
 * create bottlenecks… may require… tribulations"; DESIGN.md 'Tribulations' —
 * types Lightning, Heart Devil, Karma, Heavenly Fire, Void, Soul, Body;
 * combined tribulations are future). Some realms impose a data-driven
 * tribulation between the cultivator and the realm's breakthrough. When the
 * cultivator ENTERS such a realm (every 'realm:changed' — a breakthrough
 * success and a manual setRealm() both fire it), the system opens the gate:
 * it writes state.tribulations = { type, pending: true, survived: false }
 * and emits 'tribulation:started'. The player then calls face() to resolve
 * the pending tribulation against the realm's data-driven weighted outcome
 * table: a SUCCESS outcome (survived, barely-survived) opens the gate
 * (survived = true, pending = false, no progress loss); a FAILURE outcome
 * (injured, near-death) keeps the gate pending and subtracts progressLoss ×
 * realmProgressMax from cultivation.realmProgress (clamped at 0, never
 * negative). While the gate is pending the BreakthroughSystem's attempt()
 * rejects with reason 'tribulation' (it reads the SAME shared
 * state.tribulations slice — no system-to-system imports). The system has
 * NO 'loop:update' subscription — tribulations only change through realm
 * changes and face().
 *
 * Data-driven content: the tribulation table (realmId, tribulationType,
 * results) comes from dataManager.getAll('tribulations')
 * (data/tribulations/tribulations.json via data/manifest.json — one entry
 * per realm id, file order is tier order, canonical types are the seven
 * DESIGN.md types). A MISSING 'tribulations' collection degrades neutrally:
 * count 0, no state writes, 'realm:changed' is a silent no-op, face()
 * rejects 'no-tribulation' and requirements() reports the neutral gate.
 * An entry without a canonical type is treated as ungated (type null); an
 * ungated realm (or a realm without an entry) is a neutral gate.
 *
 * State owned (writes): state.tribulations ({ type, pending, survived } —
 * the gate the BreakthroughSystem reads through its _tribulationGate helper)
 * and cultivation.realmProgress on a FAILED face() (the progressLoss the
 * tribulation inflicts). The type/pending/survived shape is part of the
 * canonical GameState (see core/game-state.js).
 *
 * Restore-trust (attacker-shaped saves): the tribulations and cultivation
 * slices are repaired to the canonical fresh shapes when unusable (null, a
 * primitive or an array) before ANY read or write — a broken slice must
 * never abort boot or throw per call. Definition coercion is defensive
 * (applied on every read, never mutating the deep-frozen cache): realmId →
 * non-empty string (else ''); tribulationType → null unless it is a
 * non-empty string in the canonical type whitelist (a hostile type like
 * 'fire' reads as ungated); results → entries with a canonical outcome, a
 * finite weight > 0 and a progressLoss clamped into 0..1 (absent defaults
 * to 0 — success outcomes never declare it — and present out-of-range
 * values clamp, so a hostile value can never GAIN progress); a results
 * table left empty falls back to the default [{survived 70},{injured 30}].
 * Every state read goes through a fail-safe _asNumber / positive fallback
 * so a malformed value can never poison the math (a negative realmProgress
 * reads as 0; a non-positive realmProgressMax reads as the fallback 1000).
 *
 * Event contract (all emitted on the injected eventBus; subscription:
 * 'realm:changed'):
 *   realm:changed      { realmId, realmName, tier, effects } — subscribed
 *                       in the constructor. Resolves the new realm's entry:
 *                       gated → writes the open gate { type, pending: true,
 *                       survived: false } and emits 'tribulation:started';
 *                       ungated → writes the neutral gate. Identity fields
 *                       come from the payload when usable, else fall back to
 *                       realmSystem.current().
 *   tribulation:started { realmId, realmName, tier, type } — emitted when a
 *                       realm change opens a new tribulation gate (never for
 *                       an ungated realm, never on boot).
 *   tribulation:finished { realmId, realmName, tier, type, outcome,
 *                       survived } — emitted on EVERY accepted face() (never
 *                       on a blocked one); the identity is the current realm.
 *
 * Pure gameplay — no DOM access, no storage I/O, no loop subscription,
 * framework-free and GitHub Pages compatible. Systems communicate through
 * the EventBus only; this module depends solely on the shared GameState and
 * EventBus singletons (both injectable for deterministic tests) plus the
 * injected RealmSystem / DataManager / random source. The BreakthroughSystem
 * reads the gate from the SHARED state.tribulations slice, never from this
 * module.
 *
 * Future expansion (see DESIGN.md/PLANS.md): combined tribulations (a realm
 * imposing several types at once — the results table becomes a multi-gate
 * face sequence), tribulation success modifiers (a perfect face stacking a
 * bonus into the following breakthrough's roll — the BreakthroughSystem's
 * entry coercion is the hook), and higher-tier tribulation levels with their
 * own tuning blocks in the same JSON.
 */

import { EventBus } from '../core/event-bus.js';
import { GameState, freshCultivationSlice } from '../core/game-state.js';

/** The canonical tribulation type ids (DESIGN.md 'Tribulations'; combined
 * tribulations are v1-excluded). */
const CANONICAL_TYPES = new Set([
  'lightning',
  'heart-devil',
  'karma',
  'heavenly-fire',
  'void',
  'soul',
  'body',
]);

/** The canonical SUCCESS outcome ids (each opens the gate, no progressLoss). */
const SUCCESS_OUTCOMES = new Set(['survived', 'barely-survived']);

/** The canonical FAILURE outcome ids (each carries a progressLoss). */
const FAILURE_OUTCOMES = new Set(['injured', 'near-death']);

/** Every canonical outcome id. */
const CANONICAL_OUTCOMES = new Set([...SUCCESS_OUTCOMES, ...FAILURE_OUTCOMES]);

/** Fallback realm-progress cap when a usable realmProgressMax is missing. */
const FALLBACK_PROGRESS = 1000;

/** Default result table when a gated entry carries no usable results. */
const DEFAULT_RESULTS = [
  { outcome: 'survived', weight: 70, progressLoss: 0 },
  { outcome: 'injured', weight: 30, progressLoss: 0 },
];

export class TribulationSystem {
  /**
   * @param {object} [options] — constructor options (all optional).
   * @param {object} [options.state] — game state object the system reads from
   *        and writes to; defaults to the shared GameState singleton (same
   *        dependency-injection pattern as QiSystem, RealmSystem,
   *        BreakthroughSystem, UpgradeSystem, OfflineProgress, GameLoop and
   *        Renderer).
   * @param {object} [options.eventBus] — pub/sub bus for lifecycle events;
   *        defaults to the shared EventBus singleton.
   * @param {object|null} [options.realmSystem=null] — RealmSystem (or a
   *        lookalike with current()) owning the realm ladder. When absent the
   *        current realm cannot resolve — every read reports the neutral gate
   *        and face() rejects 'no-tribulation' (nothing is hardcoded).
   * @param {object|null} [options.dataManager=null] — DataManager (or a
   *        lookalike with `getAll(collection)`) resolving the tribulation
   *        table from the 'tribulations' collection. When absent the table is
   *        empty — count 0, no state writes, 'realm:changed' is a silent
   *        no-op. Content is never hardcoded.
   * @param {() => number} [options.random] — uniform [0,1) source for the
   *        weighted outcome roll; defaults to Math.random (injectable for
   *        deterministic tests).
   */
  constructor(options = {}) {
    /** @type {object} game state the system reads from and writes to. */
    this._state = options.state || GameState;
    /** @type {object} pub/sub bus for lifecycle events. */
    this._eventBus = options.eventBus || EventBus;
    /** @type {object|null} realm ladder owner (current()). */
    this._realmSystem = options.realmSystem || null;
    /** @type {object|null} definition resolver ('tribulations' collection). */
    this._dataManager = options.dataManager || null;
    /** @type {() => number} uniform [0,1) source for the weighted roll. */
    this._random = typeof options.random === 'function' ? options.random : Math.random;

    // Bound once so subscribe/unsubscribe always see the same function
    // identity (same pattern as BreakthroughSystem._onUpdate and GameLoop).
    this._onRealmChanged = this._onRealmChanged.bind(this);
    // The gate opens/closes on every realm change — a breakthrough success
    // and a manual setRealm() both fire 'realm:changed'.
    this._eventBus.subscribe('realm:changed', this._onRealmChanged);

    // Restore-trust: a malformed tribulations/cultivation slice (null, a
    // primitive or an array) restored from an attacker-shaped save must
    // never abort boot — repair both before any read/write below.
    this._ensureSlices();

    // Snapshot the tribulation table at construction time (file order =
    // tier order). Cached definitions are deep-frozen by the DataManager;
    // the array itself stays a reference snapshot for lookup performance.
    this._definitions = this._readDefinitions();

    /** @type {Map<string, object>} realmId → definition (O(1) lookup). */
    this._byRealm = new Map();
    this._buildIndexes();

    // Sync the gate for the CURRENT realm (boot — a reload mid-stay keeps a
    // cleared gate; see _syncFromCurrentRealm).
    this._syncFromCurrentRealm({ preserveSurvived: true });
  }

  /**
   * @returns {number} the number of tribulation entries (0 when the
   *          'tribulations' collection is absent or unloaded).
   */
  get count() {
    return this._definitions.length;
  }

  /**
   * Look up a single entry by realm id.
   *
   * @param {string} realmId — the realm id (e.g. 'core-formation').
   * @returns {object|null} a shallow copy of the definition, or null when
   *          the realm has no entry.
   */
  byRealm(realmId) {
    const definition = this._byRealm.get(realmId);
    return definition ? { ...definition } : null;
  }

  /**
   * Read-only snapshot of the CURRENT realm's tribulation gate — never
   * mutates state. Every field is coerced defensively: a missing entry (or a
   * non-canonical type) reads as an ungated realm (type null, pending and
   * survived forced false regardless of what a hostile save wrote, canFace
   * false). The returned object is a fresh copy — mutating it never leaks
   * into the system.
   *
   * @returns {{ realmId: string|null, type: string|null, pending: boolean,
   *            survived: boolean, canFace: boolean }} the current gate.
   */
  requirements() {
    this._ensureSlices();
    const realmId = this._currentRealmId();
    const definition = realmId ? this._byRealm.get(realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;
    const type = entry ? entry.tribulationType : null;

    return {
      realmId,
      type,
      pending: type ? this._state.tribulations.pending === true : false,
      survived: type ? this._state.tribulations.survived === true : false,
      canFace: Boolean(type) && this._state.tribulations.pending === true &&
        this._state.tribulations.survived !== true,
    };
  }

  /**
   * Whether face() would be accepted RIGHT NOW (same gates as face, no
   * roll, no event).
   *
   * @returns {boolean} true when face() would proceed to the roll.
   */
  canFace() {
    return this.requirements().canFace;
  }

  /**
   * Resolve the current realm's pending tribulation against its data-driven
   * table.
   *
   * Blocked (returns { outcome: null, survived: false, reason } with no
   * state mutation and no event):
   *   - 'no-tribulation' — the current realm has no tribulation type (no
   *     entry, or an entry whose type is not canonical);
   *   - 'not-pending' — state.tribulations.pending is not true (the gate is
   *     already open or was never opened).
   *
   * Accepted: weighted-roll an outcome via the injected random source (the
   * same cumulative walk as BreakthroughSystem._rollOutcome), then:
   *   - SUCCESS outcome (survived, barely-survived) → survived = true,
   *     pending = false (the breakthrough gate opens; no progress loss);
   *   - FAILURE outcome (injured, near-death) → survived = false (pending
   *     STAYS true — the gate stays closed) and realmProgress -=
   *     progressLoss × realmProgressMax (clamped at 0, never negative).
   * Every accepted face() emits 'tribulation:finished' with the current
   * realm's identity.
   *
   * @returns {{ outcome: string|null, survived: boolean, reason?: string }}
   *          the rolled outcome id (null when blocked) + whether the
   *          tribulation was survived + the blocked reason (accepted faces
   *          carry none).
   */
  face() {
    this._ensureSlices();

    const realmId = this._currentRealmId();
    const definition = realmId ? this._byRealm.get(realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;
    const type = entry ? entry.tribulationType : null;

    if (!type) {
      return { outcome: null, survived: false, reason: 'no-tribulation' };
    }
    if (this._state.tribulations.pending !== true) {
      return { outcome: null, survived: false, reason: 'not-pending' };
    }

    const outcome = this._rollOutcome(entry.results);
    const survived = SUCCESS_OUTCOMES.has(outcome.outcome);

    if (survived) {
      // Gate opens: a successful face clears the pending tribulation.
      this._state.tribulations.survived = true;
      this._state.tribulations.pending = false;
    } else {
      // Gate stays closed: survived stays false, pending stays true, and the
      // tribulation inflicts a progress loss (clamped — never negative).
      this._state.tribulations.survived = false;
      const loss = outcome.progressLoss * this._readRealmProgressMax();
      this._state.cultivation.realmProgress = Math.max(
        this._readProgress() - loss,
        0
      );
    }

    const identity = this._currentRealmIdentity();
    this._eventBus.emit('tribulation:finished', {
      realmId: identity.realmId,
      realmName: identity.realmName,
      tier: identity.tier,
      type,
      outcome: outcome.outcome,
      survived,
    });

    return { outcome: outcome.outcome, survived };
  }

  /**
   * Tear down the system: unsubscribe the 'realm:changed' handler so later
   * realm changes no longer mutate the gate (shutdown-sequence
   * future-proofing; the system must not be reused after this call).
   *
   * @returns {void}
   */
  destroy() {
    this._eventBus.unsubscribe('realm:changed', this._onRealmChanged);
  }

  /**
   * Realm-change handler (bound; invoked via 'realm:changed'). Resolves the
   * NEW realm's tribulation entry: gated → writes the open gate
   * { type, pending: true, survived: false } and emits 'tribulation:started'
   * with the payload identity (falling back to realmSystem.current() when a
   * payload field is unusable); ungated → writes the neutral gate. An empty
   * table is a silent no-op — no state writes, no event (neutral
   * degradation). Before any read/write the malformed top-level slices are
   * repaired (restore-trust).
   *
   * @param {object} [payload] — the 'realm:changed' payload
   *        ({ realmId, realmName, tier, effects }).
   * @returns {void}
   */
  _onRealmChanged(payload) {
    this._ensureSlices();
    if (this._definitions.length === 0) return;

    const identity = this._identityFromPayload(payload);
    const definition = identity.realmId ? this._byRealm.get(identity.realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;
    const type = entry ? entry.tribulationType : null;

    if (type) {
      // A tribulation-bearing realm always RE-OPENS the gate — a realm
      // change clears any previously survived face (boot re-syncs with
      // preserveSurvived instead; see _syncFromCurrentRealm).
      this._state.tribulations.type = type;
      this._state.tribulations.pending = true;
      this._state.tribulations.survived = false;
      this._eventBus.emit('tribulation:started', {
        realmId: identity.realmId,
        realmName: identity.realmName,
        tier: identity.tier,
        type,
      });
    } else {
      this._state.tribulations.type = null;
      this._state.tribulations.pending = false;
      this._state.tribulations.survived = false;
    }
  }

  /**
   * Read the tribulation table from the injected DataManager. Returns an
   * empty array when no DataManager was injected or it lacks getAll() —
   * count 0, no state writes, 'realm:changed' is a silent no-op and face()
   * rejects 'no-tribulation'. Entries that are not plain objects are skipped
   * defensively (a hostile lookalike must not poison the indexes). No throw,
   * no fallback to hardcoded defaults (the data-driven philosophy forbids
   * that).
   *
   * @returns {Array<object>} the table (file order preserved).
   */
  _readDefinitions() {
    if (!this._dataManager || typeof this._dataManager.getAll !== 'function') {
      return [];
    }
    const raw = this._dataManager.getAll('tribulations');
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
   * Sync the gate for the CURRENT realm (construction boot). An empty table
   * is a neutral no-op — state stays exactly as restored. A realm with no
   * entry (or a non-canonical type) reads as ungated → the neutral gate. A
   * gated realm writes { type, pending: !survived, survived } where survived
   * only carries over when preserveSurvived is true and the restored slice
   * already has survived === true — a reload mid-stay keeps the cleared
   * gate, while every realm change (see _onRealmChanged) always re-opens it.
   *
   * @param {{ preserveSurvived: boolean }} [options] — whether a restored
   *        survived flag survives the sync.
   * @returns {void}
   */
  _syncFromCurrentRealm(options = {}) {
    if (this._definitions.length === 0) return;

    const realmId = this._currentRealmId();
    const definition = realmId ? this._byRealm.get(realmId) : undefined;
    const entry = definition ? this._coerceEntry(definition) : null;
    const type = entry ? entry.tribulationType : null;

    if (!type) {
      this._state.tribulations.type = null;
      this._state.tribulations.pending = false;
      this._state.tribulations.survived = false;
      return;
    }

    const survived =
      options.preserveSurvived === true &&
      this._state.tribulations.survived === true;
    this._state.tribulations.type = type;
    this._state.tribulations.pending = !survived;
    this._state.tribulations.survived = survived;
  }

  /**
   * Resolve the current realm's id through the injected RealmSystem. Null
   * when no realmSystem was injected or its current() yields no usable id —
   * the current realm is then unresolvable (neutral gate, face() rejects
   * 'no-tribulation').
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
   * Defensive identity of the current realm through the injected
   * RealmSystem (used for the 'tribulation:finished' payload). Every field
   * defaults to null when the realm cannot resolve.
   *
   * @returns {{ realmId: string|null, realmName: string|null, tier: number|null }}
   *          the current realm's identity.
   */
  _currentRealmIdentity() {
    const current =
      this._realmSystem && typeof this._realmSystem.current === 'function'
        ? this._realmSystem.current()
        : null;
    return {
      realmId:
        current && typeof current.id === 'string' && current.id !== ''
          ? current.id
          : null,
      realmName:
        current && typeof current.name === 'string' && current.name !== ''
          ? current.name
          : null,
      tier:
        current && typeof current.tier === 'number' && Number.isFinite(current.tier)
          ? current.tier
          : null,
    };
  }

  /**
   * Merge a 'realm:changed' payload's identity with the realm-system
   * fallback: every usable payload field (string realmId/realmName, finite
   * tier) wins, anything unusable falls back to _currentRealmIdentity().
   *
   * @param {object} [payload] — the realm:changed payload.
   * @returns {{ realmId: string|null, realmName: string|null, tier: number|null }}
   *          the resolved identity.
   */
  _identityFromPayload(payload) {
    const current = this._currentRealmIdentity();
    return {
      realmId:
        payload && typeof payload.realmId === 'string' && payload.realmId !== ''
          ? payload.realmId
          : current.realmId,
      realmName:
        payload && typeof payload.realmName === 'string' && payload.realmName !== ''
          ? payload.realmName
          : current.realmName,
      tier:
        payload && typeof payload.tier === 'number' && Number.isFinite(payload.tier)
          ? payload.tier
          : current.tier,
    };
  }

  /**
   * Coerce a cached tribulation definition into the canonical internal shape
   * (fresh objects — never the deep-frozen cache). A definition that is not
   * a plain object coerces to null (unusable).
   *
   * @param {object} definition — a cached (frozen) tribulation definition.
   * @returns {{ realmId: string, tribulationType: string|null, results: Array<object> }|null}
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
      realmId:
        typeof definition.realmId === 'string' && definition.realmId !== ''
          ? definition.realmId
          : '',
      tribulationType: _coerceType(definition.tribulationType),
      results: _coerceResults(definition.results),
    };
  }

  /**
   * Weighted-roll an outcome from a coerced results table via the injected
   * random source: roll = random() × totalWeight, walked cumulatively
   * against the per-outcome weights (a larger weight = a wider bucket) — the
   * same walk as BreakthroughSystem._rollOutcome. Coercion guarantees a
   * non-empty table of positive weights, so the walk always lands; the
   * defensive fallbacks (zero total weight, roll at/past the cumulative end
   * — a hostile random source) return the first default / last entry
   * respectively.
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
   * Make sure the tribulations and cultivation slices are plain objects
   * before any read/write against them. A malformed slice restored from an
   * attacker-shaped save (null, a primitive or an array) is replaced with
   * the canonical fresh slice — restore-trust: a broken top-level slice must
   * never abort boot or throw per call. A healthy restored slice (even one
   * with extra or missing fields) is never clobbered.
   *
   * @returns {void}
   */
  _ensureSlices() {
    this._ensureSlice('tribulations', _freshTribulationsSlice);
    this._ensureSlice('cultivation', freshCultivationSlice);
  }

  /**
   * @param {string} name — top-level slice name in state (e.g. 'tribulations').
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
 * The canonical fresh tribulations slice (mirrors core/game-state.js). Used
 * as the restore-trust fallback when a restored tribulations slice is
 * unusable (null, a primitive or an array) — a broken top-level slice must
 * never abort boot or throw per call.
 *
 * @returns {{ type: null, pending: boolean, survived: boolean }} the
 *          canonical tribulations slice.
 */
function _freshTribulationsSlice() {
  return { type: null, pending: false, survived: false };
}

/**
 * Coerce a tribulationType: null unless it is a non-empty string in the
 * canonical type whitelist (a hostile or misspelled type like 'fire' reads
 * as ungated — never an unknown gate).
 *
 * @param {*} value — raw tribulationType from the definition.
 * @returns {string|null} the canonical type, or null.
 */
function _coerceType(value) {
  if (typeof value !== 'string' || value === '') return null;
  return CANONICAL_TYPES.has(value) ? value : null;
}

/**
 * Coerce a results table: entries must carry a canonical outcome id (death
 * is NOT canonical in v1 — DESIGN.md marks it 'future optional'), a finite
 * weight > 0 and a progressLoss clamped into 0..1 (absent defaults to 0 —
 * success outcomes never declare it — and present out-of-range values clamp
 * into 0..1, so a hostile value can never GAIN progress). An empty result
 * (or a table whose entries all failed coercion) falls back to the default
 * table [{survived 70},{injured 30}].
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
