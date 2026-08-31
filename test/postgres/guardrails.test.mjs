import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  consumeNextWorkflowMessage,
  createWorkflowRun,
  dispatchNextWorkflowNode,
  getWorkflowRun,
  resumeWorkflowRun,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import {
  PlatformToolError,
  dispatchPlatformTool,
} from "../../src/lib/platform-tools/dispatch.ts";

const { Client, Pool } = pg;
pg.types.setTypeParser(1184, (value) => value);
const databaseUrl = process.env.DATABASE_URL;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class CountingRuntimeAdapter {
  constructor() {
    this.calls = [];
  }

  async startSession(request) {
    this.calls.push(request);
    return { kind: "started", sessionId: `guardrail-session-${this.calls.length}` };
  }

  async reconcileSession() {
    return { kind: "absent" };
  }
}

function callAgentTool(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/orbit-agent-tools.mjs", command, JSON.stringify(input)], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      try {
        resolve({ exitCode, stdout: JSON.parse(stdout), stderr });
      } catch (error) {
        reject(new Error(`agent tool did not return strict JSON: ${error.message}; stderr=${stderr}`));
      }
    });
  });
}

test("FACT-23 guardrails enforcement", async (t) => {
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT23_PROOF_DATABASE);

    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.ok(migration.applied.includes("0014-guardrail-wake-events.sql"));

    const project = await client.query(
      "INSERT INTO projects (key, name) VALUES ('GRAIL', 'FACT-23 proof') RETURNING id",
    );
    let sequence = 0;

    async function seedAgent(name, guardrails = {}) {
      const result = await client.query(
        `INSERT INTO agents (name, role, system_prompt, model, guardrails)
         VALUES ($1, 'guardrail proof', 'Follow the node contract.', 'mock/guardrail', $2)
         RETURNING id`,
        [name, JSON.stringify(guardrails)],
      );
      return result.rows[0].id;
    }

    async function createLoopRun(agentId, spec = {}) {
      sequence += 1;
      const workflow = await client.query(
        `INSERT INTO workflows (name, description, graph)
         VALUES ($1, 'FACT-23 proof workflow', $2)
         RETURNING id`,
        [
          `FACT-23 proof ${sequence}`,
          {
            nodes: [{ id: "work", agentId, config: { entry: true } }],
            edges: [
              { source: "work", target: "work", condition: { operator: "always" } },
            ],
          },
        ],
      );
      const run = await createWorkflowRun(pool, {
        workflowId: workflow.rows[0].id,
        triggerType: "ui",
        spec: { objective: `guardrail proof ${sequence}`, ...spec },
      });
      return startWorkflowRun(pool, run.id);
    }

    async function dispatchFor(runId) {
      const result = await client.query(
        `SELECT * FROM workflow_dispatches
         WHERE run_id = $1 AND node_id = 'work'
         ORDER BY id DESC LIMIT 1`,
        [runId],
      );
      assert.ok(result.rows[0], `missing work dispatch for run ${runId}`);
      return result.rows[0];
    }

    async function consumeThrough(messageId, consumerId = "fact23-proof") {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const consumed = await consumeNextWorkflowMessage(pool, { consumerId });
        if (consumed?.message.id === messageId) return consumed;
      }
      assert.fail(`message ${messageId} was not consumed`);
    }

    async function publishOutput(dispatch, usage = null) {
      const message = await insertMessage(pool, {
        runId: dispatch.run_id,
        ticketId: dispatch.ticket_id,
        sender: `agent:${dispatch.agent_id}`,
        recipient: "system:workflow-engine",
        type: "output",
        payload: {
          dispatchId: dispatch.id,
          dispatchGeneration: dispatch.runtime_generation,
          sessionId: dispatch.runtime_session_id,
          output: { artifact: "guardrail proof" },
        },
        handoffBrief: "guardrail proof step",
        tokenUsage: usage,
      });
      await consumeThrough(message.id);
      return message;
    }

    async function ceilingMessages(runId) {
      const result = await client.query(
        `SELECT payload FROM messages
         WHERE run_id = $1 AND type = 'system' AND sender = 'system:workflow-engine'
         ORDER BY sequence_number`,
        [runId],
      );
      return result.rows.map((row) => row.payload);
    }

    async function wake(runId, runtime, workerId = "fact23-worker") {
      const request = await dispatchNextWorkflowNode(pool, runtime, { workerId });
      if (request) assert.equal(request.runId, String(runId));
      return request;
    }

    await t.test("agent cost ceiling refuses the wake at the exact boundary and pauses visibly", async () => {
      const agentId = await seedAgent("ceiling-agent", { costLimit: 1.5 });
      const run = await createLoopRun(agentId);
      const runtime = new CountingRuntimeAdapter();

      await wake(run.id, runtime);
      await publishOutput(await dispatchFor(run.id), { input: 7, output: 3, total: 10, cost: 1.4 });
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 2, "spend 1.4 stays below the 1.5 ceiling");
      await publishOutput(await dispatchFor(run.id), { input: 3, output: 2, total: 5, cost: 0.1 });

      const refused = await wake(run.id, runtime);
      assert.equal(refused, null, "spend exactly at the ceiling refuses the wake");
      assert.equal(runtime.calls.length, 2, "the refused wake never reaches the runtime");

      const paused = await getWorkflowRun(pool, run.id);
      assert.equal(paused.status, "paused");
      const dispatch = await dispatchFor(run.id);
      assert.equal(dispatch.status, "pending", "the refused dispatch stays pending for resume");

      const messages = await ceilingMessages(run.id);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].code, "guardrail_cost_ceiling");
      assert.equal(messages[0].scope, "agent");
      assert.equal(messages[0].agentId, String(agentId));
      assert.equal(messages[0].dispatchId, String(dispatch.id));
      assert.equal(Number(messages[0].spend), 1.5);
      assert.equal(Number(messages[0].ceiling), 1.5);

      const resumed = await resumeWorkflowRun(pool, run.id);
      assert.equal(resumed.status, "running");
      assert.equal(await wake(run.id, runtime), null, "resume without headroom refuses again");
      assert.equal((await getWorkflowRun(pool, run.id)).status, "paused");
      assert.equal((await ceilingMessages(run.id)).length, 2, "each pause transition stays visible");

      await client.query(
        "UPDATE agents SET guardrails = $2 WHERE id = $1",
        [agentId, JSON.stringify({ costLimit: 2 })],
      );
      await resumeWorkflowRun(pool, run.id);
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 3, "raising the ceiling lets the run continue");
    });

    await t.test("run cost ceiling from the run spec halts the whole run", async () => {
      const agentId = await seedAgent("run-ceiling-agent");
      const run = await createLoopRun(agentId, { guardrails: { costLimit: 0.5 } });
      const runtime = new CountingRuntimeAdapter();

      await wake(run.id, runtime);
      await publishOutput(await dispatchFor(run.id), { input: 2, output: 1, total: 3, cost: 0.25 });
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 2, "run spend 0.25 stays below the 0.5 run ceiling");
      await publishOutput(await dispatchFor(run.id), { input: 2, output: 1, total: 3, cost: 0.25 });

      assert.equal(await wake(run.id, runtime), null);
      assert.equal(runtime.calls.length, 2);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "paused");
      const messages = await ceilingMessages(run.id);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].code, "guardrail_cost_ceiling");
      assert.equal(messages[0].scope, "run");
      assert.equal(Number(messages[0].spend), 0.5);
    });

    await t.test("unknown agent cost fails closed before provider wake", async () => {
      const agentId = await seedAgent("unknown-agent-cost", { costLimit: 5 });
      const run = await createLoopRun(agentId);
      const runtime = new CountingRuntimeAdapter();

      await wake(run.id, runtime);
      await publishOutput(await dispatchFor(run.id), { input: 1, output: 1, total: 2, cost: 1 });
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 2, "known-cost wakes proceed");

      await publishOutput(await dispatchFor(run.id), { input: 1, output: 1, total: 2, cost: 2 });
      await client.query(
        "UPDATE cost_events SET computed_cost = NULL WHERE run_id = $1 AND agent_id = $2",
        [run.id, agentId],
      );

      assert.equal(await wake(run.id, runtime), null, "unknown cost refuses the wake");
      assert.equal(runtime.calls.length, 2, "the refused wake never reaches the runtime");
      assert.equal((await getWorkflowRun(pool, run.id)).status, "paused");

      const messages = await ceilingMessages(run.id);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].code, "guardrail_unknown_cost");
      assert.equal(messages[0].scope, "agent");
      assert.equal(messages[0].agentId, String(agentId));
      assert.equal(Number(messages[0].ceiling), 5);

      await resumeWorkflowRun(pool, run.id);
      assert.equal(await wake(run.id, runtime), null, "resume without reconciliation refuses again");
      assert.equal((await ceilingMessages(run.id)).length, 2, "each pause transition gets its own message");

      await client.query(
        "UPDATE cost_events SET computed_cost = 0.5 WHERE computed_cost IS NULL AND run_id = $1 AND agent_id = $2",
        [run.id, agentId],
      );
      await resumeWorkflowRun(pool, run.id);
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 3, "reconciled unknown cost lets the run continue");
    });

    await t.test("unknown run cost fails closed before provider wake", async () => {
      const agentId = await seedAgent("unknown-run-cost-agent");
      const run = await createLoopRun(agentId, { guardrails: { costLimit: 10 } });
      const runtime = new CountingRuntimeAdapter();

      await wake(run.id, runtime);
      await publishOutput(await dispatchFor(run.id), { input: 5, output: 5, total: 10, cost: 3 });
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 2, "known-cost wakes proceed");

      await publishOutput(await dispatchFor(run.id), { input: 1, output: 1, total: 2, cost: 1 });
      await client.query(
        "UPDATE cost_events SET computed_cost = NULL WHERE run_id = $1",
        [run.id],
      );

      assert.equal(await wake(run.id, runtime), null, "unknown cost anywhere in the run refuses the wake");
      assert.equal(runtime.calls.length, 2);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "paused");

      const messages = await ceilingMessages(run.id);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].code, "guardrail_unknown_cost");
      assert.equal(messages[0].scope, "run");

      await client.query(
        "UPDATE cost_events SET computed_cost = 2.5 WHERE computed_cost IS NULL AND run_id = $1",
        [run.id],
      );
      await resumeWorkflowRun(pool, run.id);
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 3, "reconciled unknown cost lets the run continue under ceiling");
    });

    await t.test("rate limit throttles wakes per agent over the trailing window", async () => {
      const agentId = await seedAgent("throttled-agent", { rateLimit: { perMinute: 1 } });
      const run = await createLoopRun(agentId);
      const runtime = new CountingRuntimeAdapter();

      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 1);
      await publishOutput(await dispatchFor(run.id));

      assert.equal(await wake(run.id, runtime), null, "second wake inside the window is throttled");
      assert.equal(runtime.calls.length, 1, "a throttled wake never reaches the runtime");
      assert.equal((await getWorkflowRun(pool, run.id)).status, "running", "throttling is not a pause");
      assert.equal((await dispatchFor(run.id)).status, "pending");
      assert.equal((await ceilingMessages(run.id)).length, 0, "throttling stays silent");

      await client.query(
        `UPDATE agent_wake_events
         SET created_at = clock_timestamp() - interval '61 seconds'
         WHERE agent_id = $1`,
        [agentId],
      );
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 2, "the window slides and the wake proceeds");
    });

    await t.test("rate limit counts only wakes inside the window across runs", async () => {
      const agentId = await seedAgent("windowed-agent", { rateLimit: { perMinute: 2 } });
      const firstRun = await createLoopRun(agentId);
      const secondRun = await createLoopRun(agentId);
      const runtime = new CountingRuntimeAdapter();

      await wake(firstRun.id, runtime);
      await wake(secondRun.id, runtime);
      assert.equal(runtime.calls.length, 2, "wakes across runs share one per-agent budget");
      await publishOutput(await dispatchFor(firstRun.id));
      assert.equal(await wake(firstRun.id, runtime), null, "the third wake in the window is throttled");

      await client.query(
        `UPDATE agent_wake_events
         SET created_at = clock_timestamp() - interval '61 seconds'
         WHERE agent_id = $1 AND run_id = $2`,
        [agentId, firstRun.id],
      );
      await wake(firstRun.id, runtime);
      assert.equal(runtime.calls.length, 3, "one expired event frees one wake slot");

      await publishOutput(await dispatchFor(firstRun.id));
      assert.equal(
        await wake(firstRun.id, runtime),
        null,
        "the two newer wakes still fill the window",
      );
      await client.query(
        `UPDATE agent_wake_events
         SET created_at = clock_timestamp() - interval '61 seconds'
         WHERE agent_id = $1`,
        [agentId],
      );
      await wake(firstRun.id, runtime);
      assert.equal(runtime.calls.length, 4);
    });

    await t.test("malformed guardrails fail open without disturbing existing semantics", async () => {
      const agentId = await seedAgent("malformed-agent", {
        costLimit: "lots",
        rateLimit: "fast",
        blockedActions: "everything",
      });
      const run = await createLoopRun(agentId);
      const runtime = new CountingRuntimeAdapter();
      await wake(run.id, runtime);
      await publishOutput(await dispatchFor(run.id));
      await wake(run.id, runtime);
      assert.equal(runtime.calls.length, 2);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "running");
    });

    await t.test("a blocked action is rejected before mutation with durable idempotent logging", async () => {
      const blockedAgent = await seedAgent("blocked-agent", { blockedActions: ["create_ticket"] });
      const plainAgent = await seedAgent("plain-agent");
      const run = await createLoopRun(plainAgent);

      const before = await client.query(
        `SELECT next_number FROM projects WHERE id = $1`,
        [project.rows[0].id],
      );
      const input = {
        agentId: String(blockedAgent),
        runId: String(run.id),
        projectId: String(project.rows[0].id),
        title: "This ticket must never exist",
        idempotencyKey: "blocked-create-1",
      };
      await assert.rejects(
        () => dispatchPlatformTool(pool, "create_ticket", input),
        (error) => {
          assert.ok(error instanceof PlatformToolError);
          assert.equal(error.code, "action_blocked");
          return true;
        },
      );

      const after = await client.query(
        `SELECT (SELECT next_number FROM projects WHERE id = $1) AS next_number,
                (SELECT count(*)::int FROM tickets WHERE run_id = $2) AS tickets,
                (SELECT count(*)::int FROM messages WHERE run_id = $2 AND sender = 'system:guardrails') AS logs,
                (SELECT count(*)::int FROM agent_tool_invocations WHERE agent_id = $3) AS invocations`,
        [project.rows[0].id, run.id, blockedAgent],
      );
      assert.equal(after.rows[0].next_number, before.rows[0].next_number, "rejection precedes mutation");
      assert.equal(after.rows[0].tickets, 0);
      assert.equal(after.rows[0].logs, 1, "the rejection is logged durably");
      assert.equal(after.rows[0].invocations, 1, "the rejection is recorded for replay");

      const log = await client.query(
        `SELECT type, payload FROM messages WHERE run_id = $1 AND sender = 'system:guardrails'`,
        [run.id],
      );
      assert.equal(log.rows[0].type, "system");
      assert.equal(log.rows[0].payload.code, "action_blocked");
      assert.equal(log.rows[0].payload.command, "create_ticket");
      assert.equal(log.rows[0].payload.agentId, String(blockedAgent));

      await assert.rejects(
        () => dispatchPlatformTool(pool, "create_ticket", input),
        (error) => error instanceof PlatformToolError && error.code === "action_blocked",
      );
      const replay = await client.query(
        `SELECT (SELECT count(*)::int FROM messages WHERE run_id = $1 AND sender = 'system:guardrails') AS logs,
                (SELECT count(*)::int FROM agent_tool_invocations WHERE agent_id = $2) AS invocations`,
        [run.id, blockedAgent],
      );
      assert.deepEqual(replay.rows[0], { logs: 1, invocations: 1 }, "a retry replays without logging twice");

      await assert.rejects(
        () => dispatchPlatformTool(pool, "create_ticket", { ...input, title: "A different request" }),
        (error) => error instanceof PlatformToolError && error.code === "idempotency_key_reused",
      );

      const listed = await dispatchPlatformTool(pool, "list_tickets", {
        agentId: String(blockedAgent),
        runId: String(run.id),
        idempotencyKey: "blocked-agent-list-1",
      });
      assert.deepEqual(listed.tickets, [], "unblocked commands still dispatch for the same agent");

      const cli = await callAgentTool("create_ticket", { ...input, idempotencyKey: "blocked-create-2" });
      assert.equal(cli.exitCode, 1);
      assert.equal(cli.stdout.ok, false);
      assert.equal(cli.stdout.error.code, "action_blocked");
    });

    await t.test("only the listed commands are blocked at the dispatch point", async () => {
      const agent = await seedAgent("messenger-agent", { blockedActions: ["post_message"] });
      const run = await createLoopRun(agent);

      const created = await dispatchPlatformTool(pool, "create_ticket", {
        agentId: String(agent),
        runId: String(run.id),
        projectId: String(project.rows[0].id),
        title: "Created by an agent that cannot post messages",
        idempotencyKey: "messenger-create-1",
      });
      assert.equal(created.replayed, false);

      await assert.rejects(
        () =>
          dispatchPlatformTool(pool, "post_message", {
            agentId: String(agent),
            runId: String(run.id),
            ticketId: created.ticket.id,
            recipient: "agent:someone",
            type: "question",
            payload: { question: "May I?" },
            idempotencyKey: "messenger-post-1",
          }),
        (error) => error instanceof PlatformToolError && error.code === "action_blocked",
      );
      const ticket = await client.query("SELECT updated_at FROM tickets WHERE id = $1", [
        created.ticket.id,
      ]);
      const updated = await dispatchPlatformTool(pool, "update_ticket", {
        agentId: String(agent),
        runId: String(run.id),
        ticketId: created.ticket.id,
        expectedUpdatedAt: ticket.rows[0].updated_at,
        title: "Updated by an unblocked agent",
        idempotencyKey: "messenger-update-1",
      });
      assert.equal(updated.ticket.title, "Updated by an unblocked agent", "unblocked mutations still commit");
    });
  } finally {
    await pool.end();
    await client.end();
  }
});
