# P2-1 Message bus

**Phase:** 2 · **Tag:** [MUST] · **Depends:** P1-2

DB-backed bus per PRD §3: the `messages` table is the single event log. Producers (Telegram, UI actions, cron ticks, agent outputs) insert rows; the workflow engine is the **only consumer** that routes. No Redis/RabbitMQ — Postgres LISTEN/NOTIFY, or an engine-internal poll loop if NOTIFY gets fiddly.

## Acceptance criteria

- [ ] Insert helper used by all producers (one write path).
- [ ] Engine receives new messages promptly (subscribe or poll) and exactly once per message (mark-consumed or cursor — pick the simpler that survives an engine restart).
- [ ] Restarting the engine doesn't drop or double-dispatch messages.
