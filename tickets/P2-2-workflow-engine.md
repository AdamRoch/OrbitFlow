# P2-2 Workflow engine: graph evaluation and dispatch

**Phase:** 2 · **Tag:** [MUST] · **Depends:** P2-1

The engine consumes bus messages, evaluates the active run's graph, and dispatches the next wake-up. **Prime rule (PRD §3): the engine owns transitions; agents own judgment inside their node. Agents never decide who runs next.** Routing is deterministic evaluation of edge conditions over structured agent output (e.g. `verdict == "rejected" -> back to implement`).

## Scope

- Run lifecycle: create `workflow_runs`, track status, aggregate token/cost totals.
- Edge condition evaluation over the output payload.
- Feedback loops (cycles in the graph) must work, not be special-cased.
- Fan-out: run a node over open tickets with max N concurrent ephemeral workers (PRD §7).
- Per-thread pause/resume hooks (consumed by P5-2 for questions/approvals — just leave the seam, don't build the UI side yet).

## Acceptance criteria

- [ ] Given a graph and a stream of output messages, the engine picks the correct next node deterministically (incl. a rejection loop and a fan-out) — unit-testable with a mock adapter.
- [ ] Fan-out respects max-N concurrency and creates one ephemeral worker session per ticket.
- [ ] Run status transitions (running/paused/completed/failed) are persisted and observable.
