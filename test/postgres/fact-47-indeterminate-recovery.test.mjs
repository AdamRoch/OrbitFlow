import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import {
  OpenClawEngineAdapter,
} from "../../src/lib/runtime/engine-adapter.ts";
import {
  OpenClawRuntimeAdapter,
} from "../../src/lib/runtime/openclaw.ts";
import {
  createWorkflowRun,
  dispatchNextWorkflowNode,
  getWorkflowRun,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";

const { Client, Pool } = pg;
const fixture = fileURLToPath(
  new URL("../runtime/fixtures/fake-openclaw.mjs", import.meta.url),
);

async function assertProofDatabase(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS name");
    assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT47_PROOF_DATABASE);
  } finally {
    await client.end();
  }
}

function reservationId(runId, agentId, invocationId) {
  const invocationKey = createHash("sha256")
    .update(JSON.stringify({
      agentId: String(agentId),
      invocationId,
      runId: String(runId),
    }))
    .digest("hex");
  const positive =
    (BigInt(`0x${invocationKey.slice(0, 16)}`) & ((1n << 63n) - 1n)) + 1n;
  return {
    invocationKey,
    id: (-positive).toString(),
  };
}

async function fakeRequests(runtimeRoot) {
  try {
    return (await readFile(path.join(runtimeRoot, "state", "fake-requests.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("FACT-47 fails closed when OpenClaw recovery finds an unreceipted reservation", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  assert.equal(
    process.env.ORBITFACTORY_FACT47_PROOF_DATABASE,
    new URL(databaseUrl).pathname.slice(1),
    "refuse to run the destructive proof against an unmarked database",
  );

  await assertProofDatabase(databaseUrl);
  await migratePostgres({ databaseUrl, log: () => {} });
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "orbitflow-fact47-"));

  try {
    const agent = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory)
       VALUES ('fact47-worker', 'runtime worker', 'Run the recovery proof.', 'openrouter/openai/gpt-4.1-mini', '{}', '{}', '{}')
       RETURNING id::text`,
    );
    const agentId = agent.rows[0].id;
    const workflow = await pool.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('FACT-47 recovery', 'Indeterminate OpenClaw recovery proof', $1::jsonb)
       RETURNING id::text`,
      [JSON.stringify({
        nodes: [{ id: "worker", agentId, config: { entry: true } }],
        edges: [],
      })],
    );
    const run = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: { objective: "prove indeterminate recovery" },
    });
    await startWorkflowRun(pool, run.id);
    const initialDispatch = await pool.query(
      `SELECT * FROM workflow_dispatches WHERE run_id = $1 AND node_id = 'worker'`,
      [run.id],
    );
    assert.equal(initialDispatch.rowCount, 1);
    const dispatch = initialDispatch.rows[0];
    const invocationId = dispatch.idempotency_key;
    const reservation = reservationId(run.id, agentId, invocationId);

    await pool.query(
      `INSERT INTO cost_events (
         id, run_id, agent_id, model, tokens_in, tokens_out, computed_cost
       ) VALUES ($1, $2, $3, $4, 0, 0, 0)`,
      [reservation.id, run.id, agentId, `orbitflow-invocation:${reservation.invocationKey}`],
    );
    const terminalReceipts = await pool.query(
      `SELECT count(*)::int AS count
       FROM messages
       WHERE run_id = $1
         AND sender = 'runtime:openclaw'
         AND payload->>'invocationKey' = $2
         AND payload->>'kind' IN ('openclaw_invocation_result', 'openclaw_invocation_error')`,
      [run.id, reservation.invocationKey],
    );
    assert.equal(terminalReceipts.rows[0].count, 0);
    await pool.query(
      `UPDATE workflow_dispatches
       SET status = 'reconciling', attempt_count = 1, lease_generation = 1,
           runtime_generation = 1,
           reconciliation_reason = 'provider outcome unknown after dispatch lease expired'
       WHERE id = $1`,
      [dispatch.id],
    );

    const runtime = new OpenClawRuntimeAdapter({
      pool,
      runtimeRoot,
      openClawCommand: process.execPath,
      openClawCommandArguments: [fixture],
      gatewayEnvironment: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        OPENCLAW_GATEWAY_TOKEN: "fact47-proof-token",
      },
      wakeTimeoutMs: 2_000,
      terminationGraceMs: 100,
    });
    const engine = new OpenClawEngineAdapter({ pool, openclaw: runtime });

    const recoveryRequest = await dispatchNextWorkflowNode(pool, engine, {
      workerId: "fact47-restarted-process",
    });
    assert.ok(recoveryRequest);
    assert.equal(recoveryRequest.generation, "1");
    const current = (await pool.query(
      "SELECT * FROM workflow_dispatches WHERE id = $1",
      [dispatch.id],
    )).rows[0];
    assert.equal(current.status, "failed");
    assert.equal(current.attempt_count, 2);
    assert.equal(current.runtime_generation, recoveryRequest.generation);
    assert.match(current.failure_reason, /openclaw_invocation_indeterminate/);
    assert.match(current.failure_reason, /external effect is uncertain/);
    assert.match(current.failure_reason, /provider will not be called again/);

    const failedRun = await getWorkflowRun(pool, run.id);
    assert.equal(failedRun.status, "failed");
    assert.match(failedRun.failureReason, /external effect is uncertain/);

    const messages = await pool.query(
      `SELECT sender, payload
       FROM messages WHERE run_id = $1 ORDER BY sequence_number`,
      [run.id],
    );
    const runtimeError = messages.rows.find(
      (message) => message.payload.kind === "openclaw_invocation_error",
    );
    assert.ok(runtimeError);
    assert.equal(runtimeError.payload.code, "openclaw_invocation_indeterminate");
    assert.match(runtimeError.payload.message, /external effect is uncertain/);
    assert.match(runtimeError.payload.message, /provider will not be called again/);
    const engineError = messages.rows.find(
      (message) => message.payload.code === "runtime_dispatch_failed",
    );
    assert.ok(engineError);
    assert.match(engineError.payload.message, /external effect is uncertain/);

    assert.deepEqual(await fakeRequests(runtimeRoot), [], "recovery never replays the provider");

    const restartedRuntime = new OpenClawRuntimeAdapter({
      pool,
      runtimeRoot,
      openClawCommand: process.execPath,
      openClawCommandArguments: [fixture],
      gatewayEnvironment: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        OPENCLAW_GATEWAY_TOKEN: "fact47-proof-token",
      },
      wakeTimeoutMs: 2_000,
      terminationGraceMs: 100,
    });
    assert.equal(
      await dispatchNextWorkflowNode(
        pool,
        new OpenClawEngineAdapter({ pool, openclaw: restartedRuntime }),
        { workerId: "fact47-after-restart" },
      ),
      null,
    );
    const afterRestart = (await pool.query(
      `SELECT status, runtime_generation, failure_reason
       FROM workflow_dispatches WHERE id = $1`,
      [dispatch.id],
    )).rows[0];
    assert.deepEqual(afterRestart, {
      status: "failed",
      runtime_generation: recoveryRequest.generation,
      failure_reason: current.failure_reason,
    });
    assert.deepEqual(await fakeRequests(runtimeRoot), [], "restart cannot replay a failed invocation");
  } finally {
    await pool.end();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("FACT-47 preserves authoritative absence recovery", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  assert.equal(
    process.env.ORBITFACTORY_FACT47_PROOF_DATABASE,
    new URL(databaseUrl).pathname.slice(1),
    "refuse to run the destructive proof against an unmarked database",
  );

  await assertProofDatabase(databaseUrl);
  await migratePostgres({ databaseUrl, log: () => {} });
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const agent = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model)
       VALUES ('fact47-absence-worker', 'runtime worker', 'Prove absence.', 'mock/fact47')
       RETURNING id::text`,
    );
    const workflow = await pool.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('FACT-47 absence', 'Authoritative absence recovery proof', $1::jsonb)
       RETURNING id::text`,
      [JSON.stringify({
        nodes: [{ id: "worker", agentId: agent.rows[0].id, config: { entry: true } }],
        edges: [],
      })],
    );
    const run = await createWorkflowRun(pool, {
      workflowId: workflow.rows[0].id,
      triggerType: "ui",
      spec: { objective: "prove absence recovery" },
    });
    await startWorkflowRun(pool, run.id);
    const dispatch = await pool.query(
      "SELECT id FROM workflow_dispatches WHERE run_id = $1",
      [run.id],
    );
    await pool.query(
      `UPDATE workflow_dispatches
       SET status = 'reconciling', runtime_generation = 1,
           reconciliation_reason = 'provider outcome unknown after dispatch lease expired'
       WHERE id = $1`,
      [dispatch.rows[0].id],
    );

    let reconcileCalls = 0;
    const runtime = {
      async startSession() {
        return { kind: "started", sessionId: "absence-recovery-session" };
      },
      async reconcileSession() {
        reconcileCalls += 1;
        return { kind: "absent" };
      },
    };
    await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact47-absence" });
    let recovered = (await pool.query(
      "SELECT status, runtime_generation, reconciliation_reason FROM workflow_dispatches WHERE id = $1",
      [dispatch.rows[0].id],
    )).rows[0];
    assert.equal(reconcileCalls, 1);
    assert.deepEqual(recovered, {
      status: "pending",
      runtime_generation: null,
      reconciliation_reason: null,
    });

    await dispatchNextWorkflowNode(pool, runtime, { workerId: "fact47-absence-retry" });
    recovered = (await pool.query(
      "SELECT status, runtime_session_id FROM workflow_dispatches WHERE id = $1",
      [dispatch.rows[0].id],
    )).rows[0];
    assert.deepEqual(recovered, {
      status: "active",
      runtime_session_id: "absence-recovery-session",
    });
  } finally {
    await pool.end();
  }
});
