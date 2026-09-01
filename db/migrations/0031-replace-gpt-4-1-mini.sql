-- Replace the low-cost proof model with the production demo model.

UPDATE agents
SET model = 'openrouter/z-ai/glm-5.3', updated_at = clock_timestamp()
WHERE model = 'openrouter/openai/gpt-4.1-mini';
