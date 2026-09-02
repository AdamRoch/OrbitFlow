UPDATE agents
SET system_prompt = system_prompt || E'\n\nThe coding tool works in an isolated copy and writes accepted changes back to the run workspace. Temporary paths in its transcript are executor internals, not evidence that files landed in the wrong place. Trust a successful delegation summary. To verify the result, delegate a verification task that runs the relevant checks and reports their output. Never use raw shell commands. Do not start a correction delegation only because the transcript shows temporary paths.'
WHERE name = 'Factory Implementer'
  AND system_prompt NOT LIKE E'%Temporary paths in its transcript are executor internals%';

UPDATE workflows
SET updated_at = clock_timestamp()
WHERE name = 'Software Factory'
  AND is_template = true;
