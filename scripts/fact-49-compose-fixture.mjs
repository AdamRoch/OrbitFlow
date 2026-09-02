import pg from "pg";
import { loadOpenClawModelCatalog } from "../src/lib/runtime/openclaw-model-catalog.mjs";

const proofModel = (await loadOpenClawModelCatalog()).primaryModel;
import { writeFile } from "node:fs/promises";
import {
  createWorkflowRun,
  startWorkflowRun,
} from "../src/lib/postgres/workflow-engine.ts";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, application_name: "fact49-compose-fixture" });
const command = process.argv[2];

try {
  if (command === "identity") {
    const result = await pool.query("SELECT current_database() AS name");
    process.stdout.write(`${JSON.stringify({ database: result.rows[0]?.name })}\n`);
  } else if (command === "seed") {
    const project = await pool.query(
      "INSERT INTO projects (key, name) VALUES ('BKR', 'FACT-49 broker proof') RETURNING id::text",
    );
    const planner = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-49 Planner', 'planner', 'FACT49_PLANNER marker pending', '${proofModel}')
       RETURNING id::text`,
    );
    const implementer = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-49 Implementer', 'implementer', 'FACT49_BOUND marker pending', '${proofModel}')
       RETURNING id::text`,
    );
    const graph = {
      nodes: [
        { id: "plan", agentId: planner.rows[0].id, config: { entry: true } },
        { id: "implement", agentId: implementer.rows[0].id, config: { fanOut: { over: "openTickets", maxConcurrency: 1 } } },
      ],
      edges: [{ source: "plan", target: "implement", condition: { operator: "always" } }],
    };
    const workflow = await pool.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-49 broker proof workflow', 'Production broker dependency proof', $1) RETURNING id::text",
      [graph],
    );
    const run = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: { objective: "Prove planner dependency target and bound-ticket enforcement" },
    });
    const blocker = await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (1, 'BKR-1', $1, $2, 'Completed blocker', 'Already complete.', 'Remain done.', 'done', 1)
       RETURNING id::text`,
      [project.rows[0].id, run.id],
    );
    const target = await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (2, 'BKR-2', $1, $2, 'Planner target', 'The planner supplies this target.', 'Receive the blocker set.', 'todo', 4)
       RETURNING id::text`,
      [project.rows[0].id, run.id],
    );
    const escape = await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (3, 'BKR-3', $1, $2, 'Escape target', 'Must not be changed by a bound implementer.', 'Remain untouched.', 'backlog', 0)
       RETURNING id::text`,
      [project.rows[0].id, run.id],
    );
    const blockerId = blocker.rows[0].id;
    const targetId = target.rows[0].id;
    const escapeId = escape.rows[0].id;
    await pool.query(
      "UPDATE agents SET system_prompt = $2 WHERE id = $1",
      [planner.rows[0].id, `FACT49_PLANNER target=${targetId} blocker=${blockerId}`],
    );
    await pool.query(
      "UPDATE agents SET system_prompt = $2 WHERE id = $1",
      [implementer.rows[0].id, `FACT49_BOUND wrong=${escapeId}`],
    );
    await startWorkflowRun(pool, run.id);
    process.stdout.write(`${JSON.stringify({
      runId: run.id,
      plannerId: planner.rows[0].id,
      implementerId: implementer.rows[0].id,
      projectId: project.rows[0].id,
      blockerTicketId: blockerId,
      targetTicketId: targetId,
      escapeTicketId: escapeId,
    })}\n`);
  } else if (command === "snapshot") {
    const runId = requiredId(process.argv[3], "snapshot run id");
    const result = await pool.query(
      `SELECT run.status::text AS "runStatus",
              (SELECT count(*)::int FROM workflow_dispatches WHERE run_id = run.id) AS dispatches,
              (SELECT count(*)::int FROM workflow_dispatches WHERE run_id = run.id AND status = 'dispatching') AS "dispatchingDispatches",
              (SELECT count(*)::int FROM workflow_dispatches WHERE run_id = run.id AND status = 'completed') AS "completedDispatches",
              (SELECT count(*)::int FROM openclaw_dispatch_inputs WHERE dispatch_id IN (SELECT id FROM workflow_dispatches WHERE run_id = run.id)) AS "openclawInputs"
       FROM workflow_runs AS run
       WHERE run.id = $1`,
      [runId],
    );
    const tickets = await pool.query(
      `SELECT ticket.id::text AS id, ticket.status::text AS status,
              COALESCE(array_agg(dependency.blocker_ticket_id::text ORDER BY dependency.blocker_ticket_id)
                FILTER (WHERE dependency.blocker_ticket_id IS NOT NULL), '{}') AS "blockerTicketIds"
       FROM tickets AS ticket
       LEFT JOIN dependencies AS dependency ON dependency.blocked_ticket_id = ticket.id
       WHERE ticket.run_id = $1
       GROUP BY ticket.id ORDER BY ticket.id`,
      [runId],
    );
    const dispatches = await pool.query(
      `SELECT id::text AS id, ticket_id::text AS "ticketId", status::text AS status
       FROM workflow_dispatches WHERE run_id = $1 ORDER BY id`,
      [runId],
    );
    process.stdout.write(`${JSON.stringify({
      ...(result.rows[0] ?? null),
      tickets: tickets.rows,
      dispatchRows: dispatches.rows,
    })}\n`);
  } else if (command === "planner-proof") {
    const runId = requiredId(process.argv[3], "planner-proof run id");
    const targetId = requiredId(process.argv[4], "planner-proof target id");
    const escapeId = requiredId(process.argv[5], "planner-proof escape id");
    const blockerId = requiredId(process.argv[6], "planner-proof blocker id");
    const plannerId = requiredId(process.argv[7], "planner-proof planner id");
    const target = await ticketDependencies(pool, targetId);
    const escape = await ticketDependencies(pool, escapeId);
    const invocation = await pool.query(
      `SELECT agent_id::text AS "agentId", run_id::text AS "runId", response
       FROM agent_tool_invocations
       WHERE run_id = $1 AND idempotency_key = 'fact49-planner-dependencies'`,
      [runId],
    );
    const responseTicket = invocation.rows[0]?.response?.ticket ?? null;
    process.stdout.write(`${JSON.stringify({
      target,
      escape,
      invocationCount: invocation.rowCount,
      invocationAgentId: invocation.rows[0]?.agentId ?? null,
      invocationRunId: invocation.rows[0]?.runId ?? null,
      responseTicket,
      expected: { targetId, blockerId, plannerId, runId },
    })}\n`);
  } else if (command === "make-escape-todo") {
    const escapeId = requiredId(process.argv[3], "make-escape-todo ticket id");
    const result = await pool.query(
      `UPDATE tickets SET status = 'todo', updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'backlog' RETURNING id::text`,
      [escapeId],
    );
    if (result.rowCount !== 1) throw new Error("escape ticket was not the expected backlog ticket");
    process.stdout.write(`${JSON.stringify({ ticketId: escapeId, status: "todo" })}\n`);
  } else if (command === "bound-proof") {
    const runId = requiredId(process.argv[3], "bound-proof run id");
    const targetId = requiredId(process.argv[4], "bound-proof target id");
    const escapeId = requiredId(process.argv[5], "bound-proof escape id");
    const target = await ticketDependencies(pool, targetId);
    const escape = await ticketDependencies(pool, escapeId);
    const invocation = await pool.query(
      `SELECT count(*)::int AS count
       FROM agent_tool_invocations
       WHERE run_id = $1 AND idempotency_key = 'fact49-bound-target'`,
      [runId],
    );
    const attributionInvocation = await pool.query(
      `SELECT count(*)::int AS count
       FROM agent_tool_invocations
       WHERE run_id = $1 AND idempotency_key = 'fact49-bound-attribution'`,
      [runId],
    );
    process.stdout.write(`${JSON.stringify({
      target,
      escape,
      boundInvocationCount: invocation.rows[0].count,
      attributionInvocationCount: attributionInvocation.rows[0].count,
    })}\n`);
  } else if (command === "release") {
    const phase = process.argv[3];
    if (!/^(planner|bound)$/.test(phase ?? "")) throw new Error("release requires planner or bound");
    await writeFile(
      `/var/lib/orbitflow/runtime/state/fact49-${phase}-release`,
      "released\n",
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({ released: phase })}\n`);
  } else {
    throw new Error("unknown FACT-49 Compose fixture command");
  }
} finally {
  await pool.end();
}

function requiredId(value, field) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) throw new Error(`${field} must be a positive integer`);
  return value;
}

async function ticketDependencies(database, ticketId) {
  const result = await database.query(
    `SELECT ticket.id::text AS id, ticket.status::text AS status,
            COALESCE(array_agg(dependency.blocker_ticket_id::text ORDER BY dependency.blocker_ticket_id)
              FILTER (WHERE dependency.blocker_ticket_id IS NOT NULL), '{}') AS "blockerTicketIds"
     FROM tickets AS ticket
     LEFT JOIN dependencies AS dependency ON dependency.blocked_ticket_id = ticket.id
     WHERE ticket.id = $1
     GROUP BY ticket.id`,
    [ticketId],
  );
  if (!result.rows[0]) throw new Error(`ticket ${ticketId} not found`);
  return result.rows[0];
}
