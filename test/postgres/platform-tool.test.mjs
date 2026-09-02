import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { PlatformToolError, dispatchPlatformTool } from "../../src/lib/platform-tools/dispatch.ts";

const { Client, Pool } = pg;
pg.types.setTypeParser(1184, (value) => value);
const databaseUrl = process.env.DATABASE_URL;
const proofDatabase = process.env.ORBITFACTORY_FACT13_PROOF_DATABASE;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationDirectory = path.join(repoRoot, "db", "migrations");

async function committedMigrationFiles() {
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
}

const pool = new Pool({ connectionString: databaseUrl, application_name: "orbitfactory-fact13-proof" });

async function callAgentTool(command, input) {
  try {
    return { exitCode: 0, stdout: { ok: true, command, result: await dispatchPlatformTool(pool, command, input) } };
  } catch (error) {
    if (!(error instanceof PlatformToolError)) throw error;
    return { exitCode: 1, stdout: { ok: false, error: { code: error.code, message: error.message } } };
  }
}

test("dispatch rejects unknown commands before parsing input or opening PostgreSQL", async () => {
  const pool = {
    connect: async () => assert.fail("unknown commands must not open PostgreSQL"),
  };
  await assert.rejects(
    () => dispatchPlatformTool(pool, "delete_ticket", null),
    (error) => {
      assert.ok(error instanceof PlatformToolError);
      assert.equal(error.code, "unknown_command");
      assert.equal(error.message, "command must be a supported platform tool command");
      return true;
    },
  );
});

test("FACT-13 production agent CLI persists attributed ticket and message mutations", { skip: !databaseUrl }, async (t) => {
  assert.equal(proofDatabase, new URL(databaseUrl).pathname.slice(1), "proof database identity must match ORBITFACTORY_FACT13_PROOF_DATABASE");
  const migration = await migratePostgres({ databaseUrl, log: () => {} });
  assert.deepEqual(migration.applied, await committedMigrationFiles());

  const client = new Client({ connectionString: databaseUrl, application_name: "orbitfactory-fact13-proof" });
  await client.connect();
  try {
    const project = await client.query(
      "SELECT id FROM projects WHERE key = 'FACT'",
    );
    const agent = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model, coding_tool_enabled)
       VALUES ('FACT-13 tool agent', 'worker', 'Use the platform tool.', 'local-proof', true) RETURNING id`,
    );
    const workflow = await client.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-13 proof', 'CLI proof workflow', '{}'::jsonb) RETURNING id",
    );
    const run = await client.query(
      `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec, workflow_version)
       VALUES ($1, 'running', 'ui', '{"proof":"fact-13"}'::jsonb, now()) RETURNING id`,
      [workflow.rows[0].id],
    );
    const attribution = { agentId: String(agent.rows[0].id), runId: String(run.rows[0].id) };

    await t.test("create_ticket is an agent-turn subprocess and a retry replays one ticket and event", async () => {
      const input = {
        ...attribution,
        projectId: String(project.rows[0].id),
        title: "Prove agent CLI dispatch",
        description: "The proof creates this ticket through the CLI.",
        acceptanceCriteria: "One durable ticket and one durable system message.",
        priority: 3,
        idempotencyKey: "agent-turn-1-create",
      };
      const first = await callAgentTool("create_ticket", input);
      assert.equal(first.exitCode, 0);
      assert.deepEqual(Object.keys(first.stdout).sort(), ["command", "ok", "result"]);
      assert.equal(first.stdout.command, "create_ticket");
      assert.equal(first.stdout.result.replayed, false);
      const ticketId = first.stdout.result.ticket.id;
      assert.equal(first.stdout.result.ticket.runId, attribution.runId);
      assert.equal(first.stdout.result.ticket.assigneeAgentId, null);
      assert.equal(first.stdout.result.message.ticketId, ticketId);
      assert.equal(first.stdout.result.message.type, "system");

      const retry = await callAgentTool("create_ticket", input);
      assert.equal(retry.exitCode, 0);
      assert.equal(retry.stdout.result.replayed, true);
      assert.equal(retry.stdout.result.ticket.id, ticketId);
      const rows = await client.query(
        `SELECT (SELECT count(*)::int FROM tickets) AS tickets,
                (SELECT count(*)::int FROM messages) AS messages,
                (SELECT count(*)::int FROM message_enqueues) AS enqueues,
                (SELECT count(*)::int FROM agent_tool_invocations) AS invocations`,
      );
      assert.deepEqual(rows.rows[0], { tickets: 1, messages: 1, enqueues: 1, invocations: 1 });
      const message = await client.query("SELECT run_id, ticket_id, sender, type, payload FROM messages WHERE ticket_id = $1", [ticketId]);
      assert.deepEqual(message.rows[0], {
        run_id: attribution.runId,
        ticket_id: ticketId,
        sender: `agent:${attribution.agentId}`,
        type: "system",
        payload: { action: "create_ticket", agentId: attribution.agentId, runId: attribution.runId, ticketId, idempotencyKey: "agent-turn-1-create" },
      });
    });

    await t.test("update_ticket preserves optimistic concurrency and records its event atomically", async () => {
      const original = await client.query("SELECT * FROM tickets LIMIT 1");
      const input = {
        ...attribution,
        ticketId: String(original.rows[0].id),
        expectedUpdatedAt: String(original.rows[0].updated_at).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
        status: "todo",
        idempotencyKey: "agent-turn-1-update",
      };
      const updated = await callAgentTool("update_ticket", input);
      assert.equal(updated.exitCode, 0);
      assert.equal(updated.stdout.result.ticket.status, "todo");
      assert.equal(updated.stdout.result.message.type, "system");
      const stale = await callAgentTool("update_ticket", { ...input, idempotencyKey: "agent-turn-1-stale", status: "done" });
      assert.equal(stale.exitCode, 1);
      assert.deepEqual(stale.stdout, { ok: false, error: { code: "stale_update", message: "ticket changed since expectedUpdatedAt" } });
      const audit = await client.query(
        "SELECT status, (SELECT count(*)::int FROM messages) AS messages FROM tickets WHERE id = $1",
        [input.ticketId],
      );
      assert.equal(audit.rows[0].status, "todo");
      assert.equal(audit.rows[0].messages, 2);
    });

    await t.test("update_ticket returns the durable blocker set", async () => {
      const proofWorkflow = await client.query(
        "INSERT INTO workflows (name, description, graph) VALUES ('FACT-44 response proof', 'Ticket response proof', '{}') RETURNING id",
      );
      const proofRun = await client.query(
        `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec, workflow_version)
         VALUES ($1, 'running', 'ui', '{"proof":"fact-44"}'::jsonb, now()) RETURNING id`,
        [proofWorkflow.rows[0].id],
      );
      const proofAttribution = { ...attribution, runId: String(proofRun.rows[0].id) };
      const blockerProject = await client.query(
        "INSERT INTO projects (key, name) VALUES ('FRT', 'FACT-44 response proof') RETURNING id",
      );
      const tickets = await client.query(
        `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
         VALUES (1, 'FRT-1', $1, $2, 'first blocker', 'todo', 1),
                (2, 'FRT-2', $1, $2, 'second blocker', 'todo', 1),
                (3, 'FRT-3', $1, $2, 'blocked ticket', 'todo', 1)
         RETURNING id`,
        [blockerProject.rows[0].id, proofAttribution.runId],
      );
      tickets.rows.sort((left, right) => Number(left.id) - Number(right.id));
      const firstBlockerId = String(tickets.rows[0].id);
      const secondBlockerId = String(tickets.rows[1].id);
      const blockedTicketId = String(tickets.rows[2].id);
      const dependencyResult = await callAgentTool("set_ticket_dependencies", {
        ...proofAttribution,
        ticketId: blockedTicketId,
        blockerTicketIds: [secondBlockerId, firstBlockerId],
        idempotencyKey: "agent-turn-1-fact44-dependencies",
      });
      assert.equal(dependencyResult.exitCode, 0);
      assert.deepEqual(dependencyResult.stdout.result.ticket.blockerTicketIds, [firstBlockerId, secondBlockerId]);

      const updated = await callAgentTool("update_ticket", {
        ...proofAttribution,
        ticketId: blockedTicketId,
        expectedUpdatedAt: dependencyResult.stdout.result.ticket.updatedAt,
        title: "blocked ticket renamed",
        idempotencyKey: "agent-turn-1-fact44-update",
      });
      assert.equal(updated.exitCode, 0);
      assert.deepEqual(updated.stdout.result.ticket.blockerTicketIds, [firstBlockerId, secondBlockerId]);
      assert.ok(updated.stdout.result.ticket.blockerTicketIds.every((id) => typeof id === "string"));
    });

    await t.test("post_message accepts feedback and list_tickets returns the run-scoped record", async () => {
      const ticket = await client.query("SELECT id FROM tickets LIMIT 1");
      const question = await callAgentTool("post_message", {
        ...attribution,
        ticketId: String(ticket.rows[0].id),
        recipient: "agent:reviewer",
        type: "feedback",
        payload: { note: "Should the worker retry this action?" },
        handoffBrief: "Need a reviewer decision before proceeding.",
        idempotencyKey: "agent-turn-1-question",
      });
      assert.equal(question.exitCode, 0);
      assert.equal(question.stdout.result.message.type, "feedback");
      assert.deepEqual(question.stdout.result.message.payload, {
        note: "Should the worker retry this action?",
        agentId: attribution.agentId,
        runId: attribution.runId,
        ticketId: String(ticket.rows[0].id),
      });
      const listInput = { ...attribution, idempotencyKey: "agent-turn-1-list" };
      const listed = await callAgentTool("list_tickets", listInput);
      assert.equal(listed.exitCode, 0);
      assert.deepEqual(listed.stdout.result.tickets.map((item) => item.id), [String(ticket.rows[0].id)]);
      assert.equal(listed.stdout.result.nextCursor, null);
      const listRetry = await callAgentTool("list_tickets", listInput);
      assert.equal(listRetry.exitCode, 0);
      assert.equal(listRetry.stdout.result.replayed, true);
      const listInvocation = await client.query(
        `SELECT agent_id, run_id, idempotency_key, response
         FROM agent_tool_invocations
         WHERE idempotency_key = $1`,
        [listInput.idempotencyKey],
      );
      assert.deepEqual(listInvocation.rows, [{
        agent_id: attribution.agentId,
        run_id: attribution.runId,
        idempotency_key: listInput.idempotencyKey,
        response: listed.stdout.result,
      }]);
    });

    await t.test("invalid attribution, malformed ids, conflicting retry keys, and failed mutations leave no partial rows", async () => {
      const before = await client.query("SELECT count(*)::int AS tickets, (SELECT count(*)::int FROM messages) AS messages FROM tickets");
      const missingAgent = await callAgentTool("list_tickets", { runId: attribution.runId, idempotencyKey: "agent-turn-missing-agent" });
      assert.equal(missingAgent.exitCode, 1);
      assert.equal(missingAgent.stdout.error.code, "invalid_id");
      const invalidTicket = await callAgentTool("post_message", {
        ...attribution, ticketId: "999999", recipient: "agent:reviewer", type: "feedback", payload: {}, idempotencyKey: "agent-turn-invalid-ticket",
      });
      assert.equal(invalidTicket.exitCode, 1);
      assert.equal(invalidTicket.stdout.error.code, "ticket_not_found");
      const changedRetry = await callAgentTool("create_ticket", {
        ...attribution, projectId: String(project.rows[0].id), title: "Different retry", idempotencyKey: "agent-turn-1-create",
      });
      assert.equal(changedRetry.exitCode, 1);
      assert.equal(changedRetry.stdout.error.code, "idempotency_key_reused");
      const after = await client.query("SELECT count(*)::int AS tickets, (SELECT count(*)::int FROM messages) AS messages FROM tickets");
      assert.deepEqual(after.rows[0], before.rows[0]);
    });

    await t.test("only the engine can mark a ticket in_progress or assign its first worker", async () => {
      const before = await client.query("SELECT count(*)::int AS tickets, (SELECT count(*)::int FROM messages) AS messages FROM tickets");
      const createInProgress = await callAgentTool("create_ticket", {
        ...attribution,
        projectId: String(project.rows[0].id),
        title: "Self-assigned ticket",
        status: "in_progress",
        idempotencyKey: "agent-turn-engine-owned-create",
      });
      assert.equal(createInProgress.exitCode, 1);
      assert.equal(createInProgress.stdout.error.code, "engine_owned_status");

      const current = await client.query("SELECT * FROM tickets LIMIT 1");
      const updateInProgress = await callAgentTool("update_ticket", {
        ...attribution,
        ticketId: String(current.rows[0].id),
        expectedUpdatedAt: String(current.rows[0].updated_at).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
        status: "in_progress",
        idempotencyKey: "agent-turn-engine-owned-update",
      });
      assert.equal(updateInProgress.exitCode, 1);
      assert.equal(updateInProgress.stdout.error.code, "engine_owned_status");
      const after = await client.query("SELECT count(*)::int AS tickets, (SELECT count(*)::int FROM messages) AS messages FROM tickets");
      assert.deepEqual(after.rows[0], before.rows[0]);
    });
  } finally {
    await Promise.all([client.end(), pool.end()]);
  }
});
