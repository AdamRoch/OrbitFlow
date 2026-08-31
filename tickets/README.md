# Current tickets

OrbitFlow's PostgreSQL database is the runtime ticket authority. OrbitTrack is the
external development work tracker. These files keep the accepted scope beside
the code so a future agent can understand it without tracker access.

* [FACT-40: Delete the SQLite tracker and use Monitoring as the ticket board](FACT-40-postgresql-only-control-plane.md)
* [FACT-41: Make dependencies and first assignment atomic per workflow run](FACT-41-run-scoped-ticket-dispatch.md)
* [FACT-42: Prove the PostgreSQL-only cutover and demo data path](FACT-42-prove-postgresql-cutover.md)

```text
FACT-40 ─┐
         ├──> FACT-42
FACT-41 ─┘
```

Completed contracts live in `AGENTS.md`, current docs, migrations, and executable
proof scripts. Completed planning files do not remain as a second source of
truth.
