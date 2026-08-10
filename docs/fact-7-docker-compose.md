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

The engine response says `workflowEngine: not_implemented` deliberately.
FACT-7 does not fabricate a dispatch loop, message bus, CRUD control plane,
Telegram integration, or product UI. Those belong to later tickets.

OpenClaw uses the official `ghcr.io/openclaw/openclaw:2026.4.15` image. Its
committed configuration keeps FACT-1's required OpenRouter base URL
`https://openrouter.ai/api/v1` and reads the key only from
`OPENROUTER_API_KEY`. On first start, the gateway generates an internal token
in its named state volume; it is neither an evaluator-provided credential nor
baked into an image. The gateway has no host port and accepts only the
Compose-internal network. Do not publish port `18789`.

The engine image installs the FACT-3 selection, `opencode-ai@1.18.4`, from the
committed `coding-adapter/package-lock.json`. `opencode --version` is the
structural readiness check; it makes no provider request and spends no API
credits. The gateway image has verified upstream Linux `arm64` and `amd64`
manifests, and the OpenCode package declares Linux `arm64` and `x64` support.

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

It validates Compose configuration, a no-cache build, ordered startup and
health, app HTTP reachability, the exact migration history, gateway and
OpenCode executables, a no-op migration rerun, restart, and teardown. It uses
a per-run Compose project name and a fake key only because no provider request
is made; it removes precisely the containers, network, and volumes bearing
that project label before returning.

For an iterative local rerun only, `FACT7_BUILD_NO_CACHE=0` retains Docker's
build cache. The default proof command always uses a no-cache build.
