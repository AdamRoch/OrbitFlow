# Orchestrator channel intake

FACT-16 keeps Telegram intake inside the existing durable message and workflow
contracts. The first text creates one channel-triggered run and a
`channel_inbound` row. `channel_intakes` records the collecting conversation so
the same Telegram chat and workflow reuse that run across retries and process
restarts.

The channel-bound entry agent must return one of these artifacts:

```json
{"intake":{"status":"needs_clarification","question":"What must the app do?"}}
```

```json
{"intake":{"status":"ready","spec":{"objective":"...","acceptanceCriteria":["..."],"constraints":[]}}}
```

A clarification result writes a normal durable `channel_outbound` message and
does not advance the graph. A later Telegram update is appended to the same run
and wakes the entry agent again. A ready result is validated, enriched with the
retained Telegram chat, sender, and inbound transcript, then stored in
`workflow_runs.spec`. Only then does the existing workflow-engine edge routing
enqueue the planner. Invalid specs fail the run before any downstream dispatch.

The Telegram update receipt prevents duplicate inbound delivery from creating
another message or run. The partial unique index on collecting conversations
also serializes distinct updates that race for the same chat and workflow.

## Proof

```sh
npm run fact16:proof
```

The proof uses disposable PostgreSQL plus fake runtime and Telegram provider
boundaries. It covers direct sufficient intake, clarification and restart,
duplicate delivery, exactly one channel run, strict spec validation, and normal
engine dispatch to the planner. No Telegram token or model call is used.
