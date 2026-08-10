# Visual workflow builder

FACT-20 edits the authoritative `workflows.graph` JSON through `/workflows` and
the existing PostgreSQL control-plane routes. There is no builder-only graph and
no migration. Optimistic saves use the workflow `updatedAt` value and return a
conflict instead of overwriting a newer graph.

## Engine contract

The stored graph follows the FACT-10 contract from PR #13 directly:

- `nodes[]`: `id`, positive `agentId`, and a JSON object `config`
- node IDs, optional edge IDs, and edge endpoints must already be trimmed and
  NFC Unicode-normalized; raw endpoint strings must exactly match raw node IDs
- exactly one `config.entry: true`
- optional boolean `config.channelBinding`
- optional `config.fanOut` with `over: "openTickets"` and a positive integer
  `maxConcurrency`
- optional `config.planMode`: `off`, `allowed`, or `required`
- optional boolean `config.may_answer_questions`
- optional `config.questionEscalation.target`: `agent`,
  `human-via-channel`, or `human-via-UI`; agent targets include a positive
  `agentId`
- optional `config.approvalGates.pauseBefore` and `pauseAfter` booleans
- `edges[]`: `source`, `target`, and a structured `condition`
- conditions: `always`, `equals`, `notEquals`, `in`, or `exists`
- condition paths are arrays of output object keys
- edge array order is transition priority

Cycles are valid. A cycle-closing edge whose target is an earlier node renders
on a separate return path. Reachability detects that closing edge for cycles of
any length, but the builder does not add routing data to the engine graph.

Node config also exposes `channelBinding`, `planMode`,
`may_answer_questions`, `questionEscalation`, and `approvalGates`. Unknown JSON
fields, including future fields nested inside known configuration objects,
remain intact when a user edits a known field. Optional
`builderMetadata.positions` stores canvas coordinates at the top level. FACT-10
can ignore that metadata while running, while PostgreSQL preserves it with the
rest of the submitted graph.

PR #13 remains open. `src/lib/workflow/graph-contract.ts` is the shared boundary
for the control plane, builder, and pending engine. FACT-10 must consume
`parseWorkflowGraph`, `workflowEntryNodeId`, and these exported graph types
instead of retaining its narrower parser. `parseWorkflowGraph` validates and
returns the submitted object by reference; it does not normalize, default,
project, reorder, or translate stored JSON.

## Proof

Run focused checks with:

```sh
npx vitest run tests/workflow-graph-contract.test.ts tests/workflow-editor.test.tsx
npm run fact8:proof
```

The PostgreSQL proof includes canonical save/reload identity for a rejection
cycle and a stale-write conflict. Local production browser evidence is retained
under `.fact20-proof/` during delivery and is intentionally not committed.

The original-head visual scout observed one `npm run dev` failure resolving
`@xyflow/react/dist/style.css`. It does not reproduce on the corrected head:
the installed package export resolves locally and Next.js 16.3.0 development
mode serves `/workflows` with HTTP 200. Production import behavior is unchanged;
treat the earlier result as an environment-specific failure unless it recurs.
