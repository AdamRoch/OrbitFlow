CREATE TABLE message_consumer_runs (
  run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  next_sequence_number BIGINT NOT NULL DEFAULT 1,
  last_consumed_at TIMESTAMPTZ,
  CONSTRAINT message_consumer_runs_sequence_positive CHECK (
    next_sequence_number > 0
  )
);

INSERT INTO message_consumer_runs (run_id)
SELECT id FROM workflow_runs;

CREATE FUNCTION initialize_message_consumer_run()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO message_consumer_runs (run_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_runs_30_initialize_message_consumer
AFTER INSERT ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION initialize_message_consumer_run();

-- A consumed run moves behind every other run with a pending head message.
CREATE INDEX idx_message_consumer_runs_fair
  ON message_consumer_runs(last_consumed_at ASC NULLS FIRST, run_id);

CREATE TABLE message_enqueues (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Backfill every pre-migration message; no receipts exist before this migration.
INSERT INTO message_enqueues (message_id)
SELECT id FROM messages;

CREATE FUNCTION track_message_for_consumption()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO message_enqueues (message_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_30_track_consumption
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION track_message_for_consumption();

CREATE TABLE message_consumptions (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT message_consumptions_consumer_not_blank CHECK (
    btrim(consumer_id) <> ''
  )
);

-- The primary key is the engine's claim/ack lookup. This time index supports
-- operational inspection and explicit age-based retention work without
-- weakening the one-receipt-per-message invariant.
CREATE INDEX idx_message_consumptions_consumed_at
  ON message_consumptions(consumed_at, message_id);
