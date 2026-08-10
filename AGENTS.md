# AGENTS.md

## Project Philosophy
- Long-term browser idle cultivation game.
- Prioritize maintainability, modularity, readability and extensibility.
- Avoid technical debt.

## Architecture
- Separate engine, gameplay, UI and data.
- Gameplay systems should be independent.
- Prefer event-driven communication.

## Data Driven
- Store game content in JSON whenever practical.
- Avoid hardcoded techniques, realms, pills, spirit roots, physiques, meridians, bloodlines, artifacts and events.

## UI
- UI renders state only.
- Gameplay should not manipulate the DOM directly.

## Sources of Truth
- DESIGN.md — game vision, core systems, universal rule (Grade/Quality/Compatibility), and Art Direction & UI (visual style, palette, layout).
- ROADMAP.md — current milestone and phase checklist; read before starting work.
- PLANS.md — long-term implementation plans; read alongside ROADMAP.md to know how to build what's next.

## AI Guidelines
- Do not invent lore unless requested.
- Use placeholders where appropriate.
- Do not modify unrelated files.
- One logical feature per commit.
- Whenever a clearly good option appears — new tooling, dependencies,
  architecture, process, content, or anything that would drastically improve
  the project (testing-related or not) — surface it to the user and ask
  before adopting it. Never adopt major changes silently, even when they are
  obvious improvements. The user has confirmed dependencies are acceptable
  when they provide a major improvement; the ask-first rule still applies.

## Portable Paths (Hard Rule)
- Never write machine-specific absolute paths into any committed file — code,
  data, tests, docs, or config. Anything before the repo folder name in a
  path is machine-specific and forbidden.
- Forbidden patterns: drive letters (`C:\`, `C:/`, any `X:`), user homes
  (`C:\Users\...`, `/Users/...`, `/home/...`), OS temp/app-data dirs
  (`AppData`, `\Temp\`), and any path that includes the repo folder as an
  absolute location (e.g. `.../Projects/IdleCultivationGame/...`).
- All module imports and data reads must be relative (`./`, `../`) or based
  on `import.meta.url`. See `tests/unit/path-portability.test.mjs` for the
  automated guard that enforces this on every suite run.
- For "the project directory" as a default base path (config, content,
  fixtures, future file import/export), use `js/utils/paths.js`
  (`projectRoot()` / `resolveFromRoot()`) — the ESM equivalent of .NET's
  `AppDomain.CurrentDomain.BaseDirectory` / `Application.StartupPath`.

## Testing
- Testing is mandatory for every feature: no feature is complete without its
  tests, and test writing is never skipped or deferred.
- Every feature ships with tests in `tests/`, mirroring the module zones
  (`tests/unit/`, `tests/dom/`, `tests/data/`, `tests/integration/`,
  `tests/e2e/`, `tests/perf/`, `tests/fixtures/`; shared doubles in
  `tests/helpers/`).
- The suite runs with Node's built-in runner — `node --test "tests/**/*.test.mjs"`
  (never ships; GitHub Pages unaffected). See `tests/README.md`.
- Coverage is gated: `npm run test:coverage` runs the suite with Node's built-in
  coverage and fails when total line coverage drops below **93%** (the committed
  baseline in `tests/coverage-gate.mjs`). New code without tests lowers the
  number and turns the gate red — untested paths surface automatically, not by
  accident.
- Real-browser E2E smoke tests run via Playwright — `npm run test:e2e`
  (dev-only, uses the installed Chrome; specs live in `tests/e2e/` and use
  `*.spec.mjs` so the node:test glob never executes them). Every feature that
  touches the bootstrap, renderer or save paths ships (or extends) its E2E
  spec in the same commit; how-to in `tests/README.md` ("Writing a new E2E
  test").
- The SHIPPED game stays zero-runtime-dependency, framework-free and static
  (GitHub Pages compatible). The zero-dependency stance applies to what ships,
  not to how tests run: dev-only test tooling (e.g. a real-browser E2E runner)
  is permitted when it materially improves coverage.
- New testing tooling that significantly changes how the suite runs must be
  proposed to the user before adoption (see "Testing decisions" in
  `tests/README.md`) — do not add major tooling silently, even when it is a
  clear improvement.
- The agent that builds a feature also writes/updates its tests, in the same
  commit. Changing a module's behavior requires updating that module's existing
  tests to the new contract in that same commit.
- A failing test is never deleted to make the suite pass — either the change is
  intentional (update the test) or it is a bug (fix the code).
- **Incident → guard loop.** Whenever a bug or gap is found by accident —
  manually, in review, or by the user — it becomes a guard: an automated check
  where possible (a test, a gate, a rule), a Feature Gate checklist item, and a
  dated note in `tests/README.md`. The same mistake must never be discoverable
  twice.
- **Failure classification.** Before a failing test is assigned to an agent for
  repair, classify it: `CODE_BUG` (implementation violates the intended
  contract → fix code), `TEST_BUG` (assertion, fixture, setup or expected
  result is wrong → fix test), `FLAKY_ASYNC` (timing, race, nondeterminism →
  investigate), or `ENVIRONMENT` (dependency, browser, OS, tooling, filesystem
  → investigate). Never assume every failure means the production code is
  wrong, and never weaken a test to make it pass.
- **Bounded repair loop.** Automatic repair of the same failing test is capped
  at **3 attempts per failure signature**. If the failure persists after the
  budget is spent, stop and produce an escalation report (failure, files
  changed, what each attempt did, reason for stopping) for the human — do not
  loop speculatively on the same failure.
- The full suite must be green before a feature is reported done. The Architect
  runs the Feature Gate at the end of every feature cycle and loops failures
  back to the responsible agent.

## Feature Gate (required before reporting any feature done)

Every feature clears ALL of these before it is reported done. The Architect
runs the gate at the end of every feature cycle; anything failing loops back to
the responsible agent.

1. **Logic tests green** — `npm test` (node:test suite).
2. **Coverage gate green** — `npm run test:coverage`; total line coverage must
   not drop below the committed 93% baseline.
3. **Browser smoke green** — `npm run test:e2e` when the feature touches the
   bootstrap (`js/main.js`), the renderer, or the save path.
4. **Automation audit** — nothing was verified by hand that could have been
   automated. Anything done manually during development ships as a test in the
   same commit.
5. **Machine-independence audit** — nothing depends on this machine: no
   machine-specific absolute paths (the portability guard enforces), no
   locale-sensitive assertions (Intl-formatted text), no browser/OS
   assumptions outside the documented dev-only tooling.
6. **Fresh-clone smoke** — when the feature touches paths, save format, config
   loading or tooling, the change must also pass from a clean clone: clone the
   repo into a temp dir, `npm ci`, and run the gate there.
7. **Security review** — save/storage, data-driven rendering, user input, or
   long-running systems get the Security Reviewer before done.
