# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- OpenClaw execution-plane proof, the verified OpenRouter endpoint override, and the repeat runbook live in `docs/fact-1-openclaw-spike.md`; run contracts with `npm test`.

## CodingToolAdapter (PRD §5)

v1 wraps the `opencode` CLI headlessly, authenticated via `OPENROUTER_API_KEY`
only. See `coding-adapter/DECISION.md` for why (and why `claude`/`codex` were
rejected for v1). Interface + implementation: `coding-adapter/src/openCodeAdapter.js`.
Tests: `cd coding-adapter && node --test` (all fakes, no live calls). Live proof:
`node coding-adapter/proof/run-proof.js` (needs a real `OPENROUTER_API_KEY`,
makes a real paid API call). `coding-adapter/` is a standalone Phase 0 spike
package (no build step, plain ESM) -- Phase 1 (fork OrbitTrack) should fold it
into the real app rather than leaving it as a separate package.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
