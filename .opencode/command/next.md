---
description: Do the next pending roadmap item — reads ROADMAP/PLANS/DESIGN, implements one feature, stops for verification.
---

Read ROADMAP.md, PLANS.md, and DESIGN.md.

Find the next pending (unchecked) item in ROADMAP.md that builds on the current
phase (Core Engine → Gameplay → ...). Implement exactly that one logical feature
per the relevant section of PLANS.md and DESIGN.md, following AGENTS.md rules:

- One logical feature only. Do not implement multiple items at once.
- Do not touch UI or gameplay systems unless the item requires it.
- Keep it framework-free, GitHub Pages compatible, data-driven, event-driven.
- Do not modify unrelated files. Do not hardcode content that belongs in JSON.
- Well documented with JSDoc where appropriate.

When done, stop and report:
- What you implemented and which ROADMAP.md item it satisfies.
- What the user should verify (files changed, behavior).
- Suggest the commit message, but do NOT commit — wait for the user to
  verify, commit, and push, then they will invoke this command again.
