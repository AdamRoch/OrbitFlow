# PostgreSQL schema and migration runbook

PostgreSQL is OrbitFlow's only durable ticket, control-plane, message, and
execution database. The accepted ticket authority rules live in
[`ADR/0001-postgresql-ticket-authority.md`](../ADR/0001-postgresql-ticket-authority.md).

FACT-12 extends `cost_events` in migration `0010` with cache-token attribution
and nullable usage fields. A null means the coding CLI omitted the value; zero
means it explicitly reported zero.

## Apply migrations

Set `DATABASE_URL` to a PostgreSQL database dedicated to OrbitFactory, then run:

```sh
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/orbitfactory' npm run db:migrate
```

The runner applies ordered SQL files in separate transactions under a PostgreSQL
advisory lock. It records each filename and SHA-256 checksum in
`schema_migrations`. Re-running the command is a no-op. Never edit a migration
that has been applied; add the next numbered, forward-only file instead. The
runner fails closed when an applied file disappears, a checksum changes, or a
new migration is inserted below the applied high-water mark.

When `0027-workflow-dispatch-ticket-ownership.sql` is pending, the runner first
opens a repeatable-read, read-only transaction before it can commit `0026` or
any other pending file. The check stops on duplicate unfinished
`(run_id, node_id, ticket_id)` ownership, and on an unfinished ticket-bound
dispatch whose ticket belongs to another run or is not `in_progress`. Its error
contains at most 20 duplicate ownership groups with at most four dispatches per
group, plus at most 20 inconsistent dispatches.

Stop or quiesce workflow-engine and dispatcher writers before running that
cutover. The check is a read-only snapshot. It cannot prove that another writer
will stay stopped after the check. If it finds retained ambiguity, it leaves
labels and migration history intact. An operator must manually reconcile or
quarantine every affected dispatch before retrying. The migrator never deletes,
deduplicates, replays, or guesses about external effects.

`GET /api/health` and the engine's `GET /readyz` read the full committed
`schema_migrations` history before reporting ready. They require every filename
and SHA-256 checksum through the current head. A database with a missing, stale,
or edited migration reports 503 even if it accepts queries.

FACT-18 reserves `0009-state-stream-notify.sql`. It adds no state table: AFTER
triggers call `pg_notify` only after a committed change to agents, runs,
tickets, messages, or cost events. SSE clients use that notification only as a
wake-up and re-fetch their bounded authoritative snapshot after connecting or
reconnecting; a successful PostgreSQL LISTEN installation also emits a
`state.resync` wake-up after listener loss. There is no stream replay log and
a missed notification never authorizes a write.

FACT-23 reserves `0014-guardrail-wake-events.sql` (FACT-21 owns `0013`). It
adds the durable per-agent wake log the rate limiter reads; the contract lives
in `docs/guardrails-enforcement.md`.

FACT-35 reserves `0024-factory-agent-model-catalog.sql`. It aligns all agents
referenced by shipped templates to the validated primary model from
`docker/openclaw/openclaw.json`; the migrator supplies that value
transaction-locally rather than copying a model name into SQL.

FACT-36 reserves `0025-factory-project.sql`. It seeds the stable `FACT` project
in PostgreSQL on fresh installations and forward upgrades. The insert is
conflict-safe and preserves an existing `FACT` row. Factory agents must still
discover its database-generated id through `list_projects`; neither planner
prompts nor runtime code own or hard-code that id. Monitoring reads the same
PostgreSQL project and workflow-run tickets.

FACT-35 and FACT-36 merged concurrently after their migration numbers were
reserved. The runner therefore permits exactly one late-reservation shape:
`0024-factory-agent-model-catalog.sql` may be applied to an installation that
already recorded `0025-factory-project.sql`. Every other migration gap still
fails closed.

FACT-46 adds `0027-workflow-dispatch-ticket-ownership.sql`. Its partial unique
index allows only one unfinished dispatch for a run, node, and ticket across
overlapping fan-out activations while permitting a later activation to create
sequential rework after the earlier dispatch completes. FACT-53 adds the
precondition above because `0027` must never discover retained ambiguity after
`0026` has already dropped labels.

## Run the FACT-6 proof

```sh
npm run fact6:proof
```

The proof creates only the disposable Docker container
`orbitfactory-fact6-postgres-proof`, publishes PostgreSQL on a random localhost
port, verifies the full contract against a clean database, and removes that exact
container when it exits. It refuses to start if a container with that name
already exists. Teardown preserves a failed test status, reports removal
failures, and verifies that the exact container name no longer exists. It does
not use or modify Docker Compose resources.

Messages are reconstructed with
`WHERE run_id = $1 ORDER BY sequence_number`. Incremental readers retain the
last `sequence_number` for that run and query with `sequence_number > $2`.
Appends for one run are serialized by a transaction-scoped PostgreSQL advisory
lock, so a later message cannot commit ahead of an earlier sequence. A rolled
back append does not consume a sequence number. The bigint `id` remains only the
message entity identifier and must not be used as a live-consumption cursor.
