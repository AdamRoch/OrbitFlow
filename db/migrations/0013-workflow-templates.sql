-- FACT-21: Seed two ordinary workflow templates (Software Factory and Research
-- Pipeline) with their default agents, prompts, and skills.  Forward-only,
-- idempotent: uses name-based conflict checks so restarting the migration never
-- duplicates templates and never overwrites user edits.

-- ── Helpers ──────────────────────────────────────────────────────────────────

CREATE FUNCTION template_seed_skill(
  _name        text,
  _description text,
  _procedure   text
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  outcome bigint;
BEGIN
  INSERT INTO skills (name, description, procedure)
  VALUES (_name, _description, _procedure)
  ON CONFLICT (name) DO NOTHING
  RETURNING id INTO outcome;

  IF outcome IS NULL THEN
    SELECT id INTO outcome FROM skills WHERE name = _name;
  END IF;

  RETURN outcome;
END;
$$;

CREATE FUNCTION template_seed_agent(
  _name          text,
  _role          text,
  _system_prompt text,
  _model         text,
  _skills        bigint[]
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  outcome bigint;
  sid     bigint;
BEGIN
  INSERT INTO agents (name, role, system_prompt, model, coding_tool_enabled,
                      guardrails, interaction_rules, memory)
  VALUES (_name, _role, _system_prompt, _model, false,
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  ON CONFLICT (name) DO NOTHING
  RETURNING id INTO outcome;

  IF outcome IS NULL THEN
    SELECT id INTO outcome FROM agents WHERE name = _name;
  END IF;

  -- Upsert skill attachments regardless of whether the agent row was inserted
  -- or updated, so schema changes that add a skill still link it to existing
  -- agents.
  FOREACH sid IN ARRAY _skills
  LOOP
    INSERT INTO agent_skills (agent_id, skill_id)
    VALUES (outcome, sid)
    ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN outcome;
END;
$$;

-- ── Software Factory template ────────────────────────────────────────────────

DO $$
DECLARE
  orchestrator_id  bigint;
  planner_id       bigint;
  implementer_id   bigint;
  tester_id        bigint;
  graph            jsonb;
  existing_id      bigint;
BEGIN
  SELECT id INTO existing_id FROM workflows WHERE name = 'Software Factory';
  IF FOUND THEN
    RAISE NOTICE 'Software Factory template already exists, skipping';
    RETURN;
  END IF;

  -- Skills shared by the factory agents
  PERFORM template_seed_skill(
    'Code Review',
    'Review code diffs, identify issues, and provide constructive feedback.',
    E'Read the diff carefully.\nCheck for correctness, edge cases, and style.\nWrite a structured review with verdict (approved / changes_requested).'
  );
  PERFORM template_seed_skill(
    'Ticket Management',
    'Create and update tickets to track work through the workflow.',
    E'Use the platform CLI to create tickets with clear descriptions.\nUpdate ticket status as work progresses.\nLink related tickets.'
  );
  PERFORM template_seed_skill(
    'System Design',
    'Design software architecture and plan implementation steps.',
    E'Analyze requirements.\nDesign system architecture.\nBreak work into implementable tickets.'
  );
  PERFORM template_seed_skill(
    'Testing',
    'Write and run tests to validate correctness.',
    E'Review implementation against acceptance criteria.\nIdentify edge cases.\nRun the test suite.\nReport verdict: approved or rejected with reasons.'
  );
  PERFORM template_seed_skill(
    'Coding',
    'Implement features using the coding CLI tool.',
    E'Read the assigned ticket.\nImplement the solution using the coding tool.\nVerify the implementation compiles and tests pass.\nReport what was done.'
  );

  -- Software Factory agents
  orchestrator_id := template_seed_agent(
    'Factory Orchestrator',
    'orchestrator',
    E'You are the Software Factory orchestrator. Your job is to:\n1. Receive an idea from the user.\n2. Clarify requirements through targeted questions.\n3. Produce a structured run spec with clear acceptance criteria.\n4. Hand off to the planner.\n5. Monitor progress and keep the user informed.\n\nBe concise. Ask exactly what you need to scope the work. Do not implement anything yourself.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Ticket Management')
    ]
  );
  planner_id := template_seed_agent(
    'Factory Planner',
    'planner',
    E'You are the Software Factory planner. Given a structured work request:\n1. Analyze the requirements.\n2. Design the system architecture.\n3. Break the work into small, ordered tickets.\n4. Create tickets on the board using the platform CLI.\n5. Write a clear handoff brief for the implementers.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'System Design'),
      (SELECT id FROM skills WHERE name = 'Ticket Management')
    ]
  );
  implementer_id := template_seed_agent(
    'Factory Implementer',
    'implementer',
    E'You are a Software Factory implementer. Given a ticket:\n1. Read the ticket and understand the requirements.\n2. Implement the solution using the coding CLI tool.\n3. Ensure the implementation compiles and passes tests.\n4. Update the ticket status and write a clear handoff brief.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Coding'),
      (SELECT id FROM skills WHERE name = 'Ticket Management')
    ]
  );
  tester_id := template_seed_agent(
    'Factory Tester',
    'tester',
    E'You are the Software Factory tester. Given an implementation:\n1. Review the code against the ticket acceptance criteria.\n2. Run tests and check for edge cases.\n3. Provide a verdict: "approved" or "rejected".\n4. If rejected, explain what needs to change.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Code Review'),
      (SELECT id FROM skills WHERE name = 'Testing'),
      (SELECT id FROM skills WHERE name = 'Ticket Management')
    ]
  );

  -- Software Factory graph: orchestrator -> planner -> implement (fan-out) -> test -> (rejected -> implement | always -> report)
  graph := jsonb_build_object(
    'nodes', jsonb_build_array(
      jsonb_build_object('id', 'orchestrator', 'agentId', orchestrator_id, 'config', jsonb_build_object('entry', true, 'channelBinding', true, 'planMode', 'required', 'may_answer_questions', true, 'questionEscalation', jsonb_build_object('target', 'human-via-channel'))),
      jsonb_build_object('id', 'planner', 'agentId', planner_id, 'config', jsonb_build_object('planMode', 'required', 'may_answer_questions', true)),
      jsonb_build_object('id', 'implement', 'agentId', implementer_id, 'config', jsonb_build_object('fanOut', jsonb_build_object('over', 'openTickets', 'maxConcurrency', 3), 'planMode', 'allowed')),
      jsonb_build_object('id', 'test', 'agentId', tester_id, 'config', jsonb_build_object('planMode', 'off', 'may_answer_questions', false)),
      jsonb_build_object('id', 'report', 'agentId', orchestrator_id, 'config', jsonb_build_object('planMode', 'off', 'may_answer_questions', true, 'questionEscalation', jsonb_build_object('target', 'human-via-channel')))
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('source', 'orchestrator', 'target', 'planner', 'condition', jsonb_build_object('operator', 'always')),
      jsonb_build_object('source', 'planner', 'target', 'implement', 'condition', jsonb_build_object('operator', 'always')),
      jsonb_build_object('source', 'implement', 'target', 'test', 'condition', jsonb_build_object('operator', 'always')),
      jsonb_build_object('source', 'test', 'target', 'implement', 'condition', jsonb_build_object('operator', 'equals', 'path', jsonb_build_array('verdict'), 'value', 'rejected')),
      jsonb_build_object('source', 'test', 'target', 'report', 'condition', jsonb_build_object('operator', 'always'))
    ),
    'builderMetadata', jsonb_build_object(
      'positions', jsonb_build_object(
        'orchestrator', jsonb_build_object('x', 20, 'y', 80),
        'planner', jsonb_build_object('x', 220, 'y', 80),
        'implement', jsonb_build_object('x', 420, 'y', 80),
        'test', jsonb_build_object('x', 620, 'y', 80),
        'report', jsonb_build_object('x', 420, 'y', 260)
      )
    )
  );

  INSERT INTO workflows (name, description, graph, is_template)
  VALUES (
    'Software Factory',
    'Turn a texted idea into working code. Orchestrator clarifies, planner breaks work into tickets, implementers fan out across tickets, tester approves or sends back, and the orchestrator reports the result.',
    graph,
    true
  );
END;
$$;

-- ── Research Pipeline template ───────────────────────────────────────────────

DO $$
DECLARE
  orchestrator_id    bigint;
  researcher_id      bigint;
  synthesizer_id     bigint;
  reviewer_id        bigint;
  graph              jsonb;
  existing_id        bigint;
BEGIN
  SELECT id INTO existing_id FROM workflows WHERE name = 'Research Pipeline';
  IF FOUND THEN
    RAISE NOTICE 'Research Pipeline template already exists, skipping';
    RETURN;
  END IF;

  PERFORM template_seed_skill(
    'Web Research',
    'Search and gather information from web sources.',
    E'Formulate precise search queries.\nFetch and read relevant sources.\nExtract key facts and citations.\nSummarize findings.\nDocument your sources with URLs and timestamps.'
  );
  PERFORM template_seed_skill(
    'Analysis',
    'Analyze research findings and draw insights.',
    E'Synthesize findings from multiple sources.\nIdentify patterns and contradictions.\nDraw evidence-backed conclusions.\nFlag knowledge gaps.'
  );
  PERFORM template_seed_skill(
    'Writing',
    'Write clear, structured research reports.',
    E'Organize findings into a logical structure.\nWrite in clear, concise language.\nCite all sources.\nInclude a summary of key findings.'
  );

  -- Research Pipeline agents
  orchestrator_id := template_seed_agent(
    'Research Orchestrator',
    'orchestrator',
    E'You are the Research Pipeline orchestrator. Your job is to:\n1. Receive a research question from the user.\n2. Clarify scope, depth, and format requirements.\n3. Break the question into research subtopics (one ticket per subtopic).\n4. Hand off to researchers.\n5. Monitor progress and keep the user informed.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Ticket Management')
    ]
  );
  researcher_id := template_seed_agent(
    'Researcher',
    'researcher',
    E'You are a researcher. Given a research task ticket:\n1. Read the ticket carefully.\n2. Research the topic thoroughly.\n3. Find authoritative sources.\n4. Write a structured research note with findings and citations.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Web Research'),
      (SELECT id FROM skills WHERE name = 'Ticket Management')
    ]
  );
  synthesizer_id := template_seed_agent(
    'Synthesizer',
    'synthesizer',
    E'You are the research synthesizer. Given research notes from multiple researchers:\n1. Combine and cross-reference findings.\n2. Identify themes, patterns, and contradictions.\n3. Write a coherent synthesis.\n4. Flag open questions or gaps.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Analysis'),
      (SELECT id FROM skills WHERE name = 'Writing')
    ]
  );
  reviewer_id := template_seed_agent(
    'Research Reviewer',
    'reviewer',
    E'You review research reports for quality, completeness, and accuracy.\n1. Check that all research questions were answered.\n2. Verify sources are credible and cited.\n3. Assess the quality of analysis.\n4. Provide verdict: "approved" or "rejected".\n5. If rejected, explain exactly what needs improvement.',
    'openrouter/anthropic/claude-3.5-sonnet',
    ARRAY[
      (SELECT id FROM skills WHERE name = 'Analysis'),
      (SELECT id FROM skills WHERE name = 'Writing')
    ]
  );

  -- Research Pipeline graph
  graph := jsonb_build_object(
    'nodes', jsonb_build_array(
      jsonb_build_object('id', 'orchestrator', 'agentId', orchestrator_id, 'config', jsonb_build_object('entry', true, 'channelBinding', true, 'planMode', 'required', 'may_answer_questions', true, 'questionEscalation', jsonb_build_object('target', 'human-via-channel'))),
      jsonb_build_object('id', 'research', 'agentId', researcher_id, 'config', jsonb_build_object('fanOut', jsonb_build_object('over', 'openTickets', 'maxConcurrency', 4), 'planMode', 'off')),
      jsonb_build_object('id', 'synthesize', 'agentId', synthesizer_id, 'config', jsonb_build_object('planMode', 'required', 'may_answer_questions', true)),
      jsonb_build_object('id', 'review', 'agentId', reviewer_id, 'config', jsonb_build_object('planMode', 'off')),
      jsonb_build_object('id', 'report', 'agentId', orchestrator_id, 'config', jsonb_build_object('planMode', 'off', 'may_answer_questions', true, 'questionEscalation', jsonb_build_object('target', 'human-via-channel')))
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('source', 'orchestrator', 'target', 'research', 'condition', jsonb_build_object('operator', 'always')),
      jsonb_build_object('source', 'research', 'target', 'synthesize', 'condition', jsonb_build_object('operator', 'always')),
      jsonb_build_object('source', 'synthesize', 'target', 'review', 'condition', jsonb_build_object('operator', 'always')),
      jsonb_build_object('source', 'review', 'target', 'synthesize', 'condition', jsonb_build_object('operator', 'equals', 'path', jsonb_build_array('verdict'), 'value', 'rejected')),
      jsonb_build_object('source', 'review', 'target', 'report', 'condition', jsonb_build_object('operator', 'always'))
    ),
    'builderMetadata', jsonb_build_object(
      'positions', jsonb_build_object(
        'orchestrator', jsonb_build_object('x', 20, 'y', 80),
        'research', jsonb_build_object('x', 260, 'y', 80),
        'synthesize', jsonb_build_object('x', 520, 'y', 80),
        'review', jsonb_build_object('x', 720, 'y', 80),
        'report', jsonb_build_object('x', 520, 'y', 260)
      )
    )
  );

  INSERT INTO workflows (name, description, graph, is_template)
  VALUES (
    'Research Pipeline',
    'Research a question end-to-end. Orchestrator clarifies scope, researchers fan out across subtopics, synthesizer writes the draft, reviewer approves or sends back, and the orchestrator delivers the final report.',
    graph,
    true
  );
END;
$$;

-- Clean up helper functions that are only needed during migration.
DROP FUNCTION template_seed_skill(text, text, text);
DROP FUNCTION template_seed_agent(text, text, text, text, bigint[]);
