import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  assertRequiredMigrationHistory,
  migratePostgres,
  requiredMigrationHistory,
} from "../../scripts/migrate-postgres.mjs";

const { Client } = pg;

test("FACT-42 readiness requires every committed migration checksum", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
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
