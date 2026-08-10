# Visual workflow builder

FACT-20 edits the authoritative `workflows.graph` JSON through `/workflows` and
the existing PostgreSQL control-plane routes. There is no builder-only graph and
no migration. Optimistic saves use the workflow `updatedAt` value and return a
conflict instead of overwriting a newer graph.

## Engine contract

The stored graph follows the FACT-10 contract from PR #13 directly:

- `nodes[]`: `id`, positive `agentId`, and a JSON object `config`
- exactly one `config.entry: true`
- optional `config.fanOut.maxConcurrency` as a positive integer
- `edges[]`: `source`, `target`, and a structured `condition`
- conditions: `always`, `equals`, `notEquals`, `in`, or `exists`
- condition paths are arrays of output object keys
- edge array order is transition priority

Cycles are valid. The rejection loop is an ordinary edge whose target is an
earlier node. The builder renders that edge on a separate return path, but it
does not add routing data to the engine graph.

Node config also exposes `channelBinding`, `planMode`,
`may_answer_questions`, `questionEscalation`, and `approvalGates`. Unknown JSON
fields remain intact when a user edits a known field. Optional
`builderMetadata.positions` stores canvas coordinates at the top level. FACT-10
ignores that metadata when parsing a run, while PostgreSQL preserves it with the
rest of the submitted graph.

PR #13 remains open. When it lands, keep `validateWorkflowGraph` aligned with
`src/lib/workflow/graph.ts`, or delegate validation to that parser without
normalizing or translating the graph saved by FACT-20.

## Proof

Run focused checks with:

```sh
npx vitest run tests/workflow-graph-contract.test.ts tests/workflow-editor.test.tsx
npm run fact8:proof
```

The PostgreSQL proof includes canonical save/reload identity for a rejection
cycle and a stale-write conflict. Local production browser evidence is retained
under `.fact20-proof/` during delivery and is intentionally not committed.
