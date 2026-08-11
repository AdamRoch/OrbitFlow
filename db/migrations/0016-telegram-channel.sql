-- FACT-15 keeps Telegram delivery-specific state separate from the universal
-- messages trail. The rows below make inbound polling replay-safe and prevent
-- a process restart from blindly repeating an outbound provider effect.

CREATE TYPE telegram_outbound_delivery_status AS ENUM (
  'sending',
  'sent',
  'indeterminate'
);

CREATE TABLE telegram_inbound_updates (
  update_id BIGINT PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  message_id BIGINT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_telegram_inbound_updates_run
  ON telegram_inbound_updates(run_id, update_id);

CREATE TABLE telegram_outbound_deliveries (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  status telegram_outbound_delivery_status NOT NULL,
  telegram_message_id BIGINT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  sent_at TIMESTAMPTZ,
  failure_reason TEXT,
  CONSTRAINT telegram_outbound_deliveries_state_complete CHECK (
    (status = 'sending' AND telegram_message_id IS NULL AND sent_at IS NULL AND failure_reason IS NULL)
    OR (status = 'sent' AND telegram_message_id IS NOT NULL AND sent_at IS NOT NULL AND failure_reason IS NULL)
    OR (status = 'indeterminate' AND telegram_message_id IS NULL AND sent_at IS NULL AND failure_reason IS NOT NULL AND btrim(failure_reason) <> '')
  )
);

CREATE INDEX idx_telegram_outbound_deliveries_status
  ON telegram_outbound_deliveries(status, claimed_at)
  WHERE status = 'sending';

-- The shipped template directs Telegram to the Factory workflow. Existing
-- user-selected bindings are preserved rather than silently overwritten.
UPDATE agents
SET channel_binding = jsonb_build_object(
  'provider', 'telegram',
  'workflow', 'Software Factory'
)
WHERE name = 'Factory Orchestrator'
  AND channel_binding IS NULL;
