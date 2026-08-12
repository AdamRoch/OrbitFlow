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

## Status and completion reports

FACT-17 recognizes a small fixed set of in-run status phrases, including
`how's it going`, before the normal entry wake. A status update stays a normal
`channel_inbound` message on the active channel run. The engine reads the
authoritative PostgreSQL run, workflow, ticket, dispatch, cost, and retained
output rows in the same routing transaction, then records its grounded response
as a normal `channel_outbound` message. It never asks the model to infer state
from the conversation transcript.

When a channel run changes to `completed`, the engine writes one retained
`system` completion wake addressed to its channel-bound orchestrator and records
it in `channel_completion_events`. Consumption of that wake creates one normal
`channel_outbound` final report for the original Telegram chat. The event row
and final outbound message id make terminal observation and post-restart replay
idempotent. UI and cron runs have no channel completion event.

## Proof

```sh
npm run fact16:proof
```

The proof uses disposable PostgreSQL plus fake runtime and Telegram provider
boundaries. It covers direct sufficient intake, clarification and restart,
duplicate delivery, exactly one channel run, strict spec validation, and normal
engine dispatch to the planner. No Telegram token or model call is used.

For the FACT-17 reporting proof, run:

```sh
npm run fact17:proof
```
