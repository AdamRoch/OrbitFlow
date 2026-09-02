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
    return { kind: "started", sessionId: `fact16-${request.dispatchId}` };
  }

  async reconcileSession() {
    return { kind: "absent" };
  }
}

test("FACT-16 orchestrator channel intake", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  let pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT16_PROOF_DATABASE);
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(migration.applied, await committedMigrationFiles());

    await client.query("UPDATE agents SET channel_binding = NULL");
    const orchestrator = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model, channel_binding)
       VALUES (
         'FACT-16 orchestrator', 'orchestrator', 'Return the intake contract', 'mock/orchestrator',
         '{"provider":"telegram","workflow":"FACT-16 workflow"}'::jsonb
       ) RETURNING id`,
    );
    const planner = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-16 planner', 'planner', 'Plan the validated spec', 'mock/planner')
       RETURNING id`,
    );
    const workflow = await client.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('FACT-16 workflow', 'channel intake proof', $1)
       RETURNING id`,
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

    async function activeDispatch(runId, nodeId) {
      const result = await client.query(
        `SELECT * FROM workflow_dispatches
         WHERE run_id = $1 AND node_id = $2
         ORDER BY id DESC LIMIT 1`,
        [runId, nodeId],
      );
      assert.ok(result.rows[0], `missing ${nodeId} dispatch`);
      return result.rows[0];
    }

    async function publishIntake(dispatch, intake, consumerId) {
      const output = await insertMessage(pool, {
        runId: dispatch.run_id,
        sender: `agent:${dispatch.agent_id}`,
        recipient: "workflow-engine",
        type: "output",
        payload: {
          dispatchId: dispatch.id,
          dispatchGeneration: dispatch.runtime_generation,
          sessionId: dispatch.runtime_session_id,
          output: { artifact: { intake }, handoff_brief: "intake decision", events: [] },
        },
        handoffBrief: "intake decision",
      });
      await consumeThrough(output.id, consumerId);
      return output;
    }

    await test("direct sufficient intake validates one spec and advances through the normal engine", async () => {
      const inbound = {
        updateId: 1601,
        messageId: 2601,
        chat: { id: 3601, type: "private", username: "adam" },
        from: { id: 4601, username: "adam", firstName: "Adam" },
        text: "Build a status page that checks three HTTP endpoints and shows failures.",
      };
      const accepted = await ingestTelegramInbound(pool, inbound);
      assert.equal(accepted.kind, "accepted");
      assert.deepEqual(await ingestTelegramInbound(pool, inbound), {
        kind: "duplicate",
        runId: accepted.runId,
        messageId: accepted.messageId,
      });
      await consumeThrough(accepted.messageId, "fact16-direct");

      const runtime = new FakeRuntime();
      const orchestratorWake = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact16-direct-orchestrator" });
      assert.equal(orchestratorWake?.runId, accepted.runId);
      assert.equal(runtime.calls[0].nodeId, "orchestrator");
      await publishIntake(await activeDispatch(accepted.runId, "orchestrator"), {
        status: "ready",
        spec: {
          objective: "Build an HTTP endpoint status page",
          acceptanceCriteria: ["Display the current state of all three configured endpoints"],
          constraints: ["Use HTTP health checks"],
        },
      }, "fact16-direct");

      const run = await client.query(
        "SELECT trigger_type, status, spec FROM workflow_runs WHERE id = $1",
        [accepted.runId],
      );
      assert.equal(run.rows[0].trigger_type, "channel");
      assert.equal(run.rows[0].status, "running");
      assert.deepEqual(run.rows[0].spec, {
        schemaVersion: 1,
        objective: "Build an HTTP endpoint status page",
        acceptanceCriteria: ["Display the current state of all three configured endpoints"],
        constraints: ["Use HTTP health checks"],
        channelContext: {
          provider: "telegram",
          chat: { id: "3601", type: "private", username: "adam" },
          requestedBy: { id: "4601", username: "adam", firstName: "Adam" },
          inboundMessages: [{ messageId: "2601", updateId: "1601", text: inbound.text }],
        },
      });
      const runCount = await client.query(
        "SELECT count(*)::int AS count FROM workflow_runs WHERE trigger_type = 'channel' AND spec #>> '{channelContext,chat,id}' = '3601'",
      );
      assert.equal(runCount.rows[0].count, 1);

      const plannerDispatch = await activeDispatch(accepted.runId, "planner");
      assert.deepEqual(plannerDispatch.input.runSpec, run.rows[0].spec);
      const plannerWake = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact16-direct-planner" });
      assert.equal(plannerWake?.dispatchId, plannerDispatch.id);
      assert.equal(runtime.calls[1].nodeId, "planner");
    });

    await test("clarification is durable across restart and follow-up reuses the same run", async () => {
      const first = await ingestTelegramInbound(pool, {
        updateId: 1602,
        messageId: 2602,
        chat: { id: 3602, type: "private" },
        from: { id: 4602, firstName: "Adam" },
        text: "Build me an app",
      });
      assert.equal(first.kind, "accepted");
      await consumeThrough(first.messageId, "fact16-clarify");
      const runtime = new FakeRuntime();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact16-clarify-one" });
      await publishIntake(await activeDispatch(first.runId, "orchestrator"), {
        status: "needs_clarification",
        question: "What should the app let its users accomplish?",
      }, "fact16-clarify");

      const waiting = await client.query(
        "SELECT status, last_question, clarification_count FROM channel_intakes WHERE run_id = $1",
        [first.runId],
      );
      assert.deepEqual(waiting.rows[0], {
        status: "collecting",
        last_question: "What should the app let its users accomplish?",
        clarification_count: 1,
      });
      const sent = [];
      assert.equal(await deliverNextTelegramOutbound(pool, {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text });
          return { messageId: 8602 };
        },
      }), true);
      assert.deepEqual(sent, [{ chatId: "3602", text: "What should the app let its users accomplish?" }]);

      await pool.end();
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      const followUpInput = {
        updateId: 1603,
        messageId: 2603,
        chat: { id: 3602, type: "private" },
        from: { id: 4602, firstName: "Adam" },
        text: "Track household chores and show which roommate completed each one.",
      };
      const followUp = await ingestTelegramInbound(pool, followUpInput);
      assert.equal(followUp.kind, "accepted");
      assert.equal(followUp.runId, first.runId);
      assert.deepEqual(await ingestTelegramInbound(pool, followUpInput), {
        kind: "duplicate",
        runId: first.runId,
        messageId: followUp.messageId,
      });
      await consumeThrough(followUp.messageId, "fact16-clarify");
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact16-clarify-two" });
      await publishIntake(await activeDispatch(first.runId, "orchestrator"), {
        status: "ready",
        spec: {
          objective: "Track household chores by roommate",
          acceptanceCriteria: ["Record who completed each chore", "Show chore completion history"],
          constraints: [],
        },
      }, "fact16-clarify");

      const final = await client.query(
        `SELECT run.trigger_type, run.spec, intake.status, intake.validated_spec
         FROM workflow_runs AS run
         JOIN channel_intakes AS intake ON intake.run_id = run.id
         WHERE run.id = $1`,
        [first.runId],
      );
      assert.equal(final.rows[0].trigger_type, "channel");
      assert.equal(final.rows[0].status, "ready");
      assert.deepEqual(final.rows[0].validated_spec, final.rows[0].spec);
      assert.equal(final.rows[0].spec.channelContext.inboundMessages.length, 2);
      const runCount = await client.query(
        "SELECT count(*)::int AS count FROM workflow_runs WHERE trigger_type = 'channel' AND spec #>> '{channelContext,chat,id}' = '3602'",
      );
      assert.equal(runCount.rows[0].count, 1);
      const plannerCount = await client.query(
        "SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND node_id = 'planner'",
        [first.runId],
      );
      assert.equal(plannerCount.rows[0].count, 1);
      const plannerWake = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact16-clarify-planner" });
      assert.equal(plannerWake?.nodeId, "planner");
    });

    await test("malformed ready specs fail closed before planner kickoff", async () => {
      const inbound = await ingestTelegramInbound(pool, {
        updateId: 1604,
        messageId: 2604,
        chat: { id: 3604, type: "private" },
        text: "Build a calendar",
      });
      assert.equal(inbound.kind, "accepted");
      await consumeThrough(inbound.messageId, "fact16-invalid");
      const runtime = new FakeRuntime();
      // Two contract violations get a corrective re-wake; the third fails the run.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await dispatchNextWorkflowNode(pool, runtime, { workerId: `fact16-invalid-${attempt}` });
        await publishIntake(await activeDispatch(inbound.runId, "orchestrator"), {
          status: "ready",
          spec: { objective: "Build a calendar", acceptanceCriteria: [], constraints: [] },
        }, `fact16-invalid-${attempt}`);
        const state = await client.query(
          `SELECT run.status, run.failure_reason, intake.correction_count
           FROM workflow_runs AS run JOIN channel_intakes AS intake ON intake.run_id = run.id
           WHERE run.id = $1`,
          [inbound.runId],
        );
        if (attempt < 3) {
          assert.equal(state.rows[0].status, "running", `correction ${attempt} re-wakes the orchestrator`);
          assert.equal(state.rows[0].correction_count, attempt);
        } else {
          assert.equal(state.rows[0].status, "failed");
          assert.match(state.rows[0].failure_reason, /acceptanceCriteria must be a non-empty array/);
        }
      }
      const planner = await client.query(
        "SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND node_id = 'planner'",
        [inbound.runId],
      );
      assert.equal(planner.rows[0].count, 0);
    });

    assert.equal(workflow.rowCount, 1);
  } finally {
    await pool.end();
    await client.end();
  }
});
