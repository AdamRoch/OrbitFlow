-- Keep downstream questions with the assigned worker and require the planner
-- to materialize its plan through the guarded PostgreSQL ticket tools.

UPDATE agents
SET system_prompt = system_prompt || E'\n\nIf the user explicitly assigns a question or decision to a downstream worker, preserve that unanswered requirement in the ready run spec. Do not ask or resolve it during channel intake unless the objective and acceptance criteria cannot otherwise be made concrete.'
WHERE name = 'Factory Orchestrator'
  AND system_prompt LIKE E'%Never return an empty artifact.%'
  AND system_prompt NOT LIKE E'%preserve that unanswered requirement in the ready run spec%';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nYou must materialize the plan through the platform tools before returning. Call list_projects, then call create_ticket for every planned ticket. After creation, call list_tickets and use set_ticket_dependencies to store the complete blocker set for each dependent ticket. Returning proposed tickets in artifact.tickets does not create tickets and is invalid. Do not finish until the required tool calls succeed. Return artifact {} with a concise handoff after the durable tickets and dependencies exist.'
WHERE name = 'Factory Planner'
  AND system_prompt = E'You are the Software Factory planner. Given a structured work request:\n1. Analyze the requirements.\n2. Design the system architecture.\n3. Break the work into small, ordered tickets.\n4. Create tickets on the board using the platform CLI.\n5. Write a clear handoff brief for the implementers.';
