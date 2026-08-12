-- FACT-16: retain the channel orchestrator's intake state independently from
-- process memory. One collecting row owns a provider conversation until the
-- orchestrator emits a validated run spec.

CREATE TYPE channel_intake_status AS ENUM (
  'collecting',
  'ready',
  'failed'
);

CREATE TABLE channel_intakes (
  run_id BIGINT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  workflow_id BIGINT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  status channel_intake_status NOT NULL DEFAULT 'collecting',
  last_inbound_message_id BIGINT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  last_question TEXT,
  clarification_count INTEGER NOT NULL DEFAULT 0,
  validated_spec JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT channel_intakes_provider_not_blank CHECK (btrim(provider) <> ''),
  CONSTRAINT channel_intakes_conversation_not_blank CHECK (btrim(conversation_key) <> ''),
  CONSTRAINT channel_intakes_clarification_nonnegative CHECK (clarification_count >= 0),
  CONSTRAINT channel_intakes_spec_object CHECK (
    validated_spec IS NULL OR jsonb_typeof(validated_spec) = 'object'
  ),
  CONSTRAINT channel_intakes_state_complete CHECK (
    (
      status = 'collecting'
      AND validated_spec IS NULL
    ) OR (
      status = 'ready'
      AND validated_spec IS NOT NULL
      AND last_question IS NULL
    ) OR (
      status = 'failed'
      AND validated_spec IS NULL
    )
  )
);

CREATE UNIQUE INDEX channel_intakes_one_collecting_conversation
  ON channel_intakes(provider, conversation_key, workflow_id)
  WHERE status = 'collecting';

CREATE INDEX channel_intakes_status_updated
  ON channel_intakes(status, updated_at, run_id);
