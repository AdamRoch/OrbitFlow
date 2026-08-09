# P4-1 WebSocket state stream

**Phase:** 4 · **Tag:** [MUST] · **Depends:** P2-1

Control plane pushes all state changes to the UI over WebSocket (or SSE, whichever is less code in the inherited stack — PRD §3). One stream feeds all four monitoring tabs and the live board.

## Acceptance criteria

- [ ] New/updated tickets, messages, run status, agent status, and cost events reach connected clients without refresh.
- [ ] Client reconnect recovers current state (re-fetch on connect is fine; no fancy replay).
- [ ] Events carry enough ids (run, agent, ticket, type) for client-side filtering — the Trail tab filters, the server doesn't.
