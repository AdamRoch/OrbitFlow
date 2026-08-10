CREATE TABLE message_consumptions (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  consumer_id TEXT NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT message_consumptions_consumer_not_blank CHECK (
    btrim(consumer_id) <> ''
  )
);

-- The primary key is the engine's claim/ack lookup. This time index supports
-- operational inspection and explicit age-based retention work without
-- weakening the one-receipt-per-message invariant.
CREATE INDEX idx_message_consumptions_consumed_at
  ON message_consumptions(consumed_at, message_id);
