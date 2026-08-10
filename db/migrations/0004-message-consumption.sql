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
  INSERT INTO message_ready_runs (run_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_runs_30_initialize_message_consumer
AFTER INSERT ON workflow_runs
FOR EACH ROW EXECUTE FUNCTION initialize_message_consumer_run();

CREATE TABLE message_enqueues (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- No receipts exist before this migration, so every existing message is still
-- pending.
INSERT INTO message_enqueues (message_id)
SELECT id FROM messages;

CREATE TABLE message_ready_runs (
  run_id BIGINT PRIMARY KEY
    REFERENCES message_consumer_runs(run_id) ON DELETE CASCADE,
  message_id BIGINT UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  ready_at TIMESTAMPTZ,
  CONSTRAINT message_ready_runs_state_complete CHECK (
    (message_id IS NULL AND ready_at IS NULL)
    OR (message_id IS NOT NULL AND ready_at IS NOT NULL)
  )
);

-- Every run has one projection row, but only ready runs enter this partial
-- index. Its keys supply the complete fair order before LIMIT, independent of
-- idle cursor history or backlog behind a run's current head.
CREATE INDEX idx_message_ready_runs_fair
  ON message_ready_runs(ready_at, run_id) INCLUDE (message_id)
  WHERE message_id IS NOT NULL;

INSERT INTO message_ready_runs (run_id, message_id, ready_at)
SELECT consumer.run_id, head.id, head.created_at
FROM message_consumer_runs AS consumer
LEFT JOIN LATERAL (
  SELECT message.id, message.created_at
  FROM messages AS message
  WHERE message.run_id = consumer.run_id
  ORDER BY message.sequence_number
  LIMIT 1
) AS head ON true;

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

CREATE FUNCTION refresh_message_ready_run()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Run at producer commit, after any concurrent consumer can commit its cursor
  -- advance. This closes the late-producer race without making the routing
  -- handler share a lock order with FACT-6's producer advisory lock.
  UPDATE message_ready_runs AS ready
  SET message_id = head.id,
      ready_at = clock_timestamp()
  FROM message_consumer_runs AS consumer
  JOIN messages AS head
    ON head.run_id = consumer.run_id
   AND head.sequence_number = consumer.next_sequence_number
  JOIN message_enqueues AS enqueue ON enqueue.message_id = head.id
  WHERE ready.run_id = NEW.run_id
    AND consumer.run_id = ready.run_id
    AND ready.message_id IS DISTINCT FROM head.id;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER messages_40_refresh_ready_run
AFTER INSERT ON messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION refresh_message_ready_run();

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
