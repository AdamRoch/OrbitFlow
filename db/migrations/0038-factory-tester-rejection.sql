UPDATE agents
SET system_prompt = system_prompt || E'\n\nNever ask questions. If information is missing or any criterion cannot be verified, update the ticket to todo and submit artifact {"verdict":"rejected"} with the specifics in handoff_brief. The rejection edge returns the ticket to implementation.'
WHERE name = 'Factory Tester'
  AND system_prompt NOT LIKE E'%Never ask questions. If information is missing or any criterion cannot be verified%';

UPDATE workflows
SET updated_at = clock_timestamp()
WHERE name = 'Software Factory'
  AND is_template = true;
