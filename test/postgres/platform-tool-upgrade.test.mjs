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
const CURRENT_MAIN_SHA = "3ef7f0c82ca141cc9e6452a65721b5892a84246b";
const CURRENT_MAIN_FIXTURE_LABEL = "fact13-current-main-migrations-";
const CURRENT_MAIN_MIGRATIONS = Object.freeze({
  "0001-control-plane.sql": "ffbcb9ffc69835000796f53774eea9d6f7975e3f92e5291e053811b1c5b8bc4b",
  "0002-tickets.sql": "87b4dafd060bbfeb77339d10e22d7f5afa1e403c280e6a7918a8e5c0c26fc948",
  "0003-message-plane.sql": "e85a3505337b53cc029bfc555f638990c153727a88031d92260ac9dd45240df2",
  "0004-message-consumption.sql": "e27c16ae263019262a82dedc1745143aaad2c55bd810052fd7af14e11ba697d2",
  "0009-state-stream-notify.sql": "d0a60856f6ada8c9c05ab5057894b9ade6b7d244969552b984a5d2b34a16fe57",
  "0010-coding-tool-usage.sql": "d316d80026ab8b56ddce15cdd270c6fef9edea793518095edb43434886765524",
  "0011-workflow-engine.sql": "11dc810b3bc4e5dbafe6dabe5cb5449cfa51e52df3232ce3636a41607885e92d",
});

test(`FACT-13 upgrades the exact ${CURRENT_MAIN_SHA} migration history forward`, async () => {
  const databaseUrl = process.env.ORBITFACTORY_FACT13_UPGRADE_DATABASE_URL;
  assert.ok(databaseUrl, "upgrade proof database URL must be configured");
  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), CURRENT_MAIN_FIXTURE_LABEL));
  const client = new Client({ connectionString: databaseUrl });

  try {
    await client.connect();
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT13_UPGRADE_DATABASE);

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

    const fact13Migration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(fact13Migration.applied, ["0012-platform-tool-idempotency.sql"]);

    const journal = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(journal.rows.map((row) => row.version), [
      ...Object.keys(CURRENT_MAIN_MIGRATIONS),
      "0012-platform-tool-idempotency.sql",
    ]);
  } finally {
    await client.end().catch(() => {});
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
});
