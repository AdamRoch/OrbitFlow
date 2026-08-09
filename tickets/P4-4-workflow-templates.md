# P4-4 Ship two workflow templates

**Phase:** 4 · **Tag:** [MUST] · **Depends:** P4-3

Two templates (PRD §7), both loadable and editable from the UI, stored as ordinary workflows with `is_template` set:

1. **Software Factory** — orchestrator → planner → implement fan-out → test loop; testing node deletable.
2. **Research Pipeline** — orchestrator → researcher fan-out over research-task tickets → synthesizer → reviewer loop.

## Acceptance criteria

- [ ] Both templates seed on fresh install with default agents/prompts/skills attached.
- [ ] Loading a template into the builder and deleting a node (e.g. testing) yields a workflow that still runs.
- [ ] Nothing template-specific lives in engine code — templates are pure data (platform-not-product rule, PRD §1).
