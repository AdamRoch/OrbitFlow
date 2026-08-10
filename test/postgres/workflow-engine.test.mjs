import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  consumeNextWorkflowMessage,
  createWorkflowRun,
  dispatchNextWorkflowNode,
  getWorkflowRun,
  listWorkflowThreadStates,
  pauseWorkflowThread,
  pauseWorkflowRun,
  resumeWorkflowThread,
  resumeWorkflowRun,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";

const { Client, Pool } = pg;

class DeterministicRuntimeAdapter {
  constructor({ failNodeId = null } = {}) {
    this.failNodeId = failNodeId;
    this.calls = [];
    this.sessions = new Map();
  }

  async startSession(request) {
    this.calls.push(request);
    if (request.nodeId === this.failNodeId) throw new Error("deterministic runtime failure");
    let sessionId = this.sessions.get(request.idempotencyKey);
    if (!sessionId) {
      sessionId = `mock-session-${this.sessions.size + 1}`;
      this.sessions.set(request.idempotencyKey, sessionId);
    }
    return { sessionId };
  }
}

test("FACT-10 durable workflow engine", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");

  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT10_PROOF_DATABASE);

    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(migration.applied, [
      "0001-control-plane.sql",
      "0002-tickets.sql",
      "0003-message-plane.sql",
      "0004-message-consumption.sql",
      "0006-workflow-engine.sql",
    ]);

    const agents = {};
    for (const name of ["implement", "test", "report", "worker"]) {
      const result = await client.query(
        `INSERT INTO agents (name, role, system_prompt, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [name, `${name} role`, `${name} prompt`, `mock/${name}`],
      );
      agents[name] = result.rows[0].id;
    }
    const project = await client.query(
      "INSERT INTO projects (key, name) VALUES ('PROOF', 'FACT-10 proof') RETURNING id",
    );
    let workflowCounter = 0;
    let ticketCounter = 0;

    async function createWorkflow(graph) {
      workflowCounter += 1;
      const result = await client.query(
        `INSERT INTO workflows (name, description, graph)
         VALUES ($1, 'FACT-10 proof workflow', $2)
         RETURNING id`,
        [`FACT-10 proof ${workflowCounter}`, graph],
      );
      return result.rows[0].id;
    }

    async function createRun(graph, ticketCount = 0) {
      const workflowId = await createWorkflow(graph);
      const run = await createWorkflowRun(pool, {
        workflowId,
        triggerType: "ui",
        spec: { objective: `proof run ${workflowCounter}` },
      });
      const ticketIds = [];
      for (let index = 0; index < ticketCount; index += 1) {
        ticketCounter += 1;
        const ticket = await client.query(
          `INSERT INTO tickets (
             number, identifier, project_id, run_id, title, status, priority
           ) VALUES ($1, $2, $3, $4, $5, 'todo', $6)
           RETURNING id`,
          [
            ticketCounter,
            `PROOF-${ticketCounter}`,
            project.rows[0].id,
            run.id,
            `Proof ticket ${ticketCounter}`,
            index % 5,
          ],
        );
        ticketIds.push(ticket.rows[0].id);
      }
      return { run: await startWorkflowRun(pool, run.id), ticketIds };
    }

    async function dispatchFor(runId, nodeId, ticketId = null) {
      const result = await client.query(
        `SELECT * FROM workflow_dispatches
         WHERE run_id = $1 AND node_id = $2
           AND ticket_id IS NOT DISTINCT FROM $3::bigint
         ORDER BY id DESC
         LIMIT 1`,
        [runId, nodeId, ticketId],
      );
      assert.ok(result.rows[0], `missing ${nodeId} dispatch`);
      return result.rows[0];
    }

    async function consumeThrough(messageId, consumerId = "fact10-proof") {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const consumed = await consumeNextWorkflowMessage(pool, { consumerId });
        if (consumed?.message.id === messageId) return consumed;
      }
      assert.fail(`message ${messageId} was not consumed`);
    }

    async function publishOutput(dispatch, output, usage = null) {
      const message = await insertMessage(pool, {
        runId: dispatch.run_id,
        ticketId: dispatch.ticket_id,
        sender: `agent:${dispatch.agent_id}`,
        recipient: "system:workflow-engine",
        type: "output",
        payload: {
          dispatchId: dispatch.id,
          sessionId: dispatch.runtime_session_id,
          output,
        },
        handoffBrief: `completed ${dispatch.node_id}`,
        tokenUsage: usage,
      });
      await consumeThrough(message.id);
      return message;
    }

    const cycleGraph = {
      nodes: [
        { id: "implement", agentId: agents.implement, config: { entry: true } },
        { id: "test", agentId: agents.test, config: {} },
        { id: "report", agentId: agents.report, config: {} },
      ],
      edges: [
        { source: "implement", target: "test", condition: { operator: "always" } },
        {
          source: "test",
          target: "implement",
          condition: { operator: "equals", path: ["verdict"], value: "rejected" },
        },
        {
          source: "test",
          target: "report",
          condition: { operator: "equals", path: ["verdict"], value: "approved" },
        },
      ],
    };

    await t.test("persists pause/resume, cycles, cost totals, and atomic competing consumption", async () => {
      const { run } = await createRun(cycleGraph);
      const runtime = new DeterministicRuntimeAdapter();
      await client.query(
        `UPDATE workflows
         SET graph = $2, updated_at = clock_timestamp()
         WHERE id = $1`,
        [
          run.workflowId,
          {
            nodes: cycleGraph.nodes,
            edges: [
              {
                source: "implement",
                target: "report",
                condition: { operator: "always" },
              },
            ],
          },
        ],
      );

      assert.equal((await pauseWorkflowRun(pool, run.id)).status, "paused");
      assert.equal(
        await dispatchNextWorkflowNode(pool, runtime, { workerId: "paused-worker" }),
        null,
      );
      assert.equal((await resumeWorkflowRun(pool, run.id)).status, "running");

      await dispatchNextWorkflowNode(pool, runtime, { workerId: "cycle-worker" });
      const implementOne = await dispatchFor(run.id, "implement");
      const firstOutput = await insertMessage(pool, {
        runId: run.id,
        sender: "agent:implement",
        recipient: "system:workflow-engine",
        type: "output",
        payload: {
          dispatchId: implementOne.id,
          sessionId: implementOne.runtime_session_id,
          output: { artifact: "first" },
        },
        handoffBrief: "implementation ready",
        tokenUsage: { input: 3, output: 2, total: 5, cost: 0.25 },
      });
      const competingPool = new Pool({ connectionString: databaseUrl, max: 2 });
      try {
        const results = await Promise.all([
          consumeNextWorkflowMessage(pool, { consumerId: "engine-a" }),
          consumeNextWorkflowMessage(competingPool, { consumerId: "engine-b" }),
        ]);
        assert.equal(results.filter((result) => result?.message.id === firstOutput.id).length, 1);
      } finally {
        await competingPool.end();
      }
      const testOne = await dispatchFor(run.id, "test");
      assert.equal(testOne.status, "pending");
      assert.equal(
        (await getWorkflowRun(pool, run.id)).graphSnapshot.edges.length,
        3,
        "the active run keeps its start-time graph after workflow edits",
      );

      await dispatchNextWorkflowNode(pool, runtime, { workerId: "cycle-worker" });
      await publishOutput(await dispatchFor(run.id, "test"), { verdict: "rejected" }, {
        input: 2,
        output: 1,
        total: 3,
        cost: 0.1,
      });
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "cycle-worker" });
      await publishOutput(await dispatchFor(run.id, "implement"), { artifact: "fixed" });
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "cycle-worker" });
      const approvedDispatch = await dispatchFor(run.id, "test");
      await publishOutput(approvedDispatch, { verdict: "approved" });

      const duplicate = await insertMessage(pool, {
        runId: run.id,
        sender: "agent:test",
        recipient: "system:workflow-engine",
        type: "output",
        payload: {
          dispatchId: approvedDispatch.id,
          sessionId: approvedDispatch.runtime_session_id,
          output: { verdict: "approved" },
        },
        handoffBrief: "duplicate provider completion",
      });
      await consumeThrough(duplicate.id, "duplicate-proof");
      const reportCount = await client.query(
        "SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND node_id = 'report'",
        [run.id],
      );
      assert.equal(reportCount.rows[0].count, 1, "semantic duplicate output cannot double-route");

      await dispatchNextWorkflowNode(pool, runtime, { workerId: "cycle-worker" });
      await publishOutput(await dispatchFor(run.id, "report"), { artifact: "final" });
      const completed = await getWorkflowRun(pool, run.id);
      assert.equal(completed.status, "completed");
      assert.equal(completed.totalTokens, "8");
      assert.equal(completed.totalCost, "0.35000000");
      const costs = await client.query(
        "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1",
        [run.id],
      );
      assert.equal(costs.rows[0].count, 2);
    });

    await t.test("holds fan-out at max N and releases one slot per completed ticket", async () => {
      const graph = {
        nodes: [
          {
            id: "worker",
            agentId: agents.worker,
            config: { entry: true, fanOut: { maxConcurrency: 2 } },
          },
        ],
        edges: [],
      };
      const { run, ticketIds } = await createRun(graph, 3);
      const runtime = new DeterministicRuntimeAdapter();
      await pauseWorkflowThread(pool, run.id, ticketIds[0], "waiting for one answer");
      const pausedThread = (await listWorkflowThreadStates(pool, run.id)).find(
        (thread) => thread.ticketId === ticketIds[0],
      );
      assert.ok(pausedThread);
      assert.deepEqual(
        {
          runId: pausedThread.runId,
          ticketId: pausedThread.ticketId,
          status: pausedThread.status,
          pauseReason: pausedThread.pauseReason,
        },
        {
          runId: run.id,
          ticketId: ticketIds[0],
          status: "paused",
          pauseReason: "waiting for one answer",
        },
      );
      const firstPool = new Pool({ connectionString: databaseUrl, max: 1 });
      const secondPool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        const started = await Promise.all([
          dispatchNextWorkflowNode(firstPool, runtime, { workerId: "fanout-a" }),
          dispatchNextWorkflowNode(secondPool, runtime, { workerId: "fanout-b" }),
        ]);
        assert.equal(started.filter(Boolean).length, 2);
      } finally {
        await Promise.all([firstPool.end(), secondPool.end()]);
      }
      assert.equal(
        await dispatchNextWorkflowNode(pool, runtime, { workerId: "fanout-c" }),
        null,
        "third ticket stays pending while two sessions are active",
      );
      let statuses = await client.query(
        `SELECT status, count(*)::int AS count
         FROM workflow_dispatches WHERE run_id = $1 GROUP BY status ORDER BY status`,
        [run.id],
      );
      assert.deepEqual(
        Object.fromEntries(statuses.rows.map((row) => [row.status, row.count])),
        { pending: 1, active: 2 },
      );

      const active = await client.query(
        "SELECT * FROM workflow_dispatches WHERE run_id = $1 AND status = 'active' ORDER BY id",
        [run.id],
      );
      await publishOutput(active.rows[0], { artifact: "ticket done" });
      assert.equal(
        await dispatchNextWorkflowNode(pool, runtime, { workerId: "fanout-c" }),
        null,
        "released capacity does not wake the paused ticket thread",
      );
      await resumeWorkflowThread(pool, run.id, ticketIds[0]);
      const released = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fanout-c" });
      assert.ok(released);
      assert.equal(runtime.sessions.size, 3);
      assert.deepEqual(
        new Set(runtime.calls.map((call) => call.ticketId)),
        new Set(ticketIds),
        "one ephemeral session is created for each open ticket",
      );
      assert.ok(runtime.calls.every((call) => call.ephemeral));

      const remaining = await client.query(
        "SELECT * FROM workflow_dispatches WHERE run_id = $1 AND status = 'active' ORDER BY id",
        [run.id],
      );
      for (const dispatch of remaining.rows) {
        await publishOutput(dispatch, { artifact: "ticket done" });
      }
      assert.equal((await getWorkflowRun(pool, run.id)).status, "completed");
      statuses = await client.query(
        "SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND status <> 'completed'",
        [run.id],
      );
      assert.equal(statuses.rows[0].count, 0);
    });

    await t.test("recovers an ambiguous expired claim with one stable runtime session", async () => {
      const graph = {
        nodes: [{ id: "worker", agentId: agents.worker, config: { entry: true } }],
        edges: [],
      };
      const { run } = await createRun(graph);
      const dispatch = await dispatchFor(run.id, "worker");
      await client.query(
        `UPDATE workflow_dispatches
         SET status = 'dispatching', lease_owner = 'crashed-process',
             lease_expires_at = clock_timestamp() - interval '1 second',
             attempt_count = attempt_count + 1
         WHERE id = $1`,
        [dispatch.id],
      );

      const runtime = new DeterministicRuntimeAdapter();
      const request = {
        idempotencyKey: dispatch.idempotency_key,
        runId: dispatch.run_id,
        dispatchId: dispatch.id,
        nodeId: dispatch.node_id,
        agentId: dispatch.agent_id,
        model: dispatch.agent_model,
        ticketId: dispatch.ticket_id,
        ephemeral: false,
        input: dispatch.input,
      };
      const ambiguous = await runtime.startSession(request);
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "restarted-process" });
      const recovered = await dispatchFor(run.id, "worker");
      assert.equal(recovered.status, "active");
      assert.equal(recovered.runtime_session_id, ambiguous.sessionId);
      assert.equal(recovered.attempt_count, 2);
      assert.equal(runtime.calls.length, 2, "the ambiguous provider call was retried");
      assert.equal(runtime.sessions.size, 1, "the stable key prevents a second session");
    });

    await t.test("shares one hard cap across overlapping fan-out cycle activations", async () => {
      const graph = {
        nodes: [
          {
            id: "worker",
            agentId: agents.worker,
            config: { entry: true, fanOut: { maxConcurrency: 2 } },
          },
        ],
        edges: [
          { source: "worker", target: "worker", condition: { operator: "always" } },
        ],
      };
      const { run } = await createRun(graph, 2);
      const runtime = new DeterministicRuntimeAdapter();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "overlap-a" });
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "overlap-b" });
      const firstGroup = await client.query(
        "SELECT * FROM workflow_dispatches WHERE run_id = $1 AND status = 'active' ORDER BY id",
        [run.id],
      );
      assert.equal(firstGroup.rowCount, 2);
      await publishOutput(firstGroup.rows[0], { verdict: "again" });
      const groups = await client.query(
        "SELECT count(*)::int AS count FROM workflow_fanout_groups WHERE run_id = $1",
        [run.id],
      );
      assert.equal(groups.rows[0].count, 2);

      await dispatchNextWorkflowNode(pool, runtime, { workerId: "overlap-c" });
      assert.equal(
        await dispatchNextWorkflowNode(pool, runtime, { workerId: "overlap-d" }),
        null,
      );
      const active = await client.query(
        "SELECT count(*)::int AS count FROM workflow_dispatches WHERE run_id = $1 AND status = 'active'",
        [run.id],
      );
      assert.equal(active.rows[0].count, 2, "overlapping groups cannot multiply max N");
      await client.query(
        "UPDATE workflow_runs SET status = 'canceled', ended_at = clock_timestamp() WHERE id = $1",
        [run.id],
      );
    });

    await t.test("accepts a fast session output before dispatch finalization", async () => {
      const graph = {
        nodes: [{ id: "worker", agentId: agents.worker, config: { entry: true } }],
        edges: [],
      };
      const { run } = await createRun(graph);
      const dispatch = await dispatchFor(run.id, "worker");
      await client.query(
        `UPDATE workflow_dispatches
         SET status = 'dispatching', lease_owner = 'fast-worker',
             lease_expires_at = clock_timestamp() + interval '5 minutes',
             attempt_count = attempt_count + 1
         WHERE id = $1`,
        [dispatch.id],
      );
      const runtime = new DeterministicRuntimeAdapter();
      const started = await runtime.startSession({
        idempotencyKey: dispatch.idempotency_key,
        runId: dispatch.run_id,
        dispatchId: dispatch.id,
        nodeId: dispatch.node_id,
        agentId: dispatch.agent_id,
        model: dispatch.agent_model,
        ticketId: null,
        ephemeral: false,
        input: dispatch.input,
      });
      const output = await insertMessage(pool, {
        runId: run.id,
        sender: "agent:worker",
        recipient: "system:workflow-engine",
        type: "output",
        payload: {
          dispatchId: dispatch.id,
          sessionId: started.sessionId,
          output: { artifact: "instant" },
        },
        handoffBrief: "fast completion",
      });
      await consumeThrough(output.id);
      const completed = await dispatchFor(run.id, "worker");
      assert.equal(completed.status, "completed");
      assert.equal(completed.runtime_session_id, started.sessionId);
      const lateFinalizer = await client.query(
        `UPDATE workflow_dispatches SET status = 'active'
         WHERE id = $1 AND status = 'dispatching' AND lease_owner = 'fast-worker'`,
        [dispatch.id],
      );
      assert.equal(lateFinalizer.rowCount, 0, "late adapter finalization cannot regress completion");
      assert.equal((await getWorkflowRun(pool, run.id)).status, "completed");
    });

    await t.test("persists malformed output and confirmed runtime failure without retry loops", async () => {
      const graph = {
        nodes: [{ id: "worker", agentId: agents.worker, config: { entry: true } }],
        edges: [],
      };
      const malformedRun = await createRun(graph);
      const runtime = new DeterministicRuntimeAdapter();
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "malformed-worker" });
      const dispatch = await dispatchFor(malformedRun.run.id, "worker");
      const malformed = await insertMessage(pool, {
        runId: malformedRun.run.id,
        sender: "agent:worker",
        recipient: "system:workflow-engine",
        type: "output",
        payload: {
          dispatchId: dispatch.id,
          sessionId: dispatch.runtime_session_id,
        },
        handoffBrief: "malformed output proof",
      });
      await consumeThrough(malformed.id);
      const malformedState = await getWorkflowRun(pool, malformedRun.run.id);
      assert.equal(malformedState.status, "failed");
      assert.match(malformedState.failureReason, /payload.output/);
      const receipt = await client.query(
        "SELECT count(*)::int AS count FROM message_consumptions WHERE message_id = $1",
        [malformed.id],
      );
      assert.equal(receipt.rows[0].count, 1, "invalid output is durably consumed after failing the run");

      const failedRun = await createRun(graph);
      const failingRuntime = new DeterministicRuntimeAdapter({ failNodeId: "worker" });
      await dispatchNextWorkflowNode(pool, failingRuntime, { workerId: "failure-worker" });
      const failedState = await getWorkflowRun(pool, failedRun.run.id);
      assert.equal(failedState.status, "failed");
      assert.equal(failedState.failureReason, "deterministic runtime failure");
      const failureTrail = await client.query(
        `SELECT payload
         FROM messages
         WHERE run_id = $1 AND type = 'system'
         ORDER BY sequence_number DESC LIMIT 1`,
        [failedRun.run.id],
      );
      assert.deepEqual(failureTrail.rows[0].payload, {
        code: "runtime_dispatch_failed",
        message: "deterministic runtime failure",
      });
    });
  } finally {
    await Promise.all([client.end(), pool.end()]);
  }
});
