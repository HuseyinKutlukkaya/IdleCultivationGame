/**
 * tests/unit/cultivation-panel.test.mjs — unit tests for js/ui/cultivation-panel.js.
 *
 * Exercises the Cultivation panel initializer under fakes (the real shared
 * EventBus for subscribe/unsubscribe + emission recording, FAKE
 * breakthroughs/tribulations systems returning canned requirements()/
 * canAttempt()/attempt()/face() results — the real systems are never
 * imported here — and a fake root DOM). Coverage:
 *
 *   - Constructor resolves [data-cultivation-panel] + [data-cultivation-body]
 *     once, registers exactly ONE delegated click listener and renders the
 *     character readout (spirit root + meridians from state).
 *   - Missing root.querySelector / missing panel / missing state → no-op
 *     handle that warns once and returns false from applyBreakthrough /
 *     applyFace.
 *   - Breakthrough button: disabled with a gate-reason line for the FOUR
 *     canonical gating reasons (progress / tribulation / max-realm /
 *     no-definition), enabled with the "Ready — breakthrough available"
 *     readiness line when canAttempt() is true. Cost / items branches are
 *     GONE — the informational flags do not gate (P1 #5).
 *   - Click delegation routes [data-cultivation-breakthrough] and
 *     [data-cultivation-progress-action] clicks to applyBreakthrough() and
 *     [data-cultivation-face] clicks to applyFace(); a click outside any
 *     anchor is a no-op.
 *   - applyBreakthrough renders success ("Breakthrough to X!") and failure
 *     ("Breakthrough failed.") feedback for accepted attempts AND surfaces
 *     a blocked-reason feedback string when the system rejects (instant
 *     feedback #4 — no silent dead button).
 *   - Tribulation block: absent when the realm imposes no type; visible with
 *     an enabled face button while pending; applyFace renders survived /
 *     overwhelmed feedback.
 *   - Missing breakthroughs / tribulations dependencies warn ONCE per apply
 *     call and return false; the panel degrades (disabled button / no block).
 *   - destroy() removes the click listener and unsubscribes every subscribed
 *     event (idempotent).
 *   - Every subscribed event ('realm:changed', 'realm:breakthrough',
 *     'tribulation:finished', 'resource:changed', 'ui:refresh',
 *     'loop:uiRefresh') re-renders the panel from the fresh system snapshots.
 *   - NO console warnings/errors during a normal session; NO innerHTML usage
 *     anywhere in the module source.
 *
 * Run: node --test tests/unit/cultivation-panel.test.mjs (or the full suite
 * as documented in tests/README.md).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../js/core/event-bus.js';
import { initCultivationPanel } from '../../js/ui/cultivation-panel.js';

/** CSS selector the module resolves on root for the panel article. */
const PANEL_SELECTOR = '[data-cultivation-panel]';

/** CSS selector the module resolves on the article for the body container. */
const BODY_SELECTOR = '[data-cultivation-body]';

/** CSS selector for the Breakthrough button (delegated click anchor). */
const BREAKTHROUGH_SELECTOR = '[data-cultivation-breakthrough]';

/** CSS selector for the Face Tribulation button (delegated click anchor). */
const FACE_SELECTOR = '[data-cultivation-face]';

/** CSS selector for the cross-panel actionable progress bar. */
const PROGRESS_ACTION_SELECTOR = '[data-cultivation-progress-action]';

/** CSS selector for the hint line next to the progress bar. */
const PROGRESS_HINT_SELECTOR = '[data-cultivation-progress-hint]';

/** Every event the panel subscribes to (mirrors the module's contract). */
const SUBSCRIBED_EVENTS = [
  'realm:changed',
  'realm:breakthrough',
  'tribulation:finished',
  'resource:changed',
  'ui:refresh',
  'loop:uiRefresh',
];

/** Reset the shared EventBus before every test. */
beforeEach(() => {
  EventBus.clear();
});

/**
 * A deterministic number formatter for assertions: formats as plain decimal
 * text (no Intl, no locale separators — a machine-independent baseline).
 *
 * @param {number} value — the number to format.
 * @returns {string} String(value).
 */
function identityFormatter(value) {
  return String(value);
}

/**
 * Build a fake root with a settable panel + body + cross-panel progress bar
 * + hint. The root records addEventListener / removeEventListener calls (for
 * the delegated click), the body tracks appended children +
 * replaceChildren, the article resolves the body, ownerDocument.createElement
 * returns text-bearing fake nodes, and the progress bar carries classList +
 * the hint carries a `hidden` flag the panel can flip.
 *
 * The `progressBar` / `progressHint` objects are exposed on the returned
 * handle so tests can inspect their classes / hidden state after render().
 * Either is optional (controlled by `includeProgress` / `includeHint`) so
 * tests covering a stripped markup can run with them absent.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeProgress=true] — include the progress bar.
 * @param {boolean} [options.includeHint=true] — include the progress hint
 *        (only meaningful when includeProgress is true).
 * @returns {{ root: object, panel: object, body: object, listeners: object,
 *           progressBar: object|null, progressHint: object|null,
 *           progressBarParent: object|null }}
 */
function createFakeRoot(options = {}) {
  const { includeProgress = true, includeHint = true } = options;
  const listeners = { click: [] };
  const body = {
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      this.children.length = 0;
      for (const node of nodes) this.children.push(node);
    },
  };
  const panel = {
    selector: PANEL_SELECTOR,
    querySelector(selector) {
      return selector === BODY_SELECTOR ? body : null;
    },
  };

  // Fake progress bar: classList.toggle(cls, on) is what the module calls;
  // `classes` is a Set so a test can assert membership directly.
  const progressClasses = new Set();
  /** @type {object|null} */
  let progressBar = null;
  /** @type {object|null} */
  let progressHint = null;
  /** @type {object|null} */
  let progressBarParent = null;
  if (includeProgress) {
    progressBar = {
      attrs: { [PROGRESS_ACTION_SELECTOR.slice(1).replace(/]/g, '')]: '' },
      classes: progressClasses,
      classList: {
        add(...names) {
          for (const name of names) progressClasses.add(name);
        },
        remove(...names) {
          for (const name of names) progressClasses.delete(name);
        },
        toggle(cls, on) {
          if (on === undefined) on = !progressClasses.has(cls);
          if (on) progressClasses.add(cls);
          else progressClasses.delete(cls);
        },
        contains(cls) {
          return progressClasses.has(cls);
        },
      },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
      },
      parentElement: null,
    };
    if (includeHint) {
      progressHint = {
        attrs: { [PROGRESS_HINT_SELECTOR.slice(1).replace(/]/g, '')]: '' },
        hidden: true,
        setAttribute(name, value) {
          this.attrs[name] = String(value);
        },
        getAttribute(name) {
          return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
        },
      };
    }
    progressBarParent = {
      children: includeHint ? [progressBar, progressHint] : [progressBar],
      querySelector(selector) {
        if (selector === PROGRESS_HINT_SELECTOR) return progressHint;
        if (selector === PROGRESS_ACTION_SELECTOR) return progressBar;
        return null;
      },
    };
    progressBar.parentElement = progressBarParent;
  }

  const root = {
    querySelector(selector) {
      if (selector === PANEL_SELECTOR) return panel;
      if (selector === PROGRESS_ACTION_SELECTOR) return progressBar;
      return null;
    },
    addEventListener(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = listeners[type];
      if (!bucket) return;
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    },
    ownerDocument: {
      createElement(tag) {
        const classes = new Set();
        const attrs = Object.create(null);
        const children = [];
        let text = '';
        return {
          tag,
          classes,
          attrs,
          children,
          classList: {
            add(...names) {
              for (const name of names) classes.add(name);
            },
          },
          appendChild(node) {
            children.push(node);
            return node;
          },
          get textContent() {
            return text;
          },
          set textContent(value) {
            text = String(value);
          },
          setAttribute(name, value) {
            attrs[name] = String(value);
          },
          getAttribute(name) {
            return Object.hasOwn(attrs, name) ? attrs[name] : null;
          },
        };
      },
    },
  };
  return { root, panel, body, listeners, progressBar, progressHint, progressBarParent };
}

/**
 * Find a body child (or, when `deep`, a descendant) carrying the given
 * data attribute.
 *
 * @param {object} container — the fake body (children array).
 * @param {string} attr — data attribute name (without the `data-` prefix
 *        matching: pass the full name, e.g. 'data-cultivation-breakthrough').
 * @param {boolean} [deep=false] — search nested children too.
 * @returns {object|null} the matching node, or null.
 */
function findNode(container, attr, deep = false) {
  for (const child of container.children) {
    if (child.attrs && child.attrs[attr] !== undefined) return child;
    if (deep) {
      const nested = findNode(child, attr, true);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Build a fake BreakthroughSystem handle exposing requirements()/canAttempt()/
 * attempt(). Each method can be overridden; the fake records attempt() calls.
 *
 * @param {object} [overrides] — partial overrides.
 * @returns {object} the fake.
 */
function createFakeBreakthroughs(overrides = {}) {
  const attemptCalls = [];
  // An `attempt` override still goes through the recording wrapper so
  // attemptCalls stays the single source of truth for "the panel asked the
  // system" (the override only changes the fake's return/mutation).
  const { attempt: overrideAttempt, ...rest } = overrides;
  return {
    attemptCalls,
    requirements() {
      return {
        realmId: 'mortal',
        requiredProgress: 1000,
        progress: 0,
        progressMet: false,
        cost: { spiritStones: 0 },
        costMet: true,
        bottleneck: [],
        bottleneckMet: true,
        tribulationRequired: false,
        tribulationMet: true,
        layer: 1,
        layerMax: 9,
        layerMet: false,
        canAttempt: false,
      };
    },
    canAttempt() {
      return this.requirements().canAttempt;
    },
    attempt() {
      attemptCalls.push(1);
      if (typeof overrideAttempt === 'function') return overrideAttempt();
      return { outcome: null, advanced: false, reason: 'progress' };
    },
    ...rest,
  };
}

/**
 * Build a fake TribulationSystem handle exposing requirements()/canFace()/
 * face(). Each method can be overridden; the fake records face() calls.
 *
 * @param {object} [overrides] — partial overrides.
 * @returns {object} the fake.
 */
function createFakeTribulations(overrides = {}) {
  const faceCalls = [];
  // A `face` override still goes through the recording wrapper so faceCalls
  // stays the single source of truth for "the panel asked the system".
  const { face: overrideFace, ...rest } = overrides;
  return {
    faceCalls,
    requirements() {
      return {
        realmId: 'mortal',
        type: null,
        pending: false,
        survived: false,
        canFace: false,
      };
    },
    canFace() {
      return this.requirements().canFace;
    },
    face() {
      faceCalls.push(1);
      if (typeof overrideFace === 'function') return overrideFace();
      return { outcome: null, survived: false, reason: 'no-tribulation' };
    },
    ...rest,
  };
}

/**
 * A minimal but healthy fake game state (the panel reads player.* and
 * cultivation.breakthroughCost).
 *
 * @param {object} [overrides] — partial overrides (player / cultivation).
 * @returns {object} the fake state.
 */
function createFakeState(overrides = {}) {
  return {
    player: { spiritRoot: 'Unawakened', meridians: 0 },
    cultivation: { realm: 'Mortal', breakthroughCost: 0, realmLayer: 1, realmLayerMax: 9 },
    ...overrides,
    // Allow overriding nested cultivation fields without losing defaults.
    cultivation: {
      realm: 'Mortal',
      breakthroughCost: 0,
      realmLayer: 1,
      realmLayerMax: 9,
      ...(overrides.cultivation || {}),
    },
  };
}

/** A canned requirements snapshot with every gate met (canAttempt true). */
function ALL_MET_REQUIREMENTS() {
  return {
    realmId: 'qi-gathering',
    requiredProgress: 1000,
    progress: 1000,
    progressMet: true,
    cost: { spiritStones: 50 },
    costMet: true,
    bottleneck: [],
    bottleneckMet: true,
    tribulationRequired: false,
    tribulationMet: true,
    layer: 9,
    layerMax: 9,
    layerMet: true,
    canAttempt: true,
  };
}

// ---------- Constructor ----------

test('init renders the character readout, buttons and feedback; registers exactly one click listener', () => {
  const { root, body, listeners } = createFakeRoot();
  const state = createFakeState();
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations(),
    root,
  });

  const character = findNode(body, 'data-cultivation-character');
  assert.ok(character, 'character readout rendered');
  assert.equal(character.textContent, 'Spirit Root: Unawakened · Meridians: 0');

  // Layer readout is always shown.
  const layer = findNode(body, 'data-cultivation-layer');
  assert.ok(layer, 'layer readout rendered');
  assert.equal(layer.textContent, 'Layer 1 / 9');

  // At layer 1 with zero progress: both buttons are hidden.
  const advanceBtn = findNode(body, 'data-cultivation-advance-layer');
  assert.ok(advanceBtn, 'advance layer button rendered');
  assert.equal(advanceBtn.attrs.hidden, 'true', 'advance button hidden (no progress)');

  const button = findNode(body, 'data-cultivation-breakthrough');
  assert.ok(button, 'breakthrough button rendered');
  assert.equal(button.textContent, 'Breakthrough');
  assert.equal(
    button.attrs.hidden,
    'true',
    'breakthrough button hidden (layer < 9)'
  );
  const reason = findNode(body, 'data-cultivation-reason');
  assert.ok(reason, 'reason line rendered');
  assert.match(reason.textContent, /^Progress required:/);

  const feedback = findNode(body, 'data-cultivation-feedback');
  assert.ok(feedback, 'feedback line rendered (empty on first render)');
  assert.equal(feedback.textContent, '');

  // No tribulation on Mortal → no tribulation block, no face button.
  assert.equal(findNode(body, 'data-cultivation-tribulation').hidden, true);
  assert.equal(findNode(body, 'data-cultivation-face', true).attrs.disabled, 'true');

  assert.equal(listeners.click.length, 1, 'exactly one delegated click listener attached');
  handle.destroy();
});

test('character readout reads spirit root + meridians fresh from state', () => {
  const { root, body } = createFakeRoot();
  const state = createFakeState({
    player: { spiritRoot: 'No Root', meridians: 3 },
  });
  initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations(),
    root,
  });
  const character = findNode(body, 'data-cultivation-character');
  assert.equal(character.textContent, 'Spirit Root: No Root · Meridians: 3');
});

test('character readout truncates a hostile very-long spirit root name', () => {
  const { root, body } = createFakeRoot();
  const state = createFakeState({
    player: { spiritRoot: 'X'.repeat(4096), meridians: 0 },
  });
  initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations(),
    root,
  });
  const character = findNode(body, 'data-cultivation-character');
  const text = character.textContent;
  // The rendered line stays bounded (the 64-char cap on the root name) so a
  // hostile save can never churn a multi-MB string on every loop pulse.
  assert.ok(text.length <= 128, `rendered character line length ${text.length}`);
  assert.equal(text, `Spirit Root: ${'X'.repeat(64)} · Meridians: 0`);
});

test('init without a panel warns and returns a no-op handle', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const root = {
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    };
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState(),
      breakthroughs: createFakeBreakthroughs(),
      tribulations: createFakeTribulations(),
      root,
    });
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /data-cultivation-panel/);
    assert.equal(handle.applyBreakthrough(), false);
    assert.equal(handle.applyFace(), false);
    assert.doesNotThrow(() => handle.destroy());
  } finally {
    console.warn = savedWarn;
  }
});

test('init without root.querySelector warns and returns a no-op handle', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState(),
      breakthroughs: createFakeBreakthroughs(),
      tribulations: createFakeTribulations(),
      root: {},
    });
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /root\.querySelector/);
    assert.equal(handle.applyBreakthrough(), false);
    assert.equal(handle.applyFace(), false);
  } finally {
    console.warn = savedWarn;
  }
});

test('init without game state warns and returns a no-op handle', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { root } = createFakeRoot();
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: null,
      breakthroughs: createFakeBreakthroughs(),
      tribulations: createFakeTribulations(),
      root,
    });
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /game state/);
    assert.equal(handle.applyBreakthrough(), false);
    assert.equal(handle.applyFace(), false);
  } finally {
    console.warn = savedWarn;
  }
});

// ---------- Breakthrough button + reason line ----------

test('breakthrough button disabled with the matching gate reason for every blocked state', () => {
  const cases = [
    {
      label: 'progress gate',
      requirements: {
        realmId: 'mortal',
        requiredProgress: 1000,
        progress: 123,
        progressMet: false,
        cost: { spiritStones: 0 },
        costMet: true,
        bottleneck: [],
        bottleneckMet: true,
        tribulationRequired: false,
        tribulationMet: true,
        canAttempt: false,
      },
      reason: 'Progress required: 123 / 1000',
    },
    {
      // Cost / items are INFORMATIONAL ONLY (P1 #5): the gates that block
      // the attempt are now only progress / tribulation / max-realm /
      // no-definition. A "cost not met" snapshot therefore surfaces as
      // 'max-realm' fallback (everything else met, the only remaining
      // reason — there is no cost gate to fail) so the UI never tells
      // the player "Missing items" for a state that no longer blocks.
      label: 'cost snapshot (now informational, surfaces as max-realm fallback)',
      requirements: {
        realmId: 'mortal',
        requiredProgress: 1000,
        progress: 1000,
        progressMet: true,
        cost: { spiritStones: 500 },
        costMet: false,
        bottleneck: [],
        bottleneckMet: true,
        tribulationRequired: false,
        tribulationMet: true,
        canAttempt: false,
      },
      reason: 'Peak realm reached',
    },
    {
      label: 'tribulation gate',
      requirements: {
        realmId: 'core-formation',
        requiredProgress: 2000,
        progress: 2000,
        progressMet: true,
        cost: { spiritStones: 400 },
        costMet: true,
        bottleneck: [{ id: 'spirit-herb', count: 2 }],
        bottleneckMet: true,
        tribulationRequired: true,
        tribulationMet: false,
        canAttempt: false,
      },
      reason: 'Face the tribulation first',
    },
    {
      label: 'max-realm gate (all gates met, no next tier)',
      requirements: {
        realmId: 'beyond-heaven',
        requiredProgress: 50000,
        progress: 50000,
        progressMet: true,
        cost: { spiritStones: 4200000 },
        costMet: true,
        bottleneck: [],
        bottleneckMet: true,
        tribulationRequired: false,
        tribulationMet: true,
        canAttempt: false,
      },
      reason: 'Peak realm reached',
    },
  ];

  for (const entry of cases) {
    const { root, body } = createFakeRoot();
    const state = createFakeState({ cultivation: { realm: 'X', breakthroughCost: 1, realmLayer: 9 } });
    initCultivationPanel({
      eventBus: EventBus,
      state,
      breakthroughs: createFakeBreakthroughs({
        requirements: () => ({ ...entry.requirements }),
        canAttempt() {
          return entry.requirements.canAttempt;
        },
      }),
      tribulations: createFakeTribulations(),
      root,
      notation: { format: identityFormatter },
    });

    const button = findNode(body, 'data-cultivation-breakthrough');
    const reason = findNode(body, 'data-cultivation-reason');
    assert.equal(
      button.attrs.disabled,
      'true',
      `${entry.label}: button disabled`
    );
    assert.equal(reason.textContent, entry.reason, `${entry.label}: reason text`);
  }
});

test('breakthrough button disabled with "No path forward" when the realm has no definition', () => {
  // realmId is null (no current realm) → no-definition.
  const { root, body } = createFakeRoot();
  const state = createFakeState({ cultivation: { realm: 'Mortal', breakthroughCost: null, realmLayer: 9 } });
  initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs: createFakeBreakthroughs({
      requirements: () => ({
        realmId: null,
        requiredProgress: 1000,
        progress: 0,
        progressMet: false,
        cost: { spiritStones: 0 },
        costMet: true,
        bottleneck: [],
        bottleneckMet: true,
        tribulationRequired: false,
        tribulationMet: true,
        canAttempt: false,
      }),
    }),
    tribulations: createFakeTribulations(),
    root,
  });

  const button = findNode(body, 'data-cultivation-breakthrough');
  const reason = findNode(body, 'data-cultivation-reason');
  assert.equal(button.attrs.disabled, 'true');
  assert.equal(reason.textContent, 'No path forward');
});

test('breakthrough button enabled with the readiness line when canAttempt() is true (#5)', () => {
  // The button no longer shows a misleading cost line — it shows the
  // readiness label so the player knows the action is live (P1 #5: cost /
  // items gates removed).
  const { root, body } = createFakeRoot();
  const state = createFakeState({ cultivation: { realmLayer: 9 } });
  initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs: createFakeBreakthroughs({
      requirements: ALL_MET_REQUIREMENTS,
      canAttempt: () => true,
    }),
    tribulations: createFakeTribulations(),
    root,
    notation: { format: identityFormatter },
  });

  const button = findNode(body, 'data-cultivation-breakthrough');
  const reason = findNode(body, 'data-cultivation-reason');
  assert.equal(button.attrs.disabled, undefined, 'button enabled');
  assert.equal(reason.textContent, 'Ready — breakthrough available');
});

// ---------- Click delegation ----------

test('click on [data-cultivation-breakthrough] delegates to applyBreakthrough', () => {
  const { root, listeners } = createFakeRoot();
  const state = createFakeState();
  const breakthroughs = createFakeBreakthroughs();
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  // A blocked attempt is the default fake — the call still reaches the system.
  const fakeButton = {
    closest(selector) {
      return selector === BREAKTHROUGH_SELECTOR ? this : null;
    },
  };
  listeners.click[0]({ target: fakeButton });
  assert.equal(breakthroughs.attemptCalls.length, 1, 'attempt() called through the click');

  // A click on the face anchor routes to applyFace.
  const fakeFace = {
    closest(selector) {
      return selector === FACE_SELECTOR ? this : null;
    },
  };
  listeners.click[0]({ target: fakeFace });
  assert.equal(breakthroughs.attemptCalls.length, 1, 'face clicks never reach attempt()');
  handle.destroy();
});

test('click on [data-cultivation-progress-action] delegates to applyBreakthrough (#3)', () => {
  // The cross-panel progress bar is the new actionable entry point (#3).
  const { root, listeners, progressBar } = createFakeRoot();
  const breakthroughs = createFakeBreakthroughs();
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  const fakeBar = {
    closest(selector) {
      return selector === PROGRESS_ACTION_SELECTOR ? this : null;
    },
  };
  listeners.click[0]({ target: fakeBar });
  assert.equal(
    breakthroughs.attemptCalls.length,
    1,
    'attempt() called through a click on the progress bar'
  );
  // The fake root's progress bar still carries its setUp state from
  // render() — clicking it must NOT mutate the bar itself (no re-toggle).
  assert.ok(progressBar, 'progress bar present for sanity');
  handle.destroy();
});

test('click outside any action button does nothing', () => {
  const { root, listeners, body } = createFakeRoot();
  const breakthroughs = createFakeBreakthroughs();
  const tribulations = createFakeTribulations();
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs,
    tribulations,
    root,
  });

  const before = body.children.length;
  listeners.click[0]({ target: { closest: () => null } });

  assert.equal(breakthroughs.attemptCalls.length, 0);
  assert.equal(tribulations.faceCalls.length, 0);
  assert.equal(body.children.length, before, 'no rerender');
  handle.destroy();
});

// ---------- applyBreakthrough feedback ----------

test('applyBreakthrough renders success feedback when the attempt advanced', () => {
  const { root, body } = createFakeRoot();
  const state = createFakeState({ cultivation: { realm: 'Qi Gathering', breakthroughCost: 50 } });
  const breakthroughs = createFakeBreakthroughs({
    requirements: ALL_MET_REQUIREMENTS,
    attempt() {
      // The fake system advances the realm (as the real system would).
      state.cultivation.realm = 'Qi Gathering';
      return { outcome: 'perfect', advanced: true };
    },
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  const uiRefresh = [];
  EventBus.subscribe('ui:refresh', () => uiRefresh.push(1));

  const ok = handle.applyBreakthrough();
  assert.equal(ok, true, 'accepted attempt returns true');
  assert.equal(breakthroughs.attemptCalls.length, 1);
  const feedback = findNode(body, 'data-cultivation-feedback');
  assert.equal(feedback.textContent, 'Breakthrough to Qi Gathering!');
  assert.equal(uiRefresh.length, 1, 'success emits ui:refresh');
  handle.destroy();
});

test('applyBreakthrough renders failure feedback when the attempt was accepted but failed', () => {
  const { root, body } = createFakeRoot();
  const breakthroughs = createFakeBreakthroughs({
    requirements: ALL_MET_REQUIREMENTS,
    attempt() {
      return { outcome: 'heavy-failure', advanced: false };
    },
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  const ok = handle.applyBreakthrough();
  assert.equal(ok, true);
  const feedback = findNode(body, 'data-cultivation-feedback');
  assert.equal(feedback.textContent, 'Breakthrough failed.');
  handle.destroy();
});

test('a blocked applyBreakthrough surfaces the reason inline — no silent dead button (#4)', () => {
  // The player clicked the breakthrough button, the system rejected the
  // attempt (progress gate), and the panel MUST show WHY it stayed closed.
  const { root, body } = createFakeRoot();
  const breakthroughs = createFakeBreakthroughs({
    requirements: () => ({
      realmId: 'mortal',
      requiredProgress: 1000,
      progress: 500,
      progressMet: false,
      cost: { spiritStones: 0 },
      costMet: true,
      bottleneck: [],
      bottleneckMet: true,
      tribulationRequired: false,
      tribulationMet: true,
      canAttempt: false,
    }),
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  const ok = handle.applyBreakthrough();
  assert.equal(ok, false, 'blocked attempt returns false');
  assert.equal(breakthroughs.attemptCalls.length, 1, 'the system was still asked');
  const feedback = findNode(body, 'data-cultivation-feedback');
  assert.ok(feedback, 'feedback line still rendered');
  assert.equal(feedback.textContent, 'Progress incomplete');
  // No ui:refresh on a blocked attempt — no state mutation succeeded.
  let refreshCount = 0;
  EventBus.subscribe('ui:refresh', () => refreshCount++);
  handle.applyBreakthrough();
  assert.equal(refreshCount, 0, 'blocked attempt does NOT emit ui:refresh');
  handle.destroy();
});

test('a blocked applyBreakthrough uses the matching feedback text for every canonical reason (#4)', () => {
  const cases = [
    { reason: 'progress', text: 'Progress incomplete' },
    { reason: 'tribulation', text: 'Face the tribulation first' },
    { reason: 'max-realm', text: 'Already at peak realm' },
    { reason: 'no-definition', text: 'No path forward' },
  ];
  for (const entry of cases) {
    const { root, body } = createFakeRoot();
    const breakthroughs = createFakeBreakthroughs({
      attempt() {
        return { outcome: null, advanced: false, reason: entry.reason };
      },
    });
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState(),
      breakthroughs,
      tribulations: createFakeTribulations(),
      root,
    });
    handle.applyBreakthrough();
    const feedback = findNode(body, 'data-cultivation-feedback');
    assert.equal(feedback.textContent, entry.text, `reason '${entry.reason}' → '${entry.text}'`);
    handle.destroy();
  }
});

// ---------- Progress bar actionable state (#3) ----------

test('render() toggles the progress--actionable class on the bar when canAttempt is true (#3)', () => {
  // Initially the gate is closed → no actionable class, hint hidden.
  const { root, body, progressBar, progressHint } = createFakeRoot();
  initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(), // default: blocked
    tribulations: createFakeTribulations(),
    root,
  });
  assert.equal(progressBar.classes.has('progress--actionable'), false);
  assert.equal(progressHint.hidden, true);

  // Flip the gates to "all met" → next render() makes the bar actionable
  // and shows the hint. We swap the breakthroughs fake's snapshot by
  // setting a flag the fake reads, then emit a re-render event.
  const { root: root2, progressBar: bar2, progressHint: hint2 } = createFakeRoot();
  let gatesMet = false;
  const bt = createFakeBreakthroughs({
    requirements: () => (gatesMet ? ALL_MET_REQUIREMENTS() : {
      realmId: 'mortal',
      requiredProgress: 1000,
      progress: 0,
      progressMet: false,
      cost: { spiritStones: 0 },
      costMet: true,
      bottleneck: [],
      bottleneckMet: true,
      tribulationRequired: false,
      tribulationMet: true,
      canAttempt: false,
    }),
  });
  initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: bt,
    tribulations: createFakeTribulations(),
    root: root2,
  });
  // Closed → open: the bar + hint are NOT actionable yet (initial render
  // saw the closed snapshot).
  assert.equal(bar2.classes.has('progress--actionable'), false);
  assert.equal(hint2.hidden, true);

  // Bump + emit: render() re-reads requirements() with gates met.
  gatesMet = true;
  EventBus.emit('loop:uiRefresh', { elapsedMs: 100 });
  assert.equal(bar2.classes.has('progress--actionable'), true, 'open gates → actionable class');
  assert.equal(hint2.hidden, false, 'open gates → hint visible');
});

test('render() hides the actionable class and the hint when the gate re-closes', () => {
  // Symmetric: an open gate that re-closes (e.g. the player enters a
  // tribulation-bearing realm and the face() is pending) drops both.
  const { root, progressBar, progressHint } = createFakeRoot();
  let gatesMet = true;
  const bt = createFakeBreakthroughs({
    requirements: () => (gatesMet ? ALL_MET_REQUIREMENTS() : {
      realmId: 'core-formation',
      requiredProgress: 2000,
      progress: 2000,
      progressMet: true,
      cost: { spiritStones: 400 },
      costMet: true,
      bottleneck: [],
      bottleneckMet: true,
      tribulationRequired: true,
      tribulationMet: false,
      canAttempt: false,
    }),
  });
  initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: bt,
    tribulations: createFakeTribulations(),
    root,
  });
  assert.equal(progressBar.classes.has('progress--actionable'), true, 'open at init');
  assert.equal(progressHint.hidden, false);

  // Gate re-closes → render drops the actionable class + hides the hint.
  gatesMet = false;
  EventBus.emit('realm:changed', { realmId: 'core-formation' });
  assert.equal(progressBar.classes.has('progress--actionable'), false, 'closed → class dropped');
  assert.equal(progressHint.hidden, true, 'closed → hint hidden');
});

test('render() degrades when the progress bar / hint are absent from the DOM', () => {
  // A stripped markup (no progress bar) must not throw — the Breakthrough
  // button still works, the panel re-renders, no console warnings.
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { root, body } = createFakeRoot({ includeProgress: false });
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState(),
      breakthroughs: createFakeBreakthroughs(),
      tribulations: createFakeTribulations(),
      root,
    });
    assert.equal(warnCalls.length, 0, 'no warnings when bar is absent');
    // The Breakthrough button still rendered.
    assert.ok(findNode(body, 'data-cultivation-breakthrough'));
    handle.destroy();
  } finally {
    console.warn = savedWarn;
  }
});

// ---------- Stable mounted action nodes ----------

test('mount() runs once and update() does not destroy or recreate the buttons', () => {
  const { root, body } = createFakeRoot();
  const tribulations = createFakeTribulations({
    requirements: () => ({ type: 'lightning', canFace: true }),
    canFace: () => true,
  });
  const breakthroughs = createFakeBreakthroughs({ requirements: ALL_MET_REQUIREMENTS });
  const handle = initCultivationPanel({
    eventBus: EventBus, state: createFakeState(), breakthroughs, tribulations, root,
  });
  const button = findNode(body, 'data-cultivation-breakthrough');
  const face = findNode(body, 'data-cultivation-face');
  for (let i = 0; i < 5; i += 1) handle.render();
  assert.strictEqual(findNode(body, 'data-cultivation-breakthrough'), button);
  assert.strictEqual(findNode(body, 'data-cultivation-face'), face);
  handle.destroy();
});

test('accepted actions update feedback without rebuilding their action nodes', () => {
  const { root, body } = createFakeRoot();
  const breakthroughs = createFakeBreakthroughs({
    requirements: ALL_MET_REQUIREMENTS,
    attempt: () => ({ outcome: 'perfect', advanced: true }),
  });
  const tribulations = createFakeTribulations({
    requirements: () => ({ type: 'lightning', canFace: true }),
    canFace: () => true,
    face: () => ({ outcome: 'survived', survived: true }),
  });
  const handle = initCultivationPanel({
    eventBus: EventBus, state: createFakeState(), breakthroughs, tribulations, root,
  });
  const button = findNode(body, 'data-cultivation-breakthrough');
  const face = findNode(body, 'data-cultivation-face');
  handle.applyBreakthrough();
  handle.applyFace();
  assert.strictEqual(findNode(body, 'data-cultivation-breakthrough'), button);
  assert.strictEqual(findNode(body, 'data-cultivation-face'), face);
  handle.destroy();
});


test('tribulation block is absent when the realm imposes no tribulation', () => {
  const { root, body } = createFakeRoot();
  initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations(), // type null
    root,
  });

  assert.equal(findNode(body, 'data-cultivation-tribulation').hidden, true);
  assert.equal(findNode(body, 'data-cultivation-face', true).attrs.disabled, 'true');
});

test('tribulation block renders the type and an enabled face button while pending', () => {
  const { root, body } = createFakeRoot();
  initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations({
      requirements: () => ({
        realmId: 'core-formation',
        type: 'lightning',
        pending: true,
        survived: false,
        canFace: true,
      }),
      canFace: () => true,
    }),
    root,
  });

  const block = findNode(body, 'data-cultivation-tribulation');
  assert.ok(block, 'tribulation block rendered while pending');
  const name = findNode(block, 'data-cultivation-tribulation-name');
  assert.equal(name.textContent, 'Tribulation: lightning');
  const face = findNode(block, 'data-cultivation-face');
  assert.ok(face, 'face button rendered');
  assert.equal(face.attrs.disabled, undefined, 'face button enabled while pending');
});

test('face button is disabled once the tribulation is survived', () => {
  const { root, body } = createFakeRoot();
  initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations({
      requirements: () => ({
        realmId: 'core-formation',
        type: 'lightning',
        pending: false,
        survived: true,
        canFace: false,
      }),
    }),
    root,
  });

  const block = findNode(body, 'data-cultivation-tribulation');
  const face = findNode(block, 'data-cultivation-face');
  assert.equal(face.attrs.disabled, 'true', 'survived → gate open → face disabled');
});

// ---------- applyFace feedback ----------

test('face click calls face() and renders survived feedback', () => {
  const { root, listeners } = createFakeRoot();
  const tribulations = createFakeTribulations({
    requirements: () => ({
      realmId: 'core-formation',
      type: 'lightning',
      pending: true,
      survived: false,
      canFace: true,
    }),
    canFace: () => true,
    face() {
      return { outcome: 'survived', survived: true };
    },
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations,
    root,
  });

  const fakeFace = {
    closest(selector) {
      return selector === FACE_SELECTOR ? this : null;
    },
  };
  listeners.click[0]({ target: fakeFace });

  assert.equal(tribulations.faceCalls.length, 1, 'face() called through the click');
  const feedback = findNode(root.querySelector(PANEL_SELECTOR).querySelector(BODY_SELECTOR), 'data-cultivation-feedback');
  assert.equal(feedback.textContent, 'Tribulation survived!');
  handle.destroy();
});

test('a failed face renders the overwhelmed feedback and the gate stays pending', () => {
  const { root, body } = createFakeRoot();
  const tribulations = createFakeTribulations({
    requirements: () => ({
      realmId: 'core-formation',
      type: 'lightning',
      pending: true, // gate stays pending after a failure
      survived: false,
      canFace: true,
    }),
    canFace: () => true,
    face() {
      return { outcome: 'injured', survived: false };
    },
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations,
    root,
  });

  const ok = handle.applyFace();
  assert.equal(ok, true, 'accepted face returns true');
  const feedback = findNode(body, 'data-cultivation-feedback');
  assert.equal(feedback.textContent, 'The tribulation overwhelms you.');

  // The gate stays pending — the re-rendered block still shows an enabled
  // face button (the player can try again).
  const block = findNode(body, 'data-cultivation-tribulation');
  const face = findNode(block, 'data-cultivation-face');
  assert.equal(face.attrs.disabled, undefined, 'pending gate → face still available');
  handle.destroy();
});

// ---------- Missing dependencies ----------

test('missing breakthroughs degrades: disabled button, applyBreakthrough warns once', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { root, body } = createFakeRoot();
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState(),
      breakthroughs: null,
      tribulations: createFakeTribulations(),
      root,
    });

    // No warning at init (the panel renders the unavailable action).
    assert.equal(warnCalls.length, 0);
    const button = findNode(body, 'data-cultivation-breakthrough');
    assert.equal(button.attrs.hidden, 'true', 'no system → button hidden (layer < 9)');

    assert.equal(handle.applyBreakthrough(), false);
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /BreakthroughSystem/);
    // Warns once per instance only.
    handle.applyBreakthrough();
    assert.equal(warnCalls.length, 1);
  } finally {
    console.warn = savedWarn;
  }
});

test('missing tribulations degrades: no block, applyFace warns once', () => {
  const warnCalls = [];
  const savedWarn = console.warn;
  console.warn = (...args) => warnCalls.push(args);
  try {
    const { root, body } = createFakeRoot();
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState(),
      breakthroughs: createFakeBreakthroughs(),
      tribulations: null,
      root,
    });

  assert.equal(findNode(body, 'data-cultivation-tribulation').hidden, true);
    assert.equal(handle.applyFace(), false);
    assert.equal(warnCalls.length, 1);
    assert.match(String(warnCalls[0][0]), /TribulationSystem/);
    handle.applyFace();
    assert.equal(warnCalls.length, 1, 'warns once per instance');
  } finally {
    console.warn = savedWarn;
  }
});

// ---------- Event subscription + re-render ----------

test('every subscribed event re-renders the panel from fresh system snapshots', () => {
  for (const eventName of SUBSCRIBED_EVENTS) {
    const { root, body } = createFakeRoot();
    let gatesMet = false;
    const breakthroughs = createFakeBreakthroughs({
      requirements: () =>
        gatesMet
          ? ALL_MET_REQUIREMENTS()
          : {
              realmId: 'mortal',
              requiredProgress: 1000,
              progress: 0,
              progressMet: false,
              cost: { spiritStones: 0 },
              costMet: true,
              bottleneck: [],
              bottleneckMet: true,
              tribulationRequired: false,
              tribulationMet: true,
              layer: 9,
              layerMax: 9,
              layerMet: true,
              canAttempt: false,
            },
    });
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state: createFakeState({ cultivation: { realmLayer: 9 } }),
      breakthroughs,
      tribulations: createFakeTribulations(),
      root,
    });

    // Precondition: disabled.
    assert.equal(findNode(body, 'data-cultivation-breakthrough').attrs.disabled, 'true');

    // Bump the fake gates (as a system would on its own state change) and
    // emit the event under test — the panel must re-render.
    gatesMet = true;
    EventBus.emit(eventName, {});

    assert.equal(
      findNode(body, 'data-cultivation-breakthrough').attrs.disabled,
      undefined,
      `${eventName} re-renders the button to enabled`
    );
    handle.destroy();
  }
});

test('a resource:changed event re-renders so the gate follows the latest snapshot', () => {
  // The cost / items no longer gate (#5) — the resource:changed emission
  // still re-renders so the button state follows the latest requirements()
  // snapshot (defense in depth: any wallet movement that shifts
  // requirements must repaint the panel).
  const { root, body } = createFakeRoot();
  let costMet = false;
  const breakthroughs = createFakeBreakthroughs({
    requirements: () => ({
      realmId: 'qi-gathering',
      requiredProgress: 1000,
      progress: 1000,
      progressMet: true,
      cost: { spiritStones: 50 },
      costMet,
      bottleneck: [],
      bottleneckMet: true,
      tribulationRequired: false,
      tribulationMet: true,
      layer: 9,
      layerMax: 9,
      layerMet: true,
      canAttempt: costMet,
    }),
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState({ cultivation: { realmLayer: 9 } }),
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  assert.equal(findNode(body, 'data-cultivation-breakthrough').attrs.disabled, 'true');
  assert.equal(findNode(body, 'data-cultivation-reason').textContent, 'Peak realm reached');

  costMet = true;
  EventBus.emit('resource:changed', { id: 'spiritStones', label: 'Spirit Stones', delta: 50, total: 50 });

  assert.equal(findNode(body, 'data-cultivation-breakthrough').attrs.disabled, undefined);
  assert.equal(findNode(body, 'data-cultivation-reason').textContent, 'Ready — breakthrough available');
  handle.destroy();
});

test('a realm:changed event re-renders so the tribulation block appears for a gated realm', () => {
  const { root, body } = createFakeRoot();
  let gated = false;
  const tribulations = createFakeTribulations({
    requirements: () =>
      gated
        ? {
            realmId: 'core-formation',
            type: 'lightning',
            pending: true,
            survived: false,
            canFace: true,
          }
        : {
            realmId: 'mortal',
            type: null,
            pending: false,
            survived: false,
            canFace: false,
          },
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations,
    root,
  });

   assert.equal(findNode(body, 'data-cultivation-tribulation').hidden, true, 'ungated: block is hidden');

  gated = true;
  EventBus.emit('realm:changed', { realmId: 'core-formation' });

  const block = findNode(body, 'data-cultivation-tribulation');
  assert.ok(block, 'gated realm: block appears after realm:changed');
  assert.ok(findNode(block, 'data-cultivation-face'), 'face button present');
  handle.destroy();
});

// ---------- destroy ----------

test('destroy removes the click listener AND every event subscription (idempotent)', () => {
  const { root, listeners } = createFakeRoot();
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state: createFakeState(),
    breakthroughs: createFakeBreakthroughs(),
    tribulations: createFakeTribulations(),
    root,
  });

  assert.equal(listeners.click.length, 1);
  for (const name of SUBSCRIBED_EVENTS) {
    assert.equal(EventBus.hasListeners(name), true, `${name} subscribed`);
  }

  handle.destroy();

  assert.equal(listeners.click.length, 0);
  for (const name of SUBSCRIBED_EVENTS) {
    assert.equal(EventBus.hasListeners(name), false, `${name} unsubscribed`);
  }

  // Second destroy is a no-op.
  assert.doesNotThrow(() => handle.destroy());
});

test('feedback persists across event-driven re-renders', () => {
  const { root, body } = createFakeRoot();
  const state = createFakeState({ cultivation: { realm: 'Qi Gathering', breakthroughCost: 50 } });
  const breakthroughs = createFakeBreakthroughs({
    requirements: ALL_MET_REQUIREMENTS,
    attempt() {
      state.cultivation.realm = 'Qi Gathering';
      return { outcome: 'perfect', advanced: true };
    },
  });
  const handle = initCultivationPanel({
    eventBus: EventBus,
    state,
    breakthroughs,
    tribulations: createFakeTribulations(),
    root,
  });

  handle.applyBreakthrough();
  assert.equal(findNode(body, 'data-cultivation-feedback').textContent, 'Breakthrough to Qi Gathering!');

  // An unrelated event (e.g. the loop pulse) re-renders but keeps the feedback.
  EventBus.emit('loop:uiRefresh', { elapsedMs: 100 });
  assert.equal(findNode(body, 'data-cultivation-feedback').textContent, 'Breakthrough to Qi Gathering!');
  handle.destroy();
});

// ---------- Purity ----------

test('a normal session produces zero console warnings or errors', () => {
  const calls = [];
  const savedWarn = console.warn;
  const savedError = console.error;
  console.warn = (...args) => calls.push(['warn', ...args]);
  console.error = (...args) => calls.push(['error', ...args]);
  try {
    const { root, listeners } = createFakeRoot();
    const state = createFakeState();
    const handle = initCultivationPanel({
      eventBus: EventBus,
      state,
      breakthroughs: createFakeBreakthroughs({
        requirements: ALL_MET_REQUIREMENTS,
        attempt: () => ({ outcome: 'perfect', advanced: true }),
      }),
      tribulations: createFakeTribulations(),
      root,
    });
    listeners.click[0]({ target: { closest: (s) => (s === BREAKTHROUGH_SELECTOR ? {} : null) } });
    EventBus.emit('loop:uiRefresh', {});
    EventBus.emit('resource:changed', {});
    handle.render();
    handle.destroy();
    assert.deepEqual(calls, [], 'no console output during a normal session');
  } finally {
    console.warn = savedWarn;
    console.error = savedError;
  }
});

test('initCultivationPanel never uses innerHTML and imports only the EventBus', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../js/ui/cultivation-panel.js', import.meta.url), 'utf8')
  );
  // Scan for actual innerHTML PROPERTY access (`.innerHTML`) — the naive
  // substring 'innerHTML' also matches the module's own doc comments
  // ("never innerHTML"), which would make this a self-defeating check.
  assert.ok(
    !source.includes('.innerHTML'),
    'data-driven content must render as textContent, never innerHTML'
  );

  const importMatches = source.match(/^\s*import\s.+from\s+['"][^'"]+['"]/gm) || [];
  const imports = importMatches.map((line) => line.match(/from\s+['"]([^'"]+)['"]/)[1]);
  assert.deepEqual(imports, ['../core/event-bus.js'], 'depends on the shared EventBus only');
});
