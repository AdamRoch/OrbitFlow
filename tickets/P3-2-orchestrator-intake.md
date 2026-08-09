# P3-2 Orchestrator intake → run spec → run kickoff

**Phase:** 3 · **Tag:** [MUST] · **Depends:** P3-1

The orchestrator's intake duty (PRD §9): user texts an app idea, orchestrator clarifies if needed, emits a structured run spec, and a Software Factory run kicks off with that spec.

## Acceptance criteria

- [ ] Texting an idea produces a `workflow_runs` row with `trigger_type=channel` and a structured `spec`.
- [ ] Orchestrator can ask a clarifying question over Telegram before committing the spec.
- [ ] The kicked-off run is the same engine path as P2-6 (no special-case code for channel-triggered runs).
