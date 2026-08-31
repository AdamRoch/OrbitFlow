import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { insertMessage } from "../../src/lib/postgres/message-bus.ts";
import {
  consumeNextWorkflowMessage,
  createWorkflowRun,
  dispatchNextWorkflowNode,
  getWorkflowRun,
  pauseWorkflowThread,
  resumeWorkflowThread,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import { PlatformToolError, dispatchPlatformTool } from "../../src/lib/platform-tools/dispatch.ts";

const { Client, Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const migrationDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function committedMigrationFiles() {
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
}

test("FACT-41 run-scoped dependencies and dispatch", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await client.connect();
  try {
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, process.env.ORBITFACTORY_FACT41_PROOF_DATABASE);
    assert.deepEqual((await migratePostgres({ databaseUrl, log: () => {} })).applied, await committedMigrationFiles());

    const agentId = String((await client.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-41 agent', 'worker', 'Use the tool.', 'proof') RETURNING id`,
    )).rows[0].id);
    const projectId = String((await client.query(
      "INSERT INTO projects (key, name) VALUES ('FCT', 'FACT-41 proof') RETURNING id",
    )).rows[0].id);
    let runNumber = 0;
    let ticketNumber = 0;

    async function makeRun(maxConcurrency = 10) {
      runNumber += 1;
      const workflowId = String((await client.query(
        `INSERT INTO workflows (name, description, graph)
         VALUES ($1, 'FACT-41 workflow', $2) RETURNING id`,
        [`FACT-41 workflow ${runNumber}`, {
          nodes: [{ id: "implement", agentId, config: { entry: true, fanOut: { maxConcurrency } } }],
          edges: [],
        }],
      )).rows[0].id);
      return createWorkflowRun(pool, { workflowId, triggerType: "ui", spec: { proof: runNumber } });
    }

    async function consumeThrough(messageId, consumerId) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const consumed = await consumeNextWorkflowMessage(pool, { consumerId });
        if (consumed?.message.id === messageId) return consumed;
      }
      assert.fail(`message ${messageId} was not consumed`);
    }

    async function completeDispatch(dispatch, output = { artifact: "completed" }) {
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
          output,
        },
        handoffBrief: `completed ${dispatch.node_id}`,
      });
      await consumeThrough(message.id, "fact41-regression");
    }

    async function makeTicket(runId, title) {
      ticketNumber += 1;
      return String((await client.query(
        `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
         VALUES ($1, $2, $3, $4, $5, 'todo', 1) RETURNING id`,
        [ticketNumber, `FCT-${ticketNumber}`, projectId, runId, title],
      )).rows[0].id);
    }

    async function setDependencies(runId, ticketId, blockerTicketIds, idempotencyKey) {
      return dispatchPlatformTool(pool, "set_ticket_dependencies", {
        agentId,
        runId,
        ticketId,
        blockerTicketIds,
        idempotencyKey,
      });
    }

    await t.test("replaces the complete blocker set and replays retries", async () => {
      const run = await makeRun();
      const first = await makeTicket(run.id, "first");
      const second = await makeTicket(run.id, "second");
      const blocked = await makeTicket(run.id, "blocked");
      const input = [first, second];
      const initial = await setDependencies(run.id, blocked, input, "complete-set");
      assert.equal(initial.replayed, false);
      const replay = await setDependencies(run.id, blocked, input, "complete-set");
      assert.equal(replay.replayed, true);
      const listed = await dispatchPlatformTool(pool, "list_tickets", {
        agentId, runId: run.id, limit: 10, idempotencyKey: "list-blockers",
      });
      assert.deepEqual(listed.tickets.find((ticket) => ticket.id === blocked)?.blockerTicketIds, input.sort((a, b) => Number(a) - Number(b)));
      await setDependencies(run.id, blocked, [second], "replace-set");
      const rows = await client.query(
        "SELECT blocker_ticket_id::text FROM dependencies WHERE blocked_ticket_id = $1 ORDER BY blocker_ticket_id",
        [blocked],
      );
      assert.deepEqual(rows.rows.map((row) => row.blocker_ticket_id), [second]);
      await assert.rejects(
        () => setDependencies(run.id, blocked, [second, second], "duplicate"),
        (error) => error instanceof PlatformToolError && error.code === "duplicate_blocker",
      );
    });

    await t.test("retains blocked fan-out work and wakes it after its blocker completes", async () => {
      const run = await makeRun(1);
      const blocker = await makeTicket(run.id, "fan-out blocker");
      const blocked = await makeTicket(run.id, "fan-out blocked");
      await setDependencies(run.id, blocked, [blocker], "fanout-wake-dependency");

      const started = await startWorkflowRun(pool, run.id);
      assert.equal(started.status, "running", "retained blocked work keeps the run open");
      const members = await client.query(
        `SELECT member.ticket_id::text AS ticket_id
         FROM workflow_fanout_members AS member
         JOIN workflow_fanout_groups AS fanout ON fanout.id = member.fanout_group_id
         WHERE fanout.run_id = $1 ORDER BY member.position`,
        [run.id],
      );
      assert.deepEqual(members.rows.map((row) => row.ticket_id), [blocker, blocked]);

      const initialDispatches = await client.query(
        `SELECT ticket_id::text AS ticket_id
         FROM workflow_dispatches
         WHERE run_id = $1 AND ticket_id IS NOT NULL`,
        [run.id],
      );
      assert.deepEqual(initialDispatches.rows.map((row) => row.ticket_id), [blocker]);
      const initialBlocked = await client.query(
        "SELECT status, assignee_agent_id FROM tickets WHERE id = $1",
        [blocked],
      );
      assert.deepEqual(initialBlocked.rows[0], { status: "todo", assignee_agent_id: null });

      class Runtime {
        async startSession(request) {
          return { kind: "started", sessionId: `fact41-session-${request.ticketId}` };
        }

        async reconcileSession() {
          return { kind: "absent" };
        }
      }
      const runtime = new Runtime();
      const request = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact41-wake" });
      assert.equal(request?.runId, run.id);
      assert.equal(request?.ticketId, blocker);
      const blockerDispatch = (await client.query(
        "SELECT * FROM workflow_dispatches WHERE id = $1",
        [request.dispatchId],
      )).rows[0];
      const blockerState = (await client.query(
        "SELECT updated_at FROM tickets WHERE id = $1",
        [blocker],
      )).rows[0];
      await dispatchPlatformTool(pool, "update_ticket", {
        agentId,
        runId: run.id,
        ticketId: blocker,
        expectedUpdatedAt: blockerState.updated_at,
        status: "done",
        idempotencyKey: "fanout-wake-blocker-done",
      });
      await completeDispatch(blockerDispatch);

      const awakened = await client.query(
        `SELECT ticket.id::text AS id, ticket.status, ticket.assignee_agent_id::text AS assignee_agent_id,
                dispatch.id::text AS dispatch_id
         FROM tickets AS ticket
         LEFT JOIN workflow_dispatches AS dispatch
           ON dispatch.run_id = ticket.run_id AND dispatch.ticket_id = ticket.id
         WHERE ticket.id = $1`,
        [blocked],
      );
      assert.equal(awakened.rows[0].id, blocked);
      assert.equal(awakened.rows[0].status, "in_progress");
      assert.equal(awakened.rows[0].assignee_agent_id, agentId);
      assert.ok(awakened.rows[0].dispatch_id, "the blocker completion materializes the blocked ticket");
      assert.equal((await getWorkflowRun(pool, run.id)).status, "running");

      const blockedDispatch = (await client.query(
        "SELECT * FROM workflow_dispatches WHERE id = $1",
        [awakened.rows[0].dispatch_id],
      )).rows[0];
      await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact41-wake" });
      const activeBlockedDispatch = (await client.query(
        "SELECT * FROM workflow_dispatches WHERE id = $1",
        [blockedDispatch.id],
      )).rows[0];
      await completeDispatch(activeBlockedDispatch);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "completed");
    });

    await t.test("overlapping fan-out activations share one ticket dispatch", async () => {
      const run = await makeRun(10);
      const ticket = await makeTicket(run.id, "overlapping fan-out ticket");
      const hold = await makeTicket(run.id, "held fan-out ticket");
      await startWorkflowRun(pool, run.id);
      await pauseWorkflowThread(pool, run.id, hold, "hold run open for rework");
      await pauseWorkflowThread(pool, run.id, ticket, "pause before overlapping activation");

      async function addActivation(name) {
        const source = await insertMessage(pool, {
          runId: run.id,
          sender: "system:fact-41",
          recipient: "system:workflow-engine",
          type: "system",
          payload: { output: { activation: name } },
          handoffBrief: `${name} fan-out activation`,
        });
        const group = (await client.query(
          `INSERT INTO workflow_fanout_groups (
             run_id, source_message_id, node_id, agent_id, agent_model, node_config, max_concurrency
           ) VALUES ($1, $2, 'implement', $3, 'proof', $4, 10) RETURNING id`,
          [run.id, source.id, agentId, { entry: true, fanOut: { maxConcurrency: 10 } }],
        )).rows[0].id;
        await client.query(
          `INSERT INTO workflow_fanout_members (fanout_group_id, position, ticket_id)
           VALUES ($1, 0, $2)`,
          [group, ticket],
        );
      }

      await addActivation("overlap");

      await Promise.all([
        resumeWorkflowThread(pool, run.id, ticket),
        resumeWorkflowThread(pool, run.id, ticket),
      ]);
      const overlapMembers = await client.query(
        `SELECT count(*)::int AS count
         FROM workflow_fanout_members AS member
         JOIN workflow_fanout_groups AS fanout ON fanout.id = member.fanout_group_id
         WHERE fanout.run_id = $1 AND member.ticket_id = $2`,
        [run.id, ticket],
      );
      assert.equal(overlapMembers.rows[0].count, 2, "both overlapping activations retain the ticket member");
      const dispatches = await client.query(
        `SELECT id, fanout_group_id, ticket_id, status
         FROM workflow_dispatches
         WHERE run_id = $1 AND node_id = 'implement' AND ticket_id = $2`,
        [run.id, ticket],
      );
      assert.equal(dispatches.rowCount, 1, "one run/node/ticket has one logical dispatch");
      assert.equal(dispatches.rows[0].status, "pending");
      const ticketState = (await client.query(
        "SELECT status, assignee_agent_id::text AS assignee_agent_id FROM tickets WHERE id = $1",
        [ticket],
      )).rows[0];
      assert.deepEqual(ticketState, { status: "in_progress", assignee_agent_id: agentId });

      const runtime = {
        async startSession(request) {
          return { kind: "started", sessionId: `fact41-overlap-${request.ticketId}` };
        },
        async reconcileSession() {
          return { kind: "absent" };
        },
      };
      const request = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact41-overlap" });
      const dispatch = (await client.query(
        "SELECT * FROM workflow_dispatches WHERE id = $1",
        [request.dispatchId],
      )).rows[0];
      await completeDispatch(dispatch);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "running");

      await addActivation("rework");
      await resumeWorkflowThread(pool, run.id, ticket);
      const reworkDispatches = await client.query(
        `SELECT status
         FROM workflow_dispatches
         WHERE run_id = $1 AND node_id = 'implement' AND ticket_id = $2
         ORDER BY id`,
        [run.id, ticket],
      );
      assert.deepEqual(reworkDispatches.rows.map((row) => row.status), ["completed", "pending"]);

      const reworkRequest = await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact41-overlap-rework" });
      const reworkDispatch = (await client.query(
        "SELECT * FROM workflow_dispatches WHERE id = $1",
        [reworkRequest.dispatchId],
      )).rows[0];
      await completeDispatch(reworkDispatch);
      assert.equal((await getWorkflowRun(pool, run.id)).status, "running", "held work keeps the run open");
    });

    await t.test("serializes opposing graph writes so only one can commit", async () => {
      const run = await makeRun();
      const left = await makeTicket(run.id, "left");
      const right = await makeTicket(run.id, "right");
      const results = await Promise.allSettled([
        setDependencies(run.id, left, [right], "left-depends-right"),
        setDependencies(run.id, right, [left], "right-depends-left"),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.reason instanceof PlatformToolError);
      assert.equal(rejected.reason.code, "dependency_cycle");
    });

    await t.test("the fan-out dispatches only ready tickets and moves them atomically to in_progress", async () => {
      const run = await makeRun();
      const ready = await makeTicket(run.id, "ready");
      const blocker = await makeTicket(run.id, "blocker");
      const blocked = await makeTicket(run.id, "blocked");
      await setDependencies(run.id, blocked, [blocker], "blocked-by-blocker");
      await startWorkflowRun(pool, run.id);
      const dispatches = await client.query(
        "SELECT ticket_id::text FROM workflow_dispatches WHERE run_id = $1 AND ticket_id IS NOT NULL ORDER BY ticket_id::bigint",
        [run.id],
      );
      assert.deepEqual(dispatches.rows.map((row) => row.ticket_id), [ready, blocker].sort((a, b) => Number(a) - Number(b)));
      const tickets = await client.query("SELECT id::text, status, assignee_agent_id::text FROM tickets WHERE run_id = $1 ORDER BY id", [run.id]);
      const statusById = new Map(tickets.rows.map((row) => [row.id, row]));
      assert.equal(statusById.get(ready).status, "in_progress");
      assert.equal(statusById.get(blocker).status, "in_progress");
      assert.equal(statusById.get(blocked).status, "todo");
      assert.equal(statusById.get(ready).assignee_agent_id, agentId);
      assert.equal(statusById.get(blocker).assignee_agent_id, agentId);
    });

    await t.test("dependency replacement racing first dispatch leaves either valid state and no orphan dispatch", async () => {
      const run = await makeRun();
      const blocker = await makeTicket(run.id, "race blocker");
      const blocked = await makeTicket(run.id, "race blocked");
      const result = await Promise.allSettled([
        startWorkflowRun(pool, run.id),
        setDependencies(run.id, blocked, [blocker], "race-dependency"),
      ]);
      assert.ok(result.some((item) => item.status === "fulfilled"));
      const state = await client.query(
        `SELECT ticket.id::text, ticket.status, dispatch.id::text AS dispatch_id
         FROM tickets AS ticket
         LEFT JOIN workflow_dispatches AS dispatch
           ON dispatch.run_id = ticket.run_id AND dispatch.ticket_id = ticket.id
         WHERE ticket.run_id = $1 ORDER BY ticket.id`,
        [run.id],
      );
      for (const row of state.rows) {
        if (row.status === "in_progress") assert.ok(row.dispatch_id, "in-progress ticket has its dispatch");
        if (row.status === "todo") assert.equal(row.dispatch_id, null, "blocked todo ticket has no dispatch");
      }
    });

    await t.test("separate runs update their graphs concurrently", async () => {
      const firstRun = await makeRun();
      const secondRun = await makeRun();
      const firstBlocker = await makeTicket(firstRun.id, "first blocker");
      const firstBlocked = await makeTicket(firstRun.id, "first blocked");
      const secondBlocker = await makeTicket(secondRun.id, "second blocker");
      const secondBlocked = await makeTicket(secondRun.id, "second blocked");
      const results = await Promise.all([
        setDependencies(firstRun.id, firstBlocked, [firstBlocker], "first-run"),
        setDependencies(secondRun.id, secondBlocked, [secondBlocker], "second-run"),
      ]);
      assert.ok(results.every((result) => result.replayed === false));
    });
  } finally {
    await Promise.all([client.end(), pool.end()]);
  }
});
