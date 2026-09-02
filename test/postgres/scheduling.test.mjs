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
  processDueSchedules,
  publishScheduleTick,
  triggerScheduleManually,
} from "../../src/lib/postgres/scheduling.ts";
import { deliverNextTelegramOutbound } from "../../src/lib/telegram/adapter.ts";

const { Client, Pool } = pg;
const migrationDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

class FakeRuntime {
  calls = [];
  async startSession(request) {
    this.calls.push(request);
    return { kind: "started", sessionId: `schedule-${request.dispatchId}` };
  }
  async reconcileSession() { return { kind: "absent" }; }
}

test("FACT-25 PostgreSQL scheduling", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();
  try {
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, process.env.ORBITFACTORY_FACT25_PROOF_DATABASE);
    const applied = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(applied.applied, (await readdir(migrationDirectory)).filter((file) => /^\d{4}-[a-z0-9-]+\.sql$/.test(file)).sort());

    const agent = await client.query(
      "INSERT INTO agents (name, role, system_prompt, model) VALUES ('FACT-25 agent', 'orchestrator', 'proof', 'mock/schedule') RETURNING id",
    );
    const workflow = await client.query(
      `INSERT INTO workflows (name, description, graph) VALUES
       ('FACT-25 workflow', 'proof', $1) RETURNING id`,
      [{ nodes: [{ id: "entry", agentId: agent.rows[0].id, config: { entry: true } }], edges: [] }],
    );
    const workflowSchedule = await client.query(
      "INSERT INTO schedules (cron_expression, workflow_id) VALUES ('0 9 * * 1-5', $1) RETURNING id",
      [workflow.rows[0].id],
    );
    const agentSchedule = await client.query(
      "INSERT INTO schedules (cron_expression, agent_id, task_prompt) VALUES ('0 9 * * 1-5', $1, 'Prepare the engineering standup.') RETURNING id",
      [agent.rows[0].id],
    );
    const at = new Date("2026-08-11T09:00:00.000Z");
    async function consumeThrough(messageId, consumerId) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const consumed = await consumeNextMessage(pool, routeWorkflowMessage, { consumerId });
        if (consumed?.message.id === messageId) return;
      }
      assert.fail(`did not consume scheduled message ${messageId}`);
    }
    async function dispatchThrough(runId, runtime, workerId) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const dispatched = await dispatchNextWorkflowNode(pool, runtime, { workerId });
        if (dispatched?.runId === runId) return;
      }
      assert.fail(`did not dispatch scheduled run ${runId}`);
    }

    await test("clock ticks are retained before a workflow-target dispatch and disabled rows stop without restart", async () => {
      const due = await processDueSchedules(pool, at);
      const tick = due.find((item) => item.kind === "created" && item.scheduleId === workflowSchedule.rows[0].id);
      assert.ok(tick && tick.kind === "created");
      const message = await client.query("SELECT type, sender, recipient, payload FROM messages WHERE id = $1", [tick.messageId]);
      assert.deepEqual(message.rows[0], {
        type: "cron_tick", sender: "system:scheduler", recipient: "system:workflow-engine",
        payload: { scheduleId: workflowSchedule.rows[0].id, tickKey: "2026-08-11T09:00Z", source: "clock", target: "workflow", at: at.toISOString() },
      });
      await consumeThrough(tick.messageId, "fact25-workflow");
      assert.equal((await client.query("SELECT status FROM workflow_runs WHERE id = $1", [tick.runId])).rows[0].status, "running");
      await client.query("UPDATE schedules SET enabled = false WHERE id = $1", [workflowSchedule.rows[0].id]);
      assert.equal((await processDueSchedules(pool, new Date("2026-08-12T09:00:00.000Z"))).some((item) => item.scheduleId === workflowSchedule.rows[0].id), false);
    });

    await test("agent target, manual trigger, and restart duplicate use the same durable tick path", async () => {
      const manual = await triggerScheduleManually(pool, agentSchedule.rows[0].id, "demo-1", at);
      assert.equal(manual.kind, "created");
      const replay = await triggerScheduleManually(pool, agentSchedule.rows[0].id, "demo-1", at);
      assert.deepEqual(replay, { ...manual, kind: "duplicate" });
      await consumeThrough(manual.messageId, "fact25-agent");
      const runtime = new FakeRuntime();
      await dispatchThrough(manual.runId, runtime, "fact25-agent");
      const wake = runtime.calls.find((call) => call.runId === manual.runId);
      assert.ok(wake);
      assert.equal(wake.input.runSpec.schedule.standingTask, "Prepare the engineering standup.");
      assert.equal(wake.input.runSpec.schedule.source, "manual");
      const clock = await publishScheduleTick(pool, { scheduleId: agentSchedule.rows[0].id, tickKey: "restart-safe", at, source: "clock" });
      const afterRestart = await publishScheduleTick(pool, { scheduleId: agentSchedule.rows[0].id, tickKey: "restart-safe", at, source: "clock" });
      assert.equal(clock.kind, "created");
      assert.deepEqual(afterRestart, { ...clock, kind: "duplicate" });
      assert.equal((await client.query("SELECT count(*)::int AS count FROM schedule_ticks WHERE schedule_id = $1 AND tick_key = 'restart-safe'", [agentSchedule.rows[0].id])).rows[0].count, 1);
    });

    await test("seeded daily standup receives ticket movement and spend then routes through Telegram outbound", async () => {
      const seeded = await client.query("SELECT * FROM schedules WHERE task_prompt LIKE 'Daily standup:%'");
      assert.equal(seeded.rowCount, 1);
      await client.query(
        "UPDATE agents SET channel_binding = '{\"provider\":\"telegram\",\"chatId\":\"9001\"}' WHERE id = $1",
        [seeded.rows[0].agent_id],
      );
      const contextRun = await client.query("INSERT INTO workflow_runs (workflow_id, trigger_type, spec, workflow_version) VALUES ($1, 'ui', '{}'::jsonb, now()) RETURNING id", [workflow.rows[0].id]);
      await insertMessage(pool, {
        runId: contextRun.rows[0].id, sender: "telegram:chat:9001", recipient: "agent:1", type: "channel_inbound",
        payload: { provider: "telegram", updateId: "1", messageId: "1", chat: { id: "9001", type: "private" }, text: "hello" }, handoffBrief: "hello",
      });
      const project = await client.query("INSERT INTO projects (key, name) VALUES ('SCH', 'Scheduling') RETURNING id");
      await client.query("INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority) VALUES (1, 'SCH-1', $1, $2, 'Moved ticket', 'in_progress', 1)", [project.rows[0].id, contextRun.rows[0].id]);
      await client.query("INSERT INTO cost_events (run_id, agent_id, model, tokens_in, tokens_out, computed_cost) VALUES ($1, $2, 'mock', 1, 1, 2.50)", [contextRun.rows[0].id, agent.rows[0].id]);
      const tick = await triggerScheduleManually(pool, seeded.rows[0].id, "standup-demo", at);
      assert.equal(tick.kind, "created");
      await consumeThrough(tick.messageId, "fact25-standup");
      const run = await client.query("SELECT spec FROM workflow_runs WHERE id = $1", [tick.runId]);
      assert.equal(run.rows[0].spec.standup.ticketMovement.updatedTickets, "1");
      assert.equal(run.rows[0].spec.standup.spend.totalCost, "2.50000000");
      const runtime = new FakeRuntime();
      await dispatchThrough(tick.runId, runtime, "fact25-standup");
      const dispatch = await client.query("SELECT * FROM workflow_dispatches WHERE run_id = $1", [tick.runId]);
      const outputMessage = await insertMessage(pool, {
        runId: tick.runId, sender: `agent:${dispatch.rows[0].agent_id}`, recipient: "workflow-engine", type: "output",
        payload: { dispatchId: dispatch.rows[0].id, dispatchGeneration: dispatch.rows[0].runtime_generation, sessionId: dispatch.rows[0].runtime_session_id, output: { summary: "Two tickets moved; spend is $2.50." } },
        handoffBrief: "Two tickets moved; spend is $2.50.",
      });
      await consumeThrough(outputMessage.id, "fact25-standup");
      const outbound = await client.query("SELECT payload FROM messages WHERE run_id = $1 AND type = 'channel_outbound'", [tick.runId]);
      assert.deepEqual(outbound.rows[0].payload, { provider: "telegram", chatId: "9001", text: "Two tickets moved; spend is $2.50." });
      const sent = [];
      assert.equal(await deliverNextTelegramOutbound(pool, { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { messageId: 99 }; } }), true);
      assert.deepEqual(sent, [{ chatId: "9001", text: "Two tickets moved; spend is $2.50." }]);
    });
  } finally {
    await pool.end();
    await client.end();
  }
});
