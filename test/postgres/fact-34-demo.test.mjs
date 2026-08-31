import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { migratePostgres } from "../../scripts/migrate-postgres.mjs";
import { dispatchPlatformTool } from "../../src/lib/platform-tools/dispatch.ts";
import {
  createWorkflowRun,
  getWorkflowRun,
  startWorkflowEngine,
  startWorkflowRun,
} from "../../src/lib/postgres/workflow-engine.ts";
import { deliverNextTelegramOutbound, ingestTelegramInbound } from "../../src/lib/telegram/adapter.ts";
import { OpenClawEngineAdapter } from "../../src/lib/runtime/engine-adapter.ts";
import { createProductionWorkspaceTools } from "../../src/lib/runtime/workspace-tools.ts";

const { Client, Pool } = pg;

const greetingTest = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(args) {
  return spawnSync(process.execPath, ["greeter.mjs", ...args], { encoding: "utf8" });
}

test("greets a trimmed name", () => {
  const result = run(["--name", "  Ada  "]);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: "Hello, Ada!\\n", stderr: "" });
});

test("supports shout", () => {
  const result = run(["--name", "Ada", "--shout"]);
  assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 0, stdout: "HELLO, ADA!\\n", stderr: "" });
});

test("rejects invalid input", () => {
  for (const args of [[], ["--name", "   "], ["--unknown"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.trim());
  }
});
`;

const firstPassGreeter = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--name" || !args[1].trim()) {
  process.stderr.write("Usage: greeter.mjs --name <name>\\n");
  process.exit(2);
}
process.stdout.write(\`Hello, \${args[1].trim()}!\\n\`);
`;

const correctedGreeter = `#!/usr/bin/env node
const args = process.argv.slice(2);
const shoutIndex = args.indexOf("--shout");
const shout = shoutIndex !== -1;
if (shout) args.splice(shoutIndex, 1);
if (args.length !== 2 || args[0] !== "--name" || !args[1].trim()) {
  process.stderr.write("Usage: greeter.mjs --name <name> [--shout]\\n");
  process.exit(2);
}
const greeting = \`Hello, \${args[1].trim()}!\`;
process.stdout.write(\`\${shout ? greeting.toUpperCase() : greeting}\\n\`);
`;

function runWorkspace(workspace, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, { cwd: workspace, env, encoding: "utf8", timeout: 10_000 });
}

async function installPass(workspace, source) {
  await writeFile(path.join(workspace, "greeter.mjs"), source, { mode: 0o755 });
  await writeFile(path.join(workspace, "greeter.test.mjs"), greetingTest);
}

async function inspectFirstPass(workspace) {
  const [source, tests] = await Promise.all([
    readFile(path.join(workspace, "greeter.mjs"), "utf8"),
    readFile(path.join(workspace, "greeter.test.mjs"), "utf8"),
  ]);
  assert.doesNotMatch(source, /--shout/);
  assert.match(tests, /supports shout/);
  const suite = runWorkspace(workspace, ["--test", "greeter.test.mjs"]);
  assert.notEqual(suite.status, 0, suite.stdout + suite.stderr);
  const normal = runWorkspace(workspace, ["greeter.mjs", "--name", "  Ada  "]);
  assert.deepEqual({ status: normal.status, stdout: normal.stdout, stderr: normal.stderr }, { status: 0, stdout: "Hello, Ada!\n", stderr: "" });
  const shout = runWorkspace(workspace, ["greeter.mjs", "--name", "Ada", "--shout"]);
  assert.equal(shout.status, 2);
  assert.ok(shout.stderr.trim());
}

async function inspectCorrectedPass(workspace) {
  const [source, tests] = await Promise.all([
    readFile(path.join(workspace, "greeter.mjs"), "utf8"),
    readFile(path.join(workspace, "greeter.test.mjs"), "utf8"),
  ]);
  assert.match(source, /--shout/);
  assert.match(tests, /supports shout/);
  const suite = runWorkspace(workspace, ["--test", "greeter.test.mjs"]);
  assert.equal(suite.status, 0, suite.stdout + suite.stderr);
  const normal = runWorkspace(workspace, ["greeter.mjs", "--name", "  Ada  "]);
  assert.deepEqual({ status: normal.status, stdout: normal.stdout, stderr: normal.stderr }, { status: 0, stdout: "Hello, Ada!\n", stderr: "" });
  const shout = runWorkspace(workspace, ["greeter.mjs", "--name", "Ada", "--shout"]);
  assert.deepEqual({ status: shout.status, stdout: shout.stdout, stderr: shout.stderr }, { status: 0, stdout: "HELLO, ADA!\n", stderr: "" });
  const invalid = runWorkspace(workspace, ["greeter.mjs", "--unknown"]);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.ok(invalid.stderr.trim());
}

test("FACT-34 question outputs reject discarded artifact and event data", async () => {
  const request = {
    idempotencyKey: "fact34-malformed-question",
    generation: "1",
    runId: "1",
    dispatchId: "1",
    nodeId: "implement",
    agentId: "1",
    model: "openrouter/moonshotai/kimi-k3",
    ticketId: "1",
    ephemeral: false,
    input: {},
  };
  let storedWake = null;
  const pool = {
    async query(sql, values) {
      if (sql.includes("FROM openclaw_dispatch_inputs")) {
        return { rows: storedWake ? [{ wake_input: storedWake, runtime_generation: "1" }] : [] };
      }
      if (sql.includes("SELECT system_prompt FROM agents")) {
        return { rows: [{ system_prompt: "Ask only one question." }] };
      }
      if (sql.includes("INSERT INTO openclaw_dispatch_inputs")) {
        storedWake = JSON.parse(values[2]);
        return { rows: [{ wake_input: storedWake, runtime_generation: "1" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  for (const [output, reason] of [
    [{ artifact: { ignored: true }, handoff_brief: "question", events: [{ type: "question", question: "Choose one?" }] }, /empty artifact/],
    [{ artifact: {}, handoff_brief: "question", events: [{ type: "question", question: "Choose one?" }, { type: "progress" }] }, /exactly one question event/],
  ]) {
    const adapter = new OpenClawEngineAdapter({ pool, openclaw: { async wakeAgent() { return { output }; } } });
    const result = await adapter.startSession(request);
    assert.equal(result.kind, "confirmed_failure");
    assert.match(result.reason, reason);
  }

  const replay = new OpenClawEngineAdapter({
    pool,
    openclaw: {
      async wakeAgent() {
        return {
          replayed: true,
          output: {
            artifact: { ignored: true },
            handoff_brief: "question",
            events: [{ type: "question", question: "Choose one?" }],
          },
        };
      },
    },
  });
  const reconciled = await replay.reconcileSession(request);
  assert.equal(reconciled.kind, "confirmed_failure");
  assert.match(reconciled.reason, /empty artifact/);
});

test("FACT-34 reconciliation reuses the durable canonical wake input", async () => {
  const request = {
    idempotencyKey: "fact34-crash-window",
    generation: "4",
    runId: "13",
    dispatchId: "21",
    nodeId: "implement",
    agentId: "7",
    model: "openrouter/moonshotai/kimi-k3",
    ticketId: "11",
    ephemeral: true,
    input: { upstream: { handoffBrief: "Build the greeting CLI." } },
  };
  let storedWake = null;
  let systemPrompt = "Original durable system prompt.";
  let failMessageInsert = true;
  const insertedMessages = [];
  const pool = {
    async query(sql, values) {
      if (sql.includes("FROM openclaw_dispatch_inputs")) {
        return { rows: storedWake ? [{ wake_input: storedWake, runtime_generation: "4" }] : [] };
      }
      if (sql.includes("SELECT system_prompt FROM agents")) {
        return { rows: [{ system_prompt: systemPrompt }] };
      }
      if (sql.includes("INSERT INTO openclaw_dispatch_inputs")) {
        storedWake = JSON.parse(values[2]);
        return { rows: [{ wake_input: storedWake, runtime_generation: "4" }] };
      }
      if (sql.includes("INSERT INTO messages")) {
        if (failMessageInsert) {
          failMessageInsert = false;
          throw new Error("simulated crash after provider receipt");
        }
        insertedMessages.push({ type: values[4], payload: values[5] });
        return { rows: [{
          id: "99", run_id: "13", ticket_id: "11", sequence_number: "1",
          sender: values[2], recipient: values[3], type: values[4], payload: values[5],
          handoff_brief: values[6], token_usage: values[7], created_at: new Date(), updated_at: new Date(),
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  let providerCalls = 0;
  let durableReceipt = null;
  const openclaw = {
    async wakeAgent(input) {
      const serialized = JSON.stringify(input);
      if (durableReceipt) {
        assert.equal(serialized, durableReceipt.input);
        return { ...durableReceipt.result, replayed: true };
      }
      providerCalls += 1;
      durableReceipt = {
        input: serialized,
        result: {
          output: {
            artifact: {},
            handoff_brief: "Choose whitespace behavior.",
            events: [{ type: "question", question: "Trim surrounding whitespace?" }],
          },
        },
      };
      return { ...durableReceipt.result, replayed: false };
    },
  };
  const adapter = new OpenClawEngineAdapter({
    pool,
    openclaw,
    workspaceTools: createProductionWorkspaceTools(),
  });
  await assert.rejects(() => adapter.startSession(request), /simulated crash/);
  systemPrompt = "Mutated prompt that recovery must not fingerprint.";
  const result = await adapter.reconcileSession(request);
  assert.equal(result.kind, "started");
  assert.equal(providerCalls, 1);
  assert.equal(insertedMessages.length, 1);
  assert.equal(insertedMessages[0].type, "question");
  assert.equal(storedWake.nodeSystemPrompt, "Original durable system prompt.");
  assert.equal(storedWake.agentModel, request.model);
  assert.equal(storedWake.dispatchGeneration, request.generation);
  assert.equal(storedWake.toolContext.dispatchId, request.dispatchId);
});

test("FACT-50 ticket-bound tools state the broker and engine ownership rules", () => {
  const tools = createProductionWorkspaceTools({
    tool: "/app/bin/orbit-openclaw-tool.mjs",
  })("7", "implement", "11", "13");
  assert.match(tools, /list_projects/);
  assert.match(tools, /create_ticket/);
  assert.match(tools, /list_tickets/);
  assert.match(tools, /update_ticket/);
  assert.match(tools, /set_ticket_dependencies/);
  assert.match(tools, /post_message/);
  assert.match(tools, /start_run_workspace/);
  assert.match(tools, /delegate_coding_task/);
  assert.doesNotMatch(tools, /DATABASE_URL=|ORBITFLOW_RUN_ID=|ORBITFLOW_AGENT_ID=/);
  assert.doesNotMatch(tools, /"agentId"|"runId"|"ticketId"|"workspace"/);
  assert.ok(tools.includes("The broker injects agentId and runId for every command, and ticketId for ticket-bound commands."));
  assert.ok(tools.includes("Do not supply or replace broker-injected attribution fields."));
  assert.ok(tools.includes("Only workflow-engine assignment moves tickets to in_progress. Agents cannot set that status."));
  assert.ok(tools.includes("Ticket-bound update_ticket, post_message, and set_ticket_dependencies calls use the broker-injected active ticketId; do not supply a replacement."));
  assert.doesNotMatch(tools, /Never supply or attempt to replace those bound fields\./);
  assert.match(tools, /^\/app\/bin\/orbit-openclaw-tool\.mjs/m);
  assert.doesNotMatch(tools, /projectId from the run spec or an existing ticket/);
});

test("FACT-50 planner tools distinguish their dependency target from bound attribution", () => {
  const tools = createProductionWorkspaceTools({
    tool: "/app/bin/orbit-openclaw-tool.mjs",
  })("7", "plan", null, "13");
  assert.match(tools, /### set_ticket_dependencies/);
  assert.match(tools, /"ticketId":"<ticketId from list_tickets>"/);
  assert.ok(tools.includes("A planner dispatch has no active ticket. For set_ticket_dependencies, supply the target ticketId returned by list_tickets; this planner target is not broker-injected and is preserved."));
  assert.ok(tools.includes("Only workflow-engine assignment moves tickets to in_progress. Agents cannot set that status."));
  assert.doesNotMatch(tools, /### update_ticket/);
  assert.doesNotMatch(tools, /### post_message/);
  assert.doesNotMatch(tools, /Never supply or attempt to replace those bound fields\./);
});

async function until(description, action, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

test("FACT-34 real-output question and honest rejection contract", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const workspace = await mkdtemp(path.join(tmpdir(), "orbitflow-fact34-demo-"));
  let firstWorker;
  let restartedWorker;
  await client.connect();

  try {
    assert.equal(
      (await client.query("SELECT current_database() AS name")).rows[0].name,
      process.env.ORBITFACTORY_FACT34_PROOF_DATABASE,
    );
    await migratePostgres({ databaseUrl, log: () => {} });

    const seeded = await client.query(
      `SELECT workflow.graph,
              implementer.system_prompt AS implementer_prompt,
              tester.system_prompt AS tester_prompt
       FROM workflows AS workflow
       JOIN agents AS implementer ON implementer.name = 'Factory Implementer'
       JOIN agents AS tester ON tester.name = 'Factory Tester'
       WHERE workflow.name = 'Software Factory' AND workflow.is_template = true`,
    );
    const seededGraph = seeded.rows[0].graph;
    const seededImplement = seededGraph.nodes.find((node) => node.id === "implement");
    const seededReject = seededGraph.edges.find((edge) => edge.source === "test" && edge.target === "implement");
    assert.deepEqual(seededImplement.config.questionEscalation, { target: "human-via-channel" });
    assert.deepEqual(seededReject.condition.path, ["artifact", "verdict"]);
    assert.match(seeded.rows[0].implementer_prompt, /exactly one event shaped/);
    assert.match(seeded.rows[0].tester_prompt, /update the ticket to todo/);

    const agents = {};
    for (const role of ["implement", "test", "report"]) {
      agents[role] = (await client.query(
        `INSERT INTO agents (name, role, system_prompt, model)
         VALUES ($1, $2, $3, 'openrouter/moonshotai/kimi-k3') RETURNING id::text`,
        [`FACT-34 ${role}`, role, `FACT-34 ${role} deterministic contract`],
      )).rows[0].id;
    }
    const projectId = (await client.query(
      "INSERT INTO projects (key, name) VALUES ('DMO', 'FACT-34 proof') RETURNING id::text",
    )).rows[0].id;
    const graph = {
      nodes: [
        { id: "implement", agentId: agents.implement, config: { entry: true, fanOut: { over: "openTickets", maxConcurrency: 1 }, questionEscalation: { target: "human-via-channel" } } },
        { id: "test", agentId: agents.test, config: {} },
        { id: "report", agentId: agents.report, config: {} },
      ],
      edges: [
        { source: "implement", target: "test", condition: { operator: "always" } },
        { source: "test", target: "implement", condition: { operator: "equals", path: ["artifact", "verdict"], value: "rejected" } },
        { source: "test", target: "report", condition: { operator: "equals", path: ["artifact", "verdict"], value: "approved" } },
      ],
    };
    const workflowId = (await client.query(
      "INSERT INTO workflows (name, description, graph) VALUES ('FACT-34 contract', 'Question and review loop', $1) RETURNING id::text",
      [graph],
    )).rows[0].id;
    const run = await createWorkflowRun(pool, {
      workflowId,
      triggerType: "ui",
      spec: {
        objective: "Build the documented greeting CLI",
        channelContext: { provider: "telegram", chat: { id: "-1003400", type: "supergroup" } },
      },
    });
    const ticketId = (await client.query(
      `INSERT INTO tickets (
         number, identifier, project_id, run_id, title, description,
         acceptance_criteria, status, priority
       ) VALUES (
         1, 'DMO-1', $1, $2, 'Build the greeting CLI',
         'Ask the whitespace question before implementation. The first pass omits --shout.',
         'Trim the answered name, support --shout after correction, and pass tests.',
         'todo', 3
       ) RETURNING id::text`,
      [projectId, run.id],
    )).rows[0].id;

    const projects = await dispatchPlatformTool(pool, "list_projects", {
      agentId: agents.implement,
      runId: run.id,
      limit: 10,
      idempotencyKey: "fact34-list-projects",
    });
    assert.ok(projects.projects.some((project) => project.id === projectId && project.key === "DMO"));

    const calls = { implement: 0, test: 0, report: 0 };
    let providerFailure = null;
    async function scriptedWake(input) {
      if (input.nodeId === "implement" && calls.implement === 1) {
        return {
          output: {
            artifact: {},
            handoff_brief: "Waiting for the required whitespace decision.",
            events: [{ type: "question", question: "Should --name preserve surrounding whitespace or trim it?" }],
          },
        };
      }
      if (input.nodeId === "implement") {
        await installPass(workspace, calls.implement === 2 ? firstPassGreeter : correctedGreeter);
        const listed = await dispatchPlatformTool(pool, "list_tickets", {
          agentId: agents.implement,
          runId: run.id,
          limit: 10,
          idempotencyKey: `fact34-implement-list-${calls.implement}`,
        });
        const assigned = listed.tickets.find((ticket) => ticket.id === ticketId);
        assert.ok(assigned);
        await dispatchPlatformTool(pool, "update_ticket", {
          agentId: agents.implement,
          runId: run.id,
          ticketId,
          expectedUpdatedAt: assigned.updatedAt,
          status: "done",
          idempotencyKey: `fact34-implement-done-${calls.implement}`,
        });
        return {
          output: {
            artifact: { pass: calls.implement === 2 ? "first" : "corrected" },
            handoff_brief: calls.implement === 2
              ? "Implemented the base CLI; --shout remains incomplete for review."
              : "Corrected --shout and reran the acceptance tests.",
            events: [],
          },
        };
      }
      if (input.nodeId === "test" && calls.test === 1) {
        await inspectFirstPass(workspace);
        const listed = await dispatchPlatformTool(pool, "list_tickets", {
          agentId: agents.test,
          runId: run.id,
          limit: 10,
          idempotencyKey: "fact34-test-list-rejected",
        });
        const assigned = listed.tickets.find((ticket) => ticket.id === ticketId);
        assert.ok(assigned);
        await dispatchPlatformTool(pool, "update_ticket", {
          agentId: agents.test,
          runId: run.id,
          ticketId,
          expectedUpdatedAt: assigned.updatedAt,
          status: "todo",
          idempotencyKey: "fact34-test-reopen",
        });
        return {
          output: {
            artifact: { verdict: "rejected" },
            handoff_brief: "Rejected: the documented --shout acceptance behavior is missing.",
            events: [],
          },
        };
      }
      if (input.nodeId === "test") {
        await inspectCorrectedPass(workspace);
        return {
          output: {
            artifact: { verdict: "approved" },
            handoff_brief: "Approved after independently checking --shout and the full test suite.",
            events: [],
          },
        };
      }
      return {
        output: {
          artifact: { status: "reported" },
          handoff_brief: "Reported the completed corrected result.",
          events: [],
        },
      };
    }

    const scriptedProvider = {
      async wakeAgent(input) {
        calls[input.nodeId] += 1;
        try {
          return await scriptedWake(input);
        } catch (error) {
          providerFailure = error;
          throw error;
        }
      },
    };

    await startWorkflowRun(pool, run.id);
    firstWorker = startWorkflowEngine(
      pool,
      new OpenClawEngineAdapter({ pool, openclaw: scriptedProvider }),
      { consumerId: "fact34-before-restart", dispatcherId: "fact34-before-restart", pollIntervalMs: 20 },
    );
    const pending = await until("durable worker question", async () => {
      const result = await client.query(
        "SELECT * FROM workflow_questions WHERE run_id = $1 AND status = 'pending'",
        [run.id],
      );
      return result.rows[0] ?? null;
    });
    assert.equal(pending.ticket_id, ticketId);
    assert.equal(pending.boundary, "worker");
    assert.equal(pending.route, "human-via-channel");

    let deliveredText = "";
    assert.equal(await deliverNextTelegramOutbound(pool, {
      async sendMessage(chatId, text) {
        assert.equal(chatId, "-1003400");
        deliveredText = text;
        return { messageId: 34001 };
      },
    }), true);
    assert.equal(deliveredText, pending.question_text);

    await firstWorker.stop();
    firstWorker = null;
    const answer = await ingestTelegramInbound(pool, {
      updateId: 34002,
      messageId: 34003,
      chat: { id: -1003400, type: "supergroup" },
      text: "Trim surrounding whitespace.",
      replyToMessageId: 34001,
    });
    assert.equal(answer.kind, "accepted");
    assert.equal(answer.runId, run.id);

    restartedWorker = startWorkflowEngine(
      pool,
      new OpenClawEngineAdapter({ pool, openclaw: scriptedProvider }),
      { consumerId: "fact34-after-restart", dispatcherId: "fact34-after-restart", pollIntervalMs: 20 },
    );
    let workerFailure = null;
    void restartedWorker.done.catch((error) => {
      workerFailure = error;
    });
    try {
      await until("completed corrected run", async () => {
        if (providerFailure) throw providerFailure;
        if (workerFailure) throw workerFailure;
        const current = await getWorkflowRun(pool, run.id);
        if (current?.status === "failed") throw new Error(current.failureReason ?? "workflow run failed");
        return current?.status === "completed" ? current : null;
      });
    } catch (error) {
      const state = await client.query(
        "SELECT node_id, status::text, failure_reason FROM workflow_dispatches WHERE run_id = $1 ORDER BY id",
        [run.id],
      );
      throw new Error(`${error.message}; calls=${JSON.stringify(calls)} dispatches=${JSON.stringify(state.rows)}`);
    }
    await restartedWorker.stop();
    restartedWorker = null;

    const questions = await client.query("SELECT * FROM workflow_questions WHERE run_id = $1", [run.id]);
    assert.equal(questions.rowCount, 1);
    assert.equal(questions.rows[0].status, "answered");
    assert.equal(questions.rows[0].answer_message_id, answer.messageId);

    const dispatches = await client.query(
      "SELECT node_id, ticket_id, source_message_id, status FROM workflow_dispatches WHERE run_id = $1 ORDER BY id",
      [run.id],
    );
    assert.deepEqual(dispatches.rows.map((row) => row.node_id), [
      "implement", "implement", "test", "implement", "test", "report",
    ]);
    assert.ok(dispatches.rows.every((row) => row.status === "completed"));
    assert.equal(
      dispatches.rows.filter((row) => row.source_message_id === answer.messageId).length,
      1,
      "the Telegram answer resumes exactly one ticket thread",
    );

    const testerOutputs = await client.query(
      `SELECT message.payload #>> '{output,artifact,verdict}' AS verdict
       FROM messages AS message
       JOIN workflow_dispatches AS dispatch ON dispatch.output_message_id = message.id
       WHERE message.run_id = $1 AND dispatch.node_id = 'test'
       ORDER BY message.id`,
      [run.id],
    );
    assert.deepEqual(testerOutputs.rows.map((row) => row.verdict), ["rejected", "approved"]);

    const trail = await client.query(
      "SELECT type::text, ticket_id, payload FROM messages WHERE run_id = $1 ORDER BY sequence_number",
      [run.id],
    );
    const questionMessage = trail.rows.find((row) => row.type === "question");
    assert.deepEqual(questionMessage.payload.runtimeEvent, {
      type: "question",
      question: "Should --name preserve surrounding whitespace or trim it?",
    });
    assert.ok(trail.rows.some((row) => row.type === "channel_outbound"));
    assert.ok(trail.rows.some((row) => row.type === "answer"));
    assert.equal((await client.query("SELECT status::text FROM tickets WHERE id = $1", [ticketId])).rows[0].status, "done");
    assert.deepEqual(calls, { implement: 3, test: 2, report: 1 });
  } finally {
    await firstWorker?.stop().catch(() => {});
    await restartedWorker?.stop().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
    await pool.end();
    await client.end();
  }
});
