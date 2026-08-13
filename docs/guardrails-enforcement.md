# Guardrails enforcement

FACT-23 enforces the PRD §6 guardrails with the existing control-plane fields.
No new policy language exists: the engine reads `agents.guardrails` and the run
spec, and the FACT-13 dispatch point reads `agents.guardrails.blockedActions`.
`src/lib/guardrails.ts` is the only parser; malformed values fail open (treated
as unconfigured) so a hand-edited row can never crash the engine, matching the
FACT-22 monitoring read of `costLimit`.

## Cost ceilings

Two ceilings are checked by the engine inside the dispatch-claim transaction,
after the run, thread, and dispatch rows are locked and before any provider
start is authorized. Unknown costs (rows in `cost_events` whose
`computed_cost IS NULL`, which can happen when the coding CLI omits the value
after migration `0010`) cause the engine to fail closed: the run pauses with
a `guardrail_unknown_cost` message until the rows are reconciled to concrete
values, and resume re-checks.

- **Run ceiling** — `workflow_runs.spec.guardrails.costLimit`, a non-negative
  number compared against the run's `total_cost` aggregate after confirming
  no `cost_events` rows for the run have `computed_cost IS NULL`.
- **Agent ceiling** — `agents.guardrails.costLimit`, a non-negative number
  compared against `SUM(cost_events.computed_cost)` for that agent inside that
  run after confirming no matching rows have `computed_cost IS NULL`.

The wake is refused when spend is greater than or equal to the ceiling (or
when any relevant costs are unknown); the comparison runs in PostgreSQL
`numeric` so the exact boundary holds. A refusal leaves the dispatch
`pending`, transitions the run to `paused`, and appends one durable `system`
message per pause transition from `system:workflow-engine` with payload code
`guardrail_cost_ceiling` or `guardrail_unknown_cost`, the `scope` (`run` or
`agent`), attribution, and the spend/ceiling figures (omitted for unknown
cost). A paused run blocks new claims through the existing FACT-10 lifecycle,
so nothing silently stalls and sibling progress is preserved.
`resumeWorkflowRun` re-admits the dispatch; if spend still reaches the
ceiling the run pauses again with a fresh message, and raising the ceiling
plus resume lets the run continue. Reconciliation claims do not wake a
provider and are not ceiling-checked.

## Rate limit

`agents.guardrails.rateLimit.perMinute` caps one agent's wakes over a trailing
60-second window across all runs. Migration `0014-guardrail-wake-events.sql`
adds `agent_wake_events`, the durable record of every provider start the engine
authorizes (one row per start-phase claim, unique per dispatch lease
generation); a dispatch's latest status cannot reconstruct when earlier starts
happened, which is why the additive table is required. It lands after current
main's chain (`0001`–`0004`, `0009`–`0012`); FACT-21 owns `0013`. A throttled
claim stays `pending` and the worker simply tries later candidates — throttling
never pauses the run and never logs, because a sliding window frees itself. The
agent row is locked `FOR UPDATE` during the start-phase check so concurrent
dispatch workers cannot overshoot the window or the agent ceiling.

## Blocked actions

`agents.guardrails.blockedActions` is a list of action names. The enforceable
boundary at the FACT-13 surface is exactly its five commands: `create_ticket`,
`update_ticket`, `post_message`, `list_projects`, `list_tickets`. `dispatchPlatformTool` remains
the single enforcement point: a listed command is rejected before any mutation
inside the same transaction that records the attempt, the rejection appends one
durable `system` message from `system:guardrails` with payload code
`action_blocked`, and the rejection result is stored through the existing
`agent_tool_invocations` idempotency seam. A retry with the same key replays
the identical `action_blocked` error without logging or mutating again; reusing
the key for a different request still fails closed as `idempotency_key_reused`.
Unlisted commands for the same agent are unaffected. The OpenClaw adapter also
lists the blocked actions in every composed wake prompt under
`# Blocked actions`, so agents are told the boundary before they can hit it.

## Proof

Run:

```sh
npm run fact23:proof
```

The proof creates only `orbitfactory-fact23-postgres-proof` on a random local
port, applies the clean migration chain, and removes that exact container. It
covers the agent ceiling at, below, and above the exact boundary, the visible
pause and resume-repause loop, ceiling-raise recovery, the run ceiling from the
spec, rate-window throttling and sliding across runs, malformed guardrails
failing open, blocked-action rejection before mutation, durable single logging,
idempotent rejection replay, and the production CLI error path. The runtime is
the deterministic in-memory adapter; the database is real PostgreSQL.
