# Runtime integration

OrbitFlow uses OpenCode `1.18.29` as its coding runtime and pins the matching
`@opencode-ai/sdk` contract at `1.18.29`. OpenCode is the best fit for the first
demo because it already has native file tools, per-agent prompts and permissions,
a headless HTTP API, structured JSON results, SSE events, cancellation, and
per-message token and cost fields. Goose has a strong MCP and sandbox story, but
its recipe and CLI surfaces add translation work for this product's small typed
execution boundary. OpenClaw already owns scheduling, memory, and channels, which
would duplicate the platform behavior OrbitFlow must make editable and visible.

The pinned versions were current npm `latest` on 2026-09-06. Do not silently
float either package. The runtime image installs `opencode-ai@1.18.29`; code that
imports the SDK must use `@opencode-ai/sdk@1.18.29`.

## Execution contract

`executeTurn` starts one container for one agent turn. OrbitFlow writes the
retained revision into a new host temporary directory and mounts only its
`workspace` subdirectory at `/workspace`. A generated `opencode.json` is mounted
separately and read-only. The config maps the saved system prompt, role, memory,
skills, model, blocked actions, approval policy, and requested tool
set into the OpenCode agent. Tool names accepted by this boundary are `read`,
`write`, `edit`, `glob`, and `grep`; `write` and `edit` both map to OpenCode's
`edit` permission because that permission gates write, edit, and patch operations.
The image includes Debian `ripgrep` `13.0.0-4+b2`, which OpenCode uses to
implement both `glob` and `grep`.
All other tools are denied both in the agent permissions and on the prompt request.
This second filter preserves the difference between OpenCode's unified edit
permission and OrbitFlow's individual `write` and `edit` settings. OpenCode's
internal `StructuredOutput` tool is the one explicit exception because the schema
result depends on it.

OrbitFlow enforces `maxTurns` as completed agent calls in the graph engine. It
does not map that setting to OpenCode's `agent.steps`. OpenCode `1.18.29` appends
a final assistant prefill when that native limit is reached, and Claude 4.6
rejects assistant prefills. Native cycles remain bounded by the observed-cost and
turn-time limits.

The adapter creates a session and sends:

```ts
POST /session/:id/message
{
  agent: "orbitflow-agent",
  model: { providerID, modelID },
  parts: [{ type: "text", text: prompt }],
  format: {
    type: "json_schema",
    schema: { /* summary and workflow outcome */ },
    retryCount: 2
  }
}
```

The JSON schema result supplies `summary` and a nonempty outcome string that the
editable graph uses to choose its next edge. Source files come from the workspace,
not from model prose. OrbitFlow rejects paths outside the workspace, hidden path
segments, symlinks, and file types outside its static browser artifact allowlist;
it caps input and output artifacts at 8 MiB. This also prevents a retained artifact
from injecting `.opencode` plugins or replacing the runtime policy on a later turn.
OpenCode's `message.updated` events supply `tokens.input`, `tokens.output`,
`tokens.reasoning`, `tokens.cache.read`, `tokens.cache.write`, and `cost`.
OrbitFlow replaces streaming snapshots by message ID and sums every assistant
message in the session rather than counting only the final result message. It
requires the event stream to connect before the prompt, the exact session's
`session.idle`, the response assistant ID, and complete numeric usage on every
assistant message. Its public input counter includes input plus cache reads and
writes; its public output counter includes output plus reasoning. Cost remains
unknown if any completeness condition fails.
Before a turn, the engine passes the smaller of the agent's remaining configured
cost allowance and the application's remaining authorized provider budget. The
runtime replaces repeated `message.updated` snapshots by message ID and aborts
when observed cumulative assistant cost reaches that amount. Provider usage is
reported only after a response, so this stops later model and tool steps but
cannot prevent the in-flight response from exceeding the threshold. Final usage
is read before the exact container is removed and is retained on failure.
The UI must describe cost as the runtime's estimate rather than a provider invoice;
some providers or subscription routes can legitimately report zero or incomplete
cost data.

`GET /event` provides runtime events for live monitoring. `POST
/session/:id/abort` cancels the OpenCode session. OrbitFlow also force-removes the
exact generated per-turn container on cancellation, timeout, completion, or
failure. It never performs broad container cleanup.
After a structured response, the adapter keeps the stream open until the exact
session reports `session.idle` (bounded to eight seconds) and validates the
complete assistant snapshots before accepting usage. OpenCode `1.18.29` returns
HTTP 400 when reading message history that contains its own accepted
`OutputFormatJsonSchema`, so the message-list endpoint is used only as a bounded
best effort after failures. This pinned upstream decoder mismatch is recorded from
an actual provider-backed session, not inferred from an empty probe.
Docker can publish the mapped port before OpenCode accepts HTTP, so each health
probe has its own one-second timeout and retries within the turn bound. Session
creation has a separate 15-second bound. The runtime emits `Session ready` only
after the authenticated session exists.

## Isolation and credentials

The coding container runs with a read-only root filesystem, all Linux capabilities
dropped, `no-new-privileges`, a host UID/GID, and CPU, memory, process, and time
limits. It has no Docker socket, host home directory, application checkout,
database credential, Telegram token, or orchestration environment. `bash`,
subagents, web tools, LSP, runtime skill discovery, questions, and external
directory access are denied. The only writable bind mount is the turn workspace.
The image contains the exact `@opencode-ai/plugin@1.18.29` dependency that
OpenCode loads while initializing a project. Baking it into the read-only image
avoids a network install and large npm cache in each turn's temporary home.

The backend selects the single API-key variable for the configured model provider
from its explicitly configured application environment. It does not mount or read
OpenCode's host configuration. The key is passed only to the ephemeral coding
container and the container is removed after the turn. The preview HTTP listener serves retained static text on a distinct browser origin per application lineage. It never executes generated server code and exposes no provider or OrbitFlow credentials. Generated JavaScript is never executed by the coding
runtime adapter.

The current provider-key mapping is `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, and `OPENROUTER_API_KEY`. Other providers are rejected until their credential and API contract is explicitly added.

## Evidence collected without a provider call

Using an empty temporary home and config directory, the published
`opencode-ai@1.18.29` package started `opencode serve` on loopback. The following
behavior was observed locally without any provider credential or model request:

- `GET /global/health` returned `{ "healthy": true, "version": "1.18.29" }`.
- `POST /session` created a session rooted in the selected temporary workspace
  with zero cost and zero tokens.
- `POST /session/:id/abort` returned `true`.
- `GET /config` and `GET /agent` returned the probe agent's exact prompt, model,
  seven-step limit, and ordered read/edit/shell/external-directory permissions.
- The server's live OpenAPI 3.1 document includes `format` on the message request,
  `structured` on the assistant response, and required cost and token fields.

The pinned image also built locally. Its hardened container returned the same
`1.18.29` health response with a read-only root, dropped capabilities,
`no-new-privileges`, and the configured CPU, memory, and process limits.

The production `executeTurn` path was also exercised with a dummy provider value
and aborted synchronously on its `Session ready` event. It emitted `Starting
OpenCode 1.18.29`, `Runtime ready`, and `Session ready`, then returned a
`RuntimeFailure` with zero cost and tokens and removed its exact container. The
abort check occurs before the model request, so this proved startup without a
provider call.

No model-backed response, tool call, provider cost, or generated application was
proven by that probe. Those claims require the bounded provider run and end-to-end
demo Adam authorizes later.

Official references: [OpenCode SDK](https://opencode.ai/docs/sdk/), [server API](https://opencode.ai/docs/server/), [agents](https://opencode.ai/docs/agents/), [permissions](https://opencode.ai/docs/permissions/), [tools](https://opencode.ai/docs/tools/), [Goose](https://block.github.io/goose/), and [OpenClaw cost and credential behavior](https://docs.openclaw.ai/reference/api-usage-costs).
