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

In progress: FACT-7 has current `origin/main` through FACT-19 merged at
`36be14457e46acba81f06c7f5aba92cdea053914`, without a rebase. At
`f74c566d0e7c9300e929052e18f895ae588d210e`, the retained no-cache Compose
proof passed on its unique non-3000 ports. It verifies required-config and
failed-migration negatives, hermetic interpolation, ordered health, UI and
PostgreSQL-backed `GET /api/agents` before and after restart, the full chain
through `0004-message-consumption.sql`, OpenClaw/OpenCode/Git readiness, the
real missing-key adapter contract, and the literal documented coding-adapter
command through a no-credit fake child with the scoped FACT-3 environment. Its
trap verified exact label-scoped containers, networks, volumes, and images
empty. FACT-6, FACT-8, FACT-9, inherited tests, typecheck, lint, production
build, and both production dependency audits passed locally. Firstmate owns
independent exact-head review, merge, and tracker completion.
