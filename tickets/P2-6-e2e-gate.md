# P2-6 E2E gate: Software Factory run completes

**Phase:** 2 · **Tag:** [MUST] · **Depends:** P2-1..P2-5

The E2E moment (PRD §10): a Software Factory graph, hardcoded in the DB (no builder yet), executes end to end with real OpenClaw agents and real coding delegation on a trivial task. **Nothing in Phase 3+ proceeds until this run completes.**

## Acceptance criteria

- [ ] Run triggered manually (SQL/script is fine) → orchestrator → planner → implement → test → done.
- [ ] Real tickets created by agents via the tool surface; real diff produced via `delegate_coding_task`.
- [ ] Handoff briefs flow between nodes; conversation trail reconstructable from `messages`.
- [ ] Token/cost totals aggregated on the run.
- [ ] Whatever broke getting here is fixed or ticketed before Phase 3 starts.
