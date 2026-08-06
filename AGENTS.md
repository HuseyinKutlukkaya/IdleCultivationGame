# AGENTS.md

Coding standards and conventions for contributors to this repository —
including AI coding agents. Follow these rules on every change.

## Project overview

Idle Cultivation Game is a fully static, zero-build web game:
plain HTML + CSS + ES6 JavaScript. It is intended to be hosted directly
on GitHub Pages from the repository root, with no build or deploy step.

- Entry point: `index.html` (loads `js/main.js` as an ES6 module)
- Styling: `css/styles.css` (single global stylesheet)
- Game code: modular ES6 modules under `js/`
- Tuning/data: `data/` (JSON, no code)
- Media: `assets/` (sprites, art, audio)

## Non-negotiables

- **GitHub Pages compatibility.** Never introduce a build step, a package
  manager requirement, a server, or any dependency that must be installed.
  Everything must run from a static file server (or `file://` for most
  features). Use relative paths only — no absolute URLs, no `/assets/…`
  paths that assume a domain root.
- **No frameworks.** Plain HTML, CSS, and ES6 JavaScript only. No
  libraries, no bundlers, no transpilers.

## JavaScript conventions

- **Keep it modular.** One concern per file. Prefer small ES6 modules that
  import/export from each other over one big script.
- **Avoid large files.** If a module grows past ~200 lines, split it.
  New gameplay systems belong in their own module under `js/`.
- **Prefer composition over globals.** Never mutate `window` for game
  state. Pass dependencies explicitly via constructor injection or module
  imports. (`window.__game` is allowed only as an explicit, documented
  debug hook.)
- **No globals** for mutable state — encapsulate state in classes/objects
  that own it (see `js/game.js`).
- Follow the existing style: `export`/`import` ESM syntax, JSDoc comments
  on public APIs, `const` over `let`, no `var`.
- Load external JSON with `fetch()` using relative paths, as in `js/config.js`.

## Data and tuning

- All balancing numbers live in `data/` JSON files, never hard-coded in JS.
- When a system needs tunable values, add a config block and read it in a
  small loader module (mirror `js/config.js`).
- Keep `data/game-config.json` valid JSON at all times.

## Commit conventions

- Make **descriptive, commit-friendly changes**: one logical change per
  commit, with a message that states what and why (e.g.
  `Add qi resource generation system`).
- **Never modify unrelated files.** If a task touches file A, leave files
  B and C alone — even for cosmetic fixes. Unrelated refactors belong in
  their own commit (or separate PR).

## Verification

- After writing or editing any `.js` file, run syntax validation:
  `node --check <file>`
- Confirm changes stay within the existing folder structure and honor the
  no-build constraint before finishing.

## Reference structure

```
index.html          entry page
css/styles.css      global dark-theme styles
js/main.js          boot orchestration
js/config.js        config loader
js/game.js          core Game class
js/storage.js       save/load persistence
data/game-config.json  central tuning
assets/             media (images, audio, sprites)
```
