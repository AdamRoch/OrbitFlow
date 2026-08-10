# PostgreSQL schema and migration runbook

FACT-6 defines the durable PostgreSQL contract in `db/migrations`. The retained
board still uses SQLite until its CRUD layer moves in FACT-8; the two schemas are
intentionally not wired together here.

## Apply migrations

Set `DATABASE_URL` to a PostgreSQL database dedicated to OrbitFactory, then run:

```sh
DATABASE_URL='postgresql://user:password@127.0.0.1:5432/orbitfactory' npm run db:migrate
```

The runner applies ordered SQL files in separate transactions under a PostgreSQL
advisory lock. It records each filename and SHA-256 checksum in
`schema_migrations`. Re-running the command is a no-op. Never edit a migration
that has been applied; add the next numbered, forward-only file instead.

## Run the FACT-6 proof

```sh
npm run fact6:proof
```

The proof creates only the disposable Docker container
`orbitfactory-fact6-postgres-proof`, publishes PostgreSQL on a random localhost
port, verifies the full contract against a clean database, and removes that exact
container when it exits. It refuses to start if a container with that name
already exists. It does not use or modify Docker Compose resources.

Messages are reconstructed with `WHERE run_id = $1 ORDER BY id`. The immutable
bigint identity is both the run conversation's deterministic total order and the
cursor later message-bus workers should retain.
