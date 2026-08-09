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
- The full suite must be green before a feature is reported done. The Architect
  runs it at the end of every feature cycle and loops failures back to the
  responsible agent.
