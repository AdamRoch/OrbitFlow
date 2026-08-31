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
const STATUS_UPDATE_APPLICATION_NAME = "orbitfactory-fact48-status-update";
const ASSIGNMENT_APPLICATION_NAME = "orbitfactory-fact48-assignment";
const FACT51_ROUTER_APPLICATION_NAME = "orbitfactory-fact51-ticket-router";

async function committedMigrationFiles() {
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
}

test("FACT-41 run-scoped dependencies and dispatch", { skip: !databaseUrl }, async (t) => {
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const statusUpdatePool = new Pool({
    connectionString: databaseUrl,
    application_name: STATUS_UPDATE_APPLICATION_NAME,
    max: 1,
  });
  const assignmentPool = new Pool({
    connectionString: databaseUrl,
    application_name: ASSIGNMENT_APPLICATION_NAME,
    max: 1,
  });
  const routerPool = new Pool({
    connectionString: databaseUrl,
    application_name: FACT51_ROUTER_APPLICATION_NAME,
    max: 1,
  });
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

    async function consumeThrough(messageId, consumerId, consumerPool = pool) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const consumed = await consumeNextWorkflowMessage(consumerPool, { consumerId });
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

    async function ticketState(ticketId) {
      const result = await client.query(
        "SELECT status, updated_at FROM tickets WHERE id = $1",
        [ticketId],
      );
      assert.ok(result.rows[0], `ticket ${ticketId} must exist`);
      return result.rows[0];
    }

    async function updateTicketStatus(toolPool, runId, ticketId, nextStatus, idempotencyKey) {
      const current = await ticketState(ticketId);
      return dispatchPlatformTool(toolPool, "update_ticket", {
        agentId,
        runId,
        ticketId,
        expectedUpdatedAt: current.updated_at,
        status: nextStatus,
        idempotencyKey,
      });
    }

    async function makeStatusAssignmentRace(key) {
      const run = await makeRun();
      const blocker = await makeTicket(run.id, `${key} blocker`);
      const dependent = await makeTicket(run.id, `${key} dependent`);
      await setDependencies(run.id, dependent, [blocker], `${key}-dependency`);
      await updateTicketStatus(pool, run.id, blocker, "done", `${key}-blocker-done`);
      return { run, blocker, dependent };
    }

    async function waitForRunLockWaiter(applicationName) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activity = await client.query(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE application_name = $1`,
          [applicationName],
        );
        if (activity.rows.some((row) => row.wait_event_type === "Lock")) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`${applicationName} did not wait on the workflow-run lock`);
    }

    async function waitForLockWaiter(applicationName) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activity = await client.query(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE application_name = $1`,
          [applicationName],
        );
        if (activity.rows.some((row) => row.wait_event_type === "Lock")) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`${applicationName} did not wait on its expected lock`);
    }

    async function assertStatusUpdateHasNoInvocationLock() {
      const locks = await client.query(
        `SELECT count(*)::int AS count
         FROM pg_locks AS lock
         JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
         WHERE activity.application_name = $1
           AND lock.relation = 'agent_tool_invocations'::regclass
           AND lock.mode = 'RowExclusiveLock'`,
        [STATUS_UPDATE_APPLICATION_NAME],
      );
      assert.equal(
        locks.rows[0].count,
        0,
        "a waiting status update must not take its idempotency invocation lock before the run lock",
      );
    }

    async function lockRunForInterleaving(runId) {
      const holder = new Client({
        connectionString: databaseUrl,
        application_name: "orbitfactory-fact48-holder",
      });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE", [runId]);
      return holder;
    }

    function settleWithoutDeadlock(promises) {
      let deadline;
      const timeout = new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("FACT-48 lock interleaving did not settle")),
          5_000,
        );
      });
      return Promise.race([Promise.allSettled(promises), timeout])
        .finally(() => clearTimeout(deadline));
    }

    async function runInLockOrder(runId, first, firstApplicationName, second, secondApplicationName) {
      const holder = await lockRunForInterleaving(runId);
      let committed = false;
      try {
        const firstResult = first();
        await waitForRunLockWaiter(firstApplicationName);
        const secondResult = second();
        await waitForRunLockWaiter(secondApplicationName);
        await assertStatusUpdateHasNoInvocationLock();
        await holder.query("COMMIT");
        committed = true;
        return await settleWithoutDeadlock([firstResult, secondResult]);
      } finally {
        if (!committed) await holder.query("ROLLBACK").catch(() => {});
        await holder.end();
      }
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

    await t.test("allows a completed blocker to reopen when a dependent is only planned", async () => {
      const run = await makeRun();
      const blocker = await makeTicket(run.id, "planned blocker");
      const planned = await makeTicket(run.id, "planned dependent");
      await setDependencies(run.id, planned, [blocker], "fact48-planned-dependency");
      await updateTicketStatus(pool, run.id, blocker, "done", "fact48-planned-blocker-done");
      await updateTicketStatus(pool, run.id, planned, "backlog", "fact48-planned-dependent-backlog");

      const reopened = await updateTicketStatus(pool, run.id, blocker, "todo", "fact48-planned-reopen");
      assert.equal(reopened.replayed, false);
      assert.equal(reopened.ticket.status, "todo");
      assert.equal((await ticketState(planned)).status, "backlog");
    });

    await t.test("keeps non-status edits idempotent after a dependent starts", async () => {
      const state = await makeStatusAssignmentRace("fact48-non-status");
      await startWorkflowRun(pool, state.run.id);
      assert.equal((await ticketState(state.dependent)).status, "in_progress");

      const before = await ticketState(state.blocker);
      const input = {
        agentId,
        runId: state.run.id,
        ticketId: state.blocker,
        expectedUpdatedAt: before.updated_at,
        title: "renamed without reopening",
        idempotencyKey: "fact48-non-status-title",
      };
      const first = await dispatchPlatformTool(pool, "update_ticket", input);
      const replay = await dispatchPlatformTool(pool, "update_ticket", input);
      assert.equal(first.replayed, false);
      assert.equal(replay.replayed, true);
      assert.equal(first.ticket.status, "done");
      assert.equal(replay.ticket.title, "renamed without reopening");
      const messages = await client.query(
        "SELECT count(*)::int AS count FROM messages WHERE payload ->> 'idempotencyKey' = $1",
        [input.idempotencyKey],
      );
      assert.equal(messages.rows[0].count, 1);
    });

    await t.test("serializes title-only updates before ticket routing can take the run lock", async () => {
      const run = await makeRun();
      const ticket = await makeTicket(run.id, "FACT-51 title lock order");
      await startWorkflowRun(pool, run.id);
      const prior = await updateTicketStatus(
        pool,
        run.id,
        ticket,
        "done",
        "fact51-route-prior-update",
      );
      const advisoryHolder = new Client({
        connectionString: databaseUrl,
        application_name: "orbitfactory-fact51-advisory-holder",
      });
      await advisoryHolder.connect();
      await advisoryHolder.query("SELECT pg_advisory_lock(51, 52)");
      await client.query(
        `CREATE OR REPLACE FUNCTION fact51_title_update_message_gate()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $$
         BEGIN
           IF NEW.payload ->> 'idempotencyKey' = 'fact51-title-lock-order' THEN
             PERFORM pg_advisory_xact_lock(51, 52);
           END IF;
           RETURN NEW;
         END;
         $$`,
      );
      await client.query(
        `CREATE TRIGGER fact51_title_update_message_gate
         BEFORE INSERT ON messages
         FOR EACH ROW
         EXECUTE FUNCTION fact51_title_update_message_gate()`,
      );

      let released = false;
      try {
        const beforeTitle = await ticketState(ticket);
        const titleUpdate = dispatchPlatformTool(statusUpdatePool, "update_ticket", {
          agentId,
          runId: run.id,
          ticketId: ticket,
          expectedUpdatedAt: beforeTitle.updated_at,
          title: "FACT-51 lock order holds",
          idempotencyKey: "fact51-title-lock-order",
        });
        await waitForLockWaiter(STATUS_UPDATE_APPLICATION_NAME);

        const routed = consumeThrough(prior.message.id, "fact51-lock-order", routerPool);
        await waitForRunLockWaiter(FACT51_ROUTER_APPLICATION_NAME);

        await advisoryHolder.query("SELECT pg_advisory_unlock(51, 52)");
        released = true;
        const [titleResult, routeResult] = await settleWithoutDeadlock([titleUpdate, routed]);
        assert.equal(titleResult.status, "fulfilled");
        assert.equal(routeResult.status, "fulfilled");
        assert.equal(routeResult.value?.message.id, prior.message.id);

        const titleMessage = titleResult.value.message;
        const consumedTitle = await consumeThrough(
          titleMessage.id,
          "fact51-lock-order",
          routerPool,
        );
        assert.equal(consumedTitle?.message.id, titleMessage.id);
      } finally {
        if (!released) await advisoryHolder.query("SELECT pg_advisory_unlock(51, 52)").catch(() => {});
        await client.query("DROP TRIGGER IF EXISTS fact51_title_update_message_gate ON messages").catch(() => {});
        await client.query("DROP FUNCTION IF EXISTS fact51_title_update_message_gate()").catch(() => {});
        await advisoryHolder.end();
        await client.query(
          "UPDATE workflow_runs SET status = 'canceled', ended_at = clock_timestamp() WHERE id = $1",
          [run.id],
        );
      }
    });

    await t.test("fails closed after a direct dependent completes", async () => {
      const state = await makeStatusAssignmentRace("fact48-completed-dependent");
      await startWorkflowRun(pool, state.run.id);
      await updateTicketStatus(pool, state.run.id, state.dependent, "done", "fact48-dependent-done");

      await assert.rejects(
        () => updateTicketStatus(pool, state.run.id, state.blocker, "todo", "fact48-completed-reopen"),
        (error) => error instanceof PlatformToolError && error.code === "ticket_reopen_conflict",
      );
      assert.equal((await ticketState(state.blocker)).status, "done");
      assert.equal((await ticketState(state.dependent)).status, "done");
    });

    await t.test("serializes blocker reopening and assignment in both winner orders", async () => {
      const statusFirst = await makeStatusAssignmentRace("fact48-status-first");
      const statusFirstResults = await runInLockOrder(
        statusFirst.run.id,
        () => updateTicketStatus(
          statusUpdatePool,
          statusFirst.run.id,
          statusFirst.blocker,
          "todo",
          "fact48-status-first-reopen",
        ),
        STATUS_UPDATE_APPLICATION_NAME,
        () => startWorkflowRun(assignmentPool, statusFirst.run.id),
        ASSIGNMENT_APPLICATION_NAME,
      );
      assert.equal(statusFirstResults[0].status, "fulfilled");
      assert.equal(statusFirstResults[1].status, "fulfilled");
      const statusFirstDependent = await ticketState(statusFirst.dependent);
      assert.equal(statusFirstDependent.status, "todo", "assignment must see the reopened blocker");
      const statusFirstDispatches = await client.query(
        `SELECT count(*)::int AS count
         FROM workflow_dispatches
         WHERE run_id = $1 AND ticket_id = $2`,
        [statusFirst.run.id, statusFirst.dependent],
      );
      assert.equal(statusFirstDispatches.rows[0].count, 0, "a stale readiness read must not dispatch the dependent");

      const assignmentFirst = await makeStatusAssignmentRace("fact48-assignment-first");
      const assignmentFirstResults = await runInLockOrder(
        assignmentFirst.run.id,
        () => startWorkflowRun(assignmentPool, assignmentFirst.run.id),
        ASSIGNMENT_APPLICATION_NAME,
        () => updateTicketStatus(
          statusUpdatePool,
          assignmentFirst.run.id,
          assignmentFirst.blocker,
          "todo",
          "fact48-assignment-first-reopen",
        ),
        STATUS_UPDATE_APPLICATION_NAME,
      );
      assert.equal(assignmentFirstResults[0].status, "fulfilled");
      assert.equal(assignmentFirstResults[1].status, "rejected");
      assert.ok(assignmentFirstResults[1].reason instanceof PlatformToolError);
      assert.equal(assignmentFirstResults[1].reason.code, "ticket_reopen_conflict");

      const assignmentFirstBlocker = await ticketState(assignmentFirst.blocker);
      const assignmentFirstDependent = await ticketState(assignmentFirst.dependent);
      assert.equal(assignmentFirstBlocker.status, "done");
      assert.equal(assignmentFirstDependent.status, "in_progress");
      const assignmentFirstDispatches = await client.query(
        `SELECT count(*)::int AS count
         FROM workflow_dispatches
         WHERE run_id = $1 AND ticket_id = $2`,
        [assignmentFirst.run.id, assignmentFirst.dependent],
      );
      assert.equal(assignmentFirstDispatches.rows[0].count, 1);
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
    await Promise.all([
      client.end(),
      pool.end(),
      statusUpdatePool.end(),
      assignmentPool.end(),
      routerPool.end(),
    ]);
  }
});
