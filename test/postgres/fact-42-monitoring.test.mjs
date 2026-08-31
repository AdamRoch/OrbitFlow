import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { ControlPlaneRepository } from "../../src/lib/control-plane/repository.ts";
import { assertProofDatabase } from "./proof-database.mjs";

const { Pool } = pg;

test("FACT-42 Monitoring Board reads the selected PostgreSQL workflow run", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await assertProofDatabase(pool, "ORBITFLOW_FACT42_PROOF_DATABASE");
    await migratePostgres({ databaseUrl, log: () => {} });
    const project = await pool.query(
      "INSERT INTO projects (key, name) VALUES ('FCT', 'FACT-42 proof') RETURNING id::text",
    );
    const workflow = await pool.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-42', 'Monitoring proof', '{}') RETURNING id::text",
    );
    const runs = await Promise.all(["selected", "other"].map(async (name) => {
      const result = await pool.query(
        "INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec) VALUES ($1, 'running', 'ui', $2::jsonb) RETURNING id::text",
        [workflow.rows[0].id, JSON.stringify({ name })],
      );
      return result.rows[0].id;
    }));
    await pool.query(
      `INSERT INTO tickets (number, identifier, project_id, run_id, title, status, priority)
       VALUES (1, 'FCT-1', $1, $2, 'Only this ticket belongs on the selected board', 'todo', 2),
              (2, 'FCT-2', $1, $3, 'Other run ticket', 'todo', 2)`,
      [project.rows[0].id, runs[0], runs[1]],
    );
    const snapshot = await new ControlPlaneRepository(pool).getMonitoringSnapshot({
      runId: runs[0], agentId: null, messageType: null,
    });
    assert.deepEqual(snapshot.board.map((ticket) => ticket.identifier), ["FCT-1"]);
    assert.equal(snapshot.runs.find((run) => run.id === runs[0])?.id, runs[0]);
  } finally {
    await pool.end();
  }
});
