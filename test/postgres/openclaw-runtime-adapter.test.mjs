import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
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
const migrationDirectory = fileURLToPath(
  new URL("../../db/migrations/", import.meta.url),
);
const migrationFile = /^\d{4}-[a-z0-9-]+\.sql$/;

async function committedMigrationFiles() {
  return (await readdir(migrationDirectory))
    .filter((name) => migrationFile.test(name))
    .sort();
}

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

  async function waitForRequest(predicate) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const found = (await requests()).find(predicate);
      if (found) return found;
      await delay(10);
    }
    assert.fail("timed out waiting for the fake OpenClaw request");
  }

  async function resetConcurrency() {
    await rm(path.join(stateDirectory, "fake-active"), { recursive: true, force: true });
    await rm(path.join(stateDirectory, "fake-overlap.ndjson"), { force: true });
  }

  async function overlaps() {
    try {
      return (await readFile(path.join(stateDirectory, "fake-overlap.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function createAgent(name) {
    const result = await pool.query(
      `INSERT INTO agents (
         name, role, system_prompt, model, guardrails, interaction_rules, memory
       ) VALUES ($1, $2, $3, $4, '{}', '{}', '{}')
       RETURNING id::text`,
      [name, "runtime worker", `Act as ${name}.`, "openrouter/openai/gpt-4.1-mini"],
    );
    return result.rows[0].id;
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

  async function createTicket(runId, number, label, assignee = agentId) {
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
        assignee,
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
      await committedMigrationFiles(),
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
    assert.match(firstAgentRequest.message, /# Blocked actions/);
    assert.match(
      firstAgentRequest.message,
      /No platform tool actions are blocked for this agent\./,
    );
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

  await t.test("reconstructs complete-stream usage from OpenClaw's final-call total", async () => {
    const runId = await createRun("complete-stream-usage");
    await createTicket(runId, 89, "complete stream usage");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("complete-stream-usage"),
        usage: {
          input: 30,
          output: 12,
          cacheRead: 4,
          cacheWrite: 2,
          total: 11,
          cost: { total: "0.0048" },
        },
        lastCallUsage: {
          input: 7,
          output: 4,
          total: 11,
        },
      },
    ]);

    const result = await adapter.wakeAgent({
      runId,
      agentId,
      invocationId: "complete-stream-usage",
      nodeId: "planner",
      nodeSystemPrompt: "Use tools, then return the fixed output contract.",
    });

    assert.deepEqual(result.usage, {
      input: 30,
      output: 12,
      cacheRead: 4,
      cacheWrite: 2,
      total: 48,
      computedCost: "0.0048",
    });
  });

  await t.test("lists blocked actions in the wake prompt when configured, omits when empty", async () => {
    const blocked = await pool.query(
      `INSERT INTO agents (name, role, system_prompt, model, guardrails, interaction_rules, memory)
       VALUES ($1, $2, $3, $4, $5, '{}', '{}')
       RETURNING id::text`,
      [
        "Blocker",
        "blocked agent",
        "You are blocked from creating tickets and posting messages.",
        "openrouter/openai/gpt-4.1-mini",
        JSON.stringify({ blockedActions: ["create_ticket", "post_message"] }),
      ],
    );
    const blockedAgentId = blocked.rows[0].id;
    const blockedRun = await createRun("blocked-prompt-run");
    const blockedTicket = await pool.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority, assignee_agent_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', 3, $8)
       RETURNING id::text`,
      [
        99,
        "RUN-99",
        projectId,
        blockedRun,
        "Blocked prompt ticket",
        "Prove blocked actions in prompt",
        "The prompt lists blocked actions",
        blockedAgentId,
      ],
    );
    await resetPlan([
      { mode: "success", output: completedOutput("blocked-prompt-run") },
    ]);
    await adapter.wakeAgent({
      runId: blockedRun,
      agentId: blockedAgentId,
      invocationId: "blocked-prompt-wake",
      nodeId: "work",
      nodeSystemPrompt: "Check the blocked actions in your prompt.",
      ticketIds: [blockedTicket.rows[0].id],
    });
    const blockedRequest = (await requests())
      .filter((request) => request.command === "agent")
      .at(-1);
    assert.match(blockedRequest.message, /# Blocked actions/);
    assert.match(
      blockedRequest.message,
      /The platform tool surface rejects these actions for this agent; never attempt them:/,
    );
    assert.match(blockedRequest.message, /- create_ticket/);
    assert.match(blockedRequest.message, /- post_message/);
    assert.doesNotMatch(blockedRequest.message, /- update_ticket/);
    assert.doesNotMatch(blockedRequest.message, /No platform tool actions are blocked/);
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
    assert.match(retriedRequests[1].message, /Do not repeat tool actions/);
    assert.match(retriedRequests[1].message, /entire response must start with \{ and end with \}/);
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

    // replayInvalid: true signals mutating tool actions during this turn;
    // a turn with valid output payload remains accepted (no retry risk).
    const replayValidRunId = await createRun("replay-valid-payload");
    await createTicket(replayValidRunId, 82, "replay valid payload");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("replay-valid-payload"),
        replayInvalid: true,
        usage: { input: 11, output: 7, total: 18, cost: { total: "0.002" } },
      },
    ]);
    const replayAccepted = await adapter.wakeAgent({
      runId: replayValidRunId,
      agentId,
      invocationId: "replay-valid-payload",
      nodeId: "replay-valid",
      nodeSystemPrompt: "Produce contract output, call a mutating tool.",
    });
    assert.equal(replayAccepted.replayed, false);
    assert.equal(replayAccepted.attempts, 1);
    assert.deepEqual(replayAccepted.output, completedOutput("replay-valid-payload"));

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
        label: "replay-invalid-invalid-type",
        expectedCode: "openclaw_turn_failed",
        plan: {
          mode: "raw",
          envelope: {
            status: "ok",
            summary: "completed",
            runId: "fake-run",
            result: {
              payloads: [{ text: "not-relevant", mediaUrl: null }],
              meta: {
                aborted: false,
                replayInvalid: "not-a-boolean",
                livenessState: "working",
                stopReason: "stop",
                completion: { stopReason: "stop", finishReason: "stop" },
                agentMeta: {
                  usage: { input: 1, output: 1, total: 2 },
                  provider: "openrouter",
                  model: "test-model",
                  sessionId: "fake-session",
                },
              },
            },
          },
        },
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

  await t.test("rejects replayInvalid true without payload and does not retry", async () => {
    const runId = await createRun("replay-invalid-no-payload");
    await createTicket(runId, 91, "replay invalid no payload");
    await resetPlan([
      {
        mode: "raw",
        envelope: {
          status: "ok",
          summary: "completed",
          runId: "fake-run",
          result: {
            payloads: [],
            meta: {
              aborted: false,
              replayInvalid: true,
              livenessState: "working",
              stopReason: "stop",
              completion: { stopReason: "stop", finishReason: "stop" },
              agentMeta: {
                usage: { input: 1, output: 1, total: 2 },
                provider: "openrouter",
                model: "test-model",
                sessionId: "fake-session",
              },
            },
          },
        },
      },
    ]);
    const before = (await requests()).length;
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId,
          agentId,
          invocationId: "replay-invalid-no-payload",
          nodeId: "adversarial",
          nodeSystemPrompt: "Turn with side effects and no output.",
        }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.code === "openclaw_turn_failed",
    );
    assert.equal(
      (await requests()).slice(before).filter((r) => r.command === "agent").length,
      1,
      "no unsafe retry when replayInvalid is true",
    );
    const durableError = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [runId],
    );
    assert.equal(durableError.rowCount, 1);
    assert.equal(durableError.rows[0].payload.code, "openclaw_turn_failed");
  });

  await t.test("retries no-payload turn when replayInvalid is absent", async () => {
    const runId = await createRun("no-payload-retry-absent");
    await createTicket(runId, 92, "no payload retry absent");
    await resetPlan([
      {
        mode: "raw",
        envelope: {
          status: "ok",
          summary: "completed",
          runId: "fake-run",
          result: {
            payloads: [],
            meta: {
              aborted: false,
              livenessState: "working",
              stopReason: "stop",
              completion: { stopReason: "stop", finishReason: "stop" },
              agentMeta: {
                usage: { input: 1, output: 1, total: 2 },
                provider: "openrouter",
                model: "test-model",
                sessionId: "fake-session",
              },
            },
          },
        },
      },
      {
        mode: "success",
        output: completedOutput("retry-success"),
        usage: { input: 11, output: 7, total: 18, cost: { total: "0.002" } },
      },
    ]);
    const before = (await requests()).length;
    const result = await adapter.wakeAgent({
      runId,
      agentId,
      invocationId: "no-payload-retry-absent",
      nodeId: "no-payload-retry",
      nodeSystemPrompt: "Return the fixed output contract after a no-payload first turn.",
    });
    assert.equal(result.attempts, 2);
    assert.equal(
      (await requests()).slice(before).filter((r) => r.command === "agent").length,
      2,
    );
    assert.deepEqual(result.output, completedOutput("retry-success"));
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
          timeoutMs: 500,
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
      new RegExp(`^agent:orbitflow-${agentId}:main$`),
    );
  });

  await t.test("serializes concurrent wakes for the same canonical agent ref", async () => {
    const runA = await createRun("same-ref-a");
    await createTicket(runA, 30, "same ref a");
    const runB = await createRun("same-ref-b");
    await createTicket(runB, 31, "same ref b");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("same-ref"),
        delayMs: 400,
        usage: { input: 5, output: 3, total: 8, cost: { total: "0.001" } },
      },
    ]);
    await resetConcurrency();
    const before = (await requests()).length;
    const results = await Promise.all([
      adapter.wakeAgent({
        runId: runA,
        agentId,
        invocationId: "same-ref-a",
        nodeId: "work",
        nodeSystemPrompt: "First same-ref wake.",
        timeoutMs: 10_000,
      }),
      adapter.wakeAgent({
        runId: runB,
        agentId,
        invocationId: "same-ref-b",
        nodeId: "work",
        nodeSystemPrompt: "Second same-ref wake.",
        timeoutMs: 10_000,
      }),
    ]);
    assert.ok(results.every((result) => result.replayed === false));
    const agentRequests = (await requests())
      .slice(before)
      .filter((request) => request.command === "agent");
    assert.equal(agentRequests.length, 2);
    const observations = await overlaps();
    assert.equal(observations.length, 2);
    assert.ok(
      observations.every(
        (observation) => observation.sameAgent === 1 && observation.total === 1,
      ),
      "same-agent OpenClaw turns must never overlap",
    );
  });

  await t.test("keeps wakes for different agent refs concurrent", async () => {
    const otherAgentId = await createAgent("Nova");
    const runA = await createRun("cross-ref-a");
    await createTicket(runA, 32, "cross ref a");
    const runB = await createRun("cross-ref-b");
    await createTicket(runB, 33, "cross ref b", otherAgentId);
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("cross-ref"),
        delayMs: 1_500,
        waitForTotal: 2,
        usage: { input: 6, output: 4, total: 10, cost: { total: "0.001" } },
      },
    ]);
    await resetConcurrency();
    const before = (await requests()).length;
    const results = await Promise.all([
      adapter.wakeAgent({
        runId: runA,
        agentId,
        invocationId: "cross-ref-a",
        nodeId: "work",
        nodeSystemPrompt: "First cross-ref wake.",
        timeoutMs: 10_000,
      }),
      adapter.wakeAgent({
        runId: runB,
        agentId: otherAgentId,
        invocationId: "cross-ref-b",
        nodeId: "work",
        nodeSystemPrompt: "Second cross-ref wake.",
        timeoutMs: 10_000,
      }),
    ]);
    assert.ok(results.every((result) => result.replayed === false));
    const agentRequests = (await requests())
      .slice(before)
      .filter((request) => request.command === "agent");
    assert.equal(agentRequests.length, 2);
    const observations = await overlaps();
    assert.equal(observations.length, 2);
    assert.ok(observations.every((observation) => observation.sameAgent === 1));
    assert.ok(
      observations.every((observation) => observation.total >= 2),
      "the overlap barrier must release both different-ref turns only after they see each other",
    );
  });

  await t.test("releases the agent session lock on the timeout path", async () => {
    const timedOutRun = await createRun("lock-release-timeout");
    await createTicket(timedOutRun, 34, "lock release timeout");
    await resetPlan([{ mode: "timeout" }]);
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId: timedOutRun,
          agentId,
          invocationId: "lock-release-timeout",
          nodeId: "timeout",
          nodeSystemPrompt: "This wake times out while holding the lock.",
          timeoutMs: 150,
        }),
      (error) =>
        error instanceof RuntimeAdapterError && error.code === "openclaw_timeout",
    );
    const followUpRun = await createRun("lock-release-follow-up");
    await createTicket(followUpRun, 35, "lock release follow up");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("lock-release-follow-up"),
        usage: { input: 7, output: 5, total: 12, cost: { total: "0.0012" } },
      },
    ]);
    const followUp = await adapter.wakeAgent({
      runId: followUpRun,
      agentId,
      invocationId: "lock-release-follow-up",
      nodeId: "work",
      nodeSystemPrompt: "This wake must acquire the released lock.",
      timeoutMs: 2_000,
    });
    assert.equal(followUp.replayed, false);
    assert.deepEqual(followUp.output, completedOutput("lock-release-follow-up"));
  });

  await t.test("fails closed with a typed durable error at the acquisition deadline", async () => {
    const slowRun = await createRun("lock-deadline-slow");
    await createTicket(slowRun, 36, "lock deadline slow");
    const waitingRun = await createRun("lock-deadline-waiting");
    await createTicket(waitingRun, 37, "lock deadline waiting");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("lock-deadline-slow"),
        delayMs: 1_500,
        usage: { input: 9, output: 6, total: 15, cost: { total: "0.0015" } },
      },
    ]);
    await resetConcurrency();
    const slowWake = adapter.wakeAgent({
      runId: slowRun,
      agentId,
      invocationId: "lock-deadline-slow",
      nodeId: "work",
      nodeSystemPrompt: "Slow wake holding the agent session lock.",
      timeoutMs: 10_000,
    });
    await waitForRequest(
      (request) =>
        request.command === "agent" &&
        typeof request.message === "string" &&
        request.message.includes("Slow wake holding the agent session lock."),
    );
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId: waitingRun,
          agentId,
          invocationId: "lock-deadline-waiting",
          nodeId: "work",
          nodeSystemPrompt: "This wake must stop waiting at its deadline.",
          timeoutMs: 200,
        }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.code === "openclaw_session_lock_timeout" &&
        error.safeDetails.stage === "lock",
    );
    const durable = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [waitingRun],
    );
    assert.equal(durable.rowCount, 1);
    assert.equal(durable.rows[0].payload.code, "openclaw_session_lock_timeout");
    assert.equal(durable.rows[0].payload.details.stage, "lock");
    assert.equal(durable.rows[0].payload.attempts, 0);
    const slowResult = await slowWake;
    assert.equal(slowResult.replayed, false);
    const observations = await overlaps();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].total, 1);
    const costs = await pool.query(
      `SELECT count(*)::int AS count, max(tokens_in)::int AS tokens_in
       FROM cost_events WHERE run_id = $1`,
      [waitingRun],
    );
    assert.deepEqual(costs.rows[0], { count: 1, tokens_in: 0 });
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId: waitingRun,
          agentId,
          invocationId: "lock-deadline-waiting",
          nodeId: "work",
          nodeSystemPrompt: "This wake must stop waiting at its deadline.",
          timeoutMs: 200,
        }),
      (error) =>
        error instanceof RuntimeAdapterError &&
        error.code === "openclaw_session_lock_timeout" &&
        error.safeDetails.replayed === true,
    );
  });

  await t.test("bounds pool checkout by the wake deadline with a typed durable error", async () => {
    const starvedRun = await createRun("lock-connect-starved");
    await createTicket(starvedRun, 38, "lock connect starved");
    const starvedPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const starvedAdapter = new OpenClawRuntimeAdapter({
      pool: starvedPool,
      runtimeRoot,
      openClawCommand: process.execPath,
      openClawCommandArguments: [fixture],
      wakeTimeoutMs: 2_000,
      terminationGraceMs: 100,
    });
    const held = await starvedPool.connect();
    const started = Date.now();
    try {
      await assert.rejects(
        () =>
          starvedAdapter.wakeAgent({
            runId: starvedRun,
            agentId,
            invocationId: "lock-connect-starved",
            nodeId: "work",
            nodeSystemPrompt: "This wake cannot check out a lock client.",
            timeoutMs: 300,
          }),
        (error) =>
          error instanceof RuntimeAdapterError &&
          error.code === "openclaw_session_lock_timeout" &&
          error.safeDetails.stage === "connect",
      );
      assert.ok(Date.now() - started < 3_000, "pool checkout wait must stay bounded");
    } finally {
      held.release();
      await starvedPool.end();
    }
    const durable = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [starvedRun],
    );
    assert.equal(durable.rowCount, 1);
    assert.equal(durable.rows[0].payload.code, "openclaw_session_lock_timeout");
    assert.equal(durable.rows[0].payload.details.stage, "connect");
    assert.equal(durable.rows[0].payload.attempts, 0);
  });

  await t.test("spends only the remaining deadline budget on the OpenClaw command", async () => {
    const holderRun = await createRun("lock-budget-holder");
    await createTicket(holderRun, 39, "lock budget holder");
    const waiterRun = await createRun("lock-budget-waiter");
    await createTicket(waiterRun, 40, "lock budget waiter");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("lock-budget-holder"),
        delayMs: 1_000,
        usage: { input: 5, output: 3, total: 8, cost: { total: "0.001" } },
      },
      {
        mode: "success",
        output: completedOutput("lock-budget-waiter"),
        delayMs: 3_500,
        usage: { input: 5, output: 3, total: 8, cost: { total: "0.001" } },
      },
    ]);
    await resetConcurrency();
    const before = (await requests()).length;
    const holderWake = adapter.wakeAgent({
      runId: holderRun,
      agentId,
      invocationId: "lock-budget-holder",
      nodeId: "work",
      nodeSystemPrompt: "Holder wake consuming the deadline budget.",
      timeoutMs: 10_000,
    });
    await waitForRequest(
      (request) =>
        request.command === "agent" &&
        typeof request.message === "string" &&
        request.message.includes("Holder wake consuming the deadline budget."),
    );
    // The waiter starts only after the holder's agent command is recorded
    // (explicit coordination), so the holder keeps the lock for about another
    // 1.1s. The waiter's 4s deadline therefore leaves roughly 2.9s of budget
    // at acquisition: a fresh full timeout would let the 3.5s turn succeed,
    // while the remaining-budget contract must time it out. A scheduler would
    // need roughly 3s of pathological preemption to invalidate that setup.
    await assert.rejects(
      () =>
        adapter.wakeAgent({
          runId: waiterRun,
          agentId,
          invocationId: "lock-budget-waiter",
          nodeId: "work",
          nodeSystemPrompt: "Waiter wake gets only the remaining budget.",
          timeoutMs: 4_000,
        }),
      (error) =>
        error instanceof RuntimeAdapterError && error.code === "openclaw_timeout",
    );
    const holderResult = await holderWake;
    assert.equal(holderResult.replayed, false);
    const durable = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [waiterRun],
    );
    assert.equal(durable.rowCount, 1);
    assert.equal(durable.rows[0].payload.code, "openclaw_timeout");
    const aborts = (await requests())
      .slice(before)
      .filter(
        (request) =>
          request.command === "sessions-abort" &&
          request.sessionKey === `agent:orbitflow-${agentId}:main`,
      );
    assert.equal(
      aborts.length,
      1,
      "a launched-then-timed-out agent command must keep its gateway cleanup",
    );
    await resetConcurrency();
  });

  await t.test("refuses to launch the OpenClaw command once the deadline is exhausted", async () => {
    const runId = await createRun("deadline-exhausted");
    await createTicket(runId, 41, "deadline exhausted");
    await resetPlan([
      { mode: "success", output: completedOutput("deadline-exhausted") },
    ]);
    // Park the first configuration sync command far beyond the 50ms deadline
    // so the budget is deterministically exhausted mid-sync on any machine:
    // no agent command may launch and no gateway cleanup may run.
    const holdPath = path.join(stateDirectory, "fake-config-hold.json");
    await writeFile(holdPath, JSON.stringify({ "agents-list": 250 }));
    const before = (await requests()).length;
    try {
      await assert.rejects(
        () =>
          adapter.wakeAgent({
            runId,
            agentId,
            invocationId: "deadline-exhausted",
            nodeId: "work",
            nodeSystemPrompt: "The deadline expires before the command can launch.",
            timeoutMs: 50,
          }),
        (error) =>
          error instanceof RuntimeAdapterError && error.code === "openclaw_timeout",
      );
    } finally {
      await rm(holdPath, { force: true });
    }
    const after = (await requests()).slice(before);
    assert.equal(
      after.filter((request) => request.command === "agent").length,
      0,
      "no OpenClaw agent command may launch after the deadline is exhausted",
    );
    assert.equal(
      after.filter((request) => request.command === "sessions-abort").length,
      0,
      "no gateway cleanup may run when no agent command ever launched",
    );
    const durable = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [runId],
    );
    assert.equal(durable.rowCount, 1);
    assert.equal(durable.rows[0].payload.code, "openclaw_timeout");
    assert.equal(durable.rows[0].payload.attempts, 0);
  });

  await t.test("maps a deadline-exhausted version check to openclaw_timeout and resets its cache", async () => {
    const runId = await createRun("version-check-exhausted");
    await createTicket(runId, 42, "version check exhausted");
    await resetPlan([
      {
        mode: "success",
        output: completedOutput("version-check-recovered"),
        usage: { input: 4, output: 2, total: 6, cost: { total: "0.0006" } },
      },
    ]);
    // A fresh adapter has no cached version proof, so its first wake runs
    // --version; the deterministic hold parks it past the 50ms deadline.
    const freshAdapter = new OpenClawRuntimeAdapter({
      pool,
      runtimeRoot,
      openClawCommand: process.execPath,
      openClawCommandArguments: [fixture],
      wakeTimeoutMs: 2_000,
      terminationGraceMs: 100,
    });
    const holdPath = path.join(stateDirectory, "fake-config-hold.json");
    await writeFile(holdPath, JSON.stringify({ version: 250 }));
    const before = (await requests()).length;
    try {
      await assert.rejects(
        () =>
          freshAdapter.wakeAgent({
            runId,
            agentId,
            invocationId: "version-check-exhausted",
            nodeId: "work",
            nodeSystemPrompt: "The version check consumes the whole deadline.",
            timeoutMs: 50,
          }),
        (error) =>
          error instanceof RuntimeAdapterError && error.code === "openclaw_timeout",
      );
    } finally {
      await rm(holdPath, { force: true });
    }
    const after = (await requests()).slice(before);
    assert.equal(after.filter((request) => request.command === "agent").length, 0);
    assert.equal(after.filter((request) => request.command === "sessions-abort").length, 0);
    const durable = await pool.query(
      "SELECT payload FROM messages WHERE run_id = $1",
      [runId],
    );
    assert.equal(durable.rowCount, 1);
    assert.equal(durable.rows[0].payload.code, "openclaw_timeout");

    // The rejected proof must not be cached: the same adapter re-proves the
    // version and completes a wake once the hold is gone.
    const recoveredRun = await createRun("version-check-recovered");
    await createTicket(recoveredRun, 43, "version check recovered");
    const recovered = await freshAdapter.wakeAgent({
      runId: recoveredRun,
      agentId,
      invocationId: "version-check-recovered",
      nodeId: "work",
      nodeSystemPrompt: "The version proof was reset and passes now.",
      timeoutMs: 5_000,
    });
    assert.equal(recovered.replayed, false);
    assert.deepEqual(recovered.output, completedOutput("version-check-recovered"));
  });
});
