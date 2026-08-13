import pg from "pg";
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
  } else {
    throw new Error("usage: fact-34-compose-fixture.mjs <seed|deliver|answer|snapshot>");
  }
} finally {
  await pool.end();
}
