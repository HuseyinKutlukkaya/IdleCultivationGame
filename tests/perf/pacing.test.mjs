/**
 * tests/perf/pacing.test.mjs — pacing guard for the P0 rebalance
 * (2026-08-15, user-directed "fix the first 10 minutes").
 *
 * Simulates a headless playthrough of the REAL systems wired exactly like
 * main.js (MeditationSystem → RealmSystem → QiSystem → BreakthroughSystem on
 * one state clone + the shared EventBus), driven by REAL data: the shipped
 * config (data/game-config.json), the shipped realm ladder
 * (data/realms/realms.json) and the shipped breakthrough tables
 * (data/breakthroughs/breakthroughs.json). A deterministic player advances
 * sub-layers the moment the current layer is full and attempts the
 * breakthrough at layer 9 (injected random → 0, a guaranteed success), then
 * the guard asserts the FIRST breakthrough lands in under 2 minutes of
 * simulated play.
 *
 * Why this guard exists (incident → guard, AGENTS.md): before the P0
 * rebalance, the shipped numbers made the first breakthrough take ~2 HOURS
 * (baseQiPerSecond 2 × realm progress 1000 × 9 sub-layers with the 1.15
 * layer factor). A plain data test could not catch that — the values were
 * finite, positive and monotonic. This sim makes "the game is actually
 * playable within minutes" an automated contract: any future retune that
 * pushes the first breakthrough past 2 minutes fails here.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { MeditationSystem } from '../../js/systems/meditation.js';
import { RealmSystem } from '../../js/systems/realms.js';
import { QiSystem } from '../../js/systems/qi.js';
import { BreakthroughSystem } from '../../js/systems/breakthroughs.js';

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Load the REAL shipped content relative to this test file. `new URL(...,
 * import.meta.url)` resolves against the module's own location, so the paths
 * work on any machine (portable — no absolute paths anywhere).
 */
const config = JSON.parse(
  readFileSync(new URL('../../data/game-config.json', import.meta.url), 'utf8')
);
const realmsData = JSON.parse(
  readFileSync(new URL('../../data/realms/realms.json', import.meta.url), 'utf8')
);
const breakthroughsData = JSON.parse(
  readFileSync(new URL('../../data/breakthroughs/breakthroughs.json', import.meta.url), 'utf8')
);

/** The shipped fixed simulation step (config.loop.tickRateMs). */
const TICK_RATE_MS = config.loop.tickRateMs;

/** The canonical realm ladder ids (file order = tier order). */
const REALM_IDS = realmsData.definitions.map((realm) => realm.id);

/** The canonical realm ladder display names (file order = tier order). */
const REALM_NAMES = realmsData.definitions.map((realm) => realm.name);

/**
 * Build a DataManager lookalike serving the REAL shipped collections — the
 * same shape the real DataManager exposes to the shipped systems (getAll by
 * collection id; get(collection, id) for item lookups).
 */
function makeRealDataManager() {
  return {
    getAll(collection) {
      if (collection === 'realms') return [...realmsData.definitions];
      if (collection === 'breakthroughs') return [...breakthroughsData.definitions];
      return [];
    },
    get(collection, id) {
      if (collection === 'items') return undefined;
      return undefined;
    },
  };
}

/**
 * Play the game headlessly until the FIRST breakthrough succeeds (or the
 * safety cap is hit). One tick = config.loop.tickRateMs of simulated play
 * (derived from the shipped config). The player (a) advances a sub-layer the
 * moment the current one is full and (b) attempts the breakthrough the
 * moment layer 9 is full — the same decisions a human makes through the
 * cultivation panel. The injected random source returns 0 → roll 0 →
 * 'perfect' bucket → guaranteed success.
 *
 * @param {number} [maxTicks] — safety cap in simulated seconds (default 600
 *        = 10 minutes; far above the 120s contract, so a regression fails
 *        with a clear timeout rather than an infinite loop).
 * @returns {{ state: object, firstBreakthroughAt: number|null }}
 *          the shared state at the moment of success (or after the cap) and
 *          the tick (second) at which the first breakthrough landed.
 */
function playUntilFirstBreakthrough(maxTicks = 600) {
  const state = structuredClone(GameState);
  const dataManager = makeRealDataManager();

  // Construction order mirrors main.js: meditation → realms → qi →
  // breakthroughs (the QiSystem's per-second write must run before the
  // BreakthroughSystem's accrual on every tick).
  const meditation = new MeditationSystem({ config, state, eventBus: EventBus });
  const realms = new RealmSystem({ config, state, eventBus: EventBus, dataManager });
  const qi = new QiSystem({ config, state, eventBus: EventBus });
  const breakthroughs = new BreakthroughSystem({
    config,
    state,
    eventBus: EventBus,
    realmSystem: realms,
    dataManager,
    random: () => 0,
  });

  assert.equal(state.cultivation.qiSources.meditation, config.meditation.baseQiPerSecond,
    'fresh active meditation must feed the real configured rate into the qi source slot');

  let firstBreakthroughAt = null;
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    // One simulated tick = config.loop.tickRateMs (derived from the shipped
    // config, so a future tick-rate retune stays in lockstep with the sim).
    EventBus.emit('loop:update', {
      deltaMs: TICK_RATE_MS,
      elapsedMs: tick * TICK_RATE_MS,
      tick,
    });

    const req = breakthroughs.requirements();
    if (req.progressMet && !req.layerMet) {
      // The layer is full and the cultivator is below layer 9 → advance it
      // (the same action the panel's "Advance Layer" button performs).
      assert.equal(realms.advanceLayer(), true, `advanceLayer must succeed at tick ${tick}`);
    } else if (req.canAttempt) {
      const result = breakthroughs.attempt();
      if (result.advanced) {
        firstBreakthroughAt = tick;
        break;
      }
    }
  }

  return { state, firstBreakthroughAt };
}

test('the first breakthrough lands in under 2 minutes of simulated play (real config + real data)', () => {
  const { state, firstBreakthroughAt } = playUntilFirstBreakthrough();

  assert.notEqual(
    firstBreakthroughAt,
    null,
    'the sim must reach a first breakthrough within the safety cap — if this fails, ' +
      'the shipped numbers make the first breakthrough effectively unreachable'
  );
  assert.ok(
    firstBreakthroughAt < 120,
    `first breakthrough took ${firstBreakthroughAt}s — the pacing contract is < 120s ` +
      '(P0 rebalance, tests/README.md dated note 2026-08-15)'
  );

  // The qi pool must still be climbing at the moment of the first
  // breakthrough — the 'screen goes dead' complaint was a cap hit too early
  // (baseMaxQi 100 at the old 2 qi/s rate). With baseMaxQi 2000 the pool
  // fills at 20 qi/s and the first breakthrough lands before the cap.
  assert.ok(
    state.cultivation.qi < state.cultivation.qiMax,
    `qi (${state.cultivation.qi}) must still be below the cap (${state.cultivation.qiMax}) ` +
      'at the first breakthrough — the pool should never go dead before it'
  );

  // Sanity: the breakthrough actually advanced the ladder to Qi Gathering
  // (cultivation.realm holds the display name) and the progress max
  // re-synced to that realm's (real) entry.
  assert.equal(state.cultivation.realm, REALM_NAMES[1],
    'the first breakthrough must land in Qi Gathering');
  const qiGathering = breakthroughsData.definitions.find(
    (entry) => entry.realmId === REALM_IDS[1]
  );
  assert.ok(qiGathering, 'the landed realm must have a breakthrough entry');
  assert.equal(
    state.cultivation.realmProgressMax,
    qiGathering.requiredProgress,
    'realmProgressMax must re-sync to the landed realm entry after the breakthrough'
  );
});

test('the realm ladder stays monotonic against the layer factor (sanity for the pacing contract)', () => {
  // Each realm takes 9 sub-layers at 1.15× the base, so the real time to
  // clear a realm is requiredProgress × 14.4 / (qi/s × realm speed). The
  // guard above pins the FIRST breakthrough; this test keeps the whole
  // ladder's shape sane so a curve edit cannot silently invert late-game
  // pacing while the early game still passes.
  const { cultivation } = config;
  const progressCurve = breakthroughsData.definitions.map((entry) => entry.requiredProgress);
  for (let index = 1; index < progressCurve.length; index += 1) {
    assert.ok(
      progressCurve[index] > progressCurve[index - 1],
      `requiredProgress must be strictly increasing at realm index ${index} ` +
        `(${progressCurve[index - 1]} -> ${progressCurve[index]})`
    );
  }

  // The shipped config must still declare the 9-layer / 1.15 contract the
  // pacing math above relies on.
  assert.equal(cultivation.layerMax, 9, 'the realm layer count must be 9');
  assert.equal(cultivation.layerFactor, 0.15, 'the realm layer factor must be 0.15');
});