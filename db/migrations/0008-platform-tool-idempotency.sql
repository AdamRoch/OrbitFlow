-- FACT-13 retries can happen after an agent process loses its response. Keep
-- the completed command result next to the actor/run attribution so a retry
-- cannot create a second ticket or message.
CREATE TABLE agent_tool_invocations (
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id, run_id, idempotency_key),
  CONSTRAINT agent_tool_invocations_key_not_blank CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT agent_tool_invocations_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_tool_invocations_response_object CHECK (jsonb_typeof(response) = 'object')
);
