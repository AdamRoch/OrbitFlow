CREATE TABLE result_submissions (
  dispatch_id BIGINT NOT NULL,
  runtime_generation TEXT NOT NULL,
  output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dispatch_id, runtime_generation)
);

UPDATE agents
SET system_prompt = replace(
  replace(
    replace(
      replace(
        replace(
          system_prompt,
          'The runtime wraps your response in a top-level object with artifact, handoff_brief, and events.',
          'Call submit_result with a top-level object containing artifact, handoff_brief, and events.'
        ),
        'Return artifact {} with a concise handoff after the durable tickets and dependencies exist.',
        'Submit artifact {} with a concise handoff after the durable tickets and dependencies exist.'
      ),
      'Return the fixed output contract with artifact {}, a concise handoff, and exactly one event shaped',
      'Call submit_result with artifact {}, a concise handoff, and exactly one event shaped'
    ),
    'Produce the fixed JSON output contract with your handoff brief summarizing what was done.',
    'Call submit_result with artifact {} and a handoff brief summarizing what was done.'
  ),
  'Return artifact {"verdict":"approved"} only when every criterion passes. Otherwise update the ticket to todo, return artifact {"verdict":"rejected"}',
  'Submit artifact {"verdict":"approved"} only when every criterion passes. Otherwise update the ticket to todo, submit artifact {"verdict":"rejected"}'
) || E'\n\nFinal result delivery: do not print the result as chat text. At the end of the turn, call submit_result exactly once with one single-line JSON object containing exactly artifact, handoff_brief, and events. artifact must be an object, handoff_brief must be a non-blank string, and events must be an array of objects. The broker supplies all dispatch identifiers. Text after a successful submission is ignored.'
WHERE name IN (
  'Factory Orchestrator',
  'Factory Planner',
  'Factory Implementer',
  'Factory Tester',
  'Research Orchestrator',
  'Researcher',
  'Synthesizer',
  'Research Reviewer'
)
AND system_prompt NOT LIKE E'%Final result delivery: do not print the result as chat text.%';
