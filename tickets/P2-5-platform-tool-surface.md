# P2-5 Platform tool surface for agents

**Phase:** 2 · **Tag:** [MUST] · **Depends:** P0-2 findings, P1-4

Implement the platform-owned CLI contract in PRD §5. Follow `docs/fact-2-platform-tool-spike.md` for the proven `TOOLS.md` registration method, supported `exec` integration, structured invocation capture, and PATH and host-execution constraints.

## Acceptance criteria

- [ ] All four commands work when called from inside an agent turn.
- [ ] Every call produces the corresponding DB row (and thus a bus/WS event).
- [ ] Calls are attributed: which agent, which run, which ticket.
- [ ] Blocked-action guardrails can be enforced here later (P5-1) — route all commands through one dispatch point.
