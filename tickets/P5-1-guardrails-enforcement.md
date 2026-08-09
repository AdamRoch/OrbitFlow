# P5-1 Guardrails enforcement

**Phase:** 5 · **Tag:** [MUST] · **Depends:** P2-2, P2-5

Enforce guardrails (PRD §6): per-agent and per-run cost ceilings checked **by the engine before each wake**; rate limits; blocked actions passed into the prompt AND enforced at the tool surface where possible.

## Acceptance criteria

- [ ] Wake is refused when agent or run spend ≥ ceiling; run pauses with a visible `system` message, not a silent stall.
- [ ] Rate limit throttles wakes per agent.
- [ ] A blocked action attempted via the tool surface is rejected at the dispatch point (P2-5) and logged.
- [ ] Cost-ceiling halt is covered by a test (P5-4).
