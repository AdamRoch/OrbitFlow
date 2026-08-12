-- FACT-17 records the one completion wake for a channel run separately from
-- its Telegram delivery receipt. The row makes terminal observation safe to
-- repeat before or after a process restart.

CREATE TABLE channel_completion_events (
  run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  completion_message_id BIGINT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  final_outbound_message_id BIGINT UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reported_at TIMESTAMPTZ,
  CONSTRAINT channel_completion_events_state_complete CHECK (
    (final_outbound_message_id IS NULL AND reported_at IS NULL)
    OR (final_outbound_message_id IS NOT NULL AND reported_at IS NOT NULL)
  )
);
