#  Idle Cultivation Game

> *Within this repository lies a small world, recorded like an immortal's
> cultivation journal — dark, elegant, and ever-expanding.*

A long-term, browser-based idle cultivation simulator inspired by xianxia.
Dark fantasy, elegantly minimal. No frameworks, no build step, no backend —
pure HTML, CSS and JavaScript that runs anywhere static, including GitHub Pages.

> **Build once. Expand forever. Data over code.**

---

## A Passion Project

Above all, this is a **passion project** — a personal playground for learning
and practicing modern AI-assisted engineering, done the proper way. A
deliberate exercise in working *with* AI agents as disciplined collaborators:
structured roles, shared architectural rules, data-driven design, and
one-logical-feature-per-commit. Every part of the setup is meant to be
studied, reused, and improved.

The game itself matters — but so does the craft of building it well.

---

## What Is This?

A cultivation sandbox that grows with you. Meditate to gather **Qi**, break
through realms, awaken **spirit roots**, join sects, and when one life ends —
**reincarnate** into a new one, carrying the legacy of the last.

The design is built for hundreds of techniques, pills, artifacts and events
without ever redesigning the engine. The world should feel alive while you
meditate; the interface should feel like opening an ancient cultivation
manual, not another idle clicker.

The full vision lives in the scrolls:

- **[DESIGN.md](DESIGN.md)** — the game vision, core systems, and art direction
- **[PLANS.md](PLANS.md)** — the implementation plan and architecture
- **[ROADMAP.md](ROADMAP.md)** — where the journey currently stands

## How Was This Built?

Cultivated **with** AI agents as genuine engineering partners — not as a
copy-paste demo, but as a structured, long-term development workflow.

The repository is designed so humans and AI agents contribute together
consistently, without breaking the architecture. Agent roles, coding rules and
sources of truth are recorded in **[AGENTS.md](AGENTS.md)**. One logical
feature per commit, data-driven content, and strict separation between engine,
gameplay and UI keep the codebase clean and extensible as it grows.

Think of it as a small sect of cultivators — a few of whom happen to be
machines.

## Tech Stack

- Vanilla JavaScript (ES modules)
- HTML5 + CSS3
- JSON for all game content
- LocalStorage for saves
- Git + GitHub Pages hosting

No frameworks. No build step. No dependencies to babysit.

## Running Locally

The game is fully static — just serve the folder:

```bash
# with Python
python -m http.server 8000

# or with Node
npx serve .
```

Then open `http://localhost:8000`. (Opening `index.html` directly also works
for a quick look, though a local server is recommended for module loading.)

## Status

Early cultivation. The engine core is taking shape and the first gameplay
systems are next. See [ROADMAP.md](ROADMAP.md) for the current phase.

---

*May your Qi flow steadily, and your commits stay meaningful.*
