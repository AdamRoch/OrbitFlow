import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import {
  OpenClawRuntimeAdapter,
  RuntimeAdapterError,
} from "../../src/lib/runtime/openclaw.ts";

const { Pool } = pg;
const fixture = fileURLToPath(
  new URL("../runtime/fixtures/fake-openclaw.mjs", import.meta.url),
);

function completedOutput(label) {
  return {
    artifact: { label, accepted: true },
    handoff_brief: `${label} completed`,
    events: [{ type: "proof", label }],
  };
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  assert.fail(`timed out waiting for ${file}`);
}

test("FACT-11 OpenClaw RuntimeAdapter", async (t) => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");
  assert.equal(
    process.env.ORBITFACTORY_FACT11_PROOF_DATABASE,
    new URL(databaseUrl).pathname.slice(1),
    "refuse to run the destructive proof against an unmarked database",
  );

  await migratePostgres({ databaseUrl, log: () => {} });
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "orbitflow-fact11-"));
  const stateDirectory = path.join(runtimeRoot, "state");
  const proofCredential = `gateway-proof-${randomUUID()}`;
  const exfiltrationSentinel = `provider-proof-${randomUUID()}`;
  process.env.ORBITFLOW_EXFIL_SENTINEL = exfiltrationSentinel;
  const adapter = new OpenClawRuntimeAdapter({
    pool,
    runtimeRoot,
    openClawCommand: process.execPath,
    openClawCommandArguments: [fixture],
    gatewayEnvironment: {
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_TOKEN: proofCredential,
    },
    wakeTimeoutMs: 2_000,
    terminationGraceMs: 100,
  });

  let projectId;
  let agentId;
  let workflowId;

  async function resetPlan(plan) {
    await writeFile(path.join(stateDirectory, "fake-plan.json"), JSON.stringify(plan));
    await writeFile(path.join(stateDirectory, "fake-turn-counter.txt"), "0");
  }

  async function requests() {
    try {
      return (await readFile(path.join(stateDirectory, "fake-requests.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function createRun(label) {
    const result = await pool.query(
      `INSERT INTO workflow_runs (
         workflow_id, status, trigger_type, spec, started_at
       ) VALUES ($1, 'running', 'ui', $2::jsonb, now())
       RETURNING id::text`,
      [workflowId, JSON.stringify({ label, objective: `Prove ${label}` })],
    );
    return result.rows[0].id;
  }

  async function createTicket(runId, number, label) {
    const result = await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority, assignee_agent_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', 3, $8)
       RETURNING id::text`,
      [
        number,
        `RUN-${number}`,
        projectId,
        runId,
        `Ticket ${label}`,
        `Description ${label}`,
        `Acceptance ${label}`,
        agentId,
      ],
    );
    return result.rows[0].id;
  }

  t.after(async () => {
    delete process.env.ORBITFLOW_EXFIL_SENTINEL;
    await pool.end();
    await rm(runtimeRoot, { recursive: true, force: true });
  });

  await t.test("sets up only the inherited PostgreSQL schema", async () => {
    const project = await pool.query(
      `INSERT INTO projects (key, name, next_number)
       VALUES ('RUN', 'Runtime proof', 20) RETURNING id::text`,
    );
    projectId = project.rows[0].id;
    const agent = await pool.query(
      `INSERT INTO agents (
         name, role, system_prompt, model, guardrails, interaction_rules, memory
       ) VALUES ($1, $2, $3, $4, '{}', '{}', $5::jsonb)
       RETURNING id::text`,
      [
        "Mira",
        "runtime worker",
        "Act as a careful runtime worker.",
        "openrouter/openai/gpt-4.1-mini",
        JSON.stringify({ durableFact: "run-one-fact" }),
      ],
    );
    agentId = agent.rows[0].id;
    const workflow = await pool.query(
      `INSERT INTO workflows (name, description, graph)
       VALUES ('Runtime proof', 'FACT-11 workflow context', '{}')
       RETURNING id::text`,
    );
    workflowId = workflow.rows[0].id;

    const migrations = await pool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      migrations.rows.map((row) => row.version),
      [
        "0001-control-plane.sql",
        "0002-tickets.sql",
        "0003-message-plane.sql",
        "0004-message-consumption.sql",
        "0009-state-stream-notify.sql",
      ],
    );
  });

  await t.test("creates a live agent and applies row edits on resync", async () => {
    const first = await adapter.syncAgent(agentId);
    assert.equal(first.created, true);
    assert.equal(first.openclawRef, `orbitflow-${agentId}`);

    await pool.query(
      `UPDATE agents
       SET name = 'Mira Updated',
           system_prompt = 'Use the edited node persona.',
           model = 'openrouter/openai/gpt-4.1',
           memory = '{"durableFact":"edited-before-wake"}'::jsonb,
           updated_at = now()
       WHERE id = $1`,
      [agentId],
    );
    const second = await adapter.syncAgent(agentId);
    assert.equal(second.created, false);

    const liveAgents = JSON.parse(
      await readFile(path.join(stateDirectory, "fake-agents.json"), "utf8"),
    );
    assert.equal(liveAgents[0].model, "openrouter/openai/gpt-4.1");
    assert.equal(liveAgents[0].workspace, second.workspace);
    assert.match(await readFile(path.join(second.workspace, "IDENTITY.md"), "utf8"), /Mira Updated/);
    assert.match(
      await readFile(path.join(second.workspace, "SOUL.md"), "utf8"),
      /edited node persona/,
    );
    assert.match(
      await readFile(path.join(second.workspace, "MEMORY.md"), "utf8"),
      /edited-before-wake/,
    );
    const persisted = await pool.query(
      "SELECT openclaw_ref FROM agents WHERE id = $1",
      [agentId],
    );
    assert.equal(persisted.rows[0].openclaw_ref, first.openclawRef);

    const credentiallessAdapter = new OpenClawRuntimeAdapter({
      pool,
      runtimeRoot,
      openClawCommand: process.execPath,
      openClawCommandArguments: [fixture],
      wakeTimeoutMs: 2_000,
      terminationGraceMs: 100,
    });
    const beforeCredentiallessSync = (await requests()).length;
    await credentiallessAdapter.syncAgent(agentId);
    assert.ok(
      (await requests())
        .slice(beforeCredentiallessSync)
        .every((request) => request.gatewayCredentialPresent === false),
    );
  });

  await t.test("rejects arbitrary child environment passthrough", () => {
    assert.throws(
      () =>
        new OpenClawRuntimeAdapter({
          pool,
          runtimeRoot,
          openClawCommand: process.execPath,
          openClawCommandArguments: [fixture],
          gatewayEnvironment: { OPENROUTER_API_KEY: exfiltrationSentinel },
        }),
      /unsupported variables: OPENROUTER_API_KEY/,
    );
  });

  await t.test("composes delivery context, round-trips memory, and attributes usage", async () => {
    const runOne = await createRun("memory-run-one");
    const ticketOne = await createTicket(runOne, 1, "memory one");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("memory-run-one"),
        usage: { input: 30, output: 12, total: 42, cost: { total: "0.0042" } },
      },
    ]);
    const first = await adapter.wakeAgent({
      runId: runOne,
      agentId,
      invocationId: "memory-run-one-implement",
      nodeId: "implement",
      nodeSystemPrompt: "Implement only the assigned runtime ticket.",
      ticketIds: [ticketOne],
      upstreamHandoffBrief: "Upstream verified the schema.",
    });
    assert.equal(first.attempts, 1);
    assert.deepEqual(first.output, completedOutput("memory-run-one"));
    const firstAgentRequest = (await requests()).filter(
      (request) => request.command === "agent",
    ).at(-1);
    assert.match(firstAgentRequest.message, /Implement only the assigned runtime ticket/);
    assert.match(firstAgentRequest.message, /Ticket memory one/);
    assert.match(firstAgentRequest.message, /Upstream verified the schema/);
    assert.match(firstAgentRequest.message, /edited-before-wake/);

    await pool.query(
      "UPDATE agents SET memory = $2::jsonb, updated_at = now() WHERE id = $1",
      [agentId, JSON.stringify({ durableFact: "stored-during-run-one" })],
    );
    const runTwo = await createRun("memory-run-two");
    await createTicket(runTwo, 2, "memory two");
    await resetPlan([{ mode: "success", output: completedOutput("memory-run-two") }]);
    await adapter.wakeAgent({
      runId: runTwo,
      agentId,
      invocationId: "memory-run-two-review",
      nodeId: "review",
      nodeSystemPrompt: "Review the assigned result.",
      upstreamHandoffBrief: "Run one stored a fact.",
    });
    const agentRequests = (await requests()).filter((request) => request.command === "agent");
    assert.match(agentRequests.at(-1).message, /stored-during-run-one/);
    assert.match(
      agentRequests.at(-1).arguments[agentRequests.at(-1).arguments.indexOf("--session-id") + 1],
      /^orbitflow-[a-f0-9]{32}$/,
    );
    assert.ok(agentRequests.every((request) => request.gatewayCredentialPresent));
    assert.ok(
      (await requests()).every(
        (request) => request.forbiddenEnvironmentPresent.length === 0,
      ),
    );
    const retainedRequests = await readFile(
      path.join(stateDirectory, "fake-requests.ndjson"),
      "utf8",
    );
    assert.ok(!retainedRequests.includes(proofCredential));
    assert.ok(!retainedRequests.includes(exfiltrationSentinel));

    const costs = await pool.query(
      `SELECT run_id::text, agent_id::text, model, tokens_in::int,
              tokens_out::int, computed_cost::text
       FROM cost_events
       WHERE run_id = ANY($1::bigint[])
       ORDER BY run_id`,
      [[runOne, runTwo]],
    );
    assert.equal(costs.rowCount, 2);
    assert.deepEqual(costs.rows[0], {
      run_id: runOne,
      agent_id: agentId,
      model: "openrouter/openai/gpt-4.1-mini",
      tokens_in: 30,
      tokens_out: 12,
      computed_cost: "0.00420000",
    });
    const aggregate = await pool.query(
      "SELECT total_tokens::int, total_cost::text FROM workflow_runs WHERE id = $1",
      [runOne],
    );
    assert.deepEqual(aggregate.rows[0], {
      total_tokens: 42,
      total_cost: "0.00420000",
    });
  });

  await t.test("retries malformed structured output exactly once", async () => {
    const runId = await createRun("malformed-retry-success");
    await createTicket(runId, 3, "malformed retry");
    await resetPlan([
      {
        mode: "malformed",
        final: `\`\`\`json\n${JSON.stringify(completedOutput("fenced-must-retry"))}\n\`\`\``,
      },
      { mode: "success", output: completedOutput("retry-success") },
    ]);
    const before = (await requests()).length;
    const result = await adapter.wakeAgent({
      runId,
      agentId,
      invocationId: "malformed-retry",
      nodeId: "retry",
      nodeSystemPrompt: "Return the fixed output contract.",
    });
    assert.equal(result.attempts, 2);
    assert.equal(
      (await requests()).slice(before).filter((request) => request.command === "agent").length,
      2,
    );
    const retriedRequests = (await requests())
      .slice(before)
      .filter((request) => request.command === "agent");
    assert.doesNotMatch(retriedRequests[0].message, /Structured-output retry/);
    assert.match(retriedRequests[1].message, /This is the only retry/);
    const errors = await pool.query(
      `SELECT count(*)::int AS count FROM messages
       WHERE run_id = $1 AND recipient = 'workflow-engine'`,
      [runId],
    );
    assert.equal(errors.rows[0].count, 0);
  });

  await t.test("accepts only the pinned gateway envelope and rejects false success", async () => {
    const completedRunId = await createRun("gateway-completion");
    await createTicket(completedRunId, 7, "gateway completion");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("gateway-completion"),
        usage: { input: 21, output: 9, total: 30, cost: { total: "0.003" } },
      },
    ]);
    const completed = await adapter.wakeAgent({
      runId: completedRunId,
      agentId,
      invocationId: "gateway-completion",
      nodeId: "gateway",
      nodeSystemPrompt: "Complete through the pinned gateway envelope.",
    });
    assert.equal(completed.completion.status, "stop");
    assert.deepEqual(completed.output, completedOutput("gateway-completion"));

    const rejected = [
      {
        label: "blocked",
        expectedCode: "openclaw_turn_failed",
        plan: { mode: "success", livenessState: "blocked" },
      },
      {
        label: "error",
        expectedCode: "openclaw_turn_failed",
        plan: { mode: "success", error: { kind: "provider_failure" } },
      },
      {
        label: "aborted",
        expectedCode: "openclaw_turn_failed",
        plan: { mode: "success", aborted: true },
      },
      {
        label: "replay-invalid",
        expectedCode: "openclaw_turn_failed",
        plan: { mode: "success", replayInvalid: true },
      },
      {
        label: "missing-provider",
        expectedCode: "openclaw_turn_failed",
        plan: { mode: "success", provider: null },
      },
      {
        label: "string-usage",
        expectedCode: "openclaw_usage_invalid",
        plan: {
          mode: "success",
          usage: { input: "1", output: 1, total: 2 },
        },
      },
      {
        label: "unsupported",
        expectedCode: "openclaw_turn_failed",
        plan: {
          mode: "raw",
          envelope: {
            ok: true,
            status: "ok",
            final: JSON.stringify(completedOutput("must-not-pass")),
            usage: { input: 1, output: 1, total: 2 },
            sessionId: "stale",
          },
        },
      },
    ];
    for (const [index, scenario] of rejected.entries()) {
      const runId = await createRun(`false-success-${scenario.label}`);
      await createTicket(runId, 8 + index, `false success ${scenario.label}`);
      await resetPlan([{ ...scenario.plan, output: completedOutput("must-not-pass") }]);
      await assert.rejects(
        () =>
          adapter.wakeAgent({
            runId,
            agentId,
            invocationId: `false-success-${scenario.label}`,
            nodeId: "adversarial",
            nodeSystemPrompt: "A zero exit is not sufficient.",
          }),
        (error) =>
          error instanceof RuntimeAdapterError && error.code === scenario.expectedCode,
      );
      const durableError = await pool.query(
        "SELECT payload FROM messages WHERE run_id = $1",
        [runId],
      );
      assert.equal(durableError.rowCount, 1);
      assert.equal(durableError.rows[0].payload.code, scenario.expectedCode);
    }
  });

  await t.test("replays one durable invocation without executing or charging twice", async () => {
    const runId = await createRun("durable-replay");
    const ticketId = await createTicket(runId, 20, "durable replay");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("durable-replay"),
        usage: { input: 17, output: 8, total: 25, cost: { total: "0.0025" } },
      },
    ]);
    const wake = {
      runId,
      agentId,
      invocationId: "durable-replay",
      nodeId: "replay",
      nodeSystemPrompt: "Execute this logical invocation once.",
      ticketIds: [ticketId],
    };
    const before = (await requests()).length;
    const results = await Promise.all([
      adapter.wakeAgent(wake),
      adapter.wakeAgent(wake),
    ]);
    assert.deepEqual(
      results.map((result) => result.replayed).sort(),
      [false, true],
    );
    assert.equal(results[0].costEventId, results[1].costEventId);
    const restartedAdapter = new OpenClawRuntimeAdapter({
      pool,
      runtimeRoot,
      openClawCommand: process.execPath,
      openClawCommandArguments: [fixture],
      gatewayEnvironment: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
        OPENCLAW_GATEWAY_TOKEN: proofCredential,
      },
      wakeTimeoutMs: 2_000,
      terminationGraceMs: 100,
    });
    const restartedReplay = await restartedAdapter.wakeAgent(wake);
    assert.equal(restartedReplay.replayed, true);
    assert.equal(restartedReplay.costEventId, results[0].costEventId);
    assert.equal(
      (await requests()).slice(before).filter((request) => request.command === "agent").length,
      1,
    );
    const persisted = await pool.query(
      `SELECT count(*)::int AS cost_count,
              max(tokens_in)::int AS tokens_in,
              max(tokens_out)::int AS tokens_out
       FROM cost_events WHERE run_id = $1`,
      [runId],
    );
    assert.deepEqual(persisted.rows[0], {
      cost_count: 1,
      tokens_in: 17,
      tokens_out: 8,
    });
    const aggregate = await pool.query(
      "SELECT total_tokens::int, total_cost::text FROM workflow_runs WHERE id = $1",
      [runId],
    );
    assert.deepEqual(aggregate.rows[0], {
      total_tokens: 25,
      total_cost: "0.00250000",
    });
    const receipt = await pool.query(
      `SELECT count(*)::int AS count FROM messages
       WHERE run_id = $1
         AND payload->>'kind' = 'openclaw_invocation_result'`,
      [runId],
    );
    assert.equal(receipt.rows[0].count, 1);

    await assert.rejects(
      () =>
        adapter.wakeAgent({
          ...wake,
          nodeSystemPrompt: "Changed input must not reuse the invocation id.",
        }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.code === "openclaw_invocation_conflict",
    );
    assert.equal(
      (await requests()).slice(before).filter((request) => request.command === "agent").length,
      1,
    );
  });

  await t.test("rejects output whose session identity does not match the requested session", async () => {
    const runId = await createRun("session-mismatch");
    await createTicket(runId, 21, "session mismatch");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("stale-output"),
        reportedSessionId: "stale-session-id",
      },
    ]);
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId,
          agentId,
          invocationId: "session-mismatch",
          nodeId: "session-binding",
          nodeSystemPrompt: "Reject stale output.",
        }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.code === "openclaw_session_mismatch",
    );
    const durableError = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [runId],
    );
    assert.equal(durableError.rowCount, 1);
    assert.equal(durableError.rows[0].payload.code, "openclaw_session_mismatch");
  });

  await t.test("inserts one durable FACT-9 system error after two malformed outputs", async () => {
    const runId = await createRun("malformed-final-failure");
    const ticketId = await createTicket(runId, 4, "malformed failure");
    await resetPlan([
      { mode: "malformed", final: "still not json" },
      { mode: "malformed", final: '{"artifact":{},"events":[]}' },
    ]);
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId,
          agentId,
          invocationId: "malformed-final-failure",
          nodeId: "malformed",
          nodeSystemPrompt: "Return the fixed output contract.",
        }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.code === "openclaw_malformed_output",
    );
    const message = await pool.query(
      `SELECT run_id::text, ticket_id::text, sequence_number::text, sender,
              recipient, type::text, payload
       FROM messages WHERE run_id = $1`,
      [runId],
    );
    assert.equal(message.rowCount, 1);
    assert.deepEqual(
      {
        run_id: message.rows[0].run_id,
        ticket_id: message.rows[0].ticket_id,
        sequence_number: message.rows[0].sequence_number,
        sender: message.rows[0].sender,
        recipient: message.rows[0].recipient,
        type: message.rows[0].type,
        code: message.rows[0].payload.code,
        attempts: message.rows[0].payload.attempts,
      },
      {
        run_id: runId,
        ticket_id: ticketId,
        sequence_number: "1",
        sender: "runtime:openclaw",
        recipient: "workflow-engine",
        type: "system",
        code: "openclaw_malformed_output",
        attempts: 2,
      },
    );
  });

  await t.test("times out, kills the process group, and inserts a durable system error", async () => {
    const runId = await createRun("timeout");
    await createTicket(runId, 5, "timeout");
    await resetPlan([{ mode: "timeout" }]);
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId,
          agentId,
          invocationId: "timeout",
          nodeId: "timeout",
          nodeSystemPrompt: "This fake turn hangs.",
          timeoutMs: 150,
        }),
      (error) =>
        error instanceof RuntimeAdapterError && error.code === "openclaw_timeout",
    );
    const pids = JSON.parse(
      await readFile(path.join(stateDirectory, "fake-timeout-pids.json"), "utf8"),
    );
    await delay(50);
    assert.equal(await processExists(pids.parent), false, "fake OpenClaw parent must be gone");
    assert.equal(await processExists(pids.grandchild), false, "fake OpenClaw child must be gone");
    const message = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [runId],
    );
    assert.equal(message.rowCount, 1);
    assert.equal(message.rows[0].payload.code, "openclaw_timeout");
    assert.equal(message.rows[0].payload.attempts, 1);
    const abort = (await requests()).filter((request) => request.command === "sessions-abort").at(-1);
    assert.match(
      abort.sessionKey,
      new RegExp(`^agent:orbitflow-${agentId}:explicit:orbitflow-`),
    );
  });

  await t.test("explicit termination kills the active session and surfaces a durable error", async () => {
    const runId = await createRun("explicit-termination");
    await createTicket(runId, 6, "explicit termination");
    const pidsPath = path.join(stateDirectory, "fake-timeout-pids.json");
    await unlink(pidsPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await resetPlan([{ mode: "timeout" }]);
    const wake = adapter.wakeAgent({
      runId,
      agentId,
      invocationId: "explicit-termination",
      nodeId: "terminate",
      nodeSystemPrompt: "This fake turn is terminated by the caller.",
      timeoutMs: 2_000,
    });
    const rejected = assert.rejects(
      wake,
      (error) =>
        error instanceof RuntimeAdapterError && error.code === "openclaw_terminated",
    );
    const pids = await waitForFile(pidsPath);
    await adapter.terminateAgent(agentId);
    await rejected;
    assert.equal(await processExists(pids.parent), false);
    assert.equal(await processExists(pids.grandchild), false);
    const message = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [runId],
    );
    assert.equal(message.rowCount, 1);
    assert.equal(message.rows[0].payload.code, "openclaw_terminated");
    const abort = (await requests()).filter((request) => request.command === "sessions-abort").at(-1);
    assert.match(
      abort.sessionKey,
      new RegExp(`^agent:orbitflow-${agentId}:explicit:orbitflow-`),
    );
  });
});
