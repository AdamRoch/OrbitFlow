# P4-1 WebSocket state stream

**Phase:** 4 · **Tag:** [MUST] · **Depends:** P2-1

Control plane pushes all state changes to the UI over SSE. Next.js route handlers
support a standard streaming `Response`; WebSockets would require a custom
server or another runtime layer. One stream feeds all four monitoring tabs and
the live board.

## Implementation status

**ready_for_review** — [PR #12](https://github.com/AdamRoch/OrbitFlow/pull/12)
implements `GET /api/state-stream` with a versioned SSE wake-up envelope
with nullable `runId`, `agentId`, and `ticketId` fields plus a stable event type.
PostgreSQL `AFTER` triggers emit committed control-plane wake-ups; inherited
SQLite board mutations emit only after their transaction returns. Clients
re-fetch on open and reconnect, so the database remains authoritative and no
stream delivery is claimed durable. Slow/disconnected clients are closed rather
than retaining an unbounded queue.

## Acceptance criteria

- [x] New/updated tickets, messages, run status, agent status, and cost events reach connected clients without refresh.
- [x] Client reconnect recovers current state (re-fetch on connect is fine; no fancy replay).
- [x] Events carry enough ids (run, agent, ticket, type) for client-side filtering — the Trail tab filters, the server doesn't.
