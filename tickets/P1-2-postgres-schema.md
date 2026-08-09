# P1-2 Postgres schema and migrations

**Phase:** 1 · **Tag:** [MUST] · **Depends:** P1-1

Stand up the full data model from PRD §4 as migrations: `agents`, `skills` (+ join table), `workflows`, `workflow_runs`, `tickets` (extend inherited OrbitTrack table with `run_id`, `acceptance_criteria`, `assignee_agent_id`), `messages`, `schedules`, `cost_events`. Timestamps and ids everywhere.

## Notes

- `messages` is the single event log for the whole system — get its columns right: `run_id`, nullable `ticket_id`, sender, recipient, `type` enum (`output|feedback|question|answer|channel_inbound|channel_outbound|cron_tick|system`), payload JSON, nullable `handoff_brief`, nullable `token_usage`.
- [MUST] Message history must fully reconstruct the inter-agent conversation trail per run.

## Acceptance criteria

- [ ] Migrations create all tables from a clean DB.
- [ ] `tickets` extension doesn't break existing board queries.
- [ ] A seeded run's messages can be queried back in order as a conversation trail.
