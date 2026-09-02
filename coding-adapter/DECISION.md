# FACT-3 decision: v1 CodingToolAdapter = opencode

## What was tested

Three headless coding CLIs were already installed and evaluated live against
the adapter constraints in `orbitflow-prd.md` §5:
must run with no TTY/prompts, must authenticate via a single evaluator env
var (not a builder's OAuth/subscription session), must produce a usable
diff/log/usage from an isolated git workspace.

| Candidate | Headless mode | Single-env-var auth | Result |
|---|---|---|---|
| **opencode** | `opencode --pure run --format json --dir <ws> --auto` | `OPENROUTER_API_KEY` (auto-discovered, no login step) | **Chosen.** Live end-to-end proof succeeds: real diff, bounded NDJSON log, real token/cost usage. |
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
`reasoningTokens`, cache tokens, `costUsd`). OpenCode is provisioned through
the exact npm dependency `opencode-ai@1.18.4`; the proof rejects any other
reported CLI version.

### A real gotcha this proof caught

Running the adapter against this machine's normal environment (which has a
pre-existing `~/.local/share/opencode/auth.json` with other stored provider
credentials, and a 300MB+ `opencode.db`) made the run fail with a generic
`UnknownError`, *even with a valid `OPENROUTER_API_KEY` set*. That's exactly
the failure mode this ticket's constraint exists to prevent: a coding CLI
silently depending on a builder's local state instead of the one evaluator
env var. The adapter passes a minimal child environment containing the selected
key, tool `PATH`, isolated home/state paths, and fixed safety switches. Project
config and Claude compatibility are disabled, while `--pure` excludes external
plugins. Every call removes its temporary state before returning. In a real
evaluator container (fresh `docker compose up`, no prior opencode state) this
isolation is a no-op safety net rather than a fix, but it makes the "single env
var only" guarantee true by construction instead of by accident of a clean
host.

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
function shape keeps the adapter behind one interface, so a second adapter can
be added later without reworking callers or building a plugin framework now.
The production workspace comes from `createRunWorkspaceService()`, which binds
one durable Git workspace to a verified `workflow_runs` row and filesystem
identity. `createIsolatedGitWorkspace()` remains only for the Phase 0 and unit
proof harnesses.

## Structured failures (`src/errors.js`)

`PUBLIC_ERROR_CODES` is the authoritative executable-tool response
schema. Its code enum contains `internal_failure`, `missing_credentials`,
`cli_failure`, `timeout`, `malformed_output`, `output_too_large`,
`credential_exposure`, `workspace_invalid`, `persistence_failure`, and
`invalid_request`. Runtime serialization imports that schema rather than
accepting arbitrary error codes.

- `MissingCredentialsError` -- required env var absent, checked before
  spawning (no wasted process/network call).
- `CliFailureError` -- unowned workspace, nonzero exit, spawn error, or failed
  inspection; carries bounded stderr/stdout tails when available.
- `TimeoutError` -- process exceeded `timeoutMs`; the complete POSIX process
  group is terminated (`SIGTERM`, then `SIGKILL` after the grace period).
- `MalformedOutputError` -- exit 0 but stdout didn't parse as the expected
  NDJSON event stream, has invalid usage, or lacks a terminal completed step.
- `OutputTooLargeError` -- the aggregate tracked and untracked diff exceeded
  the 10 MiB review limit.
- `CredentialExposureError` -- the evaluator key or a reversible Base64, hex,
  or URL encoding appeared in CLI output or workspace state. No affected
  output is returned. Temporary proof workspaces are removed; durable run
  workspaces are retained in quarantine.
- `WorkspaceError` (`workspace_invalid`) -- the requested run workspace is missing, escaped,
  replaced, still live during cleanup, or no longer matches its durable
  ownership record.
- `PersistenceError` (`persistence_failure`) -- usage attribution could not be verified or written;
  the delegation is not reported as a success.
- `InvalidRequestError` (`invalid_request`) -- the executable tool request, calling context, or
  configuration does not satisfy the public command contract.

The credential-free execution boundary changes into the validated workspace,
checks the resulting current directory's device and inode, and only then asks
the parent for the provider key over IPC. Git inspection, OpenCode, credential
scanning, and diff generation all use that established current directory with
relative paths. A path rename or replacement before handoff gets no key. A
replacement after entry cannot redirect the established directory.

The protocol stream is parsed in full while the presentation log remains
bounded. Token fields and their sums must be safe nonnegative integers within
PostgreSQL `BIGINT`; cost must fit `NUMERIC(18,8)`. Returned logs, diffs, error
messages, and error details are redacted, and diff generation does not stage
changes or write Git blobs. Before success,
the adapter scans literal and reversible credential forms across every file,
ignored path, symlink, and decoded Git object in the complete owned workspace.
Credential exposure containment acts only through the registered workspace
authority; an unregistered caller path is rejected before OpenCode starts. Every Git
subprocess uses a secret-free environment with host configuration, prompting,
hooks, external diffs, text conversion, pagers, lazy fetching, replacement
objects, and fsmonitor disabled.

Every recursive cleanup revalidates the temporary root and ownership marker by
their original filesystem device and inode immediately before removal. Durable
run cleanup first requires the `workflow_runs` row to be absent, closes
delegation admission for that run, cancels and joins every admitted provider
process, moves the validated directory into the identity-tracked control area,
and starts a credential-free cleanup boundary inside it. Cross-process
admission uses a PostgreSQL shared advisory lock and a deletion notification;
cleanup takes the exclusive form of the same lock before touching the
workspace. The boundary verifies the directory identity from its established
working directory before removing contents. The ownership record is removed
last. A renamed or substituted path produces a structured failure and is
retained.

## Trust boundary

The production adapter retains the Phase 0 trust boundary: it assumes
evaluator-authored tasks and every program they invoke are trusted. FACT-12
also accepts a durable workspace created by the run workspace service, with its
authority revalidated at each use. It is not a sandbox for hostile task code.
Production timeout handling supervises the complete child process group. A
permission or unknown liveness result fails closed; on macOS an independent
process-table check may confirm that a group is actually absent after `kill(0)`
returns `EPERM`. Hostile execution still requires an operating-system sandbox
outside this adapter. See `../docs/coding-tool-adapter.md` for the production
runbook.

## Proof

Run `npm ci`, then `OPENROUTER_API_KEY=<key> npm run prove` from
`coding-adapter/`. The proof verifies OpenCode 1.18.4, creates a fresh temp Git
workspace, runs a trivial task, prints redacted usage/diff/log, and removes the
workspace. Run without the key to see the missing-credential failure path.

## Tests

`npm test` in `coding-adapter/` uses only fakes and makes no live provider calls.
It covers pure command construction, minimal environment containment, state
cleanup, complete streaming usage parsing, bounded/redacted output, unstaged
diffs, encoded credential detection across ignored and Git state, owned-root
deletion, substituted-root preservation, setup-failure cleanup,
caller-workspace preservation, isolated Git behavior, protocol validation,
timeouts, and structured failure mapping.
