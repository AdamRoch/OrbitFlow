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

The caller's `invocationId` is a durable idempotency key inside one run and agent. Before OpenClaw starts, the production engine persists one canonical wake input for the dispatch, fixing its system prompt, model, generation, handoff, deterministic session, workspace tools, and bound tool context. Reconciliation reuses that input byte for byte. The adapter then reserves a deterministic negative `cost_events.id`; generated application rows remain in PostgreSQL's positive identity range. A PostgreSQL session advisory lock serializes concurrent callers without holding an open transaction around OpenClaw. On completion, one transaction converts that reservation into the attributed cost event, updates the run aggregate, and inserts an internal FACT-9 replay receipt containing the validated result. Replays return that receipt with `replayed: true` and neither execute OpenClaw nor increment cost again. A reservation without a terminal receipt means a prior process may have died after the external effect. It fails closed as `openclaw_invocation_indeterminate`, inserts the required durable error, and never guesses that executing again is safe.

FACT-30 adds same-agent serialization for OpenClaw fan-out. OpenClaw `2026.4.15` addresses one canonical session as `agent:<ref>:main`, so concurrent workflow dispatches targeting the same agent ref must never overlap. After the per-invocation reservation, the adapter takes a second PostgreSQL session-level advisory lock on a dedicated pool client, keyed by a stable 63-bit SHA-256 digest of the namespaced exact ref (`orbitflow:openclaw-agent-session:<ref>`), and holds it across workspace sync, session selection and verification, the `openclaw agent` call with its one structured-output retry, abort handling, and durable finalization. Lock order is always invocation lock first, agent-session lock second; the holder of the agent-session lock never takes a second PostgreSQL advisory lock, so nested acquisition cannot deadlock. The wake deadline is end-to-end for the session region: pool checkout, lock acquisition (via `lock_timeout`), every configuration-sync command, session verification, and each OpenClaw command attempt, including the one retry, all consume it and each receives only the remaining budget rather than a fresh full timeout. An exhausted deadline refuses to launch the next nested command as typed `openclaw_timeout`. Checkout or acquisition expiry fails closed as `openclaw_session_lock_timeout` (with a `connect` or `lock` stage detail) and other acquisition failures as `openclaw_session_lock_unavailable`; both are typed and retained as durable per-invocation error receipts without touching the live session another wake may own. Gateway `sessions.abort` cleanup runs only when an agent command actually launched. The lock is explicitly released and the client's `lock_timeout` reset in `finally` on every outcome; a failed release destroys the pool client. Different refs never contend and keep full concurrency. An in-flight wake pins two PostgreSQL pool clients (the per-invocation lock client and the agent-session lock client) for its whole duration, so pool sizing must allow at least two clients per concurrent wake before Phase 3 fan-out wiring raises dispatch concurrency. No general distributed-lock framework is introduced.

## Completion and termination

OpenClaw `2026.4.15` is pinned. Completion accepts only that release's gateway response shape: outer `status: "ok"` and `summary: "completed"`, one result payload, and metadata reporting `aborted: false`, `replayInvalid: false`, `livenessState: "working"`, and matching `stop` reasons. Blocked, errored, aborted, replay-invalid, invented, and otherwise unsupported zero-exit envelopes fail closed. Usage comes only from `result.meta.agentMeta.usage`, which represents the complete session stream; `lastCallUsage` is never substituted.

The configurable wake timeout defaults to five minutes and is bounded to thirty minutes. Every delivery gets a deterministic explicit session key scoped to its durable invocation, run, agent, node, and selected tickets. After a completed turn, `openclaw sessions --agent ... --json` must map that exact requested key to the internal session id returned by the envelope. A mismatch or stale result is rejected. The same deadline is sent to the OpenClaw request and enforced outside the CLI. Timeout or explicit `terminateAgent` sends `SIGTERM` to the isolated process group, waits a short grace period, then sends `SIGKILL`, and calls the gateway's `sessions.abort` RPC for that exact explicit session key. The failure is not reported as a normal timeout when the gateway cannot confirm `aborted` or `no-active-run`. No database transaction stays open while OpenClaw runs.

The adapter uses the gateway-backed `openclaw agent` command, not embedded `--local` execution. The OpenClaw state directory must be on the state volume used by the dedicated gateway topology selected by FACT-1.

## Credential boundary

The child gets a private runtime `HOME`, XDG directories under the runtime root, a small locale/path allowlist, and only three optional connection variables: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, and `OPENCLAW_GATEWAY_PASSWORD`. Any other supplied environment name is rejected by the constructor. Provider keys and arbitrary parent variables are not inherited. The dedicated gateway owns its provider credential; the adapter CLI does not need a copy. Retained fake proof records only booleans and forbidden variable names, never credential values. Stderr is counted for bounded diagnostics but neither retained nor attached to errors.

## Proof

Run:

```sh
npm run fact11:proof
```

The proof first requires the installed `openclaw` executable to report exactly `2026.4.15`. With `OPENROUTER_API_KEY` removed from the child environment, it exercises the real offline CLI paths for agent creation, listing, mutable `agents.list` lookup, model update, and identity update. It then starts one disposable PostgreSQL 16 container, applies the existing migration chain, and drives the adapter through a deterministic fake OpenClaw executable using the real subprocess request path. It proves create and edit synchronization, prompt contents, memory from run one appearing on run two, exact gateway-envelope rejection cases, complete-stream usage and run-total persistence, concurrent durable replay without another execution or charge, invocation-input conflict rejection, stale-session rejection, one malformed-output retry, durable FACT-9 errors, environment exfiltration resistance, timeout handling, and parent plus descendant cleanup. The FACT-30 scenarios proven by the same gate: two concurrent wakes for the same canonical ref never overlap the fake OpenClaw command (peak-observed marker concurrency stays at one); different refs overlap through an explicit marker barrier; the agent-session lock is released after a timeout so a later same-ref wake proceeds; an acquisition-deadline failure is typed `openclaw_session_lock_timeout` with a `lock` stage, durably retained, uncharged, and replayed as the same typed error; pool checkout is bounded by the wake deadline with a typed `connect`-stage durable error; a command that waited for the lock spends only the remaining deadline budget and keeps its gateway cleanup after the launched command times out; and a wake whose deadline is exhausted during configuration sync never launches an agent command and never runs `sessions.abort`. The container and temporary runtime workspace are removed on exit.

Provider execution is disabled by default and retained proof never calls OpenRouter. Setting `ORBITFLOW_FACT11_REAL_PROVIDER_PROOF` to a nonzero value makes the proof refuse to run rather than accidentally spending credentials.

## Runtime model catalog

`docker/openclaw/openclaw.json` is the single model catalog for the OpenClaw
runtime, database migration, and production-engine startup check. Migration
`0024-factory-agent-model-catalog.sql` receives the catalog's validated primary
model through a transaction-local setting and realigns every agent referenced
by a shipped workflow template. It contains no copied provider model name.

The production engine checks every database agent against that same committed
catalog before starting workers, at API writes, and again before each runtime
sync or wake. An unavailable reference names the agent, model, and registered
alternatives, then fails before provider execution. OpenClaw config application
also replaces persisted model catalog/default state while retaining the mutable
per-agent list.

Run `npm run fact35:proof` for fresh-install and upgrade PostgreSQL coverage,
negative configuration validation, and a credential-free local HTTP smoke. The
smoke sends the catalog-derived provider model to a disposable fake OpenRouter
boundary with `max_tokens: 1`; it never contacts OpenRouter or uses a provider
key, so it spends no paid tokens.

FACT-11 itself uses the existing `agents.memory`, `agents.openclaw_ref`,
`messages`, `cost_events`, and workflow-run aggregate columns. FACT-34 adds
`0023-openclaw-dispatch-inputs.sql` so the production engine can persist the
canonical wake input that reconciliation must reuse.
