# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- OpenClaw execution-plane proof, the verified OpenRouter endpoint override, and the repeat runbook live in `docs/fact-1-openclaw-spike.md`; run contracts with `npm test`.

## CodingToolAdapter (PRD §5)

v1 wraps the `opencode` CLI headlessly, authenticated via `OPENROUTER_API_KEY`
only. `coding-adapter/DECISION.md` owns the selection rationale, rejected
candidates, evaluator proof, interface, and failure contracts. `coding-adapter/`
is a standalone Phase 0 spike; `tickets/P2-4-coding-tool-adapter.md` owns its
productionization and workspace lifecycle.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
