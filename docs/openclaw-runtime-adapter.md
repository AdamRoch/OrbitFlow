# OpenClaw RuntimeAdapter

FACT-11 turns the FACT-1 control spike into the execution boundary used by later workflow-engine work. The production adapter is `OpenClawRuntimeAdapter` in `src/lib/runtime/openclaw.ts`.

## Runtime contract

`syncAgent(agentId)` reads the current PostgreSQL `agents` row, writes the generated OpenClaw workspace, creates the OpenClaw agent when its stable `openclaw_ref` is absent, and reapplies workspace, model, and identity configuration on later calls. `agents.memory` is authoritative. `MEMORY.md` is regenerated from that JSON snapshot and is never read back into PostgreSQL.

`wakeAgent(input)` requires the caller's durable node invocation id and reads one consistent agent snapshot for both the generated workspace and the delivery prompt. The prompt contains the node system prompt, workflow and run context, tickets assigned to the calling agent and run, upstream handoff brief, canonical memory, and the fixed output contract. Requested ticket ids fail closed unless every ticket belongs to that run and agent.

The adapter accepts only this top-level output:

```json
{
  "artifact": {},
  "handoff_brief": "non-blank string",
  "events": []
}
```

Every event must be a JSON object. A malformed final output gets one corrective retry. A second malformed output, a timeout, an incomplete OpenClaw envelope, invalid usage, or another runtime failure rejects the wake and inserts one durable `system` message with FACT-9's `insertMessage` helper. The error payload contains bounded metadata only. It never includes provider stderr, raw model output, the composed prompt, or credentials.

Successful wakes return the validated output to the caller. They do not route it. FACT-10 owns workflow routing. Usage is written to `cost_events` for the calling run and agent, while `workflow_runs.total_tokens` and `total_cost` are updated in the same PostgreSQL transaction.

## Completion and termination

OpenClaw `2026.4.15` is pinned. Completion requires process success plus a successful structured OpenClaw envelope. Exit code zero alone is insufficient.

The configurable wake timeout defaults to five minutes and is bounded to thirty minutes. Every delivery gets a deterministic session key scoped to its durable invocation, run, agent, node, and selected tickets. The same deadline is sent to the OpenClaw request and enforced outside the CLI. Timeout or explicit `terminateAgent` sends `SIGTERM` to the isolated process group, waits a short grace period, then sends `SIGKILL`, and calls the gateway's `sessions.abort` RPC for that exact session. The failure is not reported as a normal timeout when the gateway cannot confirm `aborted` or `no-active-run`. No database transaction stays open while OpenClaw runs.

The adapter uses the gateway-backed `openclaw agent` command, not embedded `--local` execution. The OpenClaw state directory must be on the state volume used by the dedicated gateway topology selected by FACT-1.

## Credential boundary

The child environment is an allowlist of basic process variables plus explicitly supplied OpenClaw connection variables. It receives no provider credential by default. The dedicated gateway owns its environment-backed provider credential; the adapter CLI does not need a copy. Command arguments and retained fake proof records contain only whether the test-only credential sentinel was present, never its value. Stderr is counted for bounded diagnostics but neither retained nor attached to errors.

## Proof

Run:

```sh
npm run fact11:proof
```

The proof first requires the installed `openclaw` executable to report exactly `2026.4.15`. With `OPENROUTER_API_KEY` removed from the child environment, it exercises the real offline CLI paths for agent creation, listing, mutable `agents.list` lookup, model update, and identity update. It then starts one disposable PostgreSQL 16 container, applies the existing migration chain, and drives the adapter through a deterministic fake OpenClaw executable using the real subprocess request path. It proves create and edit synchronization, prompt contents, memory from run one appearing on run two, output and completion validation, usage and run-total persistence, one malformed-output retry, durable FACT-9 errors, timeout handling, and parent plus descendant cleanup. The container and temporary runtime workspace are removed on exit.

Provider execution is disabled by default and retained proof never calls OpenRouter. Setting `ORBITFLOW_FACT11_REAL_PROVIDER_PROOF` to a nonzero value makes the proof refuse to run rather than accidentally spending credentials.

No migration is added. FACT-11 uses the existing `agents.memory`, `agents.openclaw_ref`, `messages`, `cost_events`, and workflow-run aggregate columns.
