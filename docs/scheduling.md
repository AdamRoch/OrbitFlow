# Scheduling and daily standup

FACT-25 keeps scheduling in the platform engine. `node-cron` owns the UTC minute boundary; OpenClaw's scheduler remains disabled and unused. The engine rereads enabled PostgreSQL `schedules` rows at each boundary, so an enable or disable change takes effect without restarting the process.

`publishScheduleTick` atomically creates a cron-triggered workflow run, a visible `cron_tick` bus message, and a unique `(schedule_id, tick_key)` receipt. The bus consumer starts the run only after that message is durable. Manual demo triggering uses the same function through `POST /api/schedules/:id/trigger` with an `idempotencyKey`; retrying the same key returns the original tick rather than creating another wake.

Workflow schedules use their referenced workflow. Agent schedules receive a private, durable one-node workflow, then use the normal dispatch and runtime adapter path. This is intentionally a bounded single-process scheduler, not a distributed scheduler.

The seeded Factory Orchestrator weekday 09:00 UTC schedule receives a 24-hour ticket-update count and spend total in `runSpec.standup`. When it completes, the engine emits a durable `channel_outbound` Telegram message to the most recently observed durable Telegram chat. If no user chat has ever been observed, it does not guess a destination.

Run `npm run fact25:proof` for the deterministic PostgreSQL proof. It does not wait for a wall clock, call Telegram, or call a model.
