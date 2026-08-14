import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { createRunWorkspaceService } from "../../coding-adapter/src/runWorkspaceService.js";
import { exportAcceptedFactoryWorkspace } from "../../coding-adapter/src/workspaceExporter.js";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";

const { Pool } = pg;

test("FACT-38 exports only accepted Factory workspaces and fails closed", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to the disposable FACT-38 database");
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "orbitfactory-fact38-")));
  const workspaceRoot = path.join(temporary, "compose-volume", "run-workspaces");
  const destination = path.join(temporary, "host-export");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(destination);
  await migratePostgres({ databaseUrl: process.env.DATABASE_URL, log: () => {} });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const workspaceService = createRunWorkspaceService({ pool, workspaceRoot });

  try {
    const accepted = await factoryRun(pool, { status: "completed", verdict: "approved", ticketStatus: "done" });
    const acceptedWorkspace = await workspaceService.startRunWorkspace(accepted.runId);
    await mkdir(path.join(acceptedWorkspace, "src"));
    await writeFile(path.join(acceptedWorkspace, "src", "hello.mjs"), "console.log('hello')\n", { mode: 0o755 });
    await writeFile(path.join(acceptedWorkspace, "package.json"), '{"scripts":{"start":"node src/hello.mjs"}}\n');

    await t.test("copies the complete isolated workspace and preserves executable files", async () => {
      const output = await exportAcceptedFactoryWorkspace({
        pool, workspaceRoot, destinationRoot: destination, runId: accepted.runId,
      });
      assert.equal(output, path.join(destination, `factory-run-${accepted.runId}`));
      assert.equal(await readFile(path.join(output, "src", "hello.mjs"), "utf8"), "console.log('hello')\n");
      assert.equal(await readFile(path.join(output, "package.json"), "utf8"), '{"scripts":{"start":"node src/hello.mjs"}}\n');
      assert.ok((await lstat(path.join(output, ".git", "orbitflow-workspace.json"))).isFile());
      assert.equal((await lstat(path.join(output, "src", "hello.mjs"))).mode & 0o111, 0o111);
    });

    await t.test("rejects an existing per-run result instead of overwriting it", async () => {
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: accepted.runId }),
        /export already exists/,
      );
    });

    await t.test("rejects unknown and invalid run identifiers", async () => {
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: "99999999" }),
        /does not exist/,
      );
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: "../1" }),
        /positive integer/,
      );
    });

    const unfinished = await factoryRun(pool, { status: "running", verdict: "approved", ticketStatus: "done" });
    await workspaceService.startRunWorkspace(unfinished.runId);
    await t.test("rejects unfinished runs", async () => {
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: unfinished.runId }),
        /unfinished/,
      );
    });

    const rejected = await factoryRun(pool, { status: "completed", verdict: "rejected", ticketStatus: "todo" });
    await workspaceService.startRunWorkspace(rejected.runId);
    await t.test("rejects runs whose ticket or tester verdict is not accepted", async () => {
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: rejected.runId }),
        /ticket is unfinished/,
      );
      await pool.query("UPDATE tickets SET status = 'done' WHERE id = $1", [rejected.ticketId]);
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: rejected.runId }),
        /was rejected/,
      );
    });

    const unsafe = await factoryRun(pool, { status: "completed", verdict: "approved", ticketStatus: "done" });
    const unsafeWorkspace = await workspaceService.startRunWorkspace(unsafe.runId);
    const outside = path.join(temporary, "outside-secret.txt");
    await writeFile(outside, "must not copy\n");
    await symlink(outside, path.join(unsafeWorkspace, "escape.txt"));
    await t.test("rejects workspace symlinks without copying their targets", async () => {
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: unsafe.runId }),
        /unsafe symlink/,
      );
      await assert.rejects(lstat(path.join(destination, `factory-run-${unsafe.runId}`)), { code: "ENOENT" });
    });

    await t.test("rejects symlinked and relative destinations", async () => {
      const linkedDestination = path.join(temporary, "linked-export");
      await symlink(destination, linkedDestination);
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: linkedDestination, runId: unsafe.runId }),
        /real directory/,
      );
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: "relative", runId: unsafe.runId }),
        /absolute path/,
      );
    });

    await t.test("rejects special files in a Compose-style workspace", async () => {
      const special = await factoryRun(pool, { status: "completed", verdict: "approved", ticketStatus: "done" });
      const specialWorkspace = await workspaceService.startRunWorkspace(special.runId);
      const result = spawnSync("mkfifo", [path.join(specialWorkspace, "unsafe.fifo")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      await assert.rejects(
        exportAcceptedFactoryWorkspace({ pool, workspaceRoot, destinationRoot: destination, runId: special.runId }),
        /unsupported entry/,
      );
    });
  } finally {
    await pool.end();
    await rm(temporary, { recursive: true, force: true });
  }
});

async function factoryRun(pool, { status, verdict, ticketStatus }) {
  const workflow = await pool.query("SELECT id FROM workflows WHERE name = 'Software Factory'");
  const run = await pool.query(
    `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec, started_at, ended_at)
     VALUES ($1, $2::workflow_run_status, 'ui', '{}', now(),
             CASE WHEN $2::workflow_run_status = 'completed' THEN now() ELSE NULL END)
     RETURNING id::text`,
    [workflow.rows[0].id, status],
  );
  const runId = run.rows[0].id;
  const project = await pool.query(
    `INSERT INTO projects (key, name) VALUES ('EXPFIXTURE', 'FACT-38 export fixtures')
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  const ticket = await pool.query(
    `INSERT INTO tickets (number, identifier, project_id, run_id, title, status)
     VALUES ($3, $1, $2, $3, 'Export fixture', $4) RETURNING id::text`,
    [`EXP-${runId}`, project.rows[0].id, runId, ticketStatus],
  );
  const ticketId = ticket.rows[0].id;
  const message = await pool.query(
    `INSERT INTO messages (run_id, ticket_id, sender, recipient, type, payload)
     VALUES ($1, $2, 'Factory Tester', 'engine', 'output', $3) RETURNING id`,
    [runId, ticketId, { output: { artifact: { verdict } } }],
  );
  const tester = await pool.query("SELECT id, model FROM agents WHERE name = 'Factory Tester'");
  await pool.query(
    `INSERT INTO workflow_dispatches
       (run_id, node_id, agent_id, agent_model, ticket_id, status, input,
        idempotency_key, attempt_count, lease_generation, runtime_generation,
        runtime_session_id, output_message_id)
     VALUES ($1, 'test', $2, $3, $4, 'completed', '{}', $5, 1, 1, 1, $6, $7)`,
    [runId, tester.rows[0].id, tester.rows[0].model, ticketId, `fact38-test-${runId}`, `fact38-session-${runId}`, message.rows[0].id],
  );
  return { runId, ticketId };
}
