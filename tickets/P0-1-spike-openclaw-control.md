# P0-1 Spike: programmatic OpenClaw control

**Phase:** 0 · **Tag:** [MUST] · **Depends:** —

Prove OpenClaw can be driven as the execution plane. This is the biggest technical unknown in the project (PRD §14); the spike code becomes the seed of the RuntimeAdapter.

## Scope

- Programmatically create two OpenClaw agents with distinct personas and memory.
- Wake each with a composed prompt.
- Capture structured output from the turn.
- Detect turn completion reliably.
- Capture per-turn token usage.

## Acceptance criteria

- [ ] Script creates both agents from code (no manual setup).
- [ ] Each agent wakes, runs, and the script knows when it finished.
- [ ] Structured output parsed from the turn (not scraped from logs).
- [ ] Token usage numbers captured per turn.
- [ ] Answered: can OpenClaw run headless in a container (for FACT-7's compose), or does it need a documented host-side sidecar?
- [ ] Findings written up: what works, what doesn't, what the adapter interface should look like. If any of the above fails, the architecture gets revised before Phase 1.
