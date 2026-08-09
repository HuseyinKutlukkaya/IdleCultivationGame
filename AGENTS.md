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
- Every feature ships with tests in `tests/`, mirroring the module zones
  (`tests/unit/`, `tests/dom/`, `tests/data/`, `tests/integration/`,
  `tests/perf/`, `tests/fixtures/`; shared doubles in `tests/helpers/`).
- The suite runs with Node's built-in runner — `node --test "tests/**/*.test.mjs"`
  (zero dependencies, never ships, GitHub Pages unaffected). See `tests/README.md`.
- The agent that builds a feature also writes/updates its tests, in the same
  commit. Changing a module's behavior requires updating that module's existing
  tests to the new contract in that same commit.
- A failing test is never deleted to make the suite pass — either the change is
  intentional (update the test) or it is a bug (fix the code).
- The full suite must be green before a feature is reported done. The Architect
  runs it at the end of every feature cycle and loops failures back to the
  responsible agent.
