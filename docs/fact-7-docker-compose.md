# FACT-7 Docker Compose demo stack

## Run from a clean clone

1. Copy `.env.example` to `.env` and replace `POSTGRES_PASSWORD` and
   `OPENROUTER_API_KEY`. `OPENROUTER_API_KEY` is the only evaluator provider
   credential. Do not add host credential directories, login artifacts, or
   subscription state.
2. Run:

   ```sh
   docker compose up --build
   ```

3. Open `http://127.0.0.1:${ORBITFACTORY_APP_PORT}`. The root route redirects
   to the run-filtered Monitoring Board. `GET /api/health` reports ready only
   when PostgreSQL has the exact committed migration history.

`postgres` must pass `pg_isready` before `migrate` runs. `app` starts only
after `migrate` exits successfully. `engine` starts only after the app,
migrator, and OpenClaw gateway are healthy. There are no sleep-based startup
dependencies.

## Services and boundaries

| Service | Role | Readiness |
| --- | --- | --- |
| `postgres` | FACT-6 PostgreSQL authority | `pg_isready` |
| `migrate` | One-shot ordered FACT-6 migration runner | exits successfully |
| `app` | Current OrbitTrack-derived board UI plus control-plane API | `GET /api/health`; proof also requires PostgreSQL-backed `GET /api/agents` |
| `openclaw` | Dedicated FACT-1 gateway container | `GET /readyz` on its internal port |
| `tool-broker` | Privileged dispatch validation and PostgreSQL mutation broker | root-owned Unix socket exists |
| `coding-executor` | Database-isolated OpenCode execution plane | root-owned Unix socket exists |
| `engine` | FACT-31 production consumer, dispatcher, scheduler, and runtime adapter | `GET /readyz` after successful consumer and dispatcher polls |

The engine reports `workflowEngine: operational` only after the real FACT-9
consumer and FACT-10 dispatcher have each completed a PostgreSQL polling cycle.
A reachable database alone is not operational readiness. It always listens on
internal port `3001`; `ORBITFACTORY_ENGINE_HOST_PORT` changes only its localhost
publication.

OpenClaw uses the official `ghcr.io/openclaw/openclaw:2026.4.15` image. Its
committed configuration keeps FACT-1's required OpenRouter base URL
`https://openrouter.ai/api/v1` and reads the key only from
`OPENROUTER_API_KEY`. On first start, the gateway generates an internal token
in its named state volume; it is neither an evaluator-provided credential nor
baked into an image. The gateway has no host port and accepts only the
Compose-internal network. Do not publish port `18789`.

The engine image installs Git and the pinned OpenClaw 2026.4.15 CLI used by the
production runtime adapter. The gateway token is mounted read-only from the
gateway state volume. Engine runtime state and run workspaces use their own
durable volume. The engine and tool broker receive no provider credential.
OpenClaw receives `OPENROUTER_API_KEY` for gateway model calls. Production
OpenCode execution and its scoped child environment are separately owned by
`coding-executor`, which also receives the provider key. Neither service has a
database credential. OpenClaw has no access to the coding-executor socket or
run workspaces.

The opt-in `coding-adapter` Compose profile remains an ephemeral one-shot
boundary, not part of `docker compose up`; invoke it with the already-created
`.env` and no other setup. The task is always passed to the committed adapter
wrapper; it cannot replace that wrapper's command:

```sh
docker compose --profile coding-adapter run --rm coding-adapter 'create hello.txt containing hello'
```

That wrapper passes the key only into FACT-3's existing adapter, whose child
process receives the key, tool path, and temporary isolated state paths only.
The opt-in profile uses the same scoped adapter contract as the production
`coding-executor`, but is not on the production engine path. The gateway image
has verified upstream Linux `arm64` and `amd64` manifests, and the OpenCode
package declares Linux `arm64` and `x64` support.

## State, restart, teardown

Compose names and deliberately reuses `postgres-data`, `openclaw-state`,
`engine-data`, and `run-workspaces`. OpenClaw and the engine
share `engine-data` only for runtime and agent workspace state. The gateway's
one explicitly allowlisted wrapper has no database credential and sends the
active dispatch context to `tool-broker` over a root-owned socket. The broker
reloads the engine context, requires the PostgreSQL dispatch lease and
canonical wake context to match, and performs only the named platform or coding
operation. Coding work crosses a second root-owned socket to
`coding-executor`, which has the provider key but no database credential and
only the provider network. OpenClaw also joins the provider network for model
calls, while the engine and tool broker remain on the database-bearing control
network with no provider credential. Each delegated process uses a persisted
run-specific UID and a mode-`0700` run directory, preventing access to sibling
workspaces and broker sockets. No general shell executable or underlying
project CLI is allowlisted. The migration runner stores checksums in
`schema_migrations`, so a rerun is a no-op. Stop the stack while retaining
state with `docker compose down`; remove only this stack's state with:

```sh
docker compose down --volumes --remove-orphans
```

The OpenClaw state volume is initialized from committed, credential-free
configuration. It never copies a host home directory, credentials, interactive
login artifact, or subscription state into an image or volume.

FACT-31's focused production proof is `npm run fact31:proof`. It uses the
production Compose entrypoint with the deterministic fake OpenClaw request
path, so it spends no provider credit. It proves operational readiness, a
ticket-backed UI run, adapter completion, scheduler consumption, duplicate tick
resistance, two engine restarts, exact migration readiness, and project-scoped
cleanup.

## Retained proof command

Run the complete disposable proof from the repository root:

```sh
bash scripts/fact-7-compose-proof.sh
```

It validates required-config failure, hermetic Compose interpolation, a
meaningful failed-migration dependency path, a no-cache build, ordered startup
and health, UI, and PostgreSQL-backed `GET /api/agents` reachability
before and after restart, the exact migration history, gateway and OpenCode executables, the
credential-free FACT-3 adapter contract, and a fake OpenCode child that proves
the scoped adapter key and minimal child environment without a provider call.
That fake runs through the literal documented `docker compose ... run ...
coding-adapter '<task>'` shape, not by invoking an internal script directly.
It then verifies a no-op migration rerun, restart, and teardown. The proof uses
a per-run Compose project name and fake key only because no provider request is
made; its trap removes and verifies precisely the containers, networks,
volumes, and images bearing either proof project label before returning.

For an iterative local rerun only, `FACT7_BUILD_NO_CACHE=0` retains Docker's
build cache. The default proof command always uses a no-cache build.
