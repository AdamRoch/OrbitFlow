# P5-3 Scheduling and daily standup

**Phase:** 5 · **Tag:** [MUST] (standup example [CORE]) · **Depends:** P2-2, P3-1

Cron in the platform engine via node-cron, NOT OpenClaw's scheduler — every tick becomes a `cron_tick` bus message so all wake-ups share one event log (PRD §8; note the tradeoff in the README, P5-5). Two targets: trigger a workflow run; wake a single agent with a standing task prompt.

## Acceptance criteria

- [ ] `schedules` rows drive node-cron; enable/disable works without restart.
- [ ] Both target types fire correctly and appear as `cron_tick` messages.
- [ ] Live example seeded: orchestrator **daily standup** texts the user a summary of ticket movement + spend.
- [ ] Standup can be triggered manually for the demo (nobody waits for 9am).
