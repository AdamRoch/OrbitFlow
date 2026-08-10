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

`src/lib/workflow/graph.ts` parses and evaluates this contract without database,
clock, runtime, or network access. FACT-8 still preserves submitted graph JSON;
engine-specific validation happens when a run starts. The accepted graph is
copied into `workflow_runs.graph_snapshot`, so later workflow edits cannot alter
an active run's transitions.

## Durable routing and dispatch

`startWorkflowRun` changes a pending run to running and creates its first durable
dispatch. FACT-9 calls `routeWorkflowMessage` inside the message-consumption
transaction. An output message has this routing envelope:

```json
{
  "dispatchId": "42",
  "sessionId": "runtime-session-42",
  "output": { "verdict": "rejected" }
}
```

The runtime producer copies its session identifier into this internal envelope.
That closes the race where a very fast agent finishes before the dispatcher can
persist the adapter response: the output transaction can safely promote the
leased dispatch straight to completed, and the delayed finalizer becomes a
no-op. The message also requires a non-blank `handoff_brief`; fan-out output must carry
the same `ticket_id` as its dispatch. The handler validates the active dispatch,
records usage in `cost_events`, increments run totals, evaluates one edge, and
inserts the next dispatch. Those mutations, the FACT-9 receipt, and the cursor
advance commit together. A semantic duplicate output for a completed dispatch
is consumed without another transition.

Migration `0006-workflow-engine.sql` is required because `workflow_runs.spec` is
immutable task input and FACT-9 receipts only prove message routing. Neither can
represent a node activation's pending/leased/active/completed state or enforce a
fan-out capacity boundary. FACT-12 owns ordinal `0005`; if `0006` is deployed
before `0005`, `0005` must not later be inserted behind applied history. Merge
and deployment ordering must therefore land FACT-12's `0005` first when both
changes are pending.

`workflow_dispatches` is the transactional dispatch outbox. A dispatcher claims
one row with a lease, calls the injected `RuntimeAdapter`, then records the
session. Each dispatch also snapshots the agent model used for runtime and cost
attribution. The stable persisted idempotency key survives process death. FACT-11's
adapter must honor that key and return the same session when a call succeeded
but its response or database update was interrupted. The database guarantee is
exactly-once routing and one active dispatch record, not magic exactly-once I/O
to a provider that ignores idempotency.

Fan-out snapshots the run's `todo` and `in_progress` tickets when the fan-out
node is entered. It creates one pending ephemeral dispatch per ticket. Claimers
serialize briefly on the fan-out group and count active or unexpired leased
members across every activation of that node in the run before starting another
session, enforcing the configured hard maximum even if graph cycles overlap. An
output completes that ticket dispatch and releases one slot.

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
fan-out saturation and release at max two, one mock session per ticket, an
overlapping fan-out cycle that cannot multiply max N, a start-time graph
snapshot, an expired ambiguous claim recovered with the same session key,
malformed output, and confirmed runtime failure. The runtime is deterministic
and in-memory; it does not implement FACT-11 or FACT-12.
