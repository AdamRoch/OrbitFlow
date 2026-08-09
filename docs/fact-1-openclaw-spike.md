# FACT-1 OpenClaw control spike

## Result

OpenClaw remains viable as OrbitFlow's execution plane. The spike creates two isolated agents from code, gives each a distinct persona and durable `MEMORY.md`, wakes both with a composed prompt, parses strict structured output, validates terminal state, and records per-turn token usage.

The future compose stack does not need a host-side OpenClaw sidecar. OpenClaw officially supports a containerized gateway. OrbitFlow should run that gateway as its own compose service and connect through the Gateway protocol. This local spike uses embedded `agent --local --json` because installed OpenClaw `2026.4.15` predates the current `agent exec --json` command. Embedded mode exclusively locks one state directory, so it is proof code, not the concurrent production topology.

Official references:

- [Agent CLI](https://docs.openclaw.ai/cli/agent)
- [Agent workspaces and persona files](https://docs.openclaw.ai/concepts/agent-workspace)
- [Memory files](https://docs.openclaw.ai/concepts/memory)
- [Gateway completion protocol](https://docs.openclaw.ai/gateway)
- [Containerized gateway](https://docs.openclaw.ai/install/docker)
- [OpenRouter provider](https://docs.openclaw.ai/openrouter)

## Hands-on runbook

1. Confirm `openclaw --version` works and `OPENROUTER_API_KEY` is present. Do not print the key.
2. From the repository root, run `npm test`.
3. Run `npm run fact1:spike -- --runtime-dir /tmp/orbitflow-fact1-runtime --evidence-dir /tmp/orbitflow-fact1-evidence` using two paths that do not already exist.
4. Open `/tmp/orbitflow-fact1-evidence/evidence.json`. Every acceptance criterion must say `passed: true`; then run `cd /tmp/orbitflow-fact1-evidence && shasum -a 256 -c sha256sums.txt`.
5. After inspection, move `/tmp/orbitflow-fact1-runtime` to Trash because OpenClaw runtime state can contain copied authentication profiles. Keep the evidence directory.

The runtime directory contains OpenClaw state and should not be committed. The evidence directory contains only the structured envelopes, normalized results, prompts, persona/memory files, and checksums. Credential values are never retained.

## Diagnostic finding

The installed OpenClaw package generated `models.json` with `https://openrouter.ai/v1`, which caused `POST /v1/chat/completions` to return an HTML 404. A direct request to OpenRouter's documented `POST /api/v1/chat/completions` path succeeded with the same credential and model. The spike therefore pins:

```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "api": "openai-completions"
      }
    }
  }
}
```

Do not remove that override until the pinned OpenClaw version is proven to generate the official base URL itself.

## RuntimeAdapter seed

The later adapter only needs three operations from this spike:

```text
createAgent({ id, workspace, model })
wakeAgent({ id, composedPrompt, timeoutMs })
  -> { output: { artifact, handoff_brief, events }, usage, completion, runtime }
terminateAgent({ id })
```

Completion must fail closed. A process exit code is not enough: OpenClaw `2026.4.15` returned exit `0` after a provider HTML 404, while its JSON envelope contained `meta.error` and `livenessState: "blocked"`. Reject timeouts, nonzero exits, structured errors, blocked liveness, malformed agent output, and missing or zero usage.
