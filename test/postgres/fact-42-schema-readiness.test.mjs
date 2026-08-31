import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  assertRequiredMigrationHistory,
  migratePostgres,
  requiredMigrationHistory,
} from "../../scripts/migrate-postgres.mjs";
import { assertProofDatabase } from "./proof-database.mjs";

const { Client } = pg;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationDirectory = path.join(repositoryRoot, "db", "migrations");

async function preLabelRemovalMigrations(destination) {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .filter((name) => Number(name.slice(0, 4)) <= 25)
    .sort();
  await Promise.all(names.map((name) => copyFile(
    path.join(migrationDirectory, name),
    path.join(destination, name),
  )));
  return names;
}

test("FACT-42 readiness requires every committed migration checksum", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertProofDatabase(client, "ORBITFLOW_FACT42_PROOF_DATABASE");
    await migratePostgres({ databaseUrl, log: () => {} });
    const expected = await requiredMigrationHistory();
    assert.deepEqual(await assertRequiredMigrationHistory(client), expected.at(-1));
    const head = expected.at(-1);
    await client.query("UPDATE schema_migrations SET checksum = 'wrong' WHERE version = $1", [head.version]);
    await assert.rejects(() => assertRequiredMigrationHistory(client), /required migration head/);
    await client.query("UPDATE schema_migrations SET checksum = $1 WHERE version = $2", [head.checksum, head.version]);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [head.version]);
    await assert.rejects(() => assertRequiredMigrationHistory(client), /required migration head/);
    await client.query(
      "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
      [head.version, head.checksum],
    );
  } finally {
    await client.end();
  }
});

test("FACT-42 upgrades retained PostgreSQL tickets while removing labels", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "orbitflow-fact42-pre-0026-"));
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await assertProofDatabase(client, "ORBITFLOW_FACT42_PROOF_DATABASE");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const beforeNames = await preLabelRemovalMigrations(snapshotDirectory);
    const before = await migratePostgres({
      databaseUrl,
      migrationDirectory: snapshotDirectory,
      log: () => {},
    });
    assert.deepEqual(before.applied, beforeNames);

    const project = await client.query(
      "INSERT INTO projects (key, name) VALUES ('UPG', 'Retained upgrade data') RETURNING id::text",
    );
    const workflow = await client.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-42 upgrade', 'Retained ticket proof', '{}') RETURNING id::text",
    );
    const run = await client.query(
      `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec)
       VALUES ($1, 'running', 'ui', '{}') RETURNING id::text`,
      [workflow.rows[0].id],
    );
    const ticket = await client.query(
      `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
       VALUES (1, 'UPG-1', $1, $2, 'Retained PostgreSQL ticket', 'todo', 2)
       RETURNING id::text`,
      [project.rows[0].id, run.rows[0].id],
    );
    const label = await client.query(
      "INSERT INTO labels (name, color) VALUES ('retired-label', 'violet') RETURNING id::text",
    );
    await client.query(
      "INSERT INTO ticket_labels (ticket_id, label_id) VALUES ($1, $2)",
      [ticket.rows[0].id, label.rows[0].id],
    );

    const upgrade = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(upgrade.applied, [
      "0026-remove-ticket-labels.sql",
      "0027-workflow-dispatch-ticket-ownership.sql",
    ]);
    const retained = await client.query(
      "SELECT identifier, title, run_id::text FROM tickets WHERE id = $1",
      [ticket.rows[0].id],
    );
    assert.deepEqual(retained.rows, [{
      identifier: "UPG-1",
      title: "Retained PostgreSQL ticket",
      run_id: run.rows[0].id,
    }]);
    const removed = await client.query(
      "SELECT to_regclass('public.labels') AS labels, to_regclass('public.ticket_labels') AS ticket_labels",
    );
    assert.deepEqual(removed.rows, [{ labels: null, ticket_labels: null }]);
  } finally {
    await client.end().catch(() => {});
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});

test("FACT-53 stops ambiguous pre-0027 dispatches before label removal and permits a manual quarantine", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "orbitflow-fact53-pre-0026-"));
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await assertProofDatabase(client, "ORBITFLOW_FACT42_PROOF_DATABASE");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const beforeNames = await preLabelRemovalMigrations(snapshotDirectory);
    const before = await migratePostgres({
      databaseUrl,
      migrationDirectory: snapshotDirectory,
      log: () => {},
    });
    assert.deepEqual(before.applied, beforeNames);

    const project = await client.query(
      "INSERT INTO projects (key, name) VALUES ('CUT', 'FACT-53 cutover proof') RETURNING id::text",
    );
    const agent = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('FACT-53 worker', 'implementer', 'Cutover proof worker.', 'test-model')
       RETURNING id::text`,
    );
    const workflow = await client.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-53 cutover', 'Precondition proof', '{}') RETURNING id::text",
    );
    const run = await client.query(
      `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec)
       VALUES ($1, 'running', 'ui', '{}') RETURNING id::text`,
      [workflow.rows[0].id],
    );
    const duplicateTicket = await client.query(
      `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
       VALUES (1, 'CUT-1', $1, $2, 'Ambiguous dispatch owner', 'in_progress', 2)
       RETURNING id::text`,
      [project.rows[0].id, run.rows[0].id],
    );
    const inconsistentTicket = await client.query(
      `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
       VALUES (2, 'CUT-2', $1, $2, 'Inconsistent active ticket', 'todo', 2)
       RETURNING id::text`,
      [project.rows[0].id, run.rows[0].id],
    );
    const label = await client.query(
      "INSERT INTO labels (name, color) VALUES ('retain-until-safe', 'amber') RETURNING id::text",
    );
    await client.query(
      "INSERT INTO ticket_labels (ticket_id, label_id) VALUES ($1, $2)",
      [duplicateTicket.rows[0].id, label.rows[0].id],
    );

    const sourceMessages = [];
    for (const marker of ["first", "second", "inconsistent"]) {
      const source = await client.query(
        `INSERT INTO messages (run_id, sender, recipient, type, payload)
         VALUES ($1, 'system:fact53', 'agent:fact53', 'system', $2::jsonb)
         RETURNING id::text`,
        [run.rows[0].id, JSON.stringify({ marker })],
      );
      sourceMessages.push(source.rows[0].id);
    }

    const dispatches = [];
    for (const [nodeId, ticketId, sourceMessageId, idempotencyKey] of [
      ["implement", duplicateTicket.rows[0].id, sourceMessages[0], "fact53-duplicate-first"],
      ["implement", duplicateTicket.rows[0].id, sourceMessages[1], "fact53-duplicate-second"],
      ["review", inconsistentTicket.rows[0].id, sourceMessages[2], "fact53-inconsistent-ticket"],
    ]) {
      const dispatch = await client.query(
        `INSERT INTO workflow_dispatches (
           run_id, node_id, agent_id, agent_model, ticket_id, source_message_id,
           status, input, idempotency_key
         ) VALUES ($1, $2, $3, 'test-model', $4, $5, 'pending', '{}', $6)
         RETURNING id::text`,
        [
          run.rows[0].id,
          nodeId,
          agent.rows[0].id,
          ticketId,
          sourceMessageId,
          idempotencyKey,
        ],
      );
      dispatches.push(dispatch.rows[0].id);
    }

    const historyBefore = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    await assert.rejects(
      () => migratePostgres({ databaseUrl, log: () => {} }),
      (error) => {
        assert.match(error.message, /duplicate unfinished run\/node\/ticket ownership/);
        assert.match(error.message, /inconsistent unfinished ticket activity/);
        assert.match(error.message, /Stop or quiesce workflow engine and dispatcher writers/);
        assert.match(error.message, /never deletes, deduplicates, replays, or guesses/);
        assert.match(error.message, /"sourceMessageId"/);
        return true;
      },
    );

    const historyAfterFailure = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(historyAfterFailure.rows, historyBefore.rows);
    assert.deepEqual(historyAfterFailure.rows.map((row) => row.version), beforeNames);
    const retainedLabels = await client.query(
      `SELECT ticket.identifier, label.name, label.color
       FROM ticket_labels
       JOIN tickets AS ticket ON ticket.id = ticket_labels.ticket_id
       JOIN labels AS label ON label.id = ticket_labels.label_id
       ORDER BY ticket.identifier, label.name`,
    );
    assert.deepEqual(retainedLabels.rows, [{
      identifier: "CUT-1",
      name: "retain-until-safe",
      color: "amber",
    }]);
    const labelTables = await client.query(
      "SELECT to_regclass('public.labels') AS labels, to_regclass('public.ticket_labels') AS ticket_labels",
    );
    assert.deepEqual(labelTables.rows, [{ labels: "labels", ticket_labels: "ticket_labels" }]);

    // This is deliberately operator-owned reconciliation. The migrator did not
    // modify these records, infer external effects, or pick a winning dispatch.
    const quarantined = await client.query(
      `UPDATE workflow_dispatches
       SET status = 'failed',
           failure_reason = 'manually quarantined before FACT-53 cutover',
           updated_at = clock_timestamp()
       WHERE id = ANY($1::bigint[]) AND status = 'pending'
       RETURNING id::text`,
      [dispatches],
    );
    assert.equal(quarantined.rowCount, dispatches.length);
    await client.query(
      `UPDATE tickets
       SET status = 'todo', assignee_agent_id = NULL, updated_at = clock_timestamp()
       WHERE id = $1`,
      [duplicateTicket.rows[0].id],
    );

    const upgrade = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(upgrade.applied, [
      "0026-remove-ticket-labels.sql",
      "0027-workflow-dispatch-ticket-ownership.sql",
    ]);
    const journal = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(journal.rows.map((row) => row.version), [
      ...beforeNames,
      "0026-remove-ticket-labels.sql",
      "0027-workflow-dispatch-ticket-ownership.sql",
    ]);
    const quarantinedRows = await client.query(
      `SELECT id::text AS id, status::text AS status, failure_reason
       FROM workflow_dispatches
       WHERE id = ANY($1::bigint[])
       ORDER BY id`,
      [dispatches],
    );
    assert.deepEqual(quarantinedRows.rows, dispatches.slice().sort((left, right) => Number(left) - Number(right)).map((id) => ({
      id,
      status: "failed",
      failure_reason: "manually quarantined before FACT-53 cutover",
    })));
    const removed = await client.query(
      "SELECT to_regclass('public.labels') AS labels, to_regclass('public.ticket_labels') AS ticket_labels, to_regclass('public.workflow_dispatches_run_node_ticket_active_unique') AS ownership_index",
    );
    assert.deepEqual(removed.rows, [{
      labels: null,
      ticket_labels: null,
      ownership_index: "workflow_dispatches_run_node_ticket_active_unique",
    }]);
  } finally {
    await client.end().catch(() => {});
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});
