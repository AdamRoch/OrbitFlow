import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
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
  createExecutionIdentityStore,
  createRunWorkspaceService,
} from "../../coding-adapter/src/index.js";
import { WorkspaceError } from "../../coding-adapter/src/errors.js";
import { inspectProcessGroup } from "../../coding-adapter/src/processGroup.js";

const { Pool } = pg;
const FAKE_OPENCODE = fileURLToPath(
  new URL("../../coding-adapter/fixtures/fake-opencode.mjs", import.meta.url),
);
const HANGING_OPENCODE = fileURLToPath(
  new URL("../../coding-adapter/fixtures/hanging-opencode.mjs", import.meta.url),
);
const TEST_CREDENTIAL = "fact12-disposable-secret"; // gitleaks:allow, deterministic fake
const migrationDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);
const migrationFile = /^\d{4}-[a-z0-9-]+\.sql$/;

async function committedMigrationFiles() {
  return (await readdir(migrationDirectory))
    .filter((name) => migrationFile.test(name))
    .sort();
}

test("FACT-12 production coding-tool contract", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  const configuredRoot = process.env.ORBITFLOW_WORKSPACE_ROOT;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  assert.ok(configuredRoot, "ORBITFLOW_WORKSPACE_ROOT must be the disposable proof root");

  const pool = new Pool({ connectionString: databaseUrl, application_name: "fact12-proof" });
  try {
    const identity = await pool.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT12_PROOF_DATABASE);
    const cleanMigration = await migratePostgres({ databaseUrl, log: () => {} });
    assert.deepEqual(cleanMigration.applied, await committedMigrationFiles());
    const root = await realpath(configuredRoot);
    const fixtures = await seedFixtures(pool, 19);
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
      const runTotals = await pool.query(
        "SELECT total_tokens::text, total_cost::text FROM workflow_runs WHERE id = $1",
        [runId],
      );
      assert.deepEqual(runTotals.rows[0], {
        total_tokens: "25",
        total_cost: "0.37500000",
      });
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
      const runTotals = await pool.query(
        "SELECT total_tokens::text, total_cost::text FROM workflow_runs WHERE id = $1",
        [runId],
      );
      assert.deepEqual(runTotals.rows[0], {
        total_tokens: "0",
        total_cost: "0.00000000",
      });
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
      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [crashRun]);
      assert.equal(await workspaceService.deleteRunWorkspace(crashRun), true);
      assert.deepEqual(await readdir(path.join(root, ".orbitflow", "quarantine")), []);

      const malformedRun = fixtures.runIds[4];
      const malformedWorkspace = await workspaceService.startRunWorkspace(malformedRun);
      await assert.rejects(
        () => toolFor(malformedRun).delegate_coding_task("malformed-output", malformedWorkspace),
        (error) => error.code === "malformed_output",
      );
      await access(malformedWorkspace);
    });

    await t.test("times out and removes the complete CLI process group on first and repeated runs", async () => {
      if (process.platform === "win32") return;
      const runId = fixtures.runIds[9];
      const workspace = await workspaceService.startRunWorkspace(runId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const pidFile = path.join(workspace, `descendant-${attempt}.json`);
        const timeoutTool = createCodingTool({
          runId,
          agentId: fixtures.agentId,
          workspaceService,
          costEventStore,
          adapterOptions: {
            binary: HANGING_OPENCODE,
            env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
            timeoutMs: 500,
            childStartHandshakeMs: 5_000,
            killGraceMs: 100,
            killWaitMs: 2_000,
          },
        });

        await assert.rejects(
          () => timeoutTool.delegate_coding_task(pidFile, workspace),
          (error) => error.code === "timeout" && error.timeoutMs === 500,
        );
        const { processGroupId, descendantPid } = JSON.parse(await readFile(pidFile, "utf8"));
        assert.equal(inspectProcessGroup(processGroupId).state, "absent");
        assert.equal(processExists(descendantPid), false);
      }
      await access(workspace);
      const persisted = await pool.query(
        "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1",
        [runId],
      );
      assert.equal(persisted.rows[0].count, 0);
    });

    await t.test("cleans only the identity-owned workspace after run deletion", async () => {
      const runId = fixtures.runIds[13];
      const workspace = await workspaceService.startRunWorkspace(runId);
      await assert.rejects(
        () => workspaceService.deleteRunWorkspace(runId),
        (error) => error.code === "workspace_invalid" && /still exists/.test(error.message),
      );
      await access(workspace);

      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [runId]);
      assert.equal(await workspaceService.deleteRunWorkspace(runId), true);
      assert.equal(await workspaceService.deleteRunWorkspace(runId), false);
      await assert.rejects(access(workspace), { code: "ENOENT" });
      await assert.rejects(
        access(path.join(root, ".orbitflow", `run-${runId}.json`)),
        { code: "ENOENT" },
      );
    });

    await t.test("run deletion cancels and joins admitted providers before workspace cleanup", async () => {
      if (process.platform === "win32") return;
      const runId = fixtures.runIds[15];
      let releaseDeletion;
      let reportDeletionStarted;
      const deletionStarted = new Promise((resolve) => {
        reportDeletionStarted = resolve;
      });
      const holdDeletion = new Promise((resolve) => {
        releaseDeletion = resolve;
      });
      const delegationService = createRunWorkspaceService({
        pool,
        workspaceRoot: configuredRoot,
      });
      const coordinatedService = createRunWorkspaceService({
        pool,
        workspaceRoot: configuredRoot,
        async beforeDelegationJoin({ activeCount }) {
          assert.equal(activeCount, 0);
          reportDeletionStarted();
          await holdDeletion;
        },
      });
      const workspace = await delegationService.startRunWorkspace(runId);
      const pidFile = path.join(workspace, "deletion-race-processes.json");
      const blockedPidFile = path.join(workspace, "blocked-delegation-processes.json");
      let credentialHandoffs = 0;
      const activeTool = createCodingTool({
        runId,
        agentId: fixtures.agentId,
        workspaceService: delegationService,
        costEventStore,
        adapterOptions: {
          binary: HANGING_OPENCODE,
          env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
          timeoutMs: 30_000,
          killGraceMs: 100,
          killWaitMs: 2_000,
          beforeCredential() {
            credentialHandoffs += 1;
          },
        },
      });
      const activeDelegation = activeTool.delegate_coding_task(pidFile, workspace);
      const activeFailure = assert.rejects(
        activeDelegation,
        (error) =>
          error.code === "cli_failure" && /cancelled.*workspace.*deleted/.test(error.message),
      );
      await waitForPath(pidFile);
      const { processGroupId, descendantPid } = JSON.parse(await readFile(pidFile, "utf8"));

      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [runId]);
      const deletion = coordinatedService.deleteRunWorkspace(runId);
      await deletionStarted;
      await access(workspace);
      await assert.rejects(
        () => activeTool.delegate_coding_task(blockedPidFile, workspace),
        (error) => error.code === "persistence_failure",
      );
      assert.equal(credentialHandoffs, 1);
      await assert.rejects(access(blockedPidFile), { code: "ENOENT" });

      releaseDeletion();
      assert.equal(await deletion, true);
      await activeFailure;
      assert.equal(inspectProcessGroup(processGroupId).state, "absent");
      assert.equal(processExists(descendantPid), false);
      await assert.rejects(access(workspace), { code: "ENOENT" });
      const persisted = await pool.query(
        "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1",
        [runId],
      );
      assert.equal(persisted.rows[0].count, 0);
    });

    await t.test("reuses execution identity only after positive joined cleanup", async (identityTest) => {
      if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
        identityTest.skip("POSIX identities are required");
        return;
      }
      const liveRun = fixtures.runIds[16];
      const reuseRun = fixtures.runIds[17];
      const uncertainRun = fixtures.runIds[18];
      const currentUid = process.getuid();
      const currentGid = process.getgid();
      const allocatedUid = currentUid === 0 ? 20_000 : currentUid;
      const allocatedGid = currentUid === 0 ? 20_000 : currentGid;
      let reportDeletionJoin;
      const deletionJoining = new Promise((resolve) => {
        reportDeletionJoin = resolve;
      });
      const identityStore = createExecutionIdentityStore({
        workspaceRoot: configuredRoot,
        uidMin: allocatedUid,
        uidCount: 1,
        gidForUid: () => allocatedGid,
        ...(currentUid === 0
          ? {}
          : { applyOwnership: async (workspace) => chmod(workspace, 0o700) }),
      });
      const lifecycleService = createRunWorkspaceService({
        pool,
        workspaceRoot: configuredRoot,
        async beforeDelegationJoin({ activeCount }) {
          assert.equal(activeCount, 1);
          reportDeletionJoin();
        },
        afterWorkspaceRemoved: identityStore.retire,
      });

      const liveWorkspace = await lifecycleService.startRunWorkspace(liveRun);
      const liveIdentity = await identityStore.ensure(liveRun, liveWorkspace);
      const reuseWorkspace = await lifecycleService.startRunWorkspace(reuseRun);
      await assert.rejects(
        () => identityStore.ensure(reuseRun, reuseWorkspace),
        (error) => error.code === "workspace_invalid" && /pool is exhausted/.test(error.message),
      );

      let releaseDelegation;
      let reportAdmitted;
      const admitted = new Promise((resolve) => {
        reportAdmitted = resolve;
      });
      const holdDelegation = new Promise((resolve) => {
        releaseDelegation = resolve;
      });
      const delegation = lifecycleService.authorityForRun(liveRun).withDelegation(
        async ({ signal }) => {
          reportAdmitted(signal);
          await holdDelegation;
        },
      );
      const deletionSignal = await admitted;
      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [liveRun]);
      const deletion = lifecycleService.deleteRunWorkspace(liveRun);
      await deletionJoining;
      assert.equal(deletionSignal.aborted, true);
      await assert.rejects(
        () => identityStore.ensure(reuseRun, reuseWorkspace),
        (error) => error.code === "workspace_invalid" && /pool is exhausted/.test(error.message),
      );
      releaseDelegation();
      await delegation;
      assert.equal(await deletion, true);
      await assert.rejects(
        access(path.join(identityStore.identityRoot, `run-${liveRun}.json`)),
        { code: "ENOENT" },
      );

      const reusedIdentity = await identityStore.ensure(reuseRun, reuseWorkspace);
      assert.equal(reusedIdentity.uid, liveIdentity.uid);
      const uncertainWorkspace = await lifecycleService.startRunWorkspace(uncertainRun);
      await assert.rejects(
        () => identityStore.ensure(uncertainRun, uncertainWorkspace),
        (error) => error.code === "workspace_invalid" && /pool is exhausted/.test(error.message),
      );

      const uncertainService = createRunWorkspaceService({
        pool,
        workspaceRoot: configuredRoot,
        async beforeCleanupBoundary() {
          throw new WorkspaceError("cleanup state is uncertain");
        },
        afterWorkspaceRemoved: identityStore.retire,
      });
      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [reuseRun]);
      await assert.rejects(
        () => uncertainService.deleteRunWorkspace(reuseRun),
        (error) => error.code === "workspace_invalid" && /cleanup state is uncertain/.test(error.message),
      );
      await access(path.join(identityStore.identityRoot, `run-${reuseRun}.json`));
      await assert.rejects(
        () => identityStore.ensure(uncertainRun, uncertainWorkspace),
        (error) => error.code === "workspace_invalid" && /pool is exhausted/.test(error.message),
      );
    });

    await t.test("retains renamed and substituted paths during run-deletion cleanup", async () => {
      const runId = fixtures.runIds[14];
      const workspace = await workspaceService.startRunWorkspace(runId);
      const replacement = await mkdtemp(path.join(tmpdir(), "orbitfactory-fact12-cleanup-attack-"));
      const sentinel = path.join(replacement, "must-survive.txt");
      let retainedDisposalPath;
      await writeFile(sentinel, "replacement target must survive\n");
      const adversarialService = createRunWorkspaceService({
        pool,
        workspaceRoot: configuredRoot,
        async beforeCleanupBoundary({ path: disposalPath }) {
          retainedDisposalPath = `${disposalPath}-retained`;
          await rename(disposalPath, retainedDisposalPath);
          await symlink(replacement, disposalPath, "dir");
        },
      });
      try {
        await pool.query("DELETE FROM workflow_runs WHERE id = $1", [runId]);
        await assert.rejects(
          () => adversarialService.deleteRunWorkspace(runId),
          (error) =>
            error.code === "workspace_invalid" && /anchored boundary/.test(error.message),
        );
        await assert.rejects(access(workspace), { code: "ENOENT" });
        await access(path.join(retainedDisposalPath, ".git", "orbitflow-workspace.json"));
        assert.equal(await readFile(sentinel, "utf8"), "replacement target must survive\n");
        await access(path.join(root, ".orbitflow", `run-${runId}.json`));
      } finally {
        await rm(replacement, { recursive: true, force: true });
      }
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

      const deletedRun = fixtures.runIds[10];
      const deletedWorkspace = await workspaceService.startRunWorkspace(deletedRun);
      await rm(deletedWorkspace, { recursive: true });
      await assert.rejects(
        () => workspaceService.resolveWorkspace(deletedRun, deletedWorkspace),
        (error) => error.code === "workspace_invalid",
      );
      await assert.rejects(
        () => workspaceService.startRunWorkspace(deletedRun),
        (error) => error.code === "workspace_invalid",
      );
      await assert.rejects(access(deletedWorkspace), { code: "ENOENT" });
    });

    await t.test("rejects a spawn-boundary replacement before credential handoff", async () => {
      const runId = fixtures.runIds[11];
      const workspace = await workspaceService.startRunWorkspace(runId);
      const retained = `${workspace}-retained`;
      const replacement = await mkdtemp(path.join(tmpdir(), "orbitfactory-fact12-boundary-"));
      const replacementTool = createCodingTool({
        runId,
        agentId: fixtures.agentId,
        workspaceService,
        costEventStore,
        adapterOptions: {
          ...adapterOptions,
          async beforeCredential() {
            await rename(workspace, retained);
            await symlink(replacement, workspace, "dir");
          },
        },
      });
      try {
        await assert.rejects(
          () => replacementTool.delegate_coding_task("capture-command", workspace),
          (error) => error.code === "cli_failure" && /credential handoff/.test(error.message),
        );
        await assert.rejects(access(path.join(replacement, "command-capture.json")), { code: "ENOENT" });
        await assert.rejects(access(path.join(retained, "command-capture.json")), { code: "ENOENT" });
        const persisted = await pool.query(
          "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1",
          [runId],
        );
        assert.equal(persisted.rows[0].count, 0);
      } finally {
        await rm(replacement, { recursive: true, force: true });
      }
    });

    await t.test("rejects unsafe provider usage before cost persistence", async () => {
      const runId = fixtures.runIds[12];
      const workspace = await workspaceService.startRunWorkspace(runId);
      await assert.rejects(
        () => toolFor(runId).delegate_coding_task("invalid-usage:fractional", workspace),
        (error) => error.code === "malformed_output",
      );
      const persisted = await pool.query(
        "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1",
        [runId],
      );
      assert.equal(persisted.rows[0].count, 0);
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

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPath(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(target);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${target}`);
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
