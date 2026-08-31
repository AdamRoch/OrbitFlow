import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  DEFAULT_OPENCLAW_CONFIG,
  loadOpenClawModelCatalog,
} from "../src/lib/runtime/openclaw-model-catalog.mjs";

const { Client } = pg;
const DEFAULT_MIGRATION_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "db",
  "migrations",
);
const MIGRATION_FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;
export const MIGRATION_LOCK_NAME = "orbitfactory-schema-migrations-v1";
const LATE_RESERVED_MIGRATION = "0024-factory-agent-model-catalog.sql";
const MERGED_SUCCESSOR_MIGRATION = "0025-factory-project.sql";

export async function loadMigrations(migrationDirectory) {
  const names = (await readdir(migrationDirectory))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();

  if (names.length === 0) {
    throw new Error(`no migrations found in ${migrationDirectory}`);
  }

  const migrations = await Promise.all(
    names.map(async (version) => {
      const match = MIGRATION_FILE.exec(version);
      const ordinal = Number(match[1]);
      const sql = await readFile(join(migrationDirectory, version), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      return { version, ordinal, checksum, sql };
    }),
  );

  const ordinals = new Set();
  for (const migration of migrations) {
    if (ordinals.has(migration.ordinal)) {
      throw new Error(
        `migration ordinal ${String(migration.ordinal).padStart(4, "0")} is duplicated`,
      );
    }
    ordinals.add(migration.ordinal);
  }

  return migrations.sort(
    (left, right) => left.ordinal - right.ordinal || left.version.localeCompare(right.version),
  );
}

export async function requiredMigrationHistory({
  migrationDirectory = DEFAULT_MIGRATION_DIRECTORY,
} = {}) {
  const migrations = await loadMigrations(migrationDirectory);
  return migrations.map(({ version, checksum }) => ({ version, checksum }));
}

/** A reachable database is not ready until its migration history is exact. */
export async function assertRequiredMigrationHistory(queryable, options = {}) {
  const expected = await requiredMigrationHistory(options);
  const result = await queryable.query(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  const actual = result.rows.map((row) => ({
    version: String(row.version),
    checksum: String(row.checksum),
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("PostgreSQL schema is not at the required migration head");
  }
  const head = expected.at(-1);
  if (!head) throw new Error("no committed PostgreSQL migrations exist");
  return head;
}

function validateAppliedHistory(migrations, applied) {
  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );

  for (const version of applied.keys()) {
    if (!migrationsByVersion.has(version)) {
      throw new Error(
        `applied migration ${version} is missing from the committed migration directory`,
      );
    }
  }

  let firstPending = null;
  for (const migration of migrations) {
    const recordedChecksum = applied.get(migration.version);
    if (!recordedChecksum) {
      firstPending ??= migration;
      continue;
    }

    if (recordedChecksum !== migration.checksum) {
      throw new Error(
        `applied migration ${migration.version} does not match its committed checksum`,
      );
    }

    const isReservedConcurrencyRepair =
      firstPending?.version === LATE_RESERVED_MIGRATION &&
      migration.version === MERGED_SUCCESSOR_MIGRATION;
    if (firstPending && !isReservedConcurrencyRepair) {
      throw new Error(
        `unapplied migration ${firstPending.version} was introduced before already-applied ${migration.version}`,
      );
    }
  }
}

export async function migratePostgres({
  databaseUrl = process.env.DATABASE_URL,
  log = console.log,
  migrationDirectory = DEFAULT_MIGRATION_DIRECTORY,
  openClawConfigPath = DEFAULT_OPENCLAW_CONFIG,
} = {}) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run PostgreSQL migrations");
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "orbitfactory-migrator",
  });
  const migrations = await loadMigrations(migrationDirectory);
  const modelCatalog = await loadOpenClawModelCatalog(openClawConfigPath);
  const appliedNow = [];
  let connected = false;
  let lockAcquired = false;

  try {
    await client.connect();
    connected = true;
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      MIGRATION_LOCK_NAME,
    ]);
    lockAcquired = true;
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
    validateAppliedHistory(migrations, applied);

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;

      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT set_config('orbitflow.openclaw_primary_model', $1, true)",
          [modelCatalog.primaryModel],
        );
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
      if (lockAcquired) {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          MIGRATION_LOCK_NAME,
        ]);
      }
    } finally {
      if (connected) await client.end();
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
