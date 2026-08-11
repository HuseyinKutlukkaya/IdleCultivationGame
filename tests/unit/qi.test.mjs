/**
 * tests/unit/qi.test.mjs — unit tests for js/systems/qi.js.
 *
 * Exercises the QiSystem (single owner of the qi resource): the config-driven
 * cap and sources (missing block silent, invalid baseMaxQi warns once and
 * leaves the cap untouched, malformed source entries skipped with warnings),
 * the constructor's immediate sync of qiMax and qiPerSecond, the
 * 'loop:update' tick aggregation (sum of source rates, gain = sum ×
 * deltaMs/1000, cap clamping, 'qi:gained' payload { amount, total, sources },
 * statistics.qiGenerated, zero-gain silence), safe ratePath resolution
 * (missing slices and prototype-chain paths never throw or pollute), the
 * write-only-when-changed qiPerSecond sync, restore compatibility, restore-
 * trust slice repair (malformed cultivation/statistics slices never abort
 * boot or the tick and gains flow normally after repair), the finite-write
 * guard (a restored value at the double limit never puts Infinity into
 * state), the cap-shrink clamp (a smaller cap brings the pool down with it),
 * the realm-multiplier stacking (cultivation.realmEffects.qiMaxMultiplier
 * multiplies the managed cap and cultivationSpeedMultiplier multiplies the
 * aggregate rate, with neutral coercion for missing/malformed factors and a
 * finite clamp so an absurd restored multiplier never overflows), the
 * spirit-root-multiplier stacking (cultivation.spiritRootMultiplier
 * multiplies the aggregate rate with the same neutral-1 coercion while the
 * CAP is deliberately NOT affected — a spirit root speeds up cultivation,
 * it never enlarges the cap; the realm speed multiplier AND the spirit-root
 * multiplier stack multiplicatively) and destroy() unsubscription.
 *
 * Each test injects a fresh deep clone of GameState (so the shared singleton
 * stays pristine) and the shared EventBus (cleared in beforeEach so event
 * assertions start clean). No clock is needed — QiSystem derives everything
 * from the 'loop:update' payload.
 *
 * Run: the full suite as documented in tests/README.md (`node --test` with
 * the quoted glob form, not the bare-directory form).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { GameState } from '../../js/core/game-state.js';
import { QiSystem } from '../../js/systems/qi.js';

const TICK_MS = 1000;

/** Reset the shared bus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * Build a standard config with a qi block (mirrors the real
 * data/game-config.json block) plus optional overrides.
 *
 * @param {object} [overrides] — key/values merged over the qi block.
 * @returns {object} a config object.
 */
function makeConfig(overrides = {}) {
  return {
    qi: {
      baseMaxQi: 100,
      sources: [
        { id: 'meditation', label: 'Meditation', ratePath: 'cultivation.qiSources.meditation' },
      ],
      ...overrides,
    },
  };
}

/**
 * Build a QiSystem instance with a fresh state clone (unless overridden).
 *
 * @param {object} [config] — config to inject (defaults to makeConfig()).
 * @param {object} [state] — state to inject (defaults to a GameState clone).
 * @returns {QiSystem} the system instance.
 */
function makeSystem(config = makeConfig(), state = structuredClone(GameState)) {
  return new QiSystem({ config, state, eventBus: EventBus });
}

test('a missing config.qi block is silent and leaves everything untouched', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem({}, state);

  // No warning for the missing block; the cap stays at the state value and
  // there are no sources (aggregate rate 0).
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(system.baseMaxQi, null);
  assert.deepEqual(system.sources, []);
  assert.equal(state.cultivation.qiMax, 100);
  assert.equal(state.cultivation.qiPerSecond, 0);

  // A tick produces nothing and never crashes.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 0);
});

test('an invalid baseMaxQi warns once and leaves qiMax untouched', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const state = structuredClone(GameState);

  const system = makeSystem(makeConfig({ baseMaxQi: -5 }), state);

  assert.equal(warn.mock.callCount(), 1);
  assert.equal(system.baseMaxQi, null);
  // Unmanaged cap: the state value governs and is not overwritten.
  assert.equal(state.cultivation.qiMax, 100);
});

test('the constructor syncs qiMax from baseMaxQi', () => {
  // Fresh state placeholder 100 with a config 100 → stays 100.
  const same = structuredClone(GameState);
  makeSystem(makeConfig(), same);
  assert.equal(same.cultivation.qiMax, 100);

  // Config 250 → the derived cap overwrites the placeholder 100.
  const raised = structuredClone(GameState);
  makeSystem(makeConfig({ baseMaxQi: 250 }), raised);
  assert.equal(raised.cultivation.qiMax, 250);
});

test('the constructor syncs qiPerSecond from the current source rates', () => {
  // A restored state whose meditation slot is already 2 (active session)
  // shows the aggregate rate before the first tick.
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 2);
});

test('a tick aggregates multiple configured sources into rate, gain and event', () => {
  const config = makeConfig({
    sources: [
      { id: 'a', ratePath: 'cultivation.qiSources.a' },
      { id: 'b', label: 'B', ratePath: 'cultivation.qiSources.b' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiSources.a = 2;
  state.cultivation.qiSources.b = 3;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(config, state);

  // The kept source 'a' has no label — it falls back to its id.
  assert.equal(state.cultivation.qiPerSecond, 5);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qiPerSecond, 5);
  assert.equal(state.cultivation.qi, 5);
  assert.equal(state.statistics.qiGenerated, 5);
  assert.equal(gained.length, 1);
  assert.deepEqual(gained[0], { amount: 5, total: 5, sources: ['a', 'b'] });
});

test('the tick gain uses the payload deltaMs (no hardcoded 1000ms)', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  // Half a tick at 2 qi/s → 1 qi.
  EventBus.emit('loop:update', { deltaMs: 500, elapsedMs: 500, tick: 1 });

  assert.equal(state.cultivation.qi, 1);
  assert.equal(state.statistics.qiGenerated, 1);
});

test('qi never exceeds qiMax and zero-gain ticks emit nothing', () => {
  const state = structuredClone(GameState);
  state.cultivation.qi = 99; // qiMax defaults to 100
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(makeConfig(), state);

  // Raw gain 2, but only 1 fits below the cap.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(state.cultivation.qi, 100);
  assert.equal(state.statistics.qiGenerated, 1);
  assert.equal(gained.length, 1);
  assert.deepEqual(gained[0], { amount: 1, total: 100, sources: ['meditation'] });

  // At the cap: no gain, no event (avoid zero-gain noise).
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.equal(state.cultivation.qi, 100);
  assert.equal(state.statistics.qiGenerated, 1);
  assert.equal(gained.length, 1);
});

test('a tick emits qi:gained with the exact payload shape', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(makeConfig(), state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(gained.length, 1);
  // Payload shape: { amount, total, sources } — the id of every source that
  // contributed a positive rate this tick.
  assert.deepEqual(gained[0], { amount: 2, total: 2, sources: ['meditation'] });
});

test('statistics.qiGenerated accrues across ticks', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });

  assert.equal(state.statistics.qiGenerated, 4);
});

test('zero-rate sources yield a zero aggregate rate, no gain and no event', () => {
  const state = structuredClone(GameState); // meditation slot defaults to 0
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 0);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.statistics.qiGenerated, 0);
  assert.equal(gained.length, 0);
});

test('a source ratePath resolving to undefined (missing slice) contributes 0', () => {
  const config = makeConfig({
    sources: [
      { id: 'ghost', ratePath: 'cultivation.ghost.missing' },
      { id: 'meditation', ratePath: 'cultivation.qiSources.meditation' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(config, state);

  // Only the meditation source contributes; the ghost path yields 0.
  assert.equal(state.cultivation.qiPerSecond, 2);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 2);
  assert.deepEqual(gained[0].sources, ['meditation']);
});

test('unsafe source ratePaths can never reach the prototype chain', () => {
  for (const ratePath of ['__proto__.x', 'constructor.prototype.x']) {
    EventBus.clear();
    const config = makeConfig({
      sources: [{ id: 'polluter', ratePath }],
    });
    const state = structuredClone(GameState);

    const system = makeSystem(config, state); // construction never throws

    assert.equal(state.cultivation.qiPerSecond, 0);
    EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
    assert.equal(state.cultivation.qi, 0);
    // Object.prototype is untouched, whatever the path looked like.
    assert.equal({}.x, undefined);
    assert.equal({}.hasOwnProperty('x'), false);
    assert.equal(system.sources[0].ratePath, ratePath);
  }
});

test('malformed source entries are skipped with warnings, valid ones are kept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const config = makeConfig({
    sources: [
      null,
      { id: 'broken' }, // missing ratePath
      { id: '', ratePath: 'cultivation.qiSources.meditation' }, // empty id
      { id: 'meditation', ratePath: 'cultivation.qiSources.meditation' },
    ],
  });
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  const system = makeSystem(config, state);

  // null + broken + empty are skipped (three warnings), meditation is kept.
  assert.equal(warn.mock.callCount(), 3);
  assert.equal(system.sources.length, 1);
  assert.equal(system.sources[0].id, 'meditation');
  // The kept source's label falls back to its id when absent.
  assert.equal(system.sources[0].label, 'meditation');
  // The kept source still feeds the aggregate rate.
  assert.equal(state.cultivation.qiPerSecond, 2);
});

test('a non-array sources value warns once and yields no sources', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});

  const system = makeSystem(makeConfig({ sources: 'meditation' }));

  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(system.sources, []);
});

test('qiPerSecond is only written when the aggregate rate changes', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);
  assert.equal(state.cultivation.qiPerSecond, 2);

  // Instrument the field to count subsequent writes.
  const writes = [];
  Object.defineProperty(state.cultivation, 'qiPerSecond', {
    configurable: true,
    get: () => 2,
    set: (value) => {
      writes.push(value);
    },
  });

  // A steady tick at the same aggregate rate must not write the field.
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.deepEqual(writes, []);

  // A changed aggregate rate (the meditation slot moves to 3) writes once.
  state.cultivation.qiSources.meditation = 3;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: 2 * TICK_MS, tick: 2 });
  assert.deepEqual(writes, [3]);
});

test('destroy() unsubscribes — ticks no longer mutate state', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  const system = makeSystem(makeConfig(), state);
  system.destroy();

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 0);
  assert.equal(state.statistics.qiGenerated, 0);
  assert.equal(gained.length, 0);
});

test('restore compatibility: a restored state with qi above 0 keeps producing on top', () => {
  // e.g. a restored save where qi was already partially filled.
  const state = structuredClone(GameState);
  state.cultivation.qi = 50;
  state.cultivation.qiMax = 100;
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 52);
  assert.equal(state.statistics.qiGenerated, 2);
});

test('a restored cultivation slice that is null is repaired and never aborts boot', () => {
  // An attacker-shaped save with cultivation: null must neither throw in the
  // constructor (the cap/rate sync writes through the slice) nor per-tick.
  const state = structuredClone(GameState);
  state.cultivation = null;

  const system = makeSystem(makeConfig(), state); // must not throw

  // Repaired to the canonical fresh cultivation slice (see core/game-state.js).
  assert.deepEqual(state.cultivation, {
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
    spiritRootMultiplier: 1,
    qi: 0,
    qiMax: 100,
    qiPerSecond: 0,
    qiSources: { meditation: 0 },
    breakthroughs: 0,
  });

  // Gains flow normally after repair.
  state.cultivation.qiSources.meditation = 2;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 2);
  assert.equal(state.statistics.qiGenerated, 2);
});

test('restored primitive cultivation and null statistics slices are repaired', () => {
  const state = structuredClone(GameState);
  state.cultivation = 5; // a primitive top-level slice
  state.statistics = null;

  const system = makeSystem(makeConfig(), state); // must not throw

  // The cultivation slice is repaired on construction (the cap/rate sync
  // writes through it); the statistics slice is repaired on the first tick.
  assert.equal(typeof state.cultivation, 'object');
  assert.equal(Array.isArray(state.cultivation), false);
  assert.deepEqual(state.cultivation.qiSources, { meditation: 0 });
  assert.equal(state.statistics, null);

  // Gains flow normally after repair — the tick repairs statistics too.
  state.cultivation.qiSources.meditation = 3;
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 3);
  assert.deepEqual(state.statistics, {
    playtimeMs: 0,
    meditationsCompleted: 0,
    breakthroughsTotal: 0,
    qiGenerated: 3,
  });
});

test('the finite-write guard: a restored value at the double limit never overflows', () => {
  // Unmanaged cap (no baseMaxQi) so the room below the cap stays huge. The
  // absurd-but-finite restored rate is clamped to MAX_SAFE_INTEGER by the
  // realm-multiplier aggregation (a hostile save can never overflow the rate
  // field), but an absurd deltaMs still overflows gain = rate × deltaMs/1000
  // to Infinity — the guard must drop the whole gain (no qi write, no
  // statistics write, no event) rather than put Infinity into state.
  const config = makeConfig({ baseMaxQi: undefined });
  const state = structuredClone(GameState);
  state.cultivation.qiMax = Number.MAX_VALUE;
  state.cultivation.qi = 1e308; // restored near the double limit
  state.cultivation.qiSources.meditation = 1e308; // huge but finite rate
  state.statistics.qiGenerated = Number.MAX_VALUE; // attacker-shaped value
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));

  makeSystem(config, state);

  // The clamped rate is finite (never the raw 1e308, never Infinity).
  assert.equal(state.cultivation.qiPerSecond, Number.MAX_SAFE_INTEGER);

  EventBus.emit('loop:update', { deltaMs: 1e308, elapsedMs: 1e308, tick: 1 });

  assert.equal(state.cultivation.qi, 1e308);
  assert.equal(state.statistics.qiGenerated, Number.MAX_VALUE);
  assert.equal(gained.length, 0);
  // The rate field the system did sync stays finite too.
  assert.equal(Number.isFinite(state.cultivation.qiPerSecond), true);
});

test('the qi pool is clamped down when the derived cap shrinks', () => {
  const state = structuredClone(GameState);
  state.cultivation.qi = 80; // restored above the configured cap below
  state.cultivation.qiMax = 100;
  state.cultivation.qiSources.meditation = 2;

  // baseMaxQi 50 < restored qi 80 → the cap shrinks and the pool follows.
  makeSystem(makeConfig({ baseMaxQi: 50 }), state);

  assert.equal(state.cultivation.qiMax, 50);
  assert.equal(state.cultivation.qi, 50);

  // A growing cap never touches qi.
  const grown = structuredClone(GameState);
  grown.cultivation.qi = 50;
  grown.cultivation.qiMax = 100;
  makeSystem(makeConfig({ baseMaxQi: 250 }), grown);
  assert.equal(grown.cultivation.qiMax, 250);
  assert.equal(grown.cultivation.qi, 50);
});

test('getters expose the configured cap and defensive source copies', () => {
  const system = makeSystem();

  assert.equal(system.baseMaxQi, 100);
  assert.equal(system.sources[0].label, 'Meditation');

  // Shallow copies: mutating a returned source must not leak back.
  const copy = system.sources[0];
  copy.id = 'hacked';
  assert.equal(system.sources[0].id, 'meditation');
  assert.equal(system.baseMaxQi, 100);
});

test('realm effects stack: qiMaxMultiplier multiplies the managed cap', () => {
  // The RealmSystem writes cultivation.realmEffects; a qiMaxMultiplier of 2
  // doubles the configured baseMaxQi (100 → 200) on the constructor sync.
  const state = structuredClone(GameState);
  state.cultivation.realmEffects.qiMaxMultiplier = 2;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiMax, 200);
  // The unmanaged path (no baseMaxQi) keeps the state value untouched.
  const unmanaged = structuredClone(GameState);
  unmanaged.cultivation.realmEffects.qiMaxMultiplier = 2;
  makeSystem(makeConfig({ baseMaxQi: undefined }), unmanaged);
  assert.equal(unmanaged.cultivation.qiMax, 100);
});

test('realm effects stack: cultivationSpeedMultiplier multiplies the aggregate rate', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  state.cultivation.realmEffects.cultivationSpeedMultiplier = 1.5;

  makeSystem(makeConfig(), state);

  // 2 qi/s × 1.5 → the constructor sync already exposes 3.
  assert.equal(state.cultivation.qiPerSecond, 3);

  // A full tick gains 3 (not the raw 2), and the event reports the gain.
  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 3);
  assert.equal(state.statistics.qiGenerated, 3);
  assert.deepEqual(gained[0], { amount: 3, total: 3, sources: ['meditation'] });
});

test('a missing or malformed realmEffects object is neutral (multiplier 1)', () => {
  for (const effects of [undefined, null, 'hostile', [], {}]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    if (effects === undefined) delete state.cultivation.realmEffects;
    else state.cultivation.realmEffects = effects;
    state.cultivation.qiSources.meditation = 2;

    makeSystem(makeConfig(), state);

    // Neutral cap (100 × 1) and neutral rate (2 × 1).
    assert.equal(state.cultivation.qiMax, 100);
    assert.equal(state.cultivation.qiPerSecond, 2);
  }
});

test('a missing or malformed realm multiplier field is neutral (multiplier 1)', () => {
  const state = structuredClone(GameState);
  state.cultivation.realmEffects.qiMaxMultiplier = -5; // <= 0
  state.cultivation.realmEffects.cultivationSpeedMultiplier = 'bogus'; // non-finite
  state.cultivation.qiSources.meditation = 2;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiMax, 100);
  assert.equal(state.cultivation.qiPerSecond, 2);
});

test('a hostile absurd realm multiplier can never put Infinity into qiMax/qiPerSecond', () => {
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  state.cultivation.realmEffects.qiMaxMultiplier = 1e308;
  state.cultivation.realmEffects.cultivationSpeedMultiplier = 1e308;

  makeSystem(makeConfig(), state);

  // 100 × 1e308 and 2 × 1e308 both overflow the double range — clamped to a
  // finite MAX_SAFE_INTEGER, never Infinity.
  assert.equal(Number.isFinite(state.cultivation.qiMax), true);
  assert.equal(Number.isFinite(state.cultivation.qiPerSecond), true);
  assert.equal(state.cultivation.qiMax, Number.MAX_SAFE_INTEGER);
  assert.equal(state.cultivation.qiPerSecond, Number.MAX_SAFE_INTEGER);

  // A tick at the clamped cap/rate stays finite too (no NaN/Infinity writes).
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(Number.isFinite(state.cultivation.qi), true);
  assert.equal(Number.isFinite(state.statistics.qiGenerated), true);
});

test('a hostile negative source rate clamps to neutral 0 — never a sign-flipped rate', () => {
  // A hostile save with a negative source rate (-1e308) times an absurd
  // multiplier (1e308) overflows to -Infinity. The rate must land at the
  // neutral 0 (no production), never silently flip sign to +MAX_SAFE_INTEGER.
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = -1e308;
  state.cultivation.realmEffects.cultivationSpeedMultiplier = 1e308;

  makeSystem(makeConfig(), state);

  assert.equal(state.cultivation.qiPerSecond, 0);
  assert.equal(Number.isFinite(state.cultivation.qiPerSecond), true);

  // A plain negative source rate (finite, no overflow) is neutral too — the
  // rate never carries a negative sign into the pool.
  const negative = structuredClone(GameState);
  negative.cultivation.qiSources.meditation = -5;

  makeSystem(makeConfig(), negative);

  assert.equal(negative.cultivation.qiPerSecond, 0);
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });
  assert.equal(negative.cultivation.qi, 0);
});

test('the spirit-root multiplier scales the aggregate rate', () => {
  // The SpiritRootSystem writes cultivation.spiritRootMultiplier from the
  // rolled root's speedMultiplier; a factor of 2 doubles the per-second rate.
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  state.cultivation.spiritRootMultiplier = 2;

  makeSystem(makeConfig(), state);

  // 2 qi/s × 2 → the constructor sync already exposes 4.
  assert.equal(state.cultivation.qiPerSecond, 4);
  // The cap is NOT affected (100 × realm 1).
  assert.equal(state.cultivation.qiMax, 100);

  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 4);
  assert.equal(state.statistics.qiGenerated, 4);
  assert.deepEqual(gained[0], { amount: 4, total: 4, sources: ['meditation'] });
});

test('the spirit-root multiplier never touches the qi cap', () => {
  // The cap is realm/base-driven: a spirit root speeds up cultivation, it
  // never enlarges the dantian. Even a large spirit-root factor leaves
  // qiMax at the realm-multiplied value.
  const state = structuredClone(GameState);
  state.cultivation.realmEffects.qiMaxMultiplier = 2;
  state.cultivation.spiritRootMultiplier = 2;

  makeSystem(makeConfig(), state);

  // 100 × 2 (realm only) → 200 — the spirit-root factor never multiplies in.
  assert.equal(state.cultivation.qiMax, 200);

  // The unmanaged path keeps the state value untouched too.
  const unmanaged = structuredClone(GameState);
  unmanaged.cultivation.realmEffects.qiMaxMultiplier = 2;
  unmanaged.cultivation.spiritRootMultiplier = 2;
  makeSystem(makeConfig({ baseMaxQi: undefined }), unmanaged);
  assert.equal(unmanaged.cultivation.qiMax, 100);
});

test('a missing or malformed spirit-root multiplier is neutral (multiplier 1)', () => {
  // A missing slot (an old save before the SpiritRootSystem), a hostile
  // non-positive factor and a non-finite factor must all read as the neutral
  // 1 — the rate can never be zeroed or pushed to Infinity by the slot.
  for (const multiplier of [undefined, null, -5, 0, 'bogus', NaN, Infinity]) {
    EventBus.clear();
    const state = structuredClone(GameState);
    if (multiplier === undefined) delete state.cultivation.spiritRootMultiplier;
    else state.cultivation.spiritRootMultiplier = multiplier;
    state.cultivation.qiSources.meditation = 2;

    makeSystem(makeConfig(), state);

    assert.equal(state.cultivation.qiPerSecond, 2);
    assert.equal(state.cultivation.qiMax, 100);
  }
});

test('realm speed multiplier and spirit-root multiplier stack', () => {
  // Both factors multiply the aggregate rate — the realm's
  // cultivationSpeedMultiplier AND the spirit root's slot.
  const state = structuredClone(GameState);
  state.cultivation.qiSources.meditation = 2;
  state.cultivation.realmEffects.cultivationSpeedMultiplier = 1.5;
  state.cultivation.spiritRootMultiplier = 2;

  makeSystem(makeConfig(), state);

  // 2 qi/s × 1.5 (realm) × 2 (spirit root) → 6.
  assert.equal(state.cultivation.qiPerSecond, 6);

  const gained = [];
  EventBus.subscribe('qi:gained', (payload) => gained.push(payload));
  EventBus.emit('loop:update', { deltaMs: TICK_MS, elapsedMs: TICK_MS, tick: 1 });

  assert.equal(state.cultivation.qi, 6);
  assert.equal(state.statistics.qiGenerated, 6);
  assert.deepEqual(gained[0], { amount: 6, total: 6, sources: ['meditation'] });
});
