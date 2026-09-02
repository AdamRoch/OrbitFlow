import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { consumeNextMessage, insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  routeWorkflowMessage,
  dispatchNextWorkflowNode,
} from "../../src/lib/postgres/workflow-engine.ts";
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
    return { kind: "started", sessionId: `fake-telegram-${request.dispatchId}` };
  }

  async reconcileSession() {
    return { kind: "absent" };
  }
}

test("FACT-15 Telegram adapter", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  await client.connect();

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT15_PROOF_DATABASE);
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(migration.applied, await committedMigrationFiles());

    // The shipped template owns the production binding. This fixture replaces
    // it with one isolated target so every assertion names its exact workflow.
    await client.query("UPDATE agents SET channel_binding = NULL WHERE name = 'Factory Orchestrator'");

    const agent = await client.query(
      `INSERT INTO agents (
         name, role, system_prompt, model, channel_binding
       ) VALUES (
         'Telegram proof orchestrator', 'orchestrator', 'proof prompt', 'mock/telegram',
         '{"provider":"telegram","workflow":"Telegram proof workflow"}'::jsonb
       ) RETURNING id`,
    );
    const graph = {
      nodes: [{
        id: "orchestrator",
        agentId: agent.rows[0].id,
        config: { entry: true, channelBinding: true },
      }],
      edges: [],
    };
    const workflow = await client.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('Telegram proof workflow', 'FACT-15 proof', $1)
       RETURNING id`,
      [graph],
    );

    await test("persists a text update, deduplicates it, and wakes the entry agent through the engine", async () => {
      const inbound = {
        updateId: 101,
        messageId: 501,
        chat: { id: -1009001, type: "supergroup", username: "ada" },
        from: { id: 42, username: "adam", firstName: "Adam" },
        text: "Build a useful thing",
      };
      const accepted = await ingestTelegramInbound(pool, inbound);
      assert.equal(accepted.kind, "accepted");
      const duplicate = await ingestTelegramInbound(pool, inbound);
      assert.deepEqual(duplicate, { kind: "duplicate", runId: accepted.runId, messageId: accepted.messageId });

      const message = await client.query(
        "SELECT sender, recipient, type, payload, handoff_brief FROM messages WHERE id = $1",
        [accepted.messageId],
      );
      assert.deepEqual(message.rows[0], {
        sender: "telegram:chat:-1009001",
        recipient: `agent:${agent.rows[0].id}`,
        type: "channel_inbound",
        payload: {
          provider: "telegram",
          updateId: "101",
          messageId: "501",
          chat: { id: "-1009001", type: "supergroup", username: "ada" },
          from: { id: "42", username: "adam", firstName: "Adam" },
          text: "Build a useful thing",
        },
        handoff_brief: "Build a useful thing",
      });
      const run = await client.query("SELECT status, trigger_type FROM workflow_runs WHERE id = $1", [accepted.runId]);
      assert.deepEqual(run.rows[0], { status: "pending", trigger_type: "channel" });

      const consumed = await consumeNextMessage(pool, routeWorkflowMessage, { consumerId: "fact15-inbound" });
      assert.equal(consumed?.message.id, accepted.messageId);
      const dispatch = await client.query(
        "SELECT status, source_message_id, input FROM workflow_dispatches WHERE run_id = $1",
        [accepted.runId],
      );
      assert.equal(dispatch.rowCount, 1);
      assert.equal(dispatch.rows[0].status, "pending");
      assert.equal(dispatch.rows[0].source_message_id, accepted.messageId);
      assert.deepEqual(dispatch.rows[0].input.upstream.output, message.rows[0].payload);

      const runtime = new FakeRuntime();
      const wake = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact15-wake" });
      assert.equal(wake?.runId, accepted.runId);
      assert.equal(runtime.calls.length, 1);
      assert.equal(runtime.calls[0].input.upstream.handoffBrief, "Build a useful thing");
    });

    await test("ignores unsupported and blank Telegram updates without creating a run or trail row", async () => {
      const before = await client.query("SELECT count(*)::integer AS count FROM messages");
      assert.deepEqual(await ingestTelegramInbound(pool, {
        updateId: 102,
        messageId: 502,
        chat: { id: 9001, type: "private" },
      }), { kind: "ignored" });
      assert.deepEqual(await ingestTelegramInbound(pool, {
        updateId: 103,
        messageId: 503,
        chat: { id: 9001, type: "private" },
        text: "   ",
      }), { kind: "ignored" });
      const after = await client.query("SELECT count(*)::integer AS count FROM messages");
      assert.deepEqual(after.rows[0], before.rows[0]);
    });

    await test("delivers a durable channel_outbound row to the recorded Telegram chat", async () => {
      const run = await client.query(
        `INSERT INTO workflow_runs (workflow_id, trigger_type, spec, workflow_version)
         VALUES ($1, 'ui', '{"objective":"outbound proof"}'::jsonb, now())
         RETURNING id`,
        [workflow.rows[0].id],
      );
      const outbound = await insertMessage(pool, {
        runId: run.rows[0].id,
        sender: `agent:${agent.rows[0].id}`,
        recipient: "telegram:chat:-1009001",
        type: "channel_outbound",
        payload: { provider: "telegram", chatId: "-1009001", text: "Your factory run is ready." },
      });
      const sent = [];
      const delivered = await deliverNextTelegramOutbound(pool, {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text });
          return { messageId: 7001 };
        },
      });
      assert.equal(delivered, true);
      assert.deepEqual(sent, [{ chatId: "-1009001", text: "Your factory run is ready." }]);
      const delivery = await client.query(
        "SELECT status, telegram_message_id FROM telegram_outbound_deliveries WHERE message_id = $1",
        [outbound.id],
      );
      assert.deepEqual(delivery.rows[0], { status: "sent", telegram_message_id: "7001" });
      assert.equal(await deliverNextTelegramOutbound(pool, { async sendMessage() { assert.fail("already delivered rows must not resend"); } }), false);
    });

    await test("ships OpenClaw with its Telegram consumer explicitly disabled", async () => {
      const config = await import("node:fs/promises").then(({ readFile }) =>
        readFile(new URL("../../docker/openclaw/openclaw.json", import.meta.url), "utf8"),
      );
      assert.equal(JSON.parse(config).channels.telegram.enabled, false);
    });
  } finally {
    await pool.end();
    await client.end();
  }
});
