# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- OpenClaw execution-plane proof, the verified OpenRouter endpoint override, and the repeat runbook live in `docs/fact-1-openclaw-spike.md`; run contracts with `npm test`.
- The OrbitFactory ticket foundation is adapted from OrbitTrack commit `589e04165a0744be10b7fc1b05984c6a3bff234c`; `docs/fact-5-orbittrack-inventory.md` owns its keep/delete boundary and provenance.
- The durable PostgreSQL contract and disposable clean-database proof live in `docs/postgres-schema.md`; apply it with `DATABASE_URL=... npm run db:migrate`.
- FACT-9's producer, routing transaction, polling, and cleanup contracts live in `docs/message-bus.md`; prove them with `npm run fact9:proof`.
- FACT-13's agent CLI, dispatch seam, idempotency, and PostgreSQL proof live in `docs/fact-13-platform-tool-surface.md`; prove them with `npm run fact13:proof`.
- FACT-20's engine-compatible graph schema, visual editor boundary, and proof commands live in `docs/workflow-builder.md`; no builder translation model or migration exists.
- FACT-10's pure graph, durable dispatch, fan-out, lifecycle, and mock-runtime contracts live in `docs/workflow-engine.md`; prove them with `npm run fact10:proof`.
- FACT-11's OpenClaw sync, wake, failure, credential, and fake-provider proof contracts live in `docs/openclaw-runtime-adapter.md`; prove them with `npm run fact11:proof`.
- FACT-23's cost-ceiling, rate-limit, and blocked-action contracts live in `docs/guardrails-enforcement.md`; prove them with `npm run fact23:proof`.
- FACT-21's template agents, prompts, skills, graphs, idempotent seed, and clean-install/upgrade proof contracts live in `db/migrations/0013-workflow-templates.sql` and `test/postgres/workflow-templates.test.mjs`; prove them with `npm run fact21:proof`.

## CodingToolAdapter (PRD §5)

v1 wraps the `opencode` CLI headlessly, authenticated via `OPENROUTER_API_KEY`
only. `coding-adapter/DECISION.md` owns the selection rationale, rejected
candidates, evaluator proof, interface, and failure contracts. `coding-adapter/`
contains the one production implementation; `docs/coding-tool-adapter.md` owns
its OpenClaw tool, workspace, attribution, and repeat-proof runbook.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
