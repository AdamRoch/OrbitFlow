# FACT-2 OpenClaw platform CLI spike

## Result

OpenClaw can call a platform-owned CLI without a human during a real embedded agent turn. The proof registers `orbit-tool` in the agent workspace's `TOOLS.md`, exposes only OpenClaw's supported `exec` tool, and prompts one isolated agent to run exactly `node ./orbit-tool.mjs echo fact-2-platform-tool-payload`.

The CLI writes one JSONL audit record containing its command, subcommand, payload, and exact argument array. The platform validates that record directly. It does not infer the call from rendered terminal output. The run also validates OpenClaw's structured completion envelope and nonzero token usage, then writes checksums for retained evidence.

## Hands-on runbook

1. Confirm `openclaw --version` works and `OPENROUTER_API_KEY` is present. Do not print the key.
2. From the repository root, run `npm test`.
3. Run `npm run fact2:spike -- --runtime-dir /tmp/orbitflow-fact2-runtime --evidence-dir /tmp/orbitflow-fact2-evidence` with paths that do not already exist.
4. Inspect `/tmp/orbitflow-fact2-evidence/evidence.json`, `turn-normalized.json`, and `platform-tool-invocations.jsonl`. All acceptance criteria must be `true`; then run `cd /tmp/orbitflow-fact2-evidence && shasum -a 256 -c sha256sums.txt`.

The runtime directory is removed automatically, including OpenClaw's credential-bearing state. The retained evidence contains only the sanitized agent result, deterministic invocation record, workspace instructions, and checksums. Credential values are neither printed nor retained.

## Registration and boundary findings

This proof uses OpenClaw's supported `exec` tool rather than a custom OpenClaw plugin. `TOOLS.md` provides the agent-visible CLI contract. The config sets `tools.allow=["exec"]`, so `exec` is the only OpenClaw tool visible to this proof agent. The platform copies its CLI script into the fresh agent workspace and invokes it through Node. In the installed embedded release, neither `tools.exec.pathPrepend` nor a launcher PATH override reached the exec child, so a host-installed `orbit-tool` cannot be assumed resolvable.

The proof runs with embedded `agent --local`, so `tools.exec.host=gateway` with `security=full` means the local host process can execute the command. It is deliberately isolated and not a production sandbox claim. A containerized gateway must mount or copy the CLI into its image or container, ensure the selected runtime is available, and replace this broad execution policy with a tool-specific boundary; the host's path will not be available inside the sandbox.

Later `create_ticket` and `post_message` tools should follow the same shape: one explicit executable, a narrow argument contract, least-privilege allowlisting, structured platform-side audit records, and a parser that rejects missing, extra, or malformed calls. They should not rely on the agent's prose or terminal display as evidence.
