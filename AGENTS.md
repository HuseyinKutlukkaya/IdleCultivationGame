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
