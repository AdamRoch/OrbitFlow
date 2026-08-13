CREATE TABLE openclaw_dispatch_inputs (
  dispatch_id BIGINT PRIMARY KEY REFERENCES workflow_dispatches(id) ON DELETE RESTRICT,
  runtime_generation BIGINT NOT NULL,
  wake_input JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT openclaw_dispatch_inputs_generation_positive CHECK (runtime_generation > 0),
  CONSTRAINT openclaw_dispatch_inputs_wake_input_object CHECK (jsonb_typeof(wake_input) = 'object')
);
