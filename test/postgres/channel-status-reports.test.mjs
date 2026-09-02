import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { consumeNextMessage, insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  routeWorkflowMessage,
  createWorkflowRun,
  dispatchNextWorkflowNode,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import { enqueueChannelCompletionEvent } from "../../src/lib/channel-reporting.ts";
import {
  deliverNextTelegramOutbound,
  ingestTelegramInbound,
} from "../../src/lib/telegram/adapter.ts";

const { Client, Pool } = pg;
const migrationDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const migrationFile = /^\d{4}-[a-z0-9-]+\.sql$/;

async function committedMigrationFiles() {
  return (await readdir(migrationDirectory)).filter((name) => migrationFile.test(name)).sort();
}

class FakeRuntime {
  calls = [];

  async startSession(request) {
    this.calls.push(request);
    return { kind: "started", sessionId: `fact17-${request.dispatchId}` };
  }

  async reconcileSession() {
    return { kind: "absent" };
  }
}

test("FACT-17 durable Telegram status and final reports", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  let pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT17_PROOF_DATABASE);
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(migration.applied, await committedMigrationFiles());

    await client.query("UPDATE agents SET channel_binding = NULL");
    const orchestrator = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model, channel_binding)
       VALUES ('FACT-17 orchestrator', 'orchestrator', 'proof', 'mock/orchestrator',
               '{"provider":"telegram","workflow":"FACT-17 workflow"}'::jsonb)
       RETURNING id`,
    );
    const planner = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-17 planner', 'planner', 'proof', 'mock/planner') RETURNING id`,
    );
    const workflow = await client.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('FACT-17 workflow', 'status report proof', $1) RETURNING id`,
      [{
        nodes: [
          { id: "orchestrator", agentId: orchestrator.rows[0].id, config: { entry: true, channelBinding: true } },
          { id: "planner", agentId: planner.rows[0].id, config: {} },
        ],
        edges: [{ source: "orchestrator", target: "planner", condition: { operator: "always" } }],
      }],
    );

    async function consumeThrough(messageId, consumerId) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const consumed = await consumeNextMessage(pool, routeWorkflowMessage, { consumerId });
        if (consumed?.message.id === messageId) return consumed;
      }
      assert.fail(`message ${messageId} was not consumed`);
    }

    async function dispatch(runId, nodeId) {
      const result = await client.query(
        `SELECT * FROM workflow_dispatches
         WHERE run_id = $1 AND node_id = $2 ORDER BY id DESC LIMIT 1`,
        [runId, nodeId],
      );
      assert.ok(result.rows[0], `missing ${nodeId} dispatch`);
      return result.rows[0];
    }

    async function publishOutput(row, output, handoffBrief, consumerId) {
      const message = await insertMessage(pool, {
        runId: row.run_id,
        ticketId: row.ticket_id,
        sender: `agent:${row.agent_id}`,
        recipient: "workflow-engine",
        type: "output",
        payload: {
          dispatchId: row.id,
          dispatchGeneration: row.runtime_generation,
          sessionId: row.runtime_session_id,
          output,
        },
        handoffBrief,
        tokenUsage: { input: 3, output: 5, total: 8, cost: 0.25 },
      });
      await consumeThrough(message.id, consumerId);
      return message;
    }

    await test("grounds a mid-run status request in PostgreSQL and records both bus messages", async () => {
      const first = await ingestTelegramInbound(pool, {
        updateId: 1701,
        messageId: 2701,
        chat: { id: -7171, type: "supergroup" },
        text: "Build a dashboard for releases.",
      });
      assert.equal(first.kind, "accepted");
      await consumeThrough(first.messageId, "fact17-main");

      const runtime = new FakeRuntime();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact17-orchestrator" });
      await publishOutput(await dispatch(first.runId, "orchestrator"), {
        artifact: { intake: { status: "ready", spec: {
          objective: "Build a release dashboard",
          acceptanceCriteria: ["Shows release state"],
          constraints: [],
        } } },
      }, "Validated release dashboard request.", "fact17-main");
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact17-planner" });

      const project = await client.query(
        "INSERT INTO projects (key, name) VALUES ('FSE', 'FACT-17 evidence') RETURNING id",
      );
      await client.query(
        `INSERT INTO tickets (number, identifier, project_id, run_id, title, status)
         VALUES (1, 'FSE-1', $1, $2, 'Persist proof', 'in_progress')`,
        [project.rows[0].id, first.runId],
      );
      await client.query(
        `INSERT INTO cost_events (run_id, agent_id, model, tokens_in, tokens_out, computed_cost)
         VALUES ($1, $2, 'mock/planner', 7, 11, 1.25)`,
        [first.runId, planner.rows[0].id],
      );
      await client.query(
        "UPDATE workflow_runs SET total_tokens = 18, total_cost = 1.25 WHERE id = $1",
        [first.runId],
      );

      const status = await ingestTelegramInbound(pool, {
        updateId: 1702,
        messageId: 2702,
        chat: { id: -7171, type: "supergroup" },
        text: "How's it going? We already shipped the imaginary moon feature.",
      });
      assert.equal(status.kind, "accepted");
      assert.equal(status.runId, first.runId, "an active channel run owns the status request");
      const request = await client.query("SELECT payload FROM messages WHERE id = $1", [status.messageId]);
      assert.equal(request.rows[0].payload.channelRequest, "status");
      await consumeThrough(status.messageId, "fact17-main");

      const response = await client.query(
        `SELECT id, payload, sender, recipient, type FROM messages
         WHERE run_id = $1 AND type = 'channel_outbound' AND handoff_brief LIKE 'Status for%'`,
        [first.runId],
      );
      assert.equal(response.rowCount, 1);
      assert.equal(response.rows[0].sender, `agent:${orchestrator.rows[0].id}`);
      assert.equal(response.rows[0].recipient, "telegram:chat:-7171");
      assert.match(response.rows[0].payload.text, /1 in_progress/);
      assert.match(response.rows[0].payload.text, /1 active/);
      assert.match(response.rows[0].payload.text, /\$1\.25 across 18 tokens/);
      assert.doesNotMatch(response.rows[0].payload.text, /imaginary moon/i, "conversation text cannot fabricate report state");
      assert.doesNotMatch(response.rows[0].payload.text, /shipped/i, "only retained database state is reported");

      await publishOutput(await dispatch(first.runId, "planner"), {
        artifact: { report: "Release dashboard plan retained." },
      }, "Release dashboard plan retained.", "fact17-main");
      const completed = await client.query("SELECT status FROM workflow_runs WHERE id = $1", [first.runId]);
      assert.equal(completed.rows[0].status, "completed");
      const completion = await client.query(
        `SELECT event.completion_message_id, message.recipient, message.type, message.payload
         FROM channel_completion_events AS event
         JOIN messages AS message ON message.id = event.completion_message_id
         WHERE event.run_id = $1`,
        [first.runId],
      );
      assert.equal(completion.rowCount, 1, "one terminal observation creates one durable wake");
      assert.equal(completion.rows[0].recipient, `agent:${orchestrator.rows[0].id}`);
      assert.equal(completion.rows[0].type, "system");
      assert.equal(completion.rows[0].payload.kind, "channel_run_completed");

      await pool.end();
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const observer = await pool.connect();
      try {
        await observer.query("BEGIN");
        await enqueueChannelCompletionEvent(observer, first.runId);
        await observer.query("COMMIT");
      } catch (error) {
        await observer.query("ROLLBACK");
        throw error;
      } finally {
        observer.release();
      }
      await consumeThrough(completion.rows[0].completion_message_id, "fact17-after-restart");
      const final = await client.query(
        `SELECT message.payload
         FROM channel_completion_events AS event
         JOIN messages AS message ON message.id = event.final_outbound_message_id
         WHERE event.run_id = $1`,
        [first.runId],
      );
      assert.equal(final.rowCount, 1, "restart and duplicate consumption keep one logical final report");
      assert.match(final.rows[0].payload.text, /^Final report for FACT-17 workflow run #/);
      assert.match(final.rows[0].payload.text, /Release dashboard plan retained/);

      const sent = [];
      while (await deliverNextTelegramOutbound(pool, {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text });
          return { messageId: 9000 + sent.length };
        },
      })) {}
      assert.equal(sent.filter((item) => item.text.startsWith("Final report")).length, 1);
      assert.deepEqual(sent.map((item) => item.chatId), ["-7171", "-7171"], "both replies route to the originating chat");
    });

    await test("does not create a completion report for a non-channel run", async () => {
      const run = await createWorkflowRun(pool, {
        workflowId: workflow.rows[0].id,
        triggerType: "ui",
        spec: { objective: "UI-only proof" },
      });
      await startWorkflowRun(pool, run.id);
      const runtime = new FakeRuntime();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact17-ui-orchestrator" });
      await publishOutput(await dispatch(run.id, "orchestrator"), { accepted: true }, "UI orchestrator result.", "fact17-ui");
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact17-ui-planner" });
      await publishOutput(await dispatch(run.id, "planner"), { accepted: true }, "UI planner result.", "fact17-ui");
      const events = await client.query("SELECT count(*)::int AS count FROM channel_completion_events WHERE run_id = $1", [run.id]);
      assert.equal(events.rows[0].count, 0);
    });
  } finally {
    await pool.end();
    await client.end();
  }
});
