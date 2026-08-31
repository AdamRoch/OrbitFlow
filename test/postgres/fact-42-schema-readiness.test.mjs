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
    assert.deepEqual(upgrade.applied, ["0026-remove-ticket-labels.sql"]);
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
