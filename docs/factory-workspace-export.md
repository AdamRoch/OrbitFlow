# Export an accepted Factory workspace

FACT-38 supports one export path: a command run from the OrbitFlow checkout
while the ordinary Compose stack is running. It copies one accepted run's
isolated `run-workspaces` volume directory into an existing host directory.

In Monitoring, select the completed Software Factory run and copy its numeric
Run value. Then create the destination directory and run:

```bash
mkdir -p "$PWD/exports"
npm run factory:export -- --run-id 42 --destination "$PWD/exports"
```

On success, the last line is the absolute result path, such as
`/path/to/orbitflow/exports/factory-run-42`. The copied directory includes the
generated files, executable modes, and Git state needed to inspect or run the
result. An existing `factory-run-42` directory is never overwritten.

The command accepts only a completed `Software Factory` run with a current
`approved` tester verdict for every run ticket and all run tickets in `done`.
It validates the durable workspace ownership record before copying. Unknown,
unfinished, rejected, missing, replaced, or quarantined workspaces fail closed.
The host destination must be an existing absolute real directory. Symlinked
destinations, symlinks or special files inside the workspace, escaping paths,
and changes observed during the copy are refused.

This is deliberately not a source browser, selective artifact exporter, or
download service. To repeat the disposable PostgreSQL and Compose-style volume
proof, run `npm run fact38:proof`.
