# P1-3 Docker Compose single-command run

**Phase:** 1 · **Tag:** [MUST] · **Depends:** P1-1, P1-2

`docker compose up` from a clean clone brings up the **full demo stack**: app + Postgres + engine + OpenClaw + the coding CLI runtime. This is demo step 1 (PRD §12) and the evaluator's entry point — if OpenClaw isn't part of it, the evaluator can't run the product.

## Notes

- FACT-1 resolved the execution topology: run a dedicated containerized OpenClaw gateway, not a host-side sidecar. The proof, constraints, and Docker-not-launched limitation live in `docs/fact-1-openclaw-spike.md`.
- The coding CLI must be installed and authenticated (env-var key) inside whatever container calls it.

## Acceptance criteria

- [ ] Single command from clean clone: containers build, migrations run, UI reachable.
- [ ] OpenClaw and the coding CLI are runnable by the evaluator with no manual setup beyond `.env` (containerized, or one documented fallback command).
- [ ] All secrets/config via env vars (`.env.example` provided) — API keys only, no interactive auth.
- [ ] Restart is idempotent (no re-migration failures, no orphaned state).

## Implementation status

In progress: local implementation and lifecycle proof are complete. The stack
builds the app, PostgreSQL, ordered migration step, dedicated OpenClaw gateway,
and engine-owned OpenCode runtime; it has retained configuration, health,
restart, and teardown proof in `docs/fact-7-docker-compose.md`. Firstmate owns
independent exact-head review, merge, and tracker completion.
