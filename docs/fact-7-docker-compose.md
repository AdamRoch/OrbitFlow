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

3. Open `http://127.0.0.1:${ORBITFACTORY_APP_PORT}`. The current inherited
   board UI is reachable there. `GET /api/health` reports its explicit
   `sqlite-foundation` persistence state.

`postgres` must pass `pg_isready` before `migrate` runs. `app` starts only
after `migrate` exits successfully. `engine` starts only after the app,
migrator, and OpenClaw gateway are healthy. There are no sleep-based startup
dependencies.

## Services and boundaries

| Service | Role | Readiness |
| --- | --- | --- |
| `postgres` | FACT-6 PostgreSQL authority | `pg_isready` |
| `migrate` | One-shot ordered FACT-6 migration runner | exits successfully |
| `app` | Current OrbitTrack-derived board UI | `GET /api/health` |
| `openclaw` | Dedicated FACT-1 gateway container | `GET /readyz` on its internal port |
| `engine` | Explicit Phase 1 engine entrypoint, not a workflow engine | `GET /readyz` plus `SELECT 1` |

The engine response says `workflowEngine: not_implemented` deliberately. It
always listens on internal port `3001`; `ORBITFACTORY_ENGINE_HOST_PORT` changes
only its localhost publication, so Compose health and service checks are not
coupled to a host port choice.
FACT-7 does not fabricate a dispatch loop, message bus, CRUD control plane,
Telegram integration, or product UI. Those belong to later tickets.

OpenClaw uses the official `ghcr.io/openclaw/openclaw:2026.4.15` image. Its
committed configuration keeps FACT-1's required OpenRouter base URL
`https://openrouter.ai/api/v1` and reads the key only from
`OPENROUTER_API_KEY`. On first start, the gateway generates an internal token
in its named state volume; it is neither an evaluator-provided credential nor
baked into an image. The gateway has no host port and accepts only the
Compose-internal network. Do not publish port `18789`.

The engine image installs Git and the FACT-3 selection, `opencode-ai@1.18.4`,
from the committed `coding-adapter/package-lock.json`. `opencode --version`
and the credential-free adapter structural proof are readiness checks; they
make no provider request and spend no API credits. The long-lived engine
readiness process has no provider credential.

The opt-in `coding-adapter` Compose profile is the only coding-runtime service
given the evaluator key. It is an ephemeral one-shot boundary, not part of
`docker compose up`; invoke it with the already-created `.env` and no other
setup:

```sh
docker compose --profile coding-adapter run --rm coding-adapter 'create hello.txt containing hello'
```

That wrapper passes the key only into FACT-3's existing adapter, whose child
process receives the key, tool path, and temporary isolated state paths only.
P2-4 still owns production engine workspace lifecycle. The gateway separately
uses the same evaluator key for its FACT-1 runtime configuration. The gateway
image has verified upstream Linux `arm64` and `amd64` manifests, and the
OpenCode package declares Linux `arm64` and `x64` support.

## State, restart, teardown

Compose names and deliberately reuses `postgres-data`, `app-data`, and
`openclaw-state`. The migration runner stores checksums in
`schema_migrations`, so a rerun is a no-op. Stop the stack while retaining
state with `docker compose down`; remove only this stack's state with:

```sh
docker compose down --volumes --remove-orphans
```

The OpenClaw state volume is initialized from committed, credential-free
configuration. It never copies a host home directory, credentials, interactive
login artifact, or subscription state into an image or volume.

## Retained proof command

Run the complete disposable proof from the repository root:

```sh
bash scripts/fact-7-compose-proof.sh
```

It validates required-config failure, hermetic Compose interpolation, a
meaningful failed-migration dependency path, a no-cache build, ordered startup
and health, both the health endpoint and UI reachability before and after
restart, the exact migration history, gateway and OpenCode executables, the
credential-free FACT-3 adapter contract, and a fake OpenCode child that proves
the scoped adapter key and minimal child environment without a provider call.
It then verifies a no-op migration rerun, restart, and teardown. The proof uses
a per-run Compose project name and fake key only because no provider request is
made; its trap removes and verifies precisely the containers, networks,
volumes, and images bearing either proof project label before returning.

For an iterative local rerun only, `FACT7_BUILD_NO_CACHE=0` retains Docker's
build cache. The default proof command always uses a no-cache build.
