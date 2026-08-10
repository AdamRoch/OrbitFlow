# PostgreSQL schema and migration runbook

FACT-6 defines the durable PostgreSQL contract in `db/migrations`. The retained
board still uses SQLite until its CRUD layer moves in FACT-8; the two schemas are
intentionally not wired together here.

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

FACT-18 reserves `0009-state-stream-notify.sql`. It adds no state table: AFTER
triggers call `pg_notify` only after a committed change to agents, runs,
tickets, messages, or cost events. SSE clients use that notification only as a
wake-up and re-fetch their bounded authoritative snapshot after connecting or
reconnecting; a successful PostgreSQL LISTEN installation also emits a
`state.resync` wake-up after listener loss. There is no stream replay log and
a missed notification never authorizes a write.

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
