import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { loadOpenClawModelCatalog } from "../../src/lib/runtime/openclaw-model-catalog.mjs";

const { Client } = pg;
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION_DIRECTORY = path.join(REPOSITORY_ROOT, "db", "migrations");

async function templateAgents(client) {
  return (await client.query(`
    SELECT DISTINCT agent.name, agent.model
    FROM workflows AS workflow
    CROSS JOIN LATERAL jsonb_array_elements(workflow.graph -> 'nodes') AS node
    JOIN agents AS agent ON agent.id = (node ->> 'agentId')::bigint
    WHERE workflow.is_template = true
    ORDER BY agent.name
  `)).rows;
}

test("FACT-35 fresh install seeds only runtime-registered template agent models", async () => {
  const databaseUrl = process.env.ORBITFACTORY_FACT35_FRESH_DATABASE_URL;
  assert.ok(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.ok(migration.applied.includes("0024-factory-agent-model-catalog.sql"));
    const catalog = await loadOpenClawModelCatalog();
    const agents = await templateAgents(client);
    assert.equal(agents.length, 8);
    assert.ok(agents.every((agent) => agent.model === catalog.primaryModel));
    assert.ok(agents.every((agent) => catalog.availableModels.includes(agent.model)));
  } finally {
    await client.end();
  }
});

test("FACT-35 upgrade realigns existing template agents without changing unrelated agents", async () => {
  const databaseUrl = process.env.ORBITFACTORY_FACT35_UPGRADE_DATABASE_URL;
  assert.ok(databaseUrl);
  const priorDirectory = await mkdtemp(path.join(tmpdir(), "orbitflow-fact35-prior-"));
  const client = new Client({ connectionString: databaseUrl });
  try {
    for (const name of await readdir(MIGRATION_DIRECTORY)) {
      if (/^\d{4}-.*\.sql$/.test(name) && name !== "0024-factory-agent-model-catalog.sql") {
        await copyFile(path.join(MIGRATION_DIRECTORY, name), path.join(priorDirectory, name));
      }
    }
    await migratePostgres({ databaseUrl, migrationDirectory: priorDirectory, log: () => {} });
    await client.connect();
    const before = await templateAgents(client);
    assert.ok(before.some((agent) => agent.model === "openrouter/anthropic/claude-3.5-sonnet"));
    const unrelated = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('User Agent', 'custom', 'Preserve me.', 'openrouter/user-selected')
       RETURNING id`,
    );

    const upgraded = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(upgraded.applied, ["0024-factory-agent-model-catalog.sql"]);
    const catalog = await loadOpenClawModelCatalog();
    assert.ok((await templateAgents(client)).every((agent) => agent.model === catalog.primaryModel));
    const userAgent = await client.query("SELECT model FROM agents WHERE id = $1", [unrelated.rows[0].id]);
    assert.equal(userAgent.rows[0].model, "openrouter/user-selected");
  } finally {
    await client.end().catch(() => {});
    await rm(priorDirectory, { recursive: true, force: true });
  }
});
