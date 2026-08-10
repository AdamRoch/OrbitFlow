# P1-4 CRUD API: agents, skills, workflows

**Phase:** 1 · **Tag:** [MUST] · **Depends:** P1-2

REST CRUD on the control plane for `agents` (all §4 fields incl. guardrails, interaction_rules, channel_binding), `skills` (incl. attach/detach to agents), and `workflows` (graph JSON stored as-is; validation of node/edge shape only).

## Acceptance criteria

- [ ] Create/read/update/delete for all three resources, persisted to Postgres.
- [ ] Agent guardrails and interaction_rules round-trip intact.
- [ ] Workflow graph JSON round-trips byte-for-byte (builder in P4-3 depends on this).
- [ ] Covered later by the CRUD round-trip test in P5-4 — keep handlers testable (no framework globals in logic).

## Implementation status

**in_progress** — Review corrections are complete: every PATCH requires an
`expectedUpdatedAt` compare-and-set precondition, and duplicate workflow
transitions are rejected using stable condition identity without rewriting the
submitted graph. Disposable PostgreSQL route proof and local gates passed.
Direct PR #7 remains open; Firstmate owns independent exact-head review, merge,
and tracker completion.
