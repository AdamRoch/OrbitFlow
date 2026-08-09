# FACT-3 decision: v1 CodingToolAdapter = opencode

## What was tested

Three headless coding CLIs were already installed and evaluated live against
this ticket's constraints (`orbitflow-prd.md` §5, `tickets/P0-3-spike-coding-cli-wrapper.md`):
must run with no TTY/prompts, must authenticate via a single evaluator env
var (not a builder's OAuth/subscription session), must produce a usable
diff/log/usage from an isolated git workspace.

| Candidate | Headless mode | Single-env-var auth | Result |
|---|---|---|---|
| **opencode** | `opencode run --format json --dir <ws> --auto` | `OPENROUTER_API_KEY` (auto-discovered, no login step) | **Chosen.** Live end-to-end proof succeeds: real diff, bounded NDJSON log, real token/cost usage. |
| **claude** (Claude Code) | `claude -p --bare --output-format json` | `ANTHROPIC_API_KEY` | Rejected for v1: no `ANTHROPIC_API_KEY` was available in this environment to prove the happy path. `--bare` mode is documented to read only `ANTHROPIC_API_KEY`/`apiKeyHelper`, never OAuth or keychain, and this was verified live (see below) -- a strong candidate to add later, but not provable end-to-end here. |
| **codex** (OpenAI Codex CLI) | `codex exec --json` | `OPENAI_API_KEY` | Rejected for v1: no `OPENAI_API_KEY` was available, and unlike the other two, missing-credential failure is slow, not fail-fast -- it retried live WebSocket/HTTPS connections to `api.openai.com` for ~10s (5 reconnect attempts) before surfacing `turn.failed`, instead of erroring immediately. |

## Why opencode

It's the only candidate this environment could prove **live, end to end**:
`OPENROUTER_API_KEY` was the one provider credential actually present, and
opencode picks it up automatically (`opencode providers list` shows it under
a separate "Environment" section, distinct from stored `auth.json`
credentials -- no `opencode providers login` step needed).

Concrete live run (via `proof/run-proof.js`, real API call, real cost ~$0.02):
task "create hello.txt with X" → real `git diff` showing the new file, a
bounded NDJSON event log, and real usage (`inputTokens`, `outputTokens`,
cache tokens, `costUsd`).

### A real gotcha this proof caught

Running the adapter against this machine's normal environment (which has a
pre-existing `~/.local/share/opencode/auth.json` with other stored provider
credentials, and a 300MB+ `opencode.db`) made the run fail with a generic
`UnknownError`, *even with a valid `OPENROUTER_API_KEY` set*. That's exactly
the failure mode this ticket's constraint exists to prevent: a coding CLI
silently depending on a builder's local state instead of the one evaluator
env var. Fix: the adapter (`src/openCodeAdapter.js`, `isolatedStateEnv`)
gives every `delegate_coding_task` call fresh
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` temp
dirs, so opencode can never see a builder's stored credentials or config --
verified live, this fixed the failure. In a real evaluator container (fresh
`docker compose up`, no prior opencode state) this isolation is a no-op
safety net rather than a fix, but it makes the "single env var only"
guarantee true by construction instead of by accident of a clean host.

### Rejected-but-viable: claude --bare

Verified live (no real key needed for this check): running
`claude -p --bare --output-format json` with `ANTHROPIC_API_KEY` unset --
even on *this* machine, which has an active OAuth-logged-in Claude Code
session in the real `$HOME` -- fails immediately with
`"Not logged in · Please run /login"` (`duration_ms: 21`, `total_cost_usd: 0`).
That's solid evidence `--bare` mode never falls back to a builder's
subscription/OAuth session. If a second harness is added later (PRD §6,
stretch), this is the strongest alternative -- it just couldn't be proven
end-to-end here for lack of a real `ANTHROPIC_API_KEY`.

### Rejected: codex

`OPENAI_API_KEY` also wasn't available. Beyond that, the missing-credential
behavior itself is worse for a tool call inside an agent loop: instead of
failing in milliseconds, `codex exec` attempts a live websocket connection,
falls back to HTTPS, and retries 5 times (~10s total) before giving up. That
latency would show up as every misconfigured run silently costing ~10s per
tool call before an agent even sees the error.

## Interface

`coding-adapter/src/openCodeAdapter.js` exports `createOpenCodeAdapter()`
implementing `delegate_coding_task(task, workspace) -> {diff, log, usage}`
per PRD §5. Plurality is deferred (PRD §5, §6 stretch) -- the factory
function shape (`spawn`, `apiKeyEnvVar`, `model`, `binary` all injectable)
exists so a second adapter can be added later without reworking this one,
without building a plugin framework now.

## Structured failures (`src/errors.js`)

- `MissingCredentialsError` -- required env var absent, checked before
  spawning (no wasted process/network call).
- `CliFailureError` -- nonzero exit or spawn error; carries bounded
  stderr/stdout tails.
- `TimeoutError` -- process exceeded `timeoutMs`, killed (`SIGTERM` then
  `SIGKILL` after 2s if still alive).
- `MalformedOutputError` -- exit 0 but stdout didn't parse as the expected
  NDJSON event stream (including "exit 0, empty output").

None of these ever include env var *values*, only names and bounded output
tails.

## Proof

`node coding-adapter/proof/run-proof.js` -- run with `OPENROUTER_API_KEY` set
in the environment (nothing else). Creates a fresh temp git workspace, runs
a trivial task through `delegate_coding_task`, prints usage/diff/log. Run
without the key to see the missing-credential failure path.

## Tests

`node --test` in `coding-adapter/` (11 tests, all fakes -- no live provider
calls, per the ticket's guidance): command construction (argv, cwd, env,
XDG isolation), NDJSON usage summing, diff/log shape, and failure mapping
for missing creds / nonzero exit / malformed output / empty output / spawn
errors / timeouts.
