-- Use the lower-cost GLM 5.3 Flash model for every seeded agent.

UPDATE agents
SET model = 'openrouter/z-ai/glm-5.3-flash', updated_at = clock_timestamp()
WHERE model = 'openrouter/z-ai/glm-5.3';
