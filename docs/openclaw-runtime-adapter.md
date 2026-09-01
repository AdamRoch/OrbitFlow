# OpenClaw RuntimeAdapter

FACT-11 turns the FACT-1 control spike into the execution boundary used by later workflow-engine work. The production adapter is `OpenClawRuntimeAdapter` in `src/lib/runtime/openclaw.ts`.

## Runtime contract

`syncAgent(agentId)` reads the current PostgreSQL `agents` row and writes the generated OpenClaw workspace. It then uses the gateway's `agents.list`, `agents.create`, and `agents.update` RPCs to create or reconcile the stable `openclaw_ref`, workspace, model, and identity. The gateway is the only OpenClaw agent-registry authority. `agents.memory` remains authoritative for OrbitFlow memory. `MEMORY.md` is regenerated from that JSON snapshot and is never read back into PostgreSQL.

`wakeAgent(input)` requires the caller's durable node invocation id and reads one consistent agent snapshot for both the generated workspace and the delivery prompt. The prompt contains the node system prompt, workflow and run context, tickets assigned to the calling agent and run, upstream handoff brief, canonical memory, and the `submit_result` instructions. Requested ticket ids fail closed unless every ticket belongs to that run and agent.

The agent calls `submit_result` with this top-level object:

```json
{
  "artifact": {},
  "handoff_brief": "non-blank string",
  "events": []
}
```

The broker validates the object during the tool call, stamps the authorized dispatch id and runtime generation, and stores the first valid submission for that attempt. The adapter never parses turn text. A completed turn without a submission gets one corrective retry. A second miss, a timeout, an incomplete OpenClaw envelope, invalid usage, or another runtime failure rejects the wake and inserts one durable `system` message with FACT-9's `insertMessage` helper. The error payload contains bounded metadata only. It never includes provider stderr, raw model output, the composed prompt, or credentials.

Successful wakes return the validated output to the caller. They do not route it. FACT-10 owns workflow routing. Usage is written to `cost_events` for the calling run and agent, while `workflow_runs.total_tokens` and `total_cost` are updated in the same PostgreSQL transaction.

The caller's `invocationId` is a durable idempotency key inside one run and agent. Before OpenClaw starts, the production engine persists one canonical wake input for the dispatch, fixing its system prompt, model, generation, handoff, deterministic session, workspace tools, and bound tool context. Reconciliation reuses that input byte for byte. The adapter then reserves a deterministic negative `cost_events.id`; generated application rows remain in PostgreSQL's positive identity range. A PostgreSQL session advisory lock serializes concurrent callers without holding an open transaction around OpenClaw. On completion, one transaction converts that reservation into the attributed cost event, updates the run aggregate, and inserts an internal FACT-9 replay receipt containing the validated result. Replays return that receipt with `replayed: true` and neither execute OpenClaw nor increment cost again. A reservation without a terminal receipt means a prior process may have died after the external effect. It fails closed as `openclaw_invocation_indeterminate`, inserts the required durable error, and never guesses that executing again is safe.

`OpenClawEngineAdapter` treats that typed error as a confirmed dispatch failure with an explicit uncertain-effect reason. The workflow engine therefore fails the dispatch and run instead of resetting the runtime generation or trying the provider again. `{kind: "absent"}` remains reserved for an adapter that can authoritatively prove that no external session exists.

FACT-30 adds same-agent serialization for OpenClaw fan-out. OpenClaw `2026.4.15` addresses one canonical session as `agent:<ref>:main`, so concurrent workflow dispatches targeting the same agent ref must never overlap. After the per-invocation reservation, the adapter takes a second PostgreSQL session-level advisory lock on a dedicated pool client, keyed by a stable 63-bit SHA-256 digest of the namespaced exact ref (`orbitflow:openclaw-agent-session:<ref>`), and holds it across workspace sync, session selection and verification, the gateway `agent` RPC with its one structured-output retry, abort handling, and durable finalization. Lock order is always invocation lock first, agent-session lock second; the holder of the agent-session lock never takes a second PostgreSQL advisory lock, so nested acquisition cannot deadlock. The wake deadline is end-to-end for the session region: pool checkout, lock acquisition (via `lock_timeout`), every gateway configuration call, session verification, and each agent attempt, including the one retry, all consume it and each receives only the remaining budget rather than a fresh full timeout. An exhausted deadline refuses to launch the next nested call as typed `openclaw_timeout`. Checkout or acquisition expiry fails closed as `openclaw_session_lock_timeout` (with a `connect` or `lock` stage detail) and other acquisition failures as `openclaw_session_lock_unavailable`; both are typed and retained as durable per-invocation error receipts without touching the live session another wake may own. Gateway `sessions.abort` cleanup runs only when an agent call actually launched. The lock is explicitly released and the client's `lock_timeout` reset in `finally` on every outcome; a failed release destroys the pool client. Different refs never contend and keep full concurrency. An in-flight wake pins two PostgreSQL pool clients (the per-invocation lock client and the agent-session lock client) for its whole duration, so pool sizing must allow at least two clients per concurrent wake before Phase 3 fan-out wiring raises dispatch concurrency. No general distributed-lock framework is introduced.

## Completion and termination

OpenClaw `2026.4.15` is pinned. Completion accepts only that release's gateway response shape: the outer `runId` must equal the request's deterministic idempotency key, `status` must be `ok`, `summary` must be `completed`, and metadata must report `aborted: false`, `livenessState: "working"`, and matching `stop` reasons. A `replayInvalid` turn succeeds only when the broker already stored its valid result submission. A `replayInvalid` turn without a submission fails closed rather than repeating possible side effects. Usage comes only from `result.meta.agentMeta.usage`, which represents the complete session stream; `lastCallUsage` is never substituted.

The configurable wake timeout defaults to five minutes and is bounded to thirty minutes. Every delivery uses the canonical `agent:<ref>:main` session key while its gateway run id is deterministic for the durable invocation and retry number. OpenClaw owns the internal session UUID. After a completed turn, the gateway's `sessions.resolve` RPC must map its returned UUID to that exact requested key. A mismatch or stale result is rejected. The same deadline is sent to the OpenClaw request and enforced outside the CLI. Timeout or explicit `terminateAgent` sends `SIGTERM` to the isolated process group, waits a short grace period, then sends `SIGKILL`, and calls the gateway's `sessions.abort` RPC with that exact session key and deterministic run id. An `aborted` response must report the same run id; `no-active-run` is accepted only as confirmation that the target is already gone. The failure is not reported as a normal timeout when the gateway cannot confirm `aborted` or `no-active-run`. No database transaction stays open while OpenClaw runs.

The adapter invokes `openclaw gateway call agent --expect-final`. It never uses the fallback-capable `openclaw agent` command or embedded `--local` execution. A gateway connection, authorization, method, or response failure therefore fails closed instead of starting a provider call in the engine process.

OpenClaw requires both the shared gateway token and a paired device identity for these operator RPCs. In the Compose topology, the authenticated loopback gateway health check creates that identity through OpenClaw's normal silent local-pairing path. It publishes only the gateway token, `identity/device.json`, and `identity/device-auth.json` to a dedicated client-bootstrap volume. The engine mounts that volume read-only and copies the identity into its writable private client state. It cannot read the gateway's registry, sessions, configuration, or future credential files through this bridge. ADR 0002 replaces the Compose-only volume with the `openclaw-runtime` service's authenticated OrbitFlow RPC, so Railway will not share volumes between services.

## Credential boundary

The child gets a private runtime `HOME`, XDG directories under the runtime root, a small locale/path allowlist, and only four optional connection variables: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`, and `OPENCLAW_ALLOW_INSECURE_PRIVATE_WS`. The last value must be exactly `1` when explicitly acknowledging Compose's isolated plaintext private network; public or untrusted links must use `wss://`. The adapter constructs this environment itself; callers cannot add arbitrary parent variable names. Provider keys and arbitrary parent variables are not inherited. The dedicated gateway owns its provider credential; the adapter CLI does not need a copy. Retained fake proof records only booleans and forbidden variable names, never credential values. Gateway JSON is parsed from stdout only. Stderr is counted for bounded diagnostics but neither retained nor attached to errors, and persisted failure details contain derived types, counts, and match booleans rather than raw gateway strings.

## Proof

Run:

```sh
npm run fact11:proof
```

The proof starts one disposable PostgreSQL 16 container, applies the existing migration chain, and drives the adapter through a deterministic fake OpenClaw executable using the real subprocess request path. It proves gateway-owned create and edit synchronization, direct `agent --expect-final` RPC invocation, deterministic gateway idempotency keys, session resolution, rejection of embedded fallback envelopes, prompt contents, memory from run one appearing on run two, exact gateway-envelope rejection cases, complete-stream usage and run-total persistence, concurrent durable replay without another execution or charge, invocation-input conflict rejection, stale-session rejection, one malformed-output retry, durable FACT-9 errors, environment exfiltration resistance, timeout handling, and parent plus descendant cleanup. The FACT-30 scenarios proven by the same gate remain the same-agent and cross-agent concurrency, deadline, lock release, and abort boundaries. The disposable database and temporary runtime workspace are removed on exit.

Run `npm run fact31:proof` for the production-boundary complement. It builds the pinned OpenClaw `2026.4.15` image, starts the real gateway with a local fake OpenRouter-compatible provider, proves fresh device pairing and gateway-owned agent registration, and drives the production engine through the real RPC path without a provider credential in the engine.

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
