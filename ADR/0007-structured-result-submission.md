# ADR 0007: Agents submit results through a platform tool, not final-turn prose

**Status:** Accepted (Adam, 2026-09-01)
**Applies to:** the OpenClaw runtime adapter, tool broker, and seeded agent prompts on `demo-readiness`
**Implemented by:** FACT-97

## Context

Every workflow node ends its turn by printing a JSON contract
(`{artifact, handoff_brief, events}`) as chat text, which the adapter
extracts and parses (`src/lib/runtime/openclaw.ts`). This puts the
result and the model's narration on the same channel, so the platform
must distinguish them by parsing prose. Staging run 4 (2026-09-01,
18:12 UTC) is the decisive evidence:

* The planner hit exec-allowlist friction mid-turn, recovered, and
  narrated. Its final prose failed the strict parser and the run died.
* In the same turn, its three `create_ticket` platform-tool calls all
  succeeded. The tool channel worked while the prose channel failed.

The response so far was envelope tolerance (candidate `ed5fa60`: last
non-empty payload must be the contract, leading narration ignored).
That is the ceiling of the prose road: each new narration shape invites
another tolerance, which the model-output doctrine forbids.

## Decision

Results leave the prose channel entirely. Each agent submits its final
output exactly once by calling a new `submit_result` platform tool
through the existing exec CLI + tool broker path:

1. **Broker-stamped attribution.** The broker already holds and
   authorizes the live dispatch context (`dispatchId`, `runId`,
   `agentId`, `dispatchGeneration`, lease check in
   `bin/orbit-tool-broker.mjs`). It stamps the submission with
   `(dispatch_id, runtime_generation)` itself. The model never types
   an identifier.
2. **Call-time outer validation.** The broker validates the payload
   against the uniform outer contract (exactly `artifact`,
   `handoff_brief`, `events`, with today's field rules) and returns
   the exact validation error as the tool result. The model corrects
   in-turn without burning a dispatch attempt.
3. **First write wins per attempt.** One row per
   `(dispatch_id, runtime_generation)`; a second valid call is refused
   with a clear error. The "two valid contracts" ambiguity becomes
   structurally impossible instead of a failure mode.
4. **Turn text is never parsed.** On turn completion the adapter reads
   the submission row instead of parsing payload text. Narration is
   harmless by construction. A turn that ends with no submission gets
   the existing in-session attempt-2 corrective wake, then the existing
   confirmed-failure path (FACT-80 tells the chat).
5. **Hard cutover.** A migration rewrites the seeded prompts to
   instruct tool submission, deployed atomically with the adapter
   change. No dual accept path; the envelope-tolerance code is deleted.
   Per-node inner contracts (intake decision, `artifact.verdict`) and
   their owners are unchanged.

## Consequences

* The malformed-final-output class (run 4's killer) disappears rather
  than being tolerated. Doctrine rule 1 simplifies: its envelope
  amendment is retired when this lands.
* Exec-argument formatting moves onto the critical path: a denied
  `submit_result` call would strand the turn. The exec allowlist
  `argPattern` must therefore tolerate the JSON shapes models actually
  emit (multi-line JSON is the suspected run-4 denial), fixed in the
  same change.
* The broker gains a small outer-contract validator (mirror of
  `parseOutputContract`'s rules); the adapter loses more code than the
  broker gains.
* Stored invocation receipts keep replaying: the replay path reads the
  stored output object directly instead of re-parsing text.

## Rejected alternatives

* **Provider structured output** (`response_format` JSON schema):
  unproven through the OpenClaw gateway + OpenRouter + GLM chain, does
  nothing for mid-turn tool side effects, and constrains the whole
  turn rather than just the result. The exec/tool channel is proven in
  production by run 4 itself.
* **Continued envelope tolerance:** each tolerance is a doctrine
  violation that invites the next one; `ed5fa60` already accepts every
  shape we can accept without guessing.
