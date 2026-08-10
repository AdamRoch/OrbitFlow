import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const MIGRATION_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);
const MIGRATION_FILE = /^\d{4}-[a-z0-9-]+\.sql$/;
const LOCK_NAME = "orbitfactory-schema-migrations-v1";

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIRECTORY))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();

  if (names.length === 0) {
    throw new Error(`no migrations found in ${MIGRATION_DIRECTORY}`);
  }

  return Promise.all(
    names.map(async (version) => {
      const sql = await readFile(join(MIGRATION_DIRECTORY, version), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      return { version, checksum, sql };
    }),
  );
}

export async function migratePostgres({
  databaseUrl = process.env.DATABASE_URL,
  log = console.log,
} = {}) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run PostgreSQL migrations");
  }

  const client = new Client({ connectionString: databaseUrl });
  const migrations = await loadMigrations();
  const appliedNow = [];

  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version",
    );
    const applied = new Map(
      result.rows.map((row) => [row.version, row.checksum]),
    );

    for (const migration of migrations) {
      const recordedChecksum = applied.get(migration.version);
      if (recordedChecksum) {
        if (recordedChecksum !== migration.checksum) {
          throw new Error(
            `applied migration ${migration.version} does not match its committed checksum`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      appliedNow.push(migration.version);
      log(`Applied ${migration.version}`);
    }

    if (appliedNow.length === 0) log("No migrations to apply.");
    return { applied: appliedNow };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
    } finally {
      await client.end();
    }
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  migratePostgres().catch((error) => {
    console.error(`PostgreSQL migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
