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
const CURRENT_MAIN_SHA = "dc7351a5e017ac91460fcb120acf4beb2292717d";
const CURRENT_MAIN_FIXTURE_LABEL = "fact10-live-main-dc7351a-migrations-";
const CURRENT_MAIN_MIGRATIONS = Object.freeze({
  "0001-control-plane.sql": "ffbcb9ffc69835000796f53774eea9d6f7975e3f92e5291e053811b1c5b8bc4b",
  "0002-tickets.sql": "87b4dafd060bbfeb77339d10e22d7f5afa1e403c280e6a7918a8e5c0c26fc948",
  "0003-message-plane.sql": "e85a3505337b53cc029bfc555f638990c153727a88031d92260ac9dd45240df2",
  "0004-message-consumption.sql": "e27c16ae263019262a82dedc1745143aaad2c55bd810052fd7af14e11ba697d2",
  "0009-state-stream-notify.sql": "d0a60856f6ada8c9c05ab5057894b9ade6b7d244969552b984a5d2b34a16fe57",
  "0010-coding-tool-usage.sql": "d316d80026ab8b56ddce15cdd270c6fef9edea793518095edb43434886765524",
});

test(`FACT-10 upgrades the exact ${CURRENT_MAIN_SHA} migration history forward`, async () => {
  const databaseUrl = process.env.ORBITFACTORY_FACT12_UPGRADE_DATABASE_URL;
  assert.ok(databaseUrl, "upgrade proof database URL must be configured");
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), CURRENT_MAIN_FIXTURE_LABEL));
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT12_UPGRADE_DATABASE);

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

    const mainMigration = await migratePostgres({
      databaseUrl,
      migrationDirectory: snapshotDirectory,
      log: () => {},
    });
    assert.deepEqual(mainMigration.applied, Object.keys(CURRENT_MAIN_MIGRATIONS));

    const fact10Migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(fact10Migration.applied, ["0011-workflow-engine.sql"]);

    const journal = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      journal.rows.map((row) => row.version),
      [...Object.keys(CURRENT_MAIN_MIGRATIONS), "0011-workflow-engine.sql"],
    );
    const columns = await client.query(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cost_events'
         AND column_name IN (
           'tokens_in', 'tokens_out', 'computed_cost',
           'cache_read_tokens', 'cache_write_tokens'
         )
       ORDER BY column_name`,
    );
    assert.deepEqual(columns.rows, [
      { column_name: "cache_read_tokens", is_nullable: "YES" },
      { column_name: "cache_write_tokens", is_nullable: "YES" },
      { column_name: "computed_cost", is_nullable: "YES" },
      { column_name: "tokens_in", is_nullable: "YES" },
      { column_name: "tokens_out", is_nullable: "YES" },
    ]);
  } finally {
    await client.end().catch(() => {});
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});
