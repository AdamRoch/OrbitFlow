# CodingToolAdapter v1 runbook

FACT-12 productionizes the FACT-3 OpenCode decision without adding a second
adapter. The implementation remains in `coding-adapter/`; the runtime entry
points are `bin/orbit-tool-broker.mjs` and `bin/orbit-coding-executor.mjs`.

## Runtime contract

The OpenClaw wrapper `bin/orbit-openclaw-tool.mjs` accepts `<command> <json-input>`
and forwards it over the broker Unix socket. The broker validates the request
and calls the adapter. The provider credential is never placed in an argument
list. OpenCode receives the task in its documented CLI position.

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

The authoritative public error response schema is
`coding-adapter/src/errors.js` `PUBLIC_ERROR_CODES`. Its complete code
enum is:

| Code | Meaning |
|---|---|
| `internal_failure` | An unexpected runtime error was mapped to the bounded public fallback. |
| `missing_credentials` | The required evaluator API key was absent. |
| `cli_failure` | Launch, provider execution, inspection, cancellation, or cleanup failed. |
| `timeout` | The provider process exceeded its configured timeout. |
| `malformed_output` | OpenCode returned an invalid or incomplete event stream or invalid usage. |
| `output_too_large` | The aggregate review diff exceeded its byte limit. |
| `credential_exposure` | A credential form appeared in output or workspace state. |
| `workspace_invalid` | Run or workspace ownership, containment, lifecycle, or identity was invalid. |
| `persistence_failure` | Run and agent attribution verification or usage persistence failed. |
| `invalid_request` | The public command request or trusted calling context was invalid. |

Runtime serialization imports this schema and maps any non-enumerated internal
code to `internal_failure`. The adapter test reads this table and mechanically
compares its codes, in order, with the executable schema, so code and prose
drift fails locally.

OpenClaw registers this executable through its supported `exec` tool, using the
same `TOOLS.md` pattern proved by FACT-2. The engine binds `ORBITFLOW_RUN_ID`,
`ORBITFLOW_AGENT_ID`, and the run workspace. Run and agent identity are process
context, not values the model submits in the request.

In the production Compose path, OpenClaw does not execute this database-bearing
entry point. Its credentialless allowlisted wrapper sends a closed operation to
the root-owned tool broker. The broker validates the active dispatch and owns
workspace creation and cost persistence. Coding execution crosses a second
Unix socket into a provider-network-only executor with no database environment
or route to the PostgreSQL service. The executor server runs as root, but each
OpenCode delegation drops to a distinct persisted UID for its run. The run
workspace parent is searchable but not listable, and every run directory is
mode `0700` and owned by its assigned UID, so delegated code cannot read sibling
run workspaces or either privileged socket.

## Configuration and containment

The production services require:

- `DATABASE_URL` in the trusted engine and tool broker, pointing to the
  migrated OrbitFactory PostgreSQL database.
- `ORBITFLOW_WORKSPACE_ROOT`, an absolute path to the one compose-mounted
  workspace volume shared by the broker and coding executor.
- `OPENROUTER_API_KEY` in the coding executor, where it is handed to OpenCode
  after the execution identity is established. OpenClaw separately receives
  the provider key for gateway model calls.
- the dispatch-bound run and agent context persisted by the engine and verified
  by the broker rather than submitted by the model.

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
relative paths. Replacement or deletion fails closed. The executor reports
credential contamination to the broker, which revalidates the durable ownership
handle and retains the workspace under `.orbitflow/quarantine`.
The workspace service refuses cleanup while the owning `workflow_runs` row
exists. After the platform deletes that row, `deleteRunWorkspace(runId)` closes
new delegation admission, cancels and joins every already admitted provider
process, and only then moves the identity-matched retained directory into the
control area. Delegations hold a PostgreSQL shared advisory lock and listen for
the run deletion notification. Cleanup publishes that notification and must
obtain the exclusive form of the same lock, which makes the join work across
separate tool and cleanup processes. A credential-free cleanup boundary enters
that directory and verifies its device and inode from the established working
directory before removing contents. The ownership record is removed last.
Renamed, symlinked, or substituted cleanup targets fail closed and are retained.
Each broker-to-executor delegation also has a bounded operation identifier. A
wrapper disconnect, run-deletion notification, or expired dispatch lease asks
the executor to abort that operation. The executor joins the OpenCode process
tree before acknowledging cancellation, and the broker waits for both the
operation result and that acknowledgement before releasing workspace admission
or persisting usage. Before changing workspace ownership, the broker durably
and atomically reserves one UID from the configured 40,000-identity range.
Reservations are permanent: active, failed, partial, uncertain, deleted,
quarantined, and historical workspace identities are never retired or reused.
This prevents numeric UID aliasing across cleanup and restart ambiguity. The
range therefore supports at most 40,000 workspace identities over a deployment
lifetime. Exhaustion fails closed and requires an operator migration to a fresh,
non-overlapping identity range.

OpenCode receives an explicit environment allowlist: the selected key, tool
`PATH`, isolated home/state paths, and fixed safety switches. The adapter parses
the complete NDJSON stream, validates every event, scans all output and
workspace/Git state for literal and reversible credential forms, applies one
10 MiB cap to the complete tracked plus untracked diff, and kills the complete
POSIX process group on timeout. Unknown process-group liveness fails closed.
The deterministic timeout fixture uses a bounded child-start acknowledgement
before its 500 ms execution timer begins, so loaded test hosts cannot time out
before the fixture records the descendant that cleanup must prove absent.

`cost_events` stores input, output, cache-read, cache-write, and computed cost
against the calling run and agent. `NULL` means OpenCode omitted that field; `0`
means OpenCode explicitly reported zero. Reasoning tokens remain in the returned
usage object because the FACT-6 table does not define a reasoning-token column.
Every token value and aggregate must be a safe nonnegative integer within
PostgreSQL `BIGINT`; cost must be finite, nonnegative, and fit `NUMERIC(18,8)`.

## Local proof

```sh
npm ci
npm test
npm run fact34:proof
```

`fact34:proof` starts the disposable Compose topology with a committed fake
OpenCode binary and proves the wrapper, broker, executor, and workspace
isolation boundary without a provider call.

## Trust boundary

OpenCode itself is not a general operating-system sandbox. The provider key must
enter the OpenCode process so it can call the selected provider, and model-authored
code can therefore observe that provider credential. PostgreSQL authority is a
separate boundary: the engine and tool broker hold database credentials, while
active-dispatch checks, platform mutations, workspace ownership records, and
cost persistence remain in the tool broker. Delegated code runs under a
run-specific unprivileged UID in a
container that mounts only run workspaces and the executor socket, cannot open
that root-owned socket, and joins only the provider network where the PostgreSQL
service is neither resolvable nor reachable. OpenClaw and the coding executor
join the provider network; the engine and tool broker remain on the control
network. The executor validates the persisted
run/UID/workspace device and inode before dropping identity. The broker remains
the durable workspace authority: it validates the root-side record, Git marker,
and filesystem identities before and after remote execution and performs any
quarantine. This boundary limits database authority and cross-run filesystem
access; it does not claim protection against provider-key disclosure or denial
of service within the delegated run.
Workflow execution, fan-out policy, message routing, Telegram, and the
implementer review prompt remain outside FACT-12.
