# FACT-49 production broker proof

Run the credentialless disposable proof with:

```sh
npm run fact49:proof
```

The proof reuses the FACT-34 Compose topology, fake OpenClaw runtime hold, and
local provider boundary. The workflow engine creates a real planner dispatch
with no ticket, while a real OpenClaw gateway agent executes the committed
`/app/bin/orbit-openclaw-tool.mjs` allowlisted command through the Unix socket
and tool broker. PostgreSQL verifies that the supplied planner target keeps its
complete blocker set and that the escape ticket is unchanged.

The proof then releases the planner and waits for a real fan-out implementer
dispatch bound to the target ticket. It invokes the same wrapper with a
different same-run ticket target and verifies the broker forces the active
ticket, so the command fails on the bound ticket's `in_progress` state and
cannot mutate the escape ticket. A supplied `runId` is rejected at the wrapper
boundary as well.

The Compose project uses a non-provider API-key value and a local HTTP provider;
no paid model call is made. The script checks database identity, readiness,
OpenClaw security and allowlist state, wrapper and broker results, durable
PostgreSQL rows, and exact Compose container, network, volume, and image
cleanup. Any service, command, assertion, database, or cleanup failure exits
nonzero.
