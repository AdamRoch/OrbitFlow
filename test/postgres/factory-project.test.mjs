import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import {
  dispatchPlatformTool,
  PlatformToolError,
} from "../../src/lib/platform-tools/dispatch.ts";

const { Client, Pool } = pg;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const migrationDirectory = path.join(repositoryRoot, "db", "migrations");
const factoryProjectMigration = "0025-factory-project.sql";

async function migrationNames() {
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
}

async function copyPreFactoryMigrations(destination) {
  const names = (await migrationNames()).filter(
    (name) => Number(name.slice(0, 4)) < 25,
  );
  await Promise.all(
    names.map((name) =>
      copyFile(path.join(migrationDirectory, name), path.join(destination, name)),
    ),
  );
  return names;
}

test("FACT-36 provisions a discoverable Factory project on a fresh database", async () => {
  const databaseUrl = process.env.ORBITFACTORY_FACT36_FRESH_DATABASE_URL;
  assert.ok(databaseUrl, "fresh proof database URL must be configured");

  const migration = await migratePostgres({ databaseUrl, log: () => {} });
  assert.deepEqual(migration.applied, await migrationNames());

  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl });
  await client.connect();
  try {
    const seeded = await client.query(
      "SELECT id::text, key, name, next_number::text FROM projects WHERE key = 'FACT'",
    );
    assert.equal(seeded.rowCount, 1);
    assert.deepEqual(seeded.rows, [
      { id: seeded.rows[0].id, key: "FACT", name: "Software Factory", next_number: "0" },
    ]);

    const planner = await client.query(
      "SELECT id::text FROM agents WHERE name = 'Factory Planner'",
    );
    const workflow = await client.query(
      "SELECT id::text FROM workflows WHERE name = 'Software Factory' AND is_template = true",
    );
    assert.equal(planner.rowCount, 1);
    assert.equal(workflow.rowCount, 1);
    const run = await client.query(
      `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec)
       VALUES ($1, 'running', 'ui', '{"proof":"fact-36"}'::jsonb)
       RETURNING id::text`,
      [workflow.rows[0].id],
    );
    const attribution = {
      agentId: planner.rows[0].id,
      runId: run.rows[0].id,
    };

    const listed = await dispatchPlatformTool(pool, "list_projects", {
      ...attribution,
      limit: 50,
      idempotencyKey: "fact36-list-projects",
    });
    assert.ok("projects" in listed);
    const discovered = listed.projects.find((project) => project.key === "FACT");
    assert.ok(discovered, "Factory Planner must discover FACT through list_projects");

    const created = await dispatchPlatformTool(pool, "create_ticket", {
      ...attribution,
      projectId: discovered.id,
      title: "Ticket created from discovered project",
      status: "todo",
      priority: 1,
      idempotencyKey: "fact36-create-ticket",
    });
    assert.ok("ticket" in created);
    assert.equal(created.ticket.projectId, discovered.id);
    assert.equal(created.ticket.identifier, "FACT-1");

    await assert.rejects(
      () =>
        dispatchPlatformTool(pool, "create_ticket", {
          ...attribution,
          projectId: "9223372036854775807",
          title: "Must not be created",
          idempotencyKey: "fact36-invented-project",
        }),
      (error) => {
        assert.ok(error instanceof PlatformToolError);
        assert.equal(error.code, "project_not_found");
        return true;
      },
    );
    const afterFailure = await client.query(
      `SELECT
         (SELECT count(*)::int FROM tickets) AS tickets,
         (SELECT next_number::int FROM projects WHERE key = 'FACT') AS next_number,
         (SELECT count(*)::int FROM agent_tool_invocations
          WHERE idempotency_key = 'fact36-invented-project') AS failed_invocations`,
    );
    assert.deepEqual(afterFailure.rows[0], {
      tickets: 1,
      next_number: 1,
      failed_invocations: 0,
    });
  } finally {
    await pool.end();
    await client.end();
  }
});

test("FACT-36 upgrades an existing database forward without replacing its projects", async () => {
  const databaseUrl = process.env.ORBITFACTORY_FACT36_UPGRADE_DATABASE_URL;
  assert.ok(databaseUrl, "upgrade proof database URL must be configured");
  const snapshotDirectory = await mkdtemp(
    path.join(tmpdir(), "fact36-pre-project-migrations-"),
  );
  const client = new Client({ connectionString: databaseUrl });

  try {
    const preFactoryMigrations = await copyPreFactoryMigrations(snapshotDirectory);
    const before = await migratePostgres({
      databaseUrl,
      migrationDirectory: snapshotDirectory,
      log: () => {},
    });
    assert.deepEqual(before.applied, preFactoryMigrations);

    await client.connect();
    const legacy = await client.query(
      `INSERT INTO projects (key, name, next_number)
       VALUES ('OLD', 'Existing project', 7)
       RETURNING id::text, created_at`,
    );

    const upgrade = await migratePostgres({ databaseUrl, log: () => {} });
    const expectedUpgrade = (await migrationNames()).filter(
      (name) => Number(name.slice(0, 4)) >= 25,
    );
    assert.deepEqual(upgrade.applied, expectedUpgrade);
    assert.ok(upgrade.applied.includes(factoryProjectMigration));
    const firstState = await client.query(
      "SELECT id::text, key, name, next_number::text, created_at FROM projects ORDER BY key",
    );
    assert.deepEqual(firstState.rows, [
      {
        id: firstState.rows[0].id,
        key: "FACT",
        name: "Software Factory",
        next_number: "0",
        created_at: firstState.rows[0].created_at,
      },
      {
        id: legacy.rows[0].id,
        key: "OLD",
        name: "Existing project",
        next_number: "7",
        created_at: legacy.rows[0].created_at,
      },
    ]);

    const rerun = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(rerun.applied, []);
    const secondState = await client.query(
      "SELECT id::text, key, name, next_number::text, created_at FROM projects ORDER BY key",
    );
    assert.deepEqual(secondState.rows, firstState.rows);
  } finally {
    await client.end().catch(() => {});
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});
