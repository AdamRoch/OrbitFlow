import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
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
         (SELECT failure_reason FROM workflow_runs ORDER BY id DESC LIMIT 1) AS run_failure,
         (SELECT count(*)::int FROM workflow_questions) AS questions,
         (SELECT count(*)::int FROM workflow_questions WHERE status = 'pending') AS pending_questions,
         (SELECT count(*)::int FROM workflow_questions WHERE status = 'answered') AS answered_questions,
         (SELECT count(*)::int FROM workflow_dispatches) AS dispatches,
         (SELECT count(*)::int FROM workflow_dispatches WHERE status = 'dispatching') AS dispatching_dispatches,
         (SELECT count(*)::int FROM workflow_dispatches WHERE status = 'completed') AS completed_dispatches,
         (SELECT failure_reason FROM workflow_dispatches ORDER BY id DESC LIMIT 1) AS dispatch_failure,
         (SELECT count(*)::int FROM openclaw_dispatch_inputs) AS openclaw_inputs,
         (SELECT count(*)::int FROM messages WHERE type = 'question') AS question_messages,
         (SELECT count(*)::int FROM messages WHERE type = 'answer') AS answer_messages,
         (SELECT count(*)::int FROM messages WHERE type = 'channel_outbound') AS outbound_messages,
         (SELECT count(*)::int FROM messages WHERE sender = 'runtime:openclaw'
            AND payload->>'kind' = 'openclaw_invocation_result') AS invocations,
         (SELECT count(*)::int FROM message_enqueues) AS pending_messages`,
    );
    process.stdout.write(`${JSON.stringify(result.rows[0])}\n`);
  } else if (command === "tool-proof") {
    const invocations = await pool.query(
      `SELECT idempotency_key
       FROM agent_tool_invocations
       WHERE idempotency_key LIKE 'fact34-%'
       ORDER BY idempotency_key`,
    );
    const costs = await pool.query(
      `SELECT run_id::text AS "runId", agent_id::text AS "agentId", model,
              tokens_in::text AS "tokensIn", tokens_out::text AS "tokensOut",
              computed_cost::text AS cost
       FROM cost_events
       WHERE model = 'proof/isolation-model'
       ORDER BY id`,
    );
    process.stdout.write(`${JSON.stringify({
      keys: invocations.rows.map((row) => row.idempotency_key),
      codingCosts: costs.rows,
    })}\n`);
  } else if (command === "tamper-tool-context") {
    const agentId = process.argv[3];
    const replacementRunId = process.argv[4];
    if (!/^[1-9][0-9]*$/.test(agentId ?? "") || !/^[1-9][0-9]*$/.test(replacementRunId ?? "")) {
      throw new Error("tamper-tool-context requires agent and replacement run ids");
    }
    const target = `/var/lib/orbitflow/runtime/workspaces/orbitflow-${agentId}/.orbitflow-tool-context.json`;
    const context = JSON.parse(await readFile(target, "utf8"));
    await writeFile(target, `${JSON.stringify({ ...context, runId: replacementRunId })}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ tampered: true })}\n`);
  } else if (command === "release-tool-proof") {
    await writeFile(
      "/var/lib/orbitflow/runtime/state/fact34-tool-proof-release",
      "released\n",
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({ released: true })}\n`);
  } else if (command === "seed-aux") {
    const label = process.argv[3];
    if (!/^(tamper|quarantine|cancel)$/.test(label ?? "")) {
      throw new Error("seed-aux requires tamper, quarantine, or cancel");
    }
    const project = await pool.query(
      "INSERT INTO projects (key, name) VALUES ($1, $2) RETURNING id::text",
      [`AUX${label.slice(0, 3).toUpperCase()}`, `FACT-34 ${label} proof`],
    );
    const agent = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ($1, 'implementer', $2, 'openrouter/openai/gpt-4.1-mini')
       RETURNING id::text`,
      [`FACT-34 ${label} worker`, `Hold the ${label} production-boundary proof.`],
    );
    const graph = {
      nodes: [{ id: label, agentId: agent.rows[0].id, config: { entry: true } }],
      edges: [],
    };
    const workflow = await pool.query(
      "INSERT INTO workflows (name, description, graph) VALUES ($1, $2, $3) RETURNING id::text",
      [`FACT-34 ${label} workflow`, `${label} broker/executor proof`, graph],
    );
    const run = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: { objective: `Prove ${label} at the production coding boundary` },
    });
    await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (1, $1, $2, $3, $4, $5, $6, 'todo', 3)`,
      [
        `${label.slice(0, 3).toUpperCase()}-1`,
        project.rows[0].id,
        run.id,
        `Prove ${label}`,
        `Exercise ${label} through the production broker and executor.`,
        `The ${label} boundary fails closed without attributed usage.`,
      ],
    );
    await startWorkflowRun(pool, run.id);
    process.stdout.write(`${JSON.stringify({ runId: run.id, agentId: agent.rows[0].id })}\n`);
  } else if (command === "aux-snapshot") {
    const runId = process.argv[3];
    if (!/^[1-9][0-9]*$/.test(runId ?? "")) throw new Error("aux-snapshot requires a run id");
    const result = await pool.query(
      `SELECT run.status::text AS "runStatus",
              dispatch.status::text AS "dispatchStatus",
              dispatch.lease_expires_at > clock_timestamp() AS "leaseActive",
              (SELECT count(*)::int FROM openclaw_dispatch_inputs WHERE dispatch_id = dispatch.id) AS "wakeInputs",
              (SELECT count(*)::int FROM cost_events WHERE run_id = run.id) AS "costEvents"
       FROM workflow_runs AS run
       LEFT JOIN LATERAL (
         SELECT * FROM workflow_dispatches WHERE run_id = run.id ORDER BY id DESC LIMIT 1
       ) AS dispatch ON true
       WHERE run.id = $1`,
      [runId],
    );
    process.stdout.write(`${JSON.stringify(result.rows[0] ?? null)}\n`);
  } else if (command === "release-aux") {
    const label = process.argv[3];
    if (!/^(tamper|quarantine|cancel)$/.test(label ?? "")) {
      throw new Error("release-aux requires tamper, quarantine, or cancel");
    }
    await writeFile(
      `/var/lib/orbitflow/runtime/state/fact34-${label}-release`,
      "released\n",
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify({ released: label })}\n`);
  } else if (command === "expire-aux-lease") {
    const runId = process.argv[3];
    if (!/^[1-9][0-9]*$/.test(runId ?? "")) throw new Error("expire-aux-lease requires a run id");
    const result = await pool.query(
      `UPDATE workflow_dispatches
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE run_id = $1 AND status = 'dispatching'
       RETURNING id::text`,
      [runId],
    );
    if (result.rowCount !== 1) throw new Error("expected one active auxiliary dispatch");
    process.stdout.write(`${JSON.stringify({ expiredDispatchId: result.rows[0].id })}\n`);
  } else if (command === "aux-workspace-proof") {
    const runId = process.argv[3];
    if (!/^[1-9][0-9]*$/.test(runId ?? "")) throw new Error("aux-workspace-proof requires a run id");
    const costs = await pool.query(
      "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1 AND model = 'proof/isolation-model'",
      [runId],
    );
    let record = null;
    try {
      record = JSON.parse(await readFile(
        `/var/lib/orbitflow/run-workspaces/.orbitflow/run-${runId}.json`,
        "utf8",
      ));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    process.stdout.write(`${JSON.stringify({ costEvents: costs.rows[0].count, record })}\n`);
  } else {
    throw new Error("unknown FACT-34 Compose fixture command");
  }
} finally {
  await pool.end();
}
