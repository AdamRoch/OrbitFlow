-- Use the stronger GLM model for the strict Factory Orchestrator intake contract.

UPDATE agents
SET model = 'openrouter/z-ai/glm-5.3', updated_at = clock_timestamp()
WHERE name = 'Factory Orchestrator'
  AND model = 'openrouter/z-ai/glm-5.3-flash';
