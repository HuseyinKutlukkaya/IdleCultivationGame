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

### 1. Build a FEATURE CONTEXT before implementing

Record a compact context for the feature and pass it to the implementing agent,
so it does not re-discover the same facts from every source of truth:

```text
FEATURE CONTEXT

Feature: <name>

Implementation scope:
  - <files the feature may touch, zone by zone>

Responsible agent:
  <core-engineer | gameplay-engineer | ui-renderer | data-author>

Unit / DOM / data tests:
  - <tests likely affected or added>

Relevant E2E:
  - <specs, or "none">

Architecture rules that apply:
  - <event names, data paths, UI rule, ...>
```

### 2. Verification staging — fast during implementation, complete at the end

During implementation (L1), run only targeted, affected tests with compact
output. Do NOT run the whole suite, coverage, or E2E after every intermediate
step.

When implementation is complete (L2), run the full assurance set:

1. Full Node suite: `npm test`
2. Coverage gate: `npm run test:coverage`
3. Relevant E2E (bootstrap/renderer/save only): `npm run test:e2e`

Failures are classified (CODE_BUG / TEST_BUG / FLAKY_ASYNC / ENVIRONMENT) and
repaired with at most 3 automatic attempts per failure signature; if the
failure persists, stop and escalate to the user with a report.

When done, stop and report:
- What you implemented and which ROADMAP.md item it satisfies.
- What the user should verify (files changed, behavior).
- Suggest the commit message, but do NOT commit — wait for the user to
  verify, commit, and push, then they will invoke this command again.
