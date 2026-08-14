-- FACT-35: align every agent referenced by a shipped workflow template with
-- the primary model in the committed OpenClaw catalog. The migrator injects
-- that value transaction-locally after validating the catalog, so this
-- forward migration does not duplicate a provider model name.

WITH template_agent_ids AS (
  SELECT DISTINCT (node ->> 'agentId')::bigint AS agent_id
  FROM workflows
  CROSS JOIN LATERAL jsonb_array_elements(graph -> 'nodes') AS node
  WHERE is_template = true
    AND node ->> 'agentId' ~ '^[0-9]+$'
)
UPDATE agents
SET model = current_setting('orbitflow.openclaw_primary_model'),
    updated_at = now()
FROM template_agent_ids
WHERE agents.id = template_agent_ids.agent_id
  AND agents.model <> current_setting('orbitflow.openclaw_primary_model');
