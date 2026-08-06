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
