import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { StateEventHub } from "../../src/lib/state-stream.ts";

const { Client } = pg;

async function waitUntil(assertion, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await assertion()) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("FACT-18 committed PostgreSQL state stream", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const hub = new StateEventHub({ connectionString: databaseUrl, reconnectDelayMs: 250 });
  const first = [];
  const second = [];
  const stopFirst = hub.subscribe((event) => first.push(event));
  const stopSecond = hub.subscribe((event) => second.push(event));

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT18_PROOF_DATABASE);
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(migration.applied, [
      "0001-control-plane.sql",
      "0002-tickets.sql",
      "0003-message-plane.sql",
      "0004-message-consumption.sql",
      "0009-state-stream-notify.sql",
    ]);
    await hub.ready();
    assert.equal(first.filter((event) => event.type === "state.resync").length, 1);
    assert.deepEqual(second, first, "initial listeners share the snapshot boundary");
    first.length = 0;
    second.length = 0;

    await client.query("SELECT pg_notify('orbitflow_state_changed', 'not json')");
    await delay(25);
    assert.equal(first.length, 0, "malformed wake-up must not reach clients");

    const project = await client.query(
      "INSERT INTO projects (key, name, next_number) VALUES ('FACT', 'OrbitFactory', 1) RETURNING id",
    );
    const workflow = await client.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('Stream proof', 'FACT-18', '{}') RETURNING id",
    );
    await client.query("BEGIN");
    const agent = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory)
       VALUES ('Stream agent', 'worker', 'Prove notifications.', 'test-model', '{}', '{}', '{}') RETURNING id`,
    );
    await delay(25);
    assert.equal(first.length, 0, "uncommitted state must not wake clients");
    await client.query("COMMIT");
    const run = await client.query(
      `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec)
       VALUES ($1, 'running', 'ui', '{}') RETURNING id`,
      [workflow.rows[0].id],
    );
    const ticket = await client.query(
      `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id)
       VALUES (1, 'FACT-1', $1, $2, 'State stream proof', 'todo', $3) RETURNING id`,
      [project.rows[0].id, run.rows[0].id, agent.rows[0].id],
    );
    await client.query(
      `INSERT INTO messages (run_id, ticket_id, sender, recipient, type, payload)
       VALUES ($1, $2, 'agent:stream', 'agent:next', 'output', '{}')`,
      [run.rows[0].id, ticket.rows[0].id],
    );
    await client.query(
      `INSERT INTO cost_events (run_id, agent_id, model, tokens_in, tokens_out, computed_cost)
       VALUES ($1, $2, 'test-model', 3, 5, 0.01)`,
      [run.rows[0].id, agent.rows[0].id],
    );

    await waitUntil(
      () => first.some((event) => event.type === "cost.created"),
      "all committed state wake-ups",
    );
    assert.deepEqual(second, first, "both independently subscribed clients receive the same envelope");
    const byType = new Map(first.map((event) => [event.type, event]));
    assert.deepEqual(byType.get("agent.created"), {
      schemaVersion: 1,
      type: "agent.created",
      runId: null,
      agentId: String(agent.rows[0].id),
      ticketId: null,
      occurredAt: byType.get("agent.created").occurredAt,
    });
    assert.match(byType.get("ticket.created").occurredAt, /^\d{4}-\d{2}-\d{2}/);
    assert.equal(byType.get("ticket.created").runId, String(run.rows[0].id));
    assert.equal(byType.get("ticket.created").agentId, String(agent.rows[0].id));
    assert.equal(byType.get("ticket.created").ticketId, String(ticket.rows[0].id));
    assert.equal(byType.get("message.created").ticketId, String(ticket.rows[0].id));
    assert.equal(byType.get("cost.created").runId, String(run.rows[0].id));
    assert.equal(byType.get("cost.created").agentId, String(agent.rows[0].id));

    first.length = 0;
    second.length = 0;
    const listener = await client.query(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = 'orbitfactory-state-stream'`,
    );
    assert.equal(listener.rowCount, 1, "proof must find the dedicated LISTEN connection");
    await client.query("SELECT pg_terminate_backend($1)", [listener.rows[0].pid]);
    await waitUntil(() => !hub.listening, "listener loss");

    const missedTicket = await client.query(
      `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, assignee_agent_id)
       VALUES (2, 'FACT-2', $1, $2, 'Committed while LISTEN was down', 'todo', $3) RETURNING id`,
      [project.rows[0].id, run.rows[0].id, agent.rows[0].id],
    );
    assert.equal(first.length, 0, "a committed row during listener loss has no durable stream delivery");
    assert.equal(second.length, 0, "both clients wait for recovery rather than receiving a replay");

    await waitUntil(
      () => first.some((event) => event.type === "state.resync"),
      "resync wake-up after LISTEN recovery",
    );
    assert.deepEqual(second, first, "both clients receive the recovery snapshot boundary");
    const recovery = first.find((event) => event.type === "state.resync");
    assert.deepEqual(recovery, {
      schemaVersion: 1,
      type: "state.resync",
      runId: null,
      agentId: null,
      ticketId: null,
      occurredAt: recovery.occurredAt,
    });
    assert.ok(missedTicket.rows[0].id, "the recovery snapshot has a committed authority row to fetch");
  } finally {
    stopFirst();
    stopSecond();
    await waitUntil(() => !hub.listening, "listener cleanup after last client disconnects");
    await hub.stop();
    await client.end();
  }
});
