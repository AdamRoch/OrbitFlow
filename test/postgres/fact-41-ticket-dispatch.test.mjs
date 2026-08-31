import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { startWorkflowRun, createWorkflowRun } from "../../src/lib/postgres/workflow-engine.ts";
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

    async function makeRun() {
      runNumber += 1;
      const workflowId = String((await client.query(
        `INSERT INTO workflows (name, description, graph)
         VALUES ($1, 'FACT-41 workflow', $2) RETURNING id`,
        [`FACT-41 workflow ${runNumber}`, {
          nodes: [{ id: "implement", agentId, config: { entry: true, fanOut: { maxConcurrency: 10 } } }],
          edges: [],
        }],
      )).rows[0].id);
      return createWorkflowRun(pool, { workflowId, triggerType: "ui", spec: { proof: runNumber } });
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
        "SELECT ticket_id::text FROM workflow_dispatches WHERE run_id = $1 AND ticket_id IS NOT NULL ORDER BY ticket_id",
        [run.id],
      );
      assert.deepEqual(dispatches.rows.map((row) => row.ticket_id), [ready, blocker].sort((a, b) => Number(a) - Number(b)));
      const tickets = await client.query("SELECT id::text, status, assignee_agent_id::text FROM tickets WHERE run_id = $1 ORDER BY id", [run.id]);
      assert.deepEqual(tickets.rows.map((row) => row.status), ["in_progress", "in_progress", "todo"]);
      assert.ok(tickets.rows.slice(0, 2).every((row) => row.assignee_agent_id === agentId));
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
