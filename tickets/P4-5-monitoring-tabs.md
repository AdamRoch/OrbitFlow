# P4-5 Monitoring tabs: board, trail, agents, cost

**Phase:** 4 · **Tag:** [MUST] · **Depends:** P4-1

Four tabs, all fed by the same WebSocket stream (PRD §9):

1. **Board** — inherited OrbitTrack board, live-updating per run.
2. **Trail** — inter-agent message feed incl. Telegram traffic; filterable by run/agent/type.
3. **Agents** — status (idle / working / waiting-on-question), current task, logs.
4. **Cost** — token/cost per run and per agent from `cost_events`; ceilings shown against actuals.

## Acceptance criteria

- [ ] During a live run, tickets move on the board without refresh.
- [ ] Trail shows the full conversation trail incl. handoff briefs and Telegram traffic; filters work.
- [ ] Agent status reflects reality within the stream's latency.
- [ ] Cost tab totals match `cost_events` sums; each agent's ceiling rendered next to actual spend.
