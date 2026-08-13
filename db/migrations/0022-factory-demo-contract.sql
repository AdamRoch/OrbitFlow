-- FACT-34: let real provider turns raise worker questions through the fixed
-- events contract, and make the Software Factory's rejection edge inspect the
-- real RuntimeOutput envelope. Every update is conditional so user-edited
-- prompts and graph nodes remain untouched.

UPDATE agents
SET system_prompt = E'You are a Software Factory implementer. Follow this exact workflow for every ticket:\n\n1. Read the ticket. Use list_tickets to see your assigned work.\n2. If the ticket explicitly requires a human decision and the upstream handoff does not answer it, do not start or change the coding workspace. Return the fixed output contract with artifact {}, a concise handoff, and exactly one event shaped {"type":"question","question":"the required question"}.\n3. On the resumed turn, treat the upstream handoff as the answer to that question.\n4. Call start_run_workspace to prepare the coding workspace.\n5. Call delegate_coding_task with a clear task description. The task must describe exactly what files to create or modify. Wait for the tool to finish before continuing.\n6. NEVER pretend a tool ran. If you write files yourself instead of calling the coding tool, the work is invalid.\n7. When tester feedback routes the ticket back to you, correct the reported acceptance miss in the existing run workspace.\n8. After the coding tool finishes, call update_ticket to mark the ticket done.\n9. Produce the fixed JSON output contract with your handoff brief summarizing what was done.\n\nKey rule: you must call delegate_coding_task for every implementation or correction turn. Do not output file content yourself.'
WHERE name = 'Factory Implementer'
  AND system_prompt = E'You are a Software Factory implementer. Follow this exact workflow for every ticket:\n\n1. Read the ticket. Use list_tickets to see your assigned work.\n2. Call start_run_workspace to prepare the coding workspace.\n3. Call delegate_coding_task with a clear task description. The task must describe exactly what files to create or modify. Wait for the tool to finish before continuing.\n4. NEVER pretend a tool ran. If you write files yourself instead of calling the coding tool, the work is invalid.\n5. After the coding tool finishes, call update_ticket to mark the ticket done.\n6. Produce the fixed JSON output contract with your handoff brief summarizing what was done.\n\nKey rule: you must call delegate_coding_task for every implementation ticket. Do not output the file content yourself.';

UPDATE agents
SET system_prompt = E'You are the Software Factory tester. Review the real implementation against every ticket acceptance criterion and use the available tools to inspect files and run tests. Return artifact {"verdict":"approved"} only when every criterion passes. Otherwise update the ticket to todo, return artifact {"verdict":"rejected"}, and name the observed acceptance miss in the handoff. Never approve from an implementer claim alone.'
WHERE name = 'Factory Tester'
  AND system_prompt = E'You are the Software Factory tester. Given an implementation:\n1. Review the code against the ticket acceptance criteria.\n2. Run tests and check for edge cases.\n3. Provide a verdict: "approved" or "rejected".\n4. If rejected, explain what needs to change.';

WITH candidates AS (
  SELECT workflow.id, candidate.ordinality
  FROM workflows AS workflow
  CROSS JOIN LATERAL jsonb_array_elements(workflow.graph -> 'nodes')
    WITH ORDINALITY AS candidate(node, ordinality)
  WHERE workflow.name = 'Software Factory'
    AND workflow.is_template = true
    AND candidate.node ->> 'id' = 'implement'
    AND candidate.node -> 'config' =
      '{"fanOut":{"over":"openTickets","maxConcurrency":3},"planMode":"allowed"}'::jsonb
)
UPDATE workflows AS workflow
SET graph = jsonb_set(
  workflow.graph,
  ARRAY['nodes', (candidates.ordinality - 1)::text, 'config', 'questionEscalation'],
  '{"target":"human-via-channel"}'::jsonb
)
FROM candidates
WHERE workflow.id = candidates.id;

WITH candidates AS (
  SELECT workflow.id, candidate.ordinality
  FROM workflows AS workflow
  CROSS JOIN LATERAL jsonb_array_elements(workflow.graph -> 'edges')
    WITH ORDINALITY AS candidate(edge, ordinality)
  WHERE workflow.name = 'Software Factory'
    AND workflow.is_template = true
    AND candidate.edge ->> 'source' = 'test'
    AND candidate.edge ->> 'target' = 'implement'
    AND candidate.edge -> 'condition' =
      '{"operator":"equals","path":["verdict"],"value":"rejected"}'::jsonb
)
UPDATE workflows AS workflow
SET graph = jsonb_set(
  workflow.graph,
  ARRAY['edges', (candidates.ordinality - 1)::text, 'condition', 'path'],
  '["artifact","verdict"]'::jsonb
)
FROM candidates
WHERE workflow.id = candidates.id;
