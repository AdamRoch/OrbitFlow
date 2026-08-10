# CodingToolAdapter v1 runbook

FACT-12 productionizes the FACT-3 OpenCode decision without adding a second
adapter. The implementation remains in `coding-adapter/`; the platform-facing
entry point is `bin/orbit-coding-tool.mjs`.

## Runtime contract

The tool reads exactly one JSON object from standard input and writes exactly
one JSON response to standard output. The provider credential is never placed
in an argument list. OpenCode receives the task in its documented CLI position.

Start a run workspace after its `workflow_runs` row exists:

```json
{"command":"start_run_workspace","runId":"42"}
```

Delegate as the calling run and agent:

```json
{"command":"delegate_coding_task","task":"Implement the assigned change","workspace":"/var/lib/orbitflow/workspaces/run-42"}
```

A successful delegation returns `{"ok":true,"result":{"diff","log","usage"}}`.
Failures return `{"ok":false,"error":{"code","message",...}}` with bounded,
redacted details and a nonzero process exit. Usage persistence happens before a
success response, so a failed `cost_events` write never looks successful.

OpenClaw registers this executable through its supported `exec` tool, using the
same `TOOLS.md` pattern proved by FACT-2. The engine binds `ORBITFLOW_RUN_ID`,
`ORBITFLOW_AGENT_ID`, and the run workspace. Run and agent identity are process
context, not values the model submits in the request.

## Configuration and containment

The process requires:

- `DATABASE_URL`, pointing to the migrated OrbitFactory PostgreSQL database.
- `ORBITFLOW_WORKSPACE_ROOT`, an absolute path to the one compose-mounted
  workspace volume. The engine and the OpenClaw execution boundary must see the
  same path.
- `OPENROUTER_API_KEY`, the only provider credential given to OpenCode.
- `ORBITFLOW_RUN_ID` and `ORBITFLOW_AGENT_ID` on delegation calls, bound by the
  engine as trusted calling context rather than submitted by the model.

Optional settings are `ORBITFLOW_OPENCODE_MODEL` and
`ORBITFLOW_CODING_TIMEOUT_MS`. `ORBITFLOW_OPENCODE_BINARY` exists for the
deterministic proof fixture; production uses the pinned OpenCode executable.

Each run owns `run-<id>` directly below the canonical root. A root-side
ownership record binds the run to the workspace, Git directory, and marker by
device and inode. Every use verifies the run still exists, the requested path
is exact, no boundary component is a symlink, and those identities are
unchanged. The credential-free execution boundary then changes into that path,
validates the resulting current directory by device and inode, and requests the
key over IPC only after the identity is established. All credential-bearing
work and all Git, scan, and diff operations use that current directory through
relative paths. Replacement or deletion fails closed. Credential contamination
is retained under `.orbitflow/quarantine` instead of deleting a live workspace.
The workspace service refuses cleanup while the owning `workflow_runs` row
exists. After the platform deletes that row, `deleteRunWorkspace(runId)` moves
only the identity-matched retained directory into the control area. A
credential-free cleanup boundary enters that directory and verifies its device
and inode from the established working directory before removing contents. The
ownership record is removed last. Renamed, symlinked, or substituted cleanup
targets fail closed and are retained.

OpenCode receives an explicit environment allowlist: the selected key, tool
`PATH`, isolated home/state paths, and fixed safety switches. The adapter parses
the complete NDJSON stream, validates every event, scans all output and
workspace/Git state for literal and reversible credential forms, applies one
10 MiB cap to the complete tracked plus untracked diff, and kills the complete
POSIX process group on timeout. Unknown process-group liveness fails closed.

`cost_events` stores input, output, cache-read, cache-write, and computed cost
against the calling run and agent. `NULL` means OpenCode omitted that field; `0`
means OpenCode explicitly reported zero. Reasoning tokens remain in the returned
usage object because the FACT-6 table does not define a reasoning-token column.
Every token value and aggregate must be a safe nonnegative integer within
PostgreSQL `BIGINT`; cost must be finite, nonnegative, and fit `NUMERIC(18,8)`.

## Local proof

Install both dependency sets, then run the deterministic suite and disposable
PostgreSQL/filesystem proof:

```sh
npm ci
npm --prefix coding-adapter ci
npm test
npm run fact12:proof
```

`fact12:proof` creates one exact disposable PostgreSQL container and one exact
temporary workspace root, proves sequential committed state, cost attribution,
unknown-versus-zero usage, structured failures, credential containment, and
path attacks, then removes only those named resources.

The real provider paths are executable but off by default:

```sh
ORBITFLOW_ENABLE_REAL_OPENCODE_PROOF=1 npm run fact12:proof
ORBITFLOW_ENABLE_REAL_OPENCLAW_CODING_PROOF=1 npm run fact12:proof
```

Each gate requires `OPENROUTER_API_KEY` and can spend provider credit. The first
runs the production adapter through pinned real OpenCode. The second runs a real
OpenClaw 2026.4.15 agent and fails before the request if that exact supported
version is unavailable. It invokes the production CLI through `exec`; its
nested coding operation uses the deterministic fake so the proof isolates the
OpenClaw tool boundary. With neither gate set, no provider request is made.

## Trust boundary

As in FACT-3, tasks and invoked programs are evaluator-authored and trusted.
Minimal environment inheritance, path ownership, and process-group teardown are
defense-in-depth, not an operating-system sandbox for hostile code. Workflow
execution, fan-out policy, message routing, Telegram, and the implementer review
prompt remain outside FACT-12.
