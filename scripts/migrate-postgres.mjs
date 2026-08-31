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
const WORKFLOW_DISPATCH_TICKET_OWNERSHIP_MIGRATION =
  "0027-workflow-dispatch-ticket-ownership.sql";
const CUTOVER_DIAGNOSTIC_LIMIT = 20;
const CUTOVER_DISPATCH_SAMPLE_LIMIT = 4;
const UNFINISHED_WORKFLOW_DISPATCH_STATUSES = `
  'pending', 'dispatching', 'reconciling', 'active'
`;

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

function cutoverPreconditionError(diagnostics) {
  const rendered = JSON.stringify(diagnostics);
  const categories = [];
  if (diagnostics.duplicateUnfinishedRunNodeTicketOwnership?.count !== undefined
    && diagnostics.duplicateUnfinishedRunNodeTicketOwnership.count !== "0") {
    categories.push(
      `duplicate unfinished run/node/ticket ownership: ${diagnostics.duplicateUnfinishedRunNodeTicketOwnership.count}`,
    );
  }
  if (diagnostics.inconsistentUnfinishedTicketActivity?.count !== undefined
    && diagnostics.inconsistentUnfinishedTicketActivity.count !== "0") {
    categories.push(
      `inconsistent unfinished ticket activity: ${diagnostics.inconsistentUnfinishedTicketActivity.count}`,
    );
  }
  if (diagnostics.schema) categories.push(`schema check: ${diagnostics.schema}`);
  const categorySummary = categories.length === 0 ? "" : `${categories.join("; ")}. `;
  return new Error(
    `PostgreSQL cutover precondition failed before ${WORKFLOW_DISPATCH_TICKET_OWNERSHIP_MIGRATION}. `
    + "Stop or quiesce workflow engine and dispatcher writers, then manually reconcile or quarantine the listed activity before retrying. "
    + "The migrator never deletes, deduplicates, replays, or guesses about external effects. "
    + categorySummary
    + `Bounded diagnostics: ${rendered}`,
  );
}

/**
 * 0027 adds an unfinished run/node/ticket uniqueness boundary. This check runs
 * before any pending file can commit because a later 0027 failure must not
 * leave an operator with an already-applied 0026 label removal.
 */
export async function assertWorkflowDispatchTicketOwnershipCutoverPreconditions(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const relations = await client.query(
      `SELECT to_regclass('public.workflow_dispatches') AS workflow_dispatches,
              to_regclass('public.tickets') AS tickets`,
    );
    const relation = relations.rows[0];
    if (!relation?.workflow_dispatches) {
      await client.query("COMMIT");
      return;
    }
    if (!relation.tickets) {
      throw cutoverPreconditionError({
        schema: "workflow_dispatches exists but tickets is unavailable",
      });
    }

    const duplicateCount = await client.query(
      `SELECT count(*)::text AS count
       FROM (
         SELECT dispatch.run_id, dispatch.node_id, dispatch.ticket_id
         FROM workflow_dispatches AS dispatch
         WHERE dispatch.ticket_id IS NOT NULL
           AND dispatch.status IN (${UNFINISHED_WORKFLOW_DISPATCH_STATUSES})
         GROUP BY dispatch.run_id, dispatch.node_id, dispatch.ticket_id
         HAVING count(*) > 1
       ) AS duplicate_owner`,
    );
    const inconsistentCount = await client.query(
      `SELECT count(*)::text AS count
       FROM workflow_dispatches AS dispatch
       JOIN tickets AS ticket ON ticket.id = dispatch.ticket_id
       WHERE dispatch.ticket_id IS NOT NULL
         AND dispatch.status IN (${UNFINISHED_WORKFLOW_DISPATCH_STATUSES})
         AND (
           ticket.run_id IS DISTINCT FROM dispatch.run_id
           OR ticket.status <> 'in_progress'
         )`,
    );

    const duplicateOwnershipCount = duplicateCount.rows[0]?.count ?? "0";
    const inconsistentActivityCount = inconsistentCount.rows[0]?.count ?? "0";
    if (duplicateOwnershipCount === "0" && inconsistentActivityCount === "0") {
      await client.query("COMMIT");
      return;
    }

    const duplicateSamples = await client.query(
      `WITH duplicate_owner AS (
         SELECT dispatch.run_id, dispatch.node_id, dispatch.ticket_id,
                count(*)::int AS dispatch_count
         FROM workflow_dispatches AS dispatch
         WHERE dispatch.ticket_id IS NOT NULL
           AND dispatch.status IN (${UNFINISHED_WORKFLOW_DISPATCH_STATUSES})
         GROUP BY dispatch.run_id, dispatch.node_id, dispatch.ticket_id
         HAVING count(*) > 1
       ), selected_owner AS (
         SELECT *
         FROM duplicate_owner
         ORDER BY run_id, node_id, ticket_id
         LIMIT $1
       ), ranked_dispatch AS (
         SELECT dispatch.run_id, dispatch.node_id, dispatch.ticket_id,
                dispatch.id, dispatch.source_message_id, dispatch.status,
                row_number() OVER (
                  PARTITION BY dispatch.run_id, dispatch.node_id, dispatch.ticket_id
                  ORDER BY dispatch.id
                ) AS sample_number
         FROM workflow_dispatches AS dispatch
         JOIN selected_owner AS owner
           ON owner.run_id = dispatch.run_id
          AND owner.node_id = dispatch.node_id
          AND owner.ticket_id = dispatch.ticket_id
         WHERE dispatch.status IN (${UNFINISHED_WORKFLOW_DISPATCH_STATUSES})
       )
       SELECT owner.run_id::text AS "runId",
              left(owner.node_id, 120) AS "nodeId",
              owner.ticket_id::text AS "ticketId",
              owner.dispatch_count::text AS "unfinishedDispatchCount",
              json_agg(
                json_build_object(
                  'dispatchId', ranked.id::text,
                  'sourceMessageId', ranked.source_message_id::text,
                  'status', ranked.status::text
                ) ORDER BY ranked.id
              ) FILTER (WHERE ranked.sample_number <= $2) AS dispatches
       FROM selected_owner AS owner
       JOIN ranked_dispatch AS ranked
         ON ranked.run_id = owner.run_id
        AND ranked.node_id = owner.node_id
        AND ranked.ticket_id = owner.ticket_id
       GROUP BY owner.run_id, owner.node_id, owner.ticket_id, owner.dispatch_count
       ORDER BY owner.run_id, owner.node_id, owner.ticket_id
       `,
      [CUTOVER_DIAGNOSTIC_LIMIT, CUTOVER_DISPATCH_SAMPLE_LIMIT],
    );
    const inconsistentSamples = await client.query(
      `SELECT dispatch.id::text AS "dispatchId",
              dispatch.run_id::text AS "dispatchRunId",
              left(dispatch.node_id, 120) AS "nodeId",
              dispatch.ticket_id::text AS "ticketId",
              dispatch.status::text AS "dispatchStatus",
              ticket.run_id::text AS "ticketRunId",
              ticket.status::text AS "ticketStatus",
              CASE
                WHEN ticket.run_id IS DISTINCT FROM dispatch.run_id THEN 'ticket_run_mismatch'
                ELSE 'unfinished_dispatch_ticket_not_in_progress'
              END AS issue
       FROM workflow_dispatches AS dispatch
       JOIN tickets AS ticket ON ticket.id = dispatch.ticket_id
       WHERE dispatch.ticket_id IS NOT NULL
         AND dispatch.status IN (${UNFINISHED_WORKFLOW_DISPATCH_STATUSES})
         AND (
           ticket.run_id IS DISTINCT FROM dispatch.run_id
           OR ticket.status <> 'in_progress'
         )
       ORDER BY dispatch.id
       LIMIT $1`,
      [CUTOVER_DIAGNOSTIC_LIMIT],
    );

    throw cutoverPreconditionError({
      duplicateUnfinishedRunNodeTicketOwnership: {
        count: duplicateOwnershipCount,
        samples: duplicateSamples.rows,
      },
      inconsistentUnfinishedTicketActivity: {
        count: inconsistentActivityCount,
        samples: inconsistentSamples.rows,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
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

    const pendingMigrations = migrations.filter(
      (migration) => !applied.has(migration.version),
    );
    if (pendingMigrations.some(
      (migration) => migration.version === WORKFLOW_DISPATCH_TICKET_OWNERSHIP_MIGRATION,
    )) {
      await assertWorkflowDispatchTicketOwnershipCutoverPreconditions(client);
    }

    for (const migration of pendingMigrations) {
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
