ALTER TABLE workflow_runs
  ADD COLUMN workflow_version TIMESTAMPTZ,
  ADD COLUMN retry_of_run_id BIGINT REFERENCES workflow_runs(id) ON DELETE RESTRICT,
  ADD COLUMN retry_request_key TEXT,
  ADD COLUMN retry_blocked_reason TEXT;

UPDATE workflow_runs AS run
SET workflow_version = workflow.updated_at,
    graph_snapshot = COALESCE(run.graph_snapshot, workflow.graph)
FROM workflows AS workflow
WHERE workflow.id = run.workflow_id;

ALTER TABLE workflow_runs
  ALTER COLUMN workflow_version SET NOT NULL,
  ADD CONSTRAINT workflow_runs_retry_not_self CHECK (
    retry_of_run_id IS NULL OR retry_of_run_id <> id
  ),
  ADD CONSTRAINT workflow_runs_retry_request_complete CHECK (
    (retry_of_run_id IS NULL AND retry_request_key IS NULL)
    OR (
      retry_of_run_id IS NOT NULL
      AND retry_request_key IS NOT NULL
      AND btrim(retry_request_key) <> ''
    )
  ),
  ADD CONSTRAINT workflow_runs_retry_blocked_reason_not_blank CHECK (
    retry_blocked_reason IS NULL OR btrim(retry_blocked_reason) <> ''
  );

CREATE INDEX idx_workflow_runs_retry_of
  ON workflow_runs(retry_of_run_id)
  WHERE retry_of_run_id IS NOT NULL;

CREATE UNIQUE INDEX idx_workflow_runs_retry_request
  ON workflow_runs(retry_of_run_id, retry_request_key)
  WHERE retry_of_run_id IS NOT NULL;
