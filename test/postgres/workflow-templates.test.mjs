import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migratePostgres } from "../../scripts/migrate-postgres.mjs";

const { Client } = pg;
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION_DIRECTORY = path.join(REPOSITORY_ROOT, "db", "migrations");
const CURRENT_MAIN_SHA = "e698abb7dc1edb2ff3770689c6dd53d720d8ecc8";
const CURRENT_MAIN_FIXTURE_LABEL = "fact21-current-main-migrations-";
const CURRENT_MAIN_MIGRATIONS = Object.freeze({
  "0001-control-plane.sql": "ffbcb9ffc69835000796f53774eea9d6f7975e3f92e5291e053811b1c5b8bc4b",
  "0002-tickets.sql": "87b4dafd060bbfeb77339d10e22d7f5afa1e403c280e6a7918a8e5c0c26fc948",
  "0003-message-plane.sql": "e85a3505337b53cc029bfc555f638990c153727a88031d92260ac9dd45240df2",
  "0004-message-consumption.sql": "e27c16ae263019262a82dedc1745143aaad2c55bd810052fd7af14e11ba697d2",
  "0009-state-stream-notify.sql": "d0a60856f6ada8c9c05ab5057894b9ade6b7d244969552b984a5d2b34a16fe57",
  "0010-coding-tool-usage.sql": "d316d80026ab8b56ddce15cdd270c6fef9edea793518095edb43434886765524",
  "0011-workflow-engine.sql": "11dc810b3bc4e5dbafe6dabe5cb5449cfa51e52df3232ce3636a41607885e92d",
  "0012-platform-tool-idempotency.sql": "e830c1b37b6add09867c965132ce76f00a0cd350180d36e77eb65b264cbdc80e",
});

test("FACT-21 clean install: seeds both templates on a fresh database", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set for clean-install proof");

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();

    // Fresh database with no prior migrations
    const migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.ok(migration.applied.includes("0013-workflow-templates.sql"), "0013 must be applied");

    // Both templates exist
    const workflows = await client.query(
      "SELECT name, description, is_template FROM workflows ORDER BY name",
    );
    assert.equal(workflows.rows.length, 2, "exactly two template workflows seeded");

    const [first, second] = workflows.rows;
    assert.equal(first.name, "Research Pipeline");
    assert.equal(first.is_template, true);
    assert.ok(first.description.length > 0);
    assert.equal(second.name, "Software Factory");
    assert.equal(second.is_template, true);
    assert.ok(second.description.length > 0);

    // Agents were created
    const agents = await client.query(
      "SELECT name, role, system_prompt, model FROM agents ORDER BY name",
    );
    const agentNames = agents.rows.map((row) => row.name);
    assert.ok(agentNames.includes("Factory Orchestrator"), "orchestrator agent exists");
    assert.ok(agentNames.includes("Factory Planner"), "planner agent exists");
    assert.ok(agentNames.includes("Factory Implementer"), "implementer agent exists");
    assert.ok(agentNames.includes("Factory Tester"), "tester agent exists");
    assert.ok(agentNames.includes("Research Orchestrator"), "research orchestrator exists");
    assert.ok(agentNames.includes("Researcher"), "researcher agent exists");
    assert.ok(agentNames.includes("Synthesizer"), "synthesizer agent exists");
    assert.ok(agentNames.includes("Research Reviewer"), "reviewer agent exists");

    // Two orchestrators share the same name by role — but each has a unique name
    assert.equal(agents.rows.length, 8, "total of 8 agents across both templates");

    // Skills were created
    const skills = await client.query(
      "SELECT name FROM skills ORDER BY name",
    );
    const skillNames = skills.rows.map((row) => row.name);
    assert.ok(skillNames.includes("Code Review"), "Code Review skill exists");
    assert.ok(skillNames.includes("Ticket Management"), "Ticket Management skill exists");
    assert.ok(skillNames.includes("System Design"), "System Design skill exists");
    assert.ok(skillNames.includes("Testing"), "Testing skill exists");
    assert.ok(skillNames.includes("Coding"), "Coding skill exists");
    assert.ok(skillNames.includes("Web Research"), "Web Research skill exists");
    assert.ok(skillNames.includes("Analysis"), "Analysis skill exists");
    assert.ok(skillNames.includes("Writing"), "Writing skill exists");
    assert.equal(skills.rows.length, 8, "total of 8 skills across both templates");

    // Skills are attached to agents
    const attachments = await client.query(
      "SELECT COUNT(*)::int AS count FROM agent_skills",
    );
    assert.ok(attachments.rows[0].count > 0, "skills are attached to agents");

    // Graphs are valid JSON objects with nodes and edges
    for (const workflow of workflows.rows) {
      const full = await client.query(
        "SELECT graph FROM workflows WHERE name = $1",
        [workflow.name],
      );
      const graph = full.rows[0].graph;
      assert.ok(Array.isArray(graph.nodes), `${workflow.name} has nodes`);
      assert.ok(Array.isArray(graph.edges), `${workflow.name} has edges`);
      assert.ok(graph.nodes.length >= 4, `${workflow.name} has at least 4 nodes`);
      assert.ok(graph.edges.length >= 4, `${workflow.name} has at least 4 edges`);

      // Exactly one entry node per graph
      const entryCount = graph.nodes.filter((node) => node.config?.entry === true).length;
      assert.equal(entryCount, 1, `${workflow.name} has exactly one entry node`);
    }
  } finally {
    await client.end().catch(() => {});
  }
});

test("FACT-21 idempotent restart: re-running the migration does not duplicate templates", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set for idempotency proof");

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();

    // Run migration again
    const secondRun = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(secondRun.applied, [], "no new migrations on re-run");

    // Still exactly two templates
    const workflows = await client.query(
      "SELECT name FROM workflows WHERE is_template = true ORDER BY name",
    );
    assert.equal(workflows.rows.length, 2, "still exactly two templates");

    // Still exactly 8 agents (no duplicates)
    const agents = await client.query("SELECT COUNT(*)::int AS count FROM agents");
    assert.equal(agents.rows[0].count, 8, "still exactly 8 agents");
  } finally {
    await client.end().catch(() => {});
  }
});

test("FACT-21 upgrade: applies 0013 on top of current main without touching existing data", async () => {
  const upgradeDatabaseUrl = process.env.ORBITFACTORY_FACT21_UPGRADE_DATABASE_URL;
  assert.ok(upgradeDatabaseUrl, "upgrade proof database URL must be configured");
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), CURRENT_MAIN_FIXTURE_LABEL));
  const client = new Client({ connectionString: upgradeDatabaseUrl });

  try {
    await client.connect();
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT21_UPGRADE_DATABASE);

    // Verify and copy current-main migrations
    for (const [name, expectedChecksum] of Object.entries(CURRENT_MAIN_MIGRATIONS)) {
      const source = path.join(MIGRATION_DIRECTORY, name);
      const contents = await readFile(source);
      assert.equal(
        createHash("sha256").update(contents).digest("hex"),
        expectedChecksum,
        `${name} must still match current main ${CURRENT_MAIN_SHA}`,
      );
      await copyFile(source, path.join(snapshotDirectory, name));
    }

    // Apply current-main migration history
    const mainMigration = await migratePostgres({
      databaseUrl: upgradeDatabaseUrl,
      migrationDirectory: snapshotDirectory,
      log: () => {},
    });
    assert.deepEqual(
      mainMigration.applied,
      Object.keys(CURRENT_MAIN_MIGRATIONS),
      "current-main migrations applied in order",
    );

    // Insert some pre-existing user data that 0013 must not overwrite
    const existing = await client.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('User Agent', 'custom', 'User created agent', 'openrouter/test')
       RETURNING id`,
    );
    const userWorkflow = await client.query(
      `INSERT INTO workflows (name, description, graph, is_template)
       VALUES ('User Workflow', 'Created before migration', '{"nodes":[],"edges":[]}'::jsonb, false)
       RETURNING id`,
    );
    const userSkill = await client.query(
      `INSERT INTO skills (name, description, procedure)
       VALUES ('User Skill', 'User created', 'Do user things.')
       RETURNING id`,
    );

    // Apply FACT-21 migration
    const fact21Migration = await migratePostgres({
      databaseUrl: upgradeDatabaseUrl,
      log: () => {},
    });
    assert.deepEqual(fact21Migration.applied, ["0013-workflow-templates.sql"]);

    // Verify journal
    const journal = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(journal.rows.map((row) => row.version), [
      ...Object.keys(CURRENT_MAIN_MIGRATIONS),
      "0013-workflow-templates.sql",
    ]);

    // User data is preserved
    const userAgent = await client.query("SELECT name FROM agents WHERE id = $1", [existing.rows[0].id]);
    assert.equal(userAgent.rows[0].name, "User Agent");
    const uw = await client.query("SELECT name FROM workflows WHERE id = $1", [userWorkflow.rows[0].id]);
    assert.equal(uw.rows[0].name, "User Workflow");
    const us = await client.query("SELECT name FROM skills WHERE id = $1", [userSkill.rows[0].id]);
    assert.equal(us.rows[0].name, "User Skill");

    // Templates are seeded alongside user data
    const templates = await client.query(
      "SELECT name FROM workflows WHERE is_template = true ORDER BY name",
    );
    assert.equal(templates.rows.length, 2);
    assert.deepEqual(templates.rows.map((row) => row.name), [
      "Research Pipeline",
      "Software Factory",
    ]);
  } finally {
    await client.end().catch(() => {});
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});
