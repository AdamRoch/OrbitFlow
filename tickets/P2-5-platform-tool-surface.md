# P2-5 Platform tool surface for agents

**Phase:** 2 · **Tag:** [MUST] · **Depends:** P0-2 findings, P1-4

Small CLI (or local HTTP) that OpenClaw agents call: `create_ticket`, `update_ticket`, `post_message` (incl. `type=question`), `list_tickets` (PRD §5). All calls write DB rows; data flow is one-directional (agent → DB → WebSocket → UI). No scraping.

## Acceptance criteria

- [ ] All four commands work when called from inside an agent turn.
- [ ] Every call produces the corresponding DB row (and thus a bus/WS event).
- [ ] Calls are attributed: which agent, which run, which ticket.
- [ ] Blocked-action guardrails can be enforced here later (P5-1) — route all commands through one dispatch point.
