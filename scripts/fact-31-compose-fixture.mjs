import pg from "pg";
import {
  createWorkflowRun,
  startWorkflowRun,
} from "../src/lib/postgres/workflow-engine.ts";
import { triggerScheduleManually } from "../src/lib/postgres/scheduling.ts";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, application_name: "fact31-compose-fixture" });
const command = process.argv[2];

try {
  if (command === "seed") {
    const project = await pool.query(
      `INSERT INTO projects (key, name, next_number)
       VALUES ('FACT', 'FACT-31 proof', 2)
       RETURNING id::text`,
    );
    const agent = await pool.query(
      `INSERT INTO agents (
         name, role, system_prompt, model, guardrails, interaction_rules, memory
       ) VALUES (
         'FACT-31 Production Worker', 'implementer',
         'Complete the assigned production-engine proof ticket.',
         'openrouter/openai/gpt-4.1-mini', '{}', '{}', '{}'
       ) RETURNING id::text`,
    );
    const graph = {
      nodes: [{
        id: "implement",
        agentId: agent.rows[0].id,
        config: { entry: true, fanOut: { over: "openTickets", maxConcurrency: 1 } },
      }],
      edges: [],
    };
    const workflow = await pool.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('FACT-31 production workflow', 'Compose production-entrypoint proof', $1)
       RETURNING id::text`,
      [graph],
    );
    const run = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: { objective: "Prove the production engine path" },
    });
    await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (1, 'FACT-1', $1, $2, 'Production engine ticket',
                 'Materialize this ticket into a graph dispatch.',
                 'The production adapter emits one durable output.', 'todo', 3)`,
      [project.rows[0].id, run.id],
    );
    const schedule = await pool.query(
      `INSERT INTO schedules (cron_expression, agent_id, task_prompt)
       VALUES ('0 0 1 1 *', $1, 'FACT-31 scheduled production wake')
       RETURNING id::text`,
      [agent.rows[0].id],
    );
    await startWorkflowRun(pool, run.id);
    process.stdout.write(`${JSON.stringify({ runId: run.id, scheduleId: schedule.rows[0].id })}\n`);
  } else if (command === "trigger") {
    const schedule = await pool.query(
      "SELECT id::text FROM schedules WHERE task_prompt = 'FACT-31 scheduled production wake'",
    );
    const first = await triggerScheduleManually(pool, schedule.rows[0].id, "fact31-restart-safe");
    const duplicate = await triggerScheduleManually(pool, schedule.rows[0].id, "fact31-restart-safe");
    process.stdout.write(`${JSON.stringify({ first, duplicate })}\n`);
  } else if (command === "snapshot") {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM workflow_runs WHERE status = 'completed') AS completed_runs,
         (SELECT count(*)::int FROM workflow_dispatches) AS dispatches,
         (SELECT count(*)::int FROM workflow_dispatches WHERE status = 'completed') AS completed_dispatches,
         (SELECT count(*)::int FROM message_consumptions) AS consumptions,
         (SELECT count(*)::int FROM messages
          WHERE sender = 'runtime:openclaw'
            AND payload->>'kind' = 'openclaw_invocation_result') AS invocations,
         (SELECT count(*)::int FROM schedule_ticks) AS schedule_ticks,
         (SELECT count(*)::int FROM tickets WHERE identifier = 'FACT-1' AND assignee_agent_id IS NOT NULL) AS materialized_tickets,
         (SELECT count(*)::int FROM message_enqueues) AS pending_messages`,
    );
    process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
  } else {
    throw new Error("usage: fact-31-compose-fixture.mjs <seed|trigger|snapshot>");
  }
} finally {
  await pool.end();
}
