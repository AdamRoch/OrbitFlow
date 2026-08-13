import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import {
  createWorkflowRun,
  startWorkflowRun,
} from "../src/lib/postgres/workflow-engine.ts";
import { deliverNextTelegramOutbound, ingestTelegramInbound } from "../src/lib/telegram/adapter.ts";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, application_name: "fact34-compose-fixture" });
const command = process.argv[2];

try {
  if (command === "seed") {
    const project = await pool.query(
      "INSERT INTO projects (key, name) VALUES ('CMP', 'FACT-34 Compose proof') RETURNING id::text",
    );
    const agent = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-34 Compose Worker', 'implementer',
               'Ask the required question, then apply its answer.',
               'openrouter/openai/gpt-4.1-mini') RETURNING id::text`,
    );
    const otherAgent = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-34 Other Worker', 'implementer', 'Do not run.',
               'openrouter/openai/gpt-4.1-mini') RETURNING id::text`,
    );
    const graph = {
      nodes: [{
        id: "implement",
        agentId: agent.rows[0].id,
        config: { entry: true, fanOut: { over: "openTickets", maxConcurrency: 1 }, questionEscalation: { target: "human-via-channel" } },
      }],
      edges: [],
    };
    const workflow = await pool.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-34 Compose workflow', 'Production adapter question proof', $1) RETURNING id::text",
      [graph],
    );
    const otherRun = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: { objective: "Cross-run attribution rejection target" },
    });
    const run = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: {
        objective: "Prove restart-safe Telegram question correlation",
        channelContext: { provider: "telegram", chat: { id: "-1003499", type: "supergroup" } },
      },
    });
    await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (1, 'CMP-1', $1, $2, 'Apply the naming decision',
                 'Ask before choosing whitespace behavior.',
                 'Resume only this ticket after the correlated reply.', 'todo', 3)`,
      [project.rows[0].id, run.id],
    );
    await startWorkflowRun(pool, run.id);
    process.stdout.write(`${JSON.stringify({
      runId: run.id,
      agentId: agent.rows[0].id,
      projectId: project.rows[0].id,
      otherAgentId: otherAgent.rows[0].id,
      otherRunId: otherRun.id,
    })}\n`);
  } else if (command === "deliver") {
    let sent = null;
    const delivered = await deliverNextTelegramOutbound(pool, {
      async sendMessage(chatId, text) {
        sent = { chatId, text, telegramMessageId: 34991 };
        return { messageId: 34991 };
      },
    });
    process.stdout.write(`${JSON.stringify({ delivered, sent })}\n`);
  } else if (command === "answer") {
    const result = await ingestTelegramInbound(pool, {
      updateId: 34992,
      messageId: 34993,
      chat: { id: -1003499, type: "supergroup" },
      text: "Trim surrounding whitespace.",
      replyToMessageId: 34991,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "snapshot") {
    const result = await pool.query(
      `SELECT
         (SELECT status::text FROM workflow_runs ORDER BY id DESC LIMIT 1) AS run_status,
         (SELECT count(*)::int FROM workflow_questions) AS questions,
         (SELECT count(*)::int FROM workflow_questions WHERE status = 'pending') AS pending_questions,
         (SELECT count(*)::int FROM workflow_questions WHERE status = 'answered') AS answered_questions,
         (SELECT count(*)::int FROM workflow_dispatches) AS dispatches,
         (SELECT count(*)::int FROM workflow_dispatches WHERE status = 'completed') AS completed_dispatches,
         (SELECT count(*)::int FROM messages WHERE type = 'question') AS question_messages,
         (SELECT count(*)::int FROM messages WHERE type = 'answer') AS answer_messages,
         (SELECT count(*)::int FROM messages WHERE type = 'channel_outbound') AS outbound_messages,
         (SELECT count(*)::int FROM messages WHERE sender = 'runtime:openclaw'
            AND payload->>'kind' = 'openclaw_invocation_result') AS invocations,
         (SELECT count(*)::int FROM message_enqueues) AS pending_messages`,
    );
    process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
  } else if (command === "tool-proof") {
    const result = await pool.query(
      `SELECT idempotency_key
       FROM agent_tool_invocations
       WHERE idempotency_key LIKE 'fact34-%'
       ORDER BY idempotency_key`,
    );
    process.stdout.write(`${JSON.stringify({ keys: result.rows.map((row) => row.idempotency_key) })}\n`);
  } else if (command === "prepare-tool-proof") {
    const target = await pool.query(
      `SELECT dispatch.run_id::text, dispatch.agent_id::text, dispatch.ticket_id::text
       FROM workflow_dispatches AS dispatch
       JOIN agents AS agent ON agent.id = dispatch.agent_id
       WHERE agent.name = 'FACT-34 Compose Worker'
       ORDER BY dispatch.id
       LIMIT 1`,
    );
    if (target.rowCount !== 1) throw new Error("FACT-34 proof dispatch target is missing");
    const { run_id: runId, agent_id: agentId, ticket_id: ticketId } = target.rows[0];
    const inserted = await pool.query(
      `INSERT INTO workflow_dispatches (
         run_id, node_id, agent_id, agent_model, ticket_id, status, input,
         idempotency_key, attempt_count, lease_generation, runtime_generation,
         lease_owner, lease_expires_at, runtime_session_id
       ) VALUES ($1, 'tool-boundary-proof', $2, 'openrouter/openai/gpt-4.1-mini', $3,
                 'dispatching', '{}'::jsonb, 'fact34-tool-boundary-dispatch', 1, 1, 1,
                 'fact34-tool-boundary-proof', clock_timestamp() + interval '1 hour',
                 'fact34-tool-boundary-session')
       RETURNING id::text`,
      [runId, agentId, ticketId],
    );
    const dispatchId = inserted.rows[0].id;
    const workspace = `/var/lib/orbitflow/runtime/workspaces/orbitflow-${agentId}`;
    const context = {
      version: 1,
      agentId,
      dispatchGeneration: "1",
      dispatchId,
      dispatchSessionId: "fact34-tool-boundary-session",
      invocationId: "fact34-tool-boundary-invocation",
      nodeId: "tool-boundary-proof",
      runId,
      ticketId,
      workspace,
    };
    await pool.query(
      `INSERT INTO openclaw_dispatch_inputs (dispatch_id, runtime_generation, wake_input)
       VALUES ($1, 1, jsonb_build_object('toolContext', $2::jsonb))`,
      [dispatchId, context],
    );
    await mkdir(workspace, { recursive: true });
    await writeFile(`${workspace}/.orbitflow-tool-context.json`, `${JSON.stringify(context)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ dispatchId })}\n`);
  } else if (command === "cleanup-tool-proof") {
    await pool.query(
      `DELETE FROM openclaw_dispatch_inputs
       WHERE dispatch_id = (
         SELECT id FROM workflow_dispatches WHERE idempotency_key = 'fact34-tool-boundary-dispatch'
       )`,
    );
    await pool.query(
      "DELETE FROM workflow_dispatches WHERE idempotency_key = 'fact34-tool-boundary-dispatch'",
    );
    process.stdout.write(`${JSON.stringify({ cleaned: true })}\n`);
  } else {
    throw new Error("usage: fact-34-compose-fixture.mjs <seed|deliver|answer|snapshot|tool-proof|prepare-tool-proof|cleanup-tool-proof>");
  }
} finally {
  await pool.end();
}
