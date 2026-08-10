import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import {
  createCodingTool,
  createCostEventStore,
  createRunWorkspaceService,
} from "../../coding-adapter/src/index.js";

const { Pool } = pg;
const FAKE_OPENCODE = fileURLToPath(
  new URL("../../coding-adapter/fixtures/fake-opencode.mjs", import.meta.url),
);
const TEST_CREDENTIAL = "fact12-disposable-secret";

test("FACT-12 production coding-tool contract", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  const configuredRoot = process.env.ORBITFLOW_WORKSPACE_ROOT;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  assert.ok(configuredRoot, "ORBITFLOW_WORKSPACE_ROOT must be the disposable proof root");

  const pool = new Pool({ connectionString: databaseUrl, application_name: "fact12-proof" });
  try {
    const identity = await pool.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT12_PROOF_DATABASE);
    await migratePostgres({ databaseUrl, log: () => {} });
    const root = await realpath(configuredRoot);
    const fixtures = await seedFixtures(pool, 9);
    const workspaceService = createRunWorkspaceService({ pool, workspaceRoot: configuredRoot });
    const costEventStore = createCostEventStore({ pool });
    const adapterOptions = {
      binary: FAKE_OPENCODE,
      env: {
        OPENROUTER_API_KEY: TEST_CREDENTIAL,
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: "must-not-be-inherited",
        DATABASE_URL: "must-not-be-inherited",
      },
    };

    const toolFor = (runId, agentId = fixtures.agentId) =>
      createCodingTool({
        runId,
        agentId,
        workspaceService,
        costEventStore,
        adapterOptions,
      });

    await t.test("requires a real run before creating a workspace", async () => {
      await assert.rejects(
        () => workspaceService.startRunWorkspace("999999999"),
        (error) => error.code === "workspace_invalid" && /does not exist/.test(error.message),
      );
      await assert.rejects(access(path.join(root, "run-999999999")), { code: "ENOENT" });
    });

    await t.test("creates and reuses one git workspace for sequential tasks", async () => {
      const runId = fixtures.runIds[0];
      const workspace = await workspaceService.startRunWorkspace(runId);
      assert.equal(path.dirname(workspace), root);
      assert.equal(await workspaceService.startRunWorkspace(runId), workspace);
      assert.equal((await lstat(workspace)).isSymbolicLink(), false);
      assert.match(
        execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
          cwd: workspace,
          encoding: "utf8",
        }).trim(),
        /^[0-9a-f]{40,64}$/,
      );

      const first = await toolFor(runId).delegate_coding_task("first task", workspace);
      assert.match(first.diff, /\+first task committed/);
      assert.deepEqual(first.usage, {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
        costUsd: 0.125,
      });

      const second = await toolFor(runId).delegate_coding_task("second task", workspace);
      assert.match(second.diff, /\+second task committed/);
      assert.equal(
        await readFile(path.join(workspace, "shared.txt"), "utf8"),
        "first task committed\nsecond task committed\n",
      );

      const costs = await pool.query(
        `SELECT run_id::text AS run_id,
                agent_id::text AS agent_id,
                model,
                tokens_in::text AS tokens_in,
                tokens_out::text AS tokens_out,
                cache_read_tokens::text AS cache_read_tokens,
                cache_write_tokens::text AS cache_write_tokens,
                computed_cost::text AS computed_cost
         FROM cost_events
         WHERE run_id = $1
         ORDER BY id`,
        [runId],
      );
      assert.deepEqual(costs.rows, [
        {
          run_id: runId,
          agent_id: fixtures.agentId,
          model: "openrouter/anthropic/claude-haiku-4.5",
          tokens_in: "10",
          tokens_out: "5",
          cache_read_tokens: "4",
          cache_write_tokens: "2",
          computed_cost: "0.12500000",
        },
        {
          run_id: runId,
          agent_id: fixtures.agentId,
          model: "openrouter/anthropic/claude-haiku-4.5",
          tokens_in: "7",
          tokens_out: "3",
          cache_read_tokens: "2",
          cache_write_tokens: "1",
          computed_cost: "0.25000000",
        },
      ]);
    });

    await t.test("keeps omitted usage unknown and explicit zero distinct", async () => {
      const runId = fixtures.runIds[1];
      const workspace = await workspaceService.startRunWorkspace(runId);
      const result = await toolFor(runId).delegate_coding_task("unknown usage", workspace);
      assert.deepEqual(result.usage, {
        inputTokens: null,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: 0,
        costUsd: null,
      });
      const persisted = await pool.query(
        `SELECT tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, computed_cost
         FROM cost_events WHERE run_id = $1`,
        [runId],
      );
      assert.deepEqual(persisted.rows, [
        {
          tokens_in: null,
          tokens_out: "0",
          cache_read_tokens: null,
          cache_write_tokens: "0",
          computed_cost: null,
        },
      ]);
    });

    await t.test("exposes the validated tool contract through the executable CLI", async () => {
      const runId = fixtures.runIds[8];
      const cliEnv = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ORBITFLOW_WORKSPACE_ROOT: configuredRoot,
        ORBITFLOW_OPENCODE_BINARY: FAKE_OPENCODE,
        ORBITFLOW_RUN_ID: runId,
        ORBITFLOW_AGENT_ID: fixtures.agentId,
        OPENROUTER_API_KEY: TEST_CREDENTIAL,
        ANTHROPIC_API_KEY: "must-not-be-inherited",
      };
      const started = await runCodingToolCli(
        { command: "start_run_workspace", runId },
        cliEnv,
      );
      assert.equal(started.ok, true);
      assert.equal(path.dirname(started.result.workspace), root);

      const delegated = await runCodingToolCli(
        {
          command: "delegate_coding_task",
          task: "CLI task",
          workspace: started.result.workspace,
        },
        cliEnv,
      );
      assert.equal(delegated.ok, true);
      assert.deepEqual(Object.keys(delegated.result).sort(), ["diff", "log", "usage"]);
      assert.equal(JSON.stringify(delegated).includes(TEST_CREDENTIAL), false);
      const cost = await pool.query("SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1", [
        runId,
      ]);
      assert.equal(cost.rows[0].count, 1);
    });

    await t.test("does not return false success when cost persistence fails", async () => {
      const runId = fixtures.runIds[2];
      const workspace = await workspaceService.startRunWorkspace(runId);
      await assert.rejects(
        () => toolFor(runId, "999999999").delegate_coding_task("persistence failure", workspace),
        (error) => error.code === "persistence_failure",
      );
      const persisted = await pool.query("SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1", [
        runId,
      ]);
      assert.equal(persisted.rows[0].count, 0);
    });

    await t.test("surfaces crash, malformed output, and credential exposure safely", async () => {
      const crashRun = fixtures.runIds[3];
      const crashWorkspace = await workspaceService.startRunWorkspace(crashRun);
      await assert.rejects(
        () => toolFor(crashRun).delegate_coding_task("crash", crashWorkspace),
        (error) => error.code === "cli_failure" && error.exitCode === 7,
      );
      await access(crashWorkspace);

      let exposureError;
      try {
        await toolFor(crashRun).delegate_coding_task("crash-with-credential", crashWorkspace);
      } catch (error) {
        exposureError = error;
      }
      assert.equal(exposureError?.code, "credential_exposure");
      assert.equal(JSON.stringify(exposureError).includes(TEST_CREDENTIAL), false);
      await assert.rejects(access(crashWorkspace), { code: "ENOENT" });
      const quarantine = await lstat(path.join(root, ".orbitflow", "quarantine"));
      assert.equal(quarantine.isDirectory(), true);

      const malformedRun = fixtures.runIds[4];
      const malformedWorkspace = await workspaceService.startRunWorkspace(malformedRun);
      await assert.rejects(
        () => toolFor(malformedRun).delegate_coding_task("malformed-output", malformedWorkspace),
        (error) => error.code === "malformed_output",
      );
      await access(malformedWorkspace);
    });

    await t.test("rejects containment, symlink, deletion, and replacement attacks", async () => {
      const traversalRun = fixtures.runIds[5];
      const traversalWorkspace = await workspaceService.startRunWorkspace(traversalRun);
      await assert.rejects(
        () => workspaceService.resolveWorkspace(traversalRun, path.join(traversalWorkspace, "..", "escape")),
        (error) => error.code === "workspace_invalid",
      );

      const symlinkRun = fixtures.runIds[6];
      const symlinkWorkspace = await workspaceService.startRunWorkspace(symlinkRun);
      const retainedSymlinkWorkspace = `${symlinkWorkspace}-retained`;
      const outsideRoot = await mkdtemp(path.join(tmpdir(), "orbitfactory-fact12-outside-"));
      try {
        await rename(symlinkWorkspace, retainedSymlinkWorkspace);
        await symlink(outsideRoot, symlinkWorkspace, "dir");
        await assert.rejects(
          () => workspaceService.resolveWorkspace(symlinkRun, symlinkWorkspace),
          (error) => error.code === "workspace_invalid",
        );
        await access(retainedSymlinkWorkspace);
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }

      const replacedRun = fixtures.runIds[7];
      const replacedWorkspace = await workspaceService.startRunWorkspace(replacedRun);
      const retainedReplacedWorkspace = `${replacedWorkspace}-retained`;
      await rename(replacedWorkspace, retainedReplacedWorkspace);
      await cp(retainedReplacedWorkspace, replacedWorkspace, { recursive: true });
      await assert.rejects(
        () => workspaceService.resolveWorkspace(replacedRun, replacedWorkspace),
        (error) => error.code === "workspace_invalid" && /deleted or replaced/.test(error.message),
      );
      await access(retainedReplacedWorkspace);
    });
  } finally {
    await pool.end();
  }
});

async function seedFixtures(pool, runCount) {
  const workflow = await pool.query(
    `INSERT INTO workflows (name, description, graph)
     VALUES ('FACT-12 proof workflow', 'Disposable coding adapter proof', '{"nodes":[],"edges":[]}')
     RETURNING id::text AS id`,
  );
  const agent = await pool.query(
    `INSERT INTO agents (name, role, system_prompt, model, coding_tool_enabled)
     VALUES ('FACT-12 proof agent', 'implementer', 'Use the coding tool.', 'test/model', true)
     RETURNING id::text AS id`,
  );
  const runIds = [];
  for (let index = 0; index < runCount; index += 1) {
    const run = await pool.query(
      `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec, started_at)
       VALUES ($1, 'running', 'ui', $2::jsonb, now())
       RETURNING id::text AS id`,
      [workflow.rows[0].id, JSON.stringify({ proof: "FACT-12", index })],
    );
    runIds.push(run.rows[0].id);
  }
  return { agentId: agent.rows[0].id, runIds };
}

function runCodingToolCli(request, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/orbit-coding-tool.mjs"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`coding-tool CLI exited ${code}: ${stderr.slice(-500)} ${stdout.slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("coding-tool CLI did not return JSON"));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
