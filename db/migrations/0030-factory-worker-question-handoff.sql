-- Keep an explicitly worker-owned question out of channel intake and on the
-- first implementation ticket that must ask it.

UPDATE agents
SET system_prompt = system_prompt || E'\n\nA requirement that says an implementer or worker must ask the human is already concrete enough for intake. Do not ask that question yourself. Preserve the unanswered requirement verbatim in the ready spec and handoff.'
WHERE name = 'Factory Orchestrator'
  AND system_prompt NOT LIKE E'%A requirement that says an implementer or worker must ask the human%';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nIf the ready spec assigns an unanswered human question to an implementer, copy that exact requirement into the first implementation ticket acceptance criteria. Do not answer or remove it.'
WHERE name = 'Factory Planner'
  AND system_prompt NOT LIKE E'%copy that exact requirement into the first implementation ticket%';
