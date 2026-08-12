import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  MIGRATION_LOCK_NAME,
  migratePostgres,
} from "../../scripts/migrate-postgres.mjs";

const { Client } = pg;
const FAILED_MIGRATION_DIRECTORY = fileURLToPath(
  new URL("./fixtures/failed-migration", import.meta.url),
);
const MIGRATION_DIRECTORY = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);
const MIGRATION_FILE = /^\d{4}-[a-z0-9-]+\.sql$/;

async function committedMigrationFiles() {
  return (await readdir(MIGRATION_DIRECTORY))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
}

const expectedColumns = {
  schema_migrations: ["version", "checksum", "applied_at"],
  projects: ["id", "key", "name", "next_number", "created_at", "updated_at"],
  agents: [
    "id",
    "name",
    "role",
    "system_prompt",
    "model",
    "coding_tool_enabled",
    "guardrails",
    "interaction_rules",
    "channel_binding",
    "memory",
    "openclaw_ref",
    "created_at",
    "updated_at",
  ],
  skills: [
    "id",
    "name",
    "description",
    "procedure",
    "created_at",
    "updated_at",
  ],
  agent_skills: [
    "id",
    "agent_id",
    "skill_id",
    "created_at",
    "updated_at",
  ],
  workflows: [
    "id",
    "name",
    "description",
    "graph",
    "is_template",
    "created_at",
    "updated_at",
  ],
  workflow_runs: [
    "id",
    "workflow_id",
    "status",
    "trigger_type",
    "spec",
    "started_at",
    "ended_at",
    "total_tokens",
    "total_cost",
    "created_at",
    "updated_at",
    "failure_reason",
    "graph_snapshot",
  ],
  labels: ["id", "name", "color", "created_at", "updated_at"],
  tickets: [
    "id",
    "number",
    "identifier",
    "project_id",
    "run_id",
    "title",
    "description",
    "acceptance_criteria",
    "status",
    "priority",
    "assignee_agent_id",
    "created_at",
    "updated_at",
  ],
  ticket_labels: [
    "id",
    "ticket_id",
    "label_id",
    "created_at",
    "updated_at",
  ],
  dependencies: [
    "id",
    "project_id",
    "blocker_ticket_id",
    "blocked_ticket_id",
    "created_at",
    "updated_at",
  ],
  messages: [
    "id",
    "run_id",
    "ticket_id",
    "sequence_number",
    "sender",
    "recipient",
    "type",
    "payload",
    "handoff_brief",
    "token_usage",
    "created_at",
    "updated_at",
  ],
  message_consumer_runs: [
    "run_id",
    "next_sequence_number",
    "last_consumed_at",
  ],
  message_enqueues: ["message_id", "enqueued_at"],
  message_ready_runs: ["run_id", "message_id", "ready_at"],
  message_consumptions: ["message_id", "consumer_id", "consumed_at"],
  telegram_inbound_updates: ["update_id", "run_id", "message_id", "received_at"],
  telegram_outbound_deliveries: ["message_id", "status", "telegram_message_id", "claimed_at", "sent_at", "failure_reason"],
  channel_intakes: [
    "run_id", "workflow_id", "provider", "conversation_key", "status",
    "last_inbound_message_id", "last_question", "clarification_count",
    "validated_spec", "created_at", "updated_at",
  ],
  channel_completion_events: [
    "run_id", "completion_message_id", "final_outbound_message_id", "created_at", "reported_at",
  ],
  agent_tool_invocations: ["agent_id", "run_id", "idempotency_key", "request_hash", "response", "created_at", "updated_at"],
  agent_wake_events: [
    "id",
    "run_id",
    "agent_id",
    "dispatch_id",
    "lease_generation",
    "created_at",
    "updated_at",
  ],
  workflow_fanout_groups: [
    "id",
    "run_id",
    "source_message_id",
    "node_id",
    "agent_id",
    "agent_model",
    "node_config",
    "max_concurrency",
    "created_at",
    "updated_at",
  ],
  workflow_fanout_members: [
    "fanout_group_id",
    "position",
    "ticket_id",
    "created_at",
  ],
  workflow_dispatches: [
    "id",
    "run_id",
    "node_id",
    "agent_id",
    "agent_model",
    "ticket_id",
    "source_message_id",
    "fanout_group_id",
    "status",
    "input",
    "idempotency_key",
    "attempt_count",
    "lease_generation",
    "runtime_generation",
    "lease_owner",
    "lease_expires_at",
    "runtime_session_id",
    "output_message_id",
    "reconciliation_reason",
    "failure_reason",
    "created_at",
    "updated_at",
  ],
  workflow_thread_states: [
    "id",
    "run_id",
    "ticket_id",
    "status",
    "pause_reason",
    "created_at",
    "updated_at",
  ],
  schedules: [
    "id",
    "cron_expression",
    "workflow_id",
    "agent_id",
    "task_prompt",
    "enabled",
    "created_at",
    "updated_at",
  ],
  schedule_ticks: ["id", "schedule_id", "tick_key", "run_id", "message_id", "created_at"],
  schedule_agent_workflows: ["schedule_id", "workflow_id", "created_at"],
  cost_events: [
    "id",
    "run_id",
    "agent_id",
    "model",
    "tokens_in",
    "tokens_out",
    "computed_cost",
    "created_at",
    "updated_at",
    "cache_read_tokens",
    "cache_write_tokens",
  ],
};

const expectedEnums = {
  message_type: [
    "output",
    "feedback",
    "question",
    "answer",
    "channel_inbound",
    "channel_outbound",
    "cron_tick",
    "system",
  ],
  ticket_status: ["backlog", "todo", "in_progress", "done", "canceled"],
  workflow_run_status: [
    "pending",
    "running",
    "paused",
    "completed",
    "failed",
    "canceled",
  ],
  workflow_trigger_type: ["channel", "ui", "cron"],
  workflow_dispatch_status: [
    "pending",
    "dispatching",
    "reconciling",
    "active",
    "completed",
    "failed",
  ],
  workflow_thread_status: ["running", "paused"],
  telegram_outbound_delivery_status: ["sending", "sent", "indeterminate"],
  channel_intake_status: ["collecting", "ready", "failed"],
};

const requiredConstraints = [
  "agent_skills_agent_skill_unique",
  "agent_wake_events_lease_generation_positive",
  "agent_wake_events_start_unique",
  "agents_channel_binding_object",
  "agents_guardrails_object",
  "agents_interaction_rules_object",
  "agents_memory_object",
  "agents_openclaw_ref_unique",
  "agent_tool_invocations_hash_format",
  "agent_tool_invocations_key_not_blank",
  "agent_tool_invocations_response_object",
  "cost_events_cache_read_tokens_nonnegative",
  "cost_events_cache_write_tokens_nonnegative",
  "cost_events_computed_cost_nonnegative",
  "cost_events_tokens_in_nonnegative",
  "cost_events_tokens_out_nonnegative",
  "dependencies_blocked_ticket_fk",
  "dependencies_blocker_ticket_fk",
  "dependencies_edge_unique",
  "dependencies_not_self",
  "messages_payload_object",
  "messages_run_sequence_unique",
  "messages_sequence_positive",
  "messages_token_usage_nonnegative",
  "messages_token_usage_object",
  "message_consumer_runs_sequence_positive",
  "message_consumptions_consumer_not_blank",
  "message_ready_runs_state_complete",
  "telegram_outbound_deliveries_state_complete",
  "channel_intakes_clarification_nonnegative",
  "channel_intakes_conversation_not_blank",
  "channel_intakes_provider_not_blank",
  "channel_intakes_spec_object",
  "channel_intakes_state_complete",
  "channel_completion_events_state_complete",
  "schedules_exactly_one_target",
  "schedule_ticks_key_not_blank",
  "schedule_ticks_schedule_key_unique",
  "ticket_labels_ticket_label_unique",
  "tickets_priority_range",
  "tickets_project_number_unique",
  "workflow_runs_spec_object",
  "workflow_runs_failure_state",
  "workflow_runs_graph_snapshot_object",
  "workflow_runs_total_cost_nonnegative",
  "workflow_runs_total_tokens_nonnegative",
  "workflow_fanout_groups_activation_unique",
  "workflow_fanout_groups_agent_model_not_blank",
  "workflow_fanout_groups_max_positive",
  "workflow_fanout_groups_node_config_object",
  "workflow_fanout_groups_node_not_blank",
  "workflow_fanout_members_pkey",
  "workflow_fanout_members_position_nonnegative",
  "workflow_fanout_members_ticket_unique",
  "workflow_dispatches_activation_unique",
  "workflow_dispatches_agent_model_not_blank",
  "workflow_dispatches_attempt_nonnegative",
  "workflow_dispatches_generation_nonnegative",
  "workflow_dispatches_idempotency_key_key",
  "workflow_dispatches_idempotency_not_blank",
  "workflow_dispatches_input_object",
  "workflow_dispatches_node_not_blank",
  "workflow_dispatches_output_message_id_key",
  "workflow_dispatches_runtime_generation_positive",
  "workflow_dispatches_state_complete",
  "workflow_thread_states_identity_unique",
  "workflow_thread_states_pause_complete",
];

const requiredIndexes = [
  "idx_agent_skills_skill",
  "idx_agent_tool_invocations_run_id",
  "idx_agent_wake_events_agent_window",
  "idx_cost_events_run_agent",
  "idx_cost_events_run_ordered",
  "idx_dependencies_blocked",
  "idx_dependencies_blocker",
  "idx_messages_run_conversation",
  "idx_messages_ticket",
  "idx_message_ready_runs_fair",
  "idx_message_consumptions_consumed_at",
  "idx_telegram_inbound_updates_run",
  "idx_telegram_outbound_deliveries_status",
  "channel_intakes_one_collecting_conversation",
  "channel_intakes_status_updated",
  "idx_schedules_agent",
  "idx_schedules_enabled",
  "idx_schedules_workflow",
  "idx_schedule_ticks_schedule_created",
  "idx_ticket_labels_label",
  "idx_tickets_assignee",
  "idx_tickets_project",
  "idx_tickets_run_board",
  "idx_tickets_run_frontier",
  "idx_workflow_runs_status",
  "idx_workflow_runs_workflow_created",
  "idx_workflow_fanout_groups_run_node",
  "idx_workflow_fanout_members_ticket",
  "idx_workflow_dispatches_claim",
  "idx_workflow_dispatches_fanout_status",
  "idx_workflow_dispatches_run_status",
];

async function rejectWithCode(client, text, values, code) {
  await assert.rejects(
    () => client.query(text, values),
    (error) => {
      assert.equal(error.code, code);
      return true;
    },
  );
}

async function waitForAdvisoryWait(observer, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await observer.query(
      `SELECT 1
       FROM pg_stat_activity
       WHERE application_name = $1
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'`,
      [applicationName],
    );
    if (waiting.rowCount > 0) return;
    await delay(10);
  }
  assert.fail(`${applicationName} never waited on the expected advisory lock`);
}

async function migrateQuietly(options) {
  return migratePostgres({ ...options, log: () => {} });
}

async function readPlatformToolInvocationIndexKeys(client) {
  const result = await client.query(`
    SELECT key_column.ordinality::integer AS ordinality,
           key_column.attribute_number::integer AS attribute_number,
           attribute.attname AS attribute_name
    FROM pg_index AS index_metadata
    JOIN pg_class AS index_class ON index_class.oid = index_metadata.indexrelid
    JOIN pg_class AS table_class ON table_class.oid = index_metadata.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
    CROSS JOIN LATERAL unnest(index_metadata.indkey)
      WITH ORDINALITY AS key_column(attribute_number, ordinality)
    LEFT JOIN pg_attribute AS attribute
      ON attribute.attrelid = table_class.oid
     AND attribute.attnum = key_column.attribute_number
     AND NOT attribute.attisdropped
    WHERE namespace.nspname = 'public'
      AND table_class.relname = 'agent_tool_invocations'
      AND index_class.relname = 'idx_agent_tool_invocations_run_id'
      AND index_metadata.indisvalid
    ORDER BY key_column.ordinality
  `);
  return result.rows;
}

function assertPlatformToolInvocationRunIndex(keys) {
  assert.deepEqual(keys, [{
    ordinality: 1,
    attribute_number: 2,
    attribute_name: 'run_id',
  }]);
}

test("FACT-6 PostgreSQL migration and schema contract", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(
      identity.rows[0].name,
      process.env.ORBITFACTORY_FACT6_PROOF_DATABASE,
      "proof database identity must match ORBITFACTORY_FACT6_PROOF_DATABASE",
    );

    await t.test("applies the complete chain from empty and then no-ops", async () => {
      const before = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      assert.deepEqual(before.rows, []);

      const firstLog = [];
      const first = await migratePostgres({
        databaseUrl,
        log: (line) => firstLog.push(line),
      });
      const committed = await committedMigrationFiles();
      assert.deepEqual(first.applied, committed);
      assert.equal(firstLog.length, committed.length);

      const journalBefore = await client.query(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      );
      assert.equal(journalBefore.rowCount, committed.length);
      for (const row of journalBefore.rows) {
        assert.match(row.checksum, /^[a-f0-9]{64}$/);
      }

      const secondLog = [];
      const second = await migratePostgres({
        databaseUrl,
        log: (line) => secondLog.push(line),
      });
      assert.deepEqual(second.applied, []);
      assert.deepEqual(secondLog, ["No migrations to apply."]);

      const journalAfter = await client.query(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(journalAfter.rows, journalBefore.rows);
    });

    await t.test("fails closed on migration history drift, lock contention, and failed SQL", async () => {
      const baseline = await client.query(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      );
      const baselineByVersion = new Map(
        baseline.rows.map((row) => [row.version, row]),
      );

      await client.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE version = $2",
        ["0".repeat(64), "0001-control-plane.sql"],
      );
      await assert.rejects(
        () => migrateQuietly({ databaseUrl }),
        /does not match its committed checksum/,
      );
      await client.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE version = $2",
        [
          baselineByVersion.get("0001-control-plane.sql").checksum,
          "0001-control-plane.sql",
        ],
      );

      await client.query(
        `INSERT INTO schema_migrations (version, checksum)
         VALUES ('9999-missing.sql', $1)`,
        ["f".repeat(64)],
      );
      await assert.rejects(
        () => migrateQuietly({ databaseUrl }),
        /is missing from the committed migration directory/,
      );
      await client.query(
        "DELETE FROM schema_migrations WHERE version = '9999-missing.sql'",
      );

      const removed = baselineByVersion.get("0002-tickets.sql");
      await client.query(
        "DELETE FROM schema_migrations WHERE version = '0002-tickets.sql'",
      );
      await assert.rejects(
        () => migrateQuietly({ databaseUrl }),
        /was introduced before already-applied 0003-message-plane.sql/,
      );
      await client.query(
        `INSERT INTO schema_migrations (version, checksum, applied_at)
         VALUES ($1, $2, $3)`,
        [removed.version, removed.checksum, removed.applied_at],
      );

      await client.query("SELECT pg_advisory_lock(hashtext($1))", [
        MIGRATION_LOCK_NAME,
      ]);
      const blockedMigration = migrateQuietly({ databaseUrl });
      let contentionError;
      try {
        await waitForAdvisoryWait(client, "orbitfactory-migrator");
      } catch (error) {
        contentionError = error;
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
          MIGRATION_LOCK_NAME,
        ]);
      }
      const afterContention = await blockedMigration;
      if (contentionError) throw contentionError;
      assert.deepEqual(afterContention.applied, []);

      const failedDatabaseName = "orbitfactory_fact6_failed_migration";
      await client.query(`CREATE DATABASE "${failedDatabaseName}"`);
      const failedDatabaseUrl = new URL(databaseUrl);
      failedDatabaseUrl.pathname = `/${failedDatabaseName}`;
      try {
        await assert.rejects(
          () =>
            migrateQuietly({
              databaseUrl: failedDatabaseUrl.toString(),
              migrationDirectory: FAILED_MIGRATION_DIRECTORY,
            }),
          /deliberately_missing_table/,
        );

        const failedClient = new Client({
          connectionString: failedDatabaseUrl.toString(),
        });
        await failedClient.connect();
        try {
          const journal = await failedClient.query(
            "SELECT version FROM schema_migrations",
          );
          assert.deepEqual(journal.rows, []);
          const rolledBack = await failedClient.query(
            "SELECT to_regclass('public.must_roll_back_with_failed_migration') AS name",
          );
          assert.equal(rolledBack.rows[0].name, null);
        } finally {
          await failedClient.end();
        }
      } finally {
        await client.query(`DROP DATABASE "${failedDatabaseName}" WITH (FORCE)`);
      }

      const restored = await client.query(
        "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(restored.rows, baseline.rows);
    });

    await t.test("matches tables, columns, native types, constraints, keys, and indexes", async () => {
      const columns = await client.query(`
        SELECT table_name,
               array_agg(column_name::text ORDER BY ordinal_position) AS columns
        FROM information_schema.columns
        WHERE table_schema = 'public'
        GROUP BY table_name
        ORDER BY table_name
      `);
      assert.deepEqual(
        Object.fromEntries(columns.rows.map((row) => [row.table_name, row.columns])),
        Object.fromEntries(Object.entries(expectedColumns).sort(([a], [b]) => a.localeCompare(b))),
      );

      const enums = await client.query(`
        SELECT t.typname,
               array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
        GROUP BY t.typname
        ORDER BY t.typname
      `);
      assert.deepEqual(
        Object.fromEntries(enums.rows.map((row) => [row.typname, row.values])),
        expectedEnums,
      );

      const nativeTypes = await client.query(`
        SELECT table_name, column_name, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('agents', 'guardrails'),
            ('workflows', 'graph'),
            ('workflow_dispatches', 'input'),
            ('workflow_runs', 'graph_snapshot'),
            ('workflow_runs', 'spec'),
            ('workflow_runs', 'total_cost'),
            ('tickets', 'run_id'),
            ('messages', 'payload'),
            ('messages', 'sequence_number'),
            ('messages', 'token_usage'),
            ('cost_events', 'computed_cost'),
            ('cost_events', 'cache_read_tokens'),
            ('cost_events', 'cache_write_tokens')
          )
        ORDER BY table_name, column_name
      `);
      assert.deepEqual(
        nativeTypes.rows.map((row) => [row.table_name, row.column_name, row.udt_name]),
        [
          ["agents", "guardrails", "jsonb"],
          ["cost_events", "cache_read_tokens", "int8"],
          ["cost_events", "cache_write_tokens", "int8"],
          ["cost_events", "computed_cost", "numeric"],
          ["messages", "payload", "jsonb"],
          ["messages", "sequence_number", "int8"],
          ["messages", "token_usage", "jsonb"],
          ["tickets", "run_id", "int8"],
          ["workflow_dispatches", "input", "jsonb"],
          ["workflow_runs", "graph_snapshot", "jsonb"],
          ["workflow_runs", "spec", "jsonb"],
          ["workflow_runs", "total_cost", "numeric"],
          ["workflows", "graph", "jsonb"],
        ],
      );

      const nullableUsage = await client.query(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'cost_events'
          AND column_name IN (
            'tokens_in',
            'tokens_out',
            'computed_cost',
            'cache_read_tokens',
            'cache_write_tokens'
          )
        ORDER BY column_name
      `);
      assert.deepEqual(
        nullableUsage.rows.map((row) => [row.column_name, row.is_nullable]),
        [
          ["cache_read_tokens", "YES"],
          ["cache_write_tokens", "YES"],
          ["computed_cost", "YES"],
          ["tokens_in", "YES"],
          ["tokens_out", "YES"],
        ],
      );

      const constraints = await client.query(`
        SELECT conname
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public'
      `);
      const constraintNames = new Set(constraints.rows.map((row) => row.conname));
      for (const name of requiredConstraints) assert.ok(constraintNames.has(name), name);

      const foreignKeys = await client.query(`
        SELECT conname, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f'
      `);
      const definitions = Object.fromEntries(
        foreignKeys.rows.map((row) => [row.conname, row.definition]),
      );
      const expectedForeignKeys = {
        agent_skills_agent_id_fkey: "REFERENCES agents(id) ON DELETE CASCADE",
        agent_skills_skill_id_fkey: "REFERENCES skills(id) ON DELETE CASCADE",
        agent_tool_invocations_agent_id_fkey: "REFERENCES agents(id) ON DELETE RESTRICT",
        agent_tool_invocations_run_id_fkey: "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        agent_wake_events_agent_id_fkey: "REFERENCES agents(id) ON DELETE RESTRICT",
        agent_wake_events_dispatch_id_fkey:
          "REFERENCES workflow_dispatches(id) ON DELETE RESTRICT",
        agent_wake_events_run_id_fkey: "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        cost_events_agent_id_fkey: "REFERENCES agents(id) ON DELETE RESTRICT",
        cost_events_run_id_fkey: "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        dependencies_blocked_ticket_fk:
          "REFERENCES tickets(id, project_id) ON DELETE CASCADE",
        dependencies_blocker_ticket_fk:
          "REFERENCES tickets(id, project_id) ON DELETE CASCADE",
        dependencies_project_id_fkey: "REFERENCES projects(id) ON DELETE RESTRICT",
        messages_run_id_fkey: "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        messages_ticket_id_fkey: "REFERENCES tickets(id) ON DELETE SET NULL",
        message_consumer_runs_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE CASCADE",
        message_enqueues_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        message_ready_runs_run_id_fkey:
          "REFERENCES message_consumer_runs(run_id) ON DELETE CASCADE",
        message_ready_runs_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        message_consumptions_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        telegram_inbound_updates_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        telegram_inbound_updates_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        telegram_outbound_deliveries_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        channel_intakes_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        channel_intakes_workflow_id_fkey:
          "REFERENCES workflows(id) ON DELETE RESTRICT",
        channel_intakes_last_inbound_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        channel_completion_events_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        channel_completion_events_completion_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        channel_completion_events_final_outbound_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        schedules_agent_id_fkey: "REFERENCES agents(id) ON DELETE RESTRICT",
        schedules_workflow_id_fkey: "REFERENCES workflows(id) ON DELETE RESTRICT",
        schedule_ticks_schedule_id_fkey: "REFERENCES schedules(id) ON DELETE RESTRICT",
        schedule_ticks_run_id_fkey: "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        schedule_ticks_message_id_fkey: "REFERENCES messages(id) ON DELETE RESTRICT",
        schedule_agent_workflows_schedule_id_fkey:
          "REFERENCES schedules(id) ON DELETE RESTRICT",
        schedule_agent_workflows_workflow_id_fkey:
          "REFERENCES workflows(id) ON DELETE RESTRICT",
        ticket_labels_label_id_fkey: "REFERENCES labels(id) ON DELETE CASCADE",
        ticket_labels_ticket_id_fkey: "REFERENCES tickets(id) ON DELETE CASCADE",
        tickets_assignee_agent_id_fkey: "REFERENCES agents(id) ON DELETE SET NULL",
        tickets_project_id_fkey: "REFERENCES projects(id) ON DELETE RESTRICT",
        tickets_run_id_fkey: "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        workflow_dispatches_agent_id_fkey:
          "REFERENCES agents(id) ON DELETE RESTRICT",
        workflow_dispatches_fanout_group_id_fkey:
          "REFERENCES workflow_fanout_groups(id) ON DELETE RESTRICT",
        workflow_dispatches_output_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        workflow_dispatches_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        workflow_dispatches_source_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        workflow_dispatches_ticket_id_fkey:
          "REFERENCES tickets(id) ON DELETE RESTRICT",
        workflow_fanout_groups_agent_id_fkey:
          "REFERENCES agents(id) ON DELETE RESTRICT",
        workflow_fanout_groups_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        workflow_fanout_groups_source_message_id_fkey:
          "REFERENCES messages(id) ON DELETE RESTRICT",
        workflow_fanout_members_fanout_group_id_fkey:
          "REFERENCES workflow_fanout_groups(id) ON DELETE RESTRICT",
        workflow_fanout_members_ticket_id_fkey:
          "REFERENCES tickets(id) ON DELETE RESTRICT",
        workflow_thread_states_run_id_fkey:
          "REFERENCES workflow_runs(id) ON DELETE RESTRICT",
        workflow_thread_states_ticket_id_fkey:
          "REFERENCES tickets(id) ON DELETE RESTRICT",
        workflow_runs_workflow_id_fkey:
          "REFERENCES workflows(id) ON DELETE RESTRICT",
      };
      assert.deepEqual(
        Object.keys(definitions).sort(),
        Object.keys(expectedForeignKeys).sort(),
      );
      for (const [name, fragment] of Object.entries(expectedForeignKeys)) {
        assert.ok(definitions[name].includes(fragment), `${name}: ${definitions[name]}`);
      }

      const indexes = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
      `);
      const indexNames = new Set(indexes.rows.map((row) => row.indexname));
      for (const name of requiredIndexes) assert.ok(indexNames.has(name), name);

      assertPlatformToolInvocationRunIndex(
        await readPlatformToolInvocationIndexKeys(client),
      );

      await t.test("rejects an expression-first invocation run index", async () => {
        await client.query("DROP INDEX idx_agent_tool_invocations_run_id");
        try {
          await client.query(`
            CREATE INDEX idx_agent_tool_invocations_run_id
              ON agent_tool_invocations ((lower(idempotency_key)), run_id)
          `);
          const expressionFirstKeys = await readPlatformToolInvocationIndexKeys(client);
          assert.deepEqual(expressionFirstKeys, [
            { ordinality: 1, attribute_number: 0, attribute_name: null },
            { ordinality: 2, attribute_number: 2, attribute_name: "run_id" },
          ]);
          assert.throws(
            () => assertPlatformToolInvocationRunIndex(expressionFirstKeys),
            assert.AssertionError,
          );
        } finally {
          await client.query("DROP INDEX IF EXISTS idx_agent_tool_invocations_run_id");
          await client.query(`
            CREATE INDEX idx_agent_tool_invocations_run_id
              ON agent_tool_invocations(run_id)
          `);
        }
        assertPlatformToolInvocationRunIndex(
          await readPlatformToolInvocationIndexKeys(client),
        );
      });

      const triggers = await client.query(`
        SELECT tgname
        FROM pg_trigger
        WHERE NOT tgisinternal
        ORDER BY tgname
      `);
      assert.deepEqual(
        triggers.rows.map((row) => row.tgname),
        [
          "agents_90_notify_state_stream",
          "cost_events_90_notify_state_stream",
          "messages_05_preserve_order",
          "messages_10_enforce_ticket_run",
          "messages_20_assign_sequence",
          "messages_30_track_consumption",
          "messages_40_refresh_ready_run",
          "messages_90_notify_state_stream",
          "tickets_10_enforce_message_runs",
          "tickets_90_notify_state_stream",
          "workflow_runs_30_initialize_message_consumer",
          "workflow_runs_90_notify_state_stream",
        ],
      );
    });

    let ids;
    await t.test("preserves retained board, label, blocker, and frontier query shapes", async () => {
      const project = await client.query(
        `INSERT INTO projects (key, name, next_number)
         VALUES ('FACT', 'OrbitFactory', 5)
         RETURNING id`,
      );
      const agent = await client.query(
        `INSERT INTO agents (
           name, role, system_prompt, model, guardrails, interaction_rules, memory
         ) VALUES (
           'Implementer', 'worker', 'Implement the assigned ticket.', 'test/model',
           '{"cost_limit": 5}', '{"autonomy": "high"}', '{"facts": []}'
         ) RETURNING id`,
      );
      const skill = await client.query(
        `INSERT INTO skills (name, description, procedure)
         VALUES ('testing', 'Prove behavior', 'Run the contract tests.') RETURNING id`,
      );
      await client.query(
        "INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2)",
        [agent.rows[0].id, skill.rows[0].id],
      );
      const workflow = await client.query(
        `INSERT INTO workflows (name, description, graph)
         VALUES ('Schema proof workflow', 'Test workflow', '{"nodes": [], "edges": []}')
         RETURNING id`,
      );
      const run = await client.query(
        `INSERT INTO workflow_runs (
           workflow_id, status, trigger_type, spec, started_at
         ) VALUES ($1, 'running', 'ui', '{"task": "Build FACT-6"}', now())
         RETURNING id`,
        [workflow.rows[0].id],
      );
      const otherRun = await client.query(
        `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec)
         VALUES ($1, 'running', 'cron', '{"task": "Other run"}')
         RETURNING id`,
        [workflow.rows[0].id],
      );

      const ticketRows = await client.query(
        `INSERT INTO tickets (
           number, identifier, project_id, run_id, title, description,
           acceptance_criteria, status, priority, assignee_agent_id
         ) VALUES
           (1, 'FACT-1', $1, $2, 'Finished blocker', NULL, NULL, 'done', 2, NULL),
           (2, 'FACT-2', $1, $2, 'Ready work', 'Retained description',
             'The proof passes.', 'todo', 3, $3),
           (3, 'FACT-3', $1, $2, 'Blocked work', NULL, NULL, 'todo', 4, NULL),
           (4, 'FACT-4', $1, $2, 'Open blocker', NULL, NULL, 'todo', 0, NULL),
           (5, 'FACT-5', $1, NULL, 'Unscoped retained ticket', NULL, NULL,
             'backlog', 0, NULL)
         RETURNING id, identifier`,
        [project.rows[0].id, run.rows[0].id, agent.rows[0].id],
      );
      const ticketIds = Object.fromEntries(
        ticketRows.rows.map((row) => [row.identifier, row.id]),
      );
      const label = await client.query(
        "INSERT INTO labels (name, color) VALUES ('feature', '#8b5cf6') RETURNING id",
      );
      await client.query(
        "INSERT INTO ticket_labels (ticket_id, label_id) VALUES ($1, $2)",
        [ticketIds["FACT-2"], label.rows[0].id],
      );
      await client.query(
        `INSERT INTO dependencies (project_id, blocker_ticket_id, blocked_ticket_id)
         VALUES ($1, $2, $3), ($1, $4, $5)`,
        [
          project.rows[0].id,
          ticketIds["FACT-1"],
          ticketIds["FACT-2"],
          ticketIds["FACT-4"],
          ticketIds["FACT-3"],
        ],
      );

      const board = await client.query(
        `SELECT t.identifier, t.status, t.priority,
                COALESCE(
                  array_agg(l.name ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL),
                  ARRAY[]::text[]
                ) AS labels
         FROM tickets t
         LEFT JOIN ticket_labels tl ON tl.ticket_id = t.id
         LEFT JOIN labels l ON l.id = tl.label_id
         WHERE t.run_id = $1
         GROUP BY t.id
         ORDER BY t.priority DESC, t.created_at DESC, t.id DESC`,
        [run.rows[0].id],
      );
      assert.deepEqual(
        board.rows.map((row) => row.identifier),
        ["FACT-3", "FACT-2", "FACT-1", "FACT-4"],
      );
      assert.deepEqual(
        board.rows.find((row) => row.identifier === "FACT-2").labels,
        ["feature"],
      );

      const frontier = await client.query(
        `SELECT candidate.identifier
         FROM tickets candidate
         WHERE candidate.run_id = $1
           AND candidate.status = 'todo'
           AND NOT EXISTS (
             SELECT 1
             FROM dependencies dependency
             JOIN tickets blocker ON blocker.id = dependency.blocker_ticket_id
             WHERE dependency.blocked_ticket_id = candidate.id
               AND blocker.status <> 'done'
           )
         ORDER BY candidate.priority DESC, candidate.created_at, candidate.id`,
        [run.rows[0].id],
      );
      assert.deepEqual(frontier.rows.map((row) => row.identifier), ["FACT-2", "FACT-4"]);

      const nullableExtension = await client.query(
        `SELECT run_id, acceptance_criteria, assignee_agent_id
         FROM tickets WHERE identifier = 'FACT-5'`,
      );
      assert.deepEqual(nullableExtension.rows[0], {
        run_id: null,
        acceptance_criteria: null,
        assignee_agent_id: null,
      });

      ids = {
        project: project.rows[0].id,
        agent: agent.rows[0].id,
        workflow: workflow.rows[0].id,
        run: run.rows[0].id,
        otherRun: otherRun.rows[0].id,
        ticket: ticketIds["FACT-2"],
        nullRunTicket: ticketIds["FACT-5"],
      };
    });

    await t.test("enforces message ticket ownership while allowing null-run tickets", async () => {
      await rejectWithCode(
        client,
        `INSERT INTO messages (
           run_id, ticket_id, sender, recipient, type, payload
         ) VALUES ($1, $2, 'system', 'agent:other', 'system', '{}')`,
        [ids.otherRun, ids.ticket],
        "23514",
      );

      const retainedTicketMessage = await client.query(
        `INSERT INTO messages (
           run_id, ticket_id, sender, recipient, type, payload
         ) VALUES ($1, $2, 'system', 'agent:other', 'system',
           '{"retained_ticket": true}')
         RETURNING ticket_id, sequence_number`,
        [ids.otherRun, ids.nullRunTicket],
      );
      assert.deepEqual(retainedTicketMessage.rows[0], {
        ticket_id: ids.nullRunTicket,
        sequence_number: "1",
      });

      await rejectWithCode(
        client,
        "UPDATE tickets SET run_id = $1 WHERE id = $2",
        [ids.run, ids.nullRunTicket],
        "23514",
      );
    });

    await t.test("reconstructs every message field in deterministic run order", async () => {
      const types = expectedEnums.message_type;
      const expectedTrail = [];

      for (const [index, type] of types.entries()) {
        const item = {
          ticket_id: index % 2 === 0 ? ids.ticket : null,
          sender: index % 3 === 0 ? "human:adam" : `agent:${index}`,
          recipient: index % 2 === 0 ? "agent:orchestrator" : "human:adam",
          type,
          payload: { index, artifact: `artifact-${index}` },
          handoff_brief: index === 0 ? "Preserve the migration contract." : null,
          token_usage:
            index % 2 === 0
              ? { input: index + 1, output: index + 2, total: index * 2 + 3 }
              : null,
        };
        expectedTrail.push(item);
        await client.query(
          `INSERT INTO messages (
             run_id, ticket_id, sender, recipient, type, payload,
             handoff_brief, token_usage
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            ids.run,
            item.ticket_id,
            item.sender,
            item.recipient,
            item.type,
            item.payload,
            item.handoff_brief,
            item.token_usage,
          ],
        );
      }

      const trail = await client.query(
        `SELECT sequence_number, ticket_id, sender, recipient, type, payload,
                handoff_brief, token_usage
         FROM messages
         WHERE run_id = $1
         ORDER BY sequence_number`,
        [ids.run],
      );
      assert.deepEqual(
        trail.rows.map(({ sequence_number: sequenceNumber, ...message }, index) => {
          assert.equal(sequenceNumber, String(index + 1));
          return message;
        }),
        expectedTrail,
      );

      await rejectWithCode(
        client,
        `UPDATE messages
         SET sequence_number = sequence_number + 1
         WHERE run_id = $1 AND sequence_number = 1`,
        [ids.run],
        "23514",
      );
    });

    await t.test("does not let a consumer cursor skip an earlier late commit", async () => {
      const run = await client.query(
        `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec)
         VALUES ($1, 'running', 'ui', '{"task": "Concurrent append proof"}')
         RETURNING id`,
        [ids.workflow],
      );
      const runId = run.rows[0].id;
      const earlierProducer = new Client({ connectionString: databaseUrl });
      const laterProducer = new Client({ connectionString: databaseUrl });
      let earlierTransaction = false;
      let laterTransaction = false;
      let laterInsert;

      await earlierProducer.connect();
      await laterProducer.connect();
      try {
        await earlierProducer.query("BEGIN");
        earlierTransaction = true;
        await laterProducer.query("BEGIN");
        laterTransaction = true;
        await laterProducer.query(
          "SET LOCAL application_name = 'fact6-later-message-producer'",
        );

        const earlierInsert = await earlierProducer.query(
          `INSERT INTO messages (run_id, sender, recipient, type, payload)
           VALUES ($1, 'agent:early', 'agent:next', 'output', '{"order": "early"}')
           RETURNING sequence_number`,
          [runId],
        );
        assert.equal(earlierInsert.rows[0].sequence_number, "1");

        laterInsert = laterProducer.query(
          `INSERT INTO messages (run_id, sender, recipient, type, payload)
           VALUES ($1, 'agent:later', 'agent:next', 'output', '{"order": "later"}')
           RETURNING sequence_number`,
          [runId],
        );
        await waitForAdvisoryWait(client, "fact6-later-message-producer");

        const beforeEarlierCommit = await client.query(
          `SELECT sequence_number
           FROM messages
           WHERE run_id = $1 AND sequence_number > 0
           ORDER BY sequence_number`,
          [runId],
        );
        assert.deepEqual(beforeEarlierCommit.rows, []);

        await earlierProducer.query("COMMIT");
        earlierTransaction = false;
        const laterResult = await laterInsert;
        assert.equal(laterResult.rows[0].sequence_number, "2");

        const afterEarlierCommit = await client.query(
          `SELECT sequence_number, payload
           FROM messages
           WHERE run_id = $1 AND sequence_number > 0
           ORDER BY sequence_number`,
          [runId],
        );
        assert.deepEqual(afterEarlierCommit.rows, [
          { sequence_number: "1", payload: { order: "early" } },
        ]);

        await laterProducer.query("COMMIT");
        laterTransaction = false;
        const afterLaterCommit = await client.query(
          `SELECT sequence_number, payload
           FROM messages
           WHERE run_id = $1 AND sequence_number > $2
           ORDER BY sequence_number`,
          [runId, 1],
        );
        assert.deepEqual(afterLaterCommit.rows, [
          { sequence_number: "2", payload: { order: "later" } },
        ]);

        const completeTrail = await client.query(
          `SELECT sequence_number
           FROM messages
           WHERE run_id = $1
           ORDER BY sequence_number`,
          [runId],
        );
        assert.deepEqual(
          completeTrail.rows.map((row) => row.sequence_number),
          ["1", "2"],
        );
      } finally {
        if (earlierTransaction) await earlierProducer.query("ROLLBACK");
        if (laterInsert) {
          try {
            await laterInsert;
          } catch {
            // The transaction cleanup below is authoritative.
          }
        }
        if (laterTransaction) await laterProducer.query("ROLLBACK");
        await earlierProducer.end();
        await laterProducer.end();
      }
    });

    await t.test("rejects invalid, orphaned, negative, and destructive writes", async () => {
      await rejectWithCode(
        client,
        `INSERT INTO messages (run_id, sender, recipient, type, payload)
         VALUES ($1, 'system', 'agent:1', 'bogus', '{}')`,
        [ids.run],
        "22P02",
      );
      await rejectWithCode(
        client,
        `INSERT INTO messages (run_id, sender, recipient, type, payload)
         VALUES (999999999, 'system', 'agent:1', 'system', '{}')`,
        [],
        "23503",
      );
      await rejectWithCode(
        client,
        `INSERT INTO messages (run_id, sender, recipient, type, payload, token_usage)
         VALUES ($1, 'system', 'agent:1', 'system', '{}', '{"input": -1}')`,
        [ids.run],
        "23514",
      );
      await rejectWithCode(
        client,
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost
         ) VALUES ($1, $2, 'test/model', -1, 2, 0.01)`,
        [ids.run, ids.agent],
        "23514",
      );
      await rejectWithCode(
        client,
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost,
           cache_read_tokens, cache_write_tokens
         ) VALUES ($1, $2, 'test/model', 1, 2, 0.01, -1, 0)`,
        [ids.run, ids.agent],
        "23514",
      );
      await rejectWithCode(
        client,
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost,
           cache_read_tokens, cache_write_tokens
         ) VALUES ($1, $2, 'test/model', 1, 2, -0.01, 0, 0)`,
        [ids.run, ids.agent],
        "23514",
      );
      await rejectWithCode(
        client,
        `INSERT INTO dependencies (project_id, blocker_ticket_id, blocked_ticket_id)
         VALUES ($1, $2, $2)`,
        [ids.project, ids.ticket],
        "23514",
      );

      await client.query(
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost,
           cache_read_tokens, cache_write_tokens
         ) VALUES ($1, $2, 'test/model', 12, 8, 0.0042, 20, 3)`,
        [ids.run, ids.agent],
      );
      await client.query(
        `INSERT INTO cost_events (
           run_id, agent_id, model, tokens_in, tokens_out, computed_cost,
           cache_read_tokens, cache_write_tokens
         ) VALUES ($1, $2, 'test/model', NULL, 0, NULL, NULL, 0)`,
        [ids.run, ids.agent],
      );
      await rejectWithCode(
        client,
        "DELETE FROM workflows WHERE id = $1",
        [ids.workflow],
        "23503",
      );
      await rejectWithCode(
        client,
        "DELETE FROM workflow_runs WHERE id = $1",
        [ids.run],
        "23503",
      );
      await rejectWithCode(
        client,
        "DELETE FROM agents WHERE id = $1",
        [ids.agent],
        "23503",
      );
    });
  } finally {
    await client.end();
  }
});
