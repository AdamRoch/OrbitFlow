# Durable workflow engine

FACT-10 adds the smallest engine that can turn FACT-9 messages into durable node
dispatches. PostgreSQL remains authoritative. The engine owns every transition;
an agent output names only the dispatch it completed and its structured result.
It never names the next node.

## Graph contract

`workflows.graph` keeps the control-plane shape established by FACT-8:

```json
{
  "nodes": [
    { "id": "implement", "agentId": "1", "config": { "entry": true } },
    { "id": "test", "agentId": "2", "config": {} }
  ],
  "edges": [
    {
      "source": "test",
      "target": "implement",
      "condition": {
        "operator": "equals",
        "path": ["verdict"],
        "value": "rejected"
      }
    }
  ]
}
```

Exactly one node has `config.entry: true`. A fan-out node adds
`config.fanOut.maxConcurrency`, a positive integer. Supported predicates are
`always`, `equals`, `notEquals`, `in`, and `exists`. Paths are arrays of object
keys, not executable expressions. Edge array order is transition priority, so
the first matching outgoing edge wins deterministically. A node with no outgoing
edges is terminal. An outgoing edge set with no match fails the run. Cycles need
no special case because each accepted output creates one new activation.

`src/lib/workflow/graph-contract.ts` validates the submitted graph without
normalizing, projecting, or reordering it. `src/lib/workflow/graph.ts` re-exports
that exact parser and evaluates transitions without database, clock, runtime, or
network access. The accepted graph is copied into `workflow_runs.graph_snapshot`,
so later workflow edits cannot alter an active run's transitions.

## Durable routing and dispatch

`startWorkflowRun` changes a pending run to running and creates its first durable
dispatch. FACT-9 calls `routeWorkflowMessage` inside the message-consumption
transaction. An output message has this routing envelope:

```json
{
  "dispatchId": "42",
  "dispatchGeneration": "1",
  "sessionId": "runtime-session-42",
  "output": { "verdict": "rejected" }
}
```

The runtime producer copies its provider-attempt generation and session
identifier into this internal envelope. The generation changes only after
reconciliation proves an earlier start absent and the engine authorizes a new
provider start. A fast agent can finish before the dispatcher persists the
adapter response, while a late worker from an older, reclaimed attempt cannot
complete or fail the current attempt. The message also requires a non-blank
`handoff_brief`; fan-out output must carry
the same `ticket_id` as its dispatch. The handler validates the active dispatch,
records usage in `cost_events`, increments run totals, evaluates one edge, and
inserts the next dispatch. Those mutations, the FACT-9 receipt, and the cursor
advance commit together. A semantic duplicate output for a completed dispatch
is consumed without another transition.

Migration `0011-workflow-engine.sql` is required because `workflow_runs.spec` is
immutable task input and FACT-9 receipts only prove message routing. Neither can
represent a node activation's pending/leased/active/completed state or enforce a
fan-out capacity boundary. It lands after main's existing chain (`0001`–`0004`,
`0009`, `0010`); the upgrade proof applies exactly `0011` on top of the exact
main migration history.

`workflow_dispatches` is the transactional dispatch outbox. A dispatcher claims
one row with a monotonically increasing lease generation, calls the injected
`RuntimeAdapter`, then records success or confirmed failure only if that
generation still owns the row. This fence works even if two processes reuse the
same worker name.

The adapter has separate `startSession` and `reconcileSession` operations. A
confirmed provider rejection is explicit. An exception or invalid response is
ambiguous and moves the dispatch to durable `reconciling` state without failing
the run. After restart, the engine reconciles the persisted idempotency key. It
may activate a found session, keep waiting, record a confirmed failure, or return
the row to `pending` only after the provider authoritatively reports that no
session exists. It never blindly repeats an uncertain external start. FACT-11's
adapter must implement that contract against OpenClaw. The database guarantee is
exactly-once routing and fenced ownership, not magic exactly-once I/O from a
provider that cannot reconcile an idempotency key.

Fan-out snapshots the run's `todo` and `in_progress` tickets into durable
`workflow_fanout_members` when the node is entered. It materializes at most
`maxConcurrency` runnable dispatch rows across every overlapping activation of
that node in the run. Pending rows count against the cap, so one transaction
cannot build an unbounded runnable queue before workers start claiming it. A
completion releases one slot and materializes the next snapshotted ticket in
stable group and ticket order. Each materialized ticket still receives one
ephemeral runtime session.

## Lifecycle seams

`createWorkflowRun`, `startWorkflowRun`, `pauseWorkflowRun`,
`resumeWorkflowRun`, and `getWorkflowRun` expose persisted lifecycle operations.
Pausing blocks new runtime claims. An already active output may still commit its
result and next pending dispatch while paused; resume makes that durable work
eligible again. This is the seam later question and approval work will use. No
approval UI or question policy is implemented here.

`pauseWorkflowThread` and `resumeWorkflowThread` apply the same gate to one
run-level thread or one ticket inside a fan-out. A paused ticket does not consume
fan-out capacity and does not stop sibling tickets. `listWorkflowThreadStates`
is the observability seam later approval and question routes can expose.

Malformed output, unmatched predicates, and confirmed runtime-start failures
move the run and all unfinished dispatches to failed and append a bounded system
message. Unexpected database faults still throw so FACT-9 rolls the entire route
back for safe retry.

## Disposable proof

Run:

```sh
npm run fact10:proof
```

The proof creates only `orbitfactory-fact10-postgres-proof` on a random local
port, applies the clean migration chain, and removes that exact container. It
handles whole-run and one-ticket pause/resume, a rejection cycle, terminal
completion, aggregate usage,
two FACT-9 consumers racing one output, semantic duplicate output, three-ticket
fan-out materialization and release at max two, one mock session per ticket, an
overlapping fan-out cycle that cannot multiply max N, a start-time graph
snapshot, ambiguous-start reconciliation without replay, stale-worker success
and failure attacks after reclaim, fast output before finalization, malformed
output, and confirmed runtime failure. The runtime is deterministic and
in-memory; it does not implement FACT-11 or FACT-12.
