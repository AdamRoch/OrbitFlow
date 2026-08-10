# FACT-1 OpenClaw control spike

## Result

OpenClaw remains viable as OrbitFlow's execution plane. The spike creates two isolated agents from code, gives each a distinct persona and durable `MEMORY.md`, wakes both with a composed prompt, parses strict structured output, validates each reported identity and persona theme against its configuration, rejects incomplete workspace injection, validates terminal state, and records per-turn token usage.

The future compose stack does not need a host-side OpenClaw sidecar. OpenClaw officially supports a containerized gateway. OrbitFlow should run that gateway as its own compose service and connect through the Gateway protocol. This local spike uses embedded `agent --local --json` because installed OpenClaw `2026.4.15` predates the current `agent exec --json` command. Embedded mode exclusively locks one state directory, so it is proof code, not the concurrent production topology.

Official references:

- [Agent CLI](https://docs.openclaw.ai/cli/agent)
- [Agent workspaces and persona files](https://docs.openclaw.ai/concepts/agent-workspace)
- [Memory files](https://docs.openclaw.ai/concepts/memory)
- [Gateway completion protocol](https://docs.openclaw.ai/gateway/protocol)
- [Containerized gateway](https://docs.openclaw.ai/install/docker)
- [OpenRouter provider](https://docs.openclaw.ai/openrouter)
- [Official OpenRouter API endpoint](https://openrouter.ai/docs/quickstart)

## Hands-on runbook

1. Confirm `openclaw --version` works and `OPENROUTER_API_KEY` is present. Do not print the key.
2. From the repository root, run `npm test`.
3. Run `npm run fact1:spike -- --runtime-dir /tmp/orbitflow-fact1-runtime --evidence-dir /tmp/orbitflow-fact1-evidence` using two paths that do not already exist. This command first runs the direct OpenRouter and controlled OpenClaw endpoint diagnostic. The spike fails before success evidence is written if that diagnostic fails.
4. Open `/tmp/orbitflow-fact1-evidence/evidence.json` and `/tmp/orbitflow-fact1-evidence/diagnostic-openrouter.json`. Every acceptance criterion in both files must say `true`; then run `cd /tmp/orbitflow-fact1-evidence && shasum -a 256 -c sha256sums.txt`.
5. After inspection, move `/tmp/orbitflow-fact1-runtime` to Trash because OpenClaw runtime state can contain copied authentication profiles. Keep the evidence directory.

The runtime directory contains OpenClaw state and should not be committed. The evidence directory contains only the structured envelopes, normalized results, prompts, persona/memory files, and checksums. Credential values are never retained.

## Diagnostic finding

The executable diagnostic holds `models.mode=replace`, the `openrouter:default` environment-backed auth profile, model, prompt, and session constant. Both conditions begin from the same hashed OpenClaw state snapshot. The failing condition runs in a clone so its session cannot affect the corrected condition. It captures OpenClaw's request URL from the OpenAI SDK info log inside the OpenClaw process and stops the intentionally broken run immediately after the authoritative 404 response is captured. With the installed package's generated `https://openrouter.ai/v1` base URL, OpenClaw issued `POST /v1/chat/completions` and received 404. Changing only `models.providers.openrouter.baseUrl` made OpenClaw issue `POST /api/v1/chat/completions` and complete real inference. A separate direct request to that official path also completed real inference with the same credential source and model. Only sanitized request metadata, output, and usage are retained. The spike therefore pins:

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
