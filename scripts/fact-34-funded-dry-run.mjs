import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migratePostgres } from "./migrate-postgres.mjs";
import { getWorkflowRun, startWorkflowEngine } from "../src/lib/postgres/workflow-engine.ts";
import { deliverNextTelegramOutbound, ingestTelegramInbound } from "../src/lib/telegram/adapter.ts";
import { OpenClawRuntimeAdapter } from "../src/lib/runtime/openclaw.ts";
import { OpenClawEngineAdapter } from "../src/lib/runtime/engine-adapter.ts";

const { Pool } = pg;
const model = "openrouter/moonshotai/kimi-k3";
const attempt = process.env.ORBITFLOW_FACT34_ATTEMPT;
const databaseUrl = process.env.DATABASE_URL;
const evidenceDirectory = process.env.ORBITFLOW_FACT34_EVIDENCE_DIR;
const runtimeRoot = process.env.ORBITFLOW_FACT34_RUNTIME_ROOT;
const workspaceRoot = process.env.ORBITFLOW_WORKSPACE_ROOT;
const gatewayPort = Number(process.env.ORBITFLOW_FACT34_GATEWAY_PORT);

assert.match(attempt ?? "", /^[12]$/, "ORBITFLOW_FACT34_ATTEMPT must be 1 or 2");
assert.ok(databaseUrl, "DATABASE_URL is required");
assert.ok(evidenceDirectory, "ORBITFLOW_FACT34_EVIDENCE_DIR is required");
assert.ok(runtimeRoot, "ORBITFLOW_FACT34_RUNTIME_ROOT is required");
assert.ok(workspaceRoot, "ORBITFLOW_WORKSPACE_ROOT is required");
assert.ok(Number.isSafeInteger(gatewayPort) && gatewayPort > 1024, "valid gateway port required");
assert.ok(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY is required");

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const agentTool = path.join(repositoryRoot, "bin", "orbit-agent-tools.mjs");
const codingTool = path.join(repositoryRoot, "bin", "orbit-coding-tool.mjs");
const chatId = -1003401 - Number(attempt);
const telegramQuestionMessageId = 34_100 + Number(attempt);
const telegramAnswerUpdateId = 34_200 + Number(attempt);
const telegramAnswerMessageId = 34_300 + Number(attempt);
const pool = new Pool({ connectionString: databaseUrl, max: 12 });

let gateway = null;
let engine = null;
let runId = null;
let thrown = null;

function databaseContract() {
  return [
    "ORBITFLOW_PLATFORM_DATABASE_URL is already set to the disposable proof database.",
    "Never print, replace, export, or invent its value.",
    "Use the exact DATABASE_URL=\"$ORBITFLOW_PLATFORM_DATABASE_URL\" prefix in the commands below.",
  ];
}

function workspaceTools(agentName, nodeId, projectId, agentId, currentRunId) {
  const common = databaseContract();
  if (nodeId === "orchestrator") {
    return [
      "# Channel intake",
      "Do not call tools. The inbound request is complete. Return a ready intake artifact preserving every acceptance criterion and constraint.",
    ].join("\n");
  }
  if (nodeId === "planner") {
    return [
      "# Planner tools",
      ...common,
      "Create exactly one todo ticket by running this command once. Do not create another ticket.",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} create_ticket '${JSON.stringify({
        agentId,
        runId: currentRunId,
        projectId,
        title: "Build a dependency-free greeting CLI",
        description: "Create greeter.mjs and greeter.test.mjs. Before changing the workspace, ask exactly: Should --name preserve surrounding whitespace or trim it? After the answer, the first implementation pass must implement the default greeting and invalid-input behavior but deliberately leave --shout unsupported. State that miss in the handoff. After tester rejection, correct the existing workspace by adding --shout.",
        acceptanceCriteria: "Trim surrounding whitespace when the answer says to trim. node greeter.mjs --name Ada prints Hello, Ada! plus a newline. Adding --shout prints HELLO, ADA! plus a newline. Missing or empty --name and unknown options write a useful stderr message and exit 2. Use only Node.js built-ins. node --test greeter.test.mjs passes. The tester must reject the documented first pass while --shout is missing and approve only after the correction.",
        status: "todo",
        priority: 3,
        idempotencyKey: `fact34-planner-create-${attempt}`,
      })}'`,
    ].join("\n");
  }
  if (nodeId === "implement") {
    return [
      "# Implementer tools",
      ...common,
      `Your agentId is ${agentId}, runId is ${currentRunId}, and the ticket id is shown in Assigned tickets.`,
      "On the first worker turn, emit the exact required question event and do not call any tool.",
      "After the Telegram answer, follow the ticket's documented first-pass boundary. On tester feedback, correct the existing workspace.",
      "Replace every <unique-suffix> with a new short value for this turn.",
      "",
      "### list_tickets",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} list_tickets '{"agentId":"${agentId}","runId":"${currentRunId}","limit":10,"idempotencyKey":"impl-list-<unique-suffix>"}'`,
      "",
      "### update_ticket",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} update_ticket '{"agentId":"${agentId}","runId":"${currentRunId}","ticketId":"<id>","expectedUpdatedAt":"<updatedAt>","status":"done","idempotencyKey":"impl-done-<unique-suffix>"}'`,
      "",
      "### start_run_workspace",
      `echo '{"command":"start_run_workspace","runId":"${currentRunId}"}' | DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ORBITFLOW_WORKSPACE_ROOT=$ORBITFLOW_WORKSPACE_ROOT node ${codingTool}`,
      "",
      "### delegate_coding_task",
      `echo '{"command":"delegate_coding_task","task":"<precise task for this pass>","workspace":"$ORBITFLOW_WORKSPACE_ROOT/run-${currentRunId}"}' | DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" ORBITFLOW_RUN_ID=${currentRunId} ORBITFLOW_AGENT_ID=${agentId} ORBITFLOW_WORKSPACE_ROOT=$ORBITFLOW_WORKSPACE_ROOT node ${codingTool}`,
    ].join("\n");
  }
  if (nodeId === "test") {
    return [
      "# Tester tools",
      ...common,
      `The implementation workspace is $ORBITFLOW_WORKSPACE_ROOT/run-${currentRunId}.`,
      "Inspect greeter.mjs and greeter.test.mjs. Run node --test greeter.test.mjs plus the documented CLI commands from that workspace.",
      "Never infer approval from the implementer handoff. If any final criterion fails, list the assigned ticket and update it to todo before returning artifact {\"verdict\":\"rejected\"}.",
      "Replace every <unique-suffix> with a new short value for this turn.",
      "",
      "### list_tickets",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} list_tickets '{"agentId":"${agentId}","runId":"${currentRunId}","limit":10,"idempotencyKey":"test-list-<unique-suffix>"}'`,
      "",
      "### reopen rejected ticket",
      `DATABASE_URL="$ORBITFLOW_PLATFORM_DATABASE_URL" node ${agentTool} update_ticket '{"agentId":"${agentId}","runId":"${currentRunId}","ticketId":"<id>","expectedUpdatedAt":"<updatedAt>","status":"todo","idempotencyKey":"test-reopen-<unique-suffix>"}'`,
    ].join("\n");
  }
  if (nodeId === "report") {
    return "# Reporter\nDo not call tools. Summarize the approved corrected result and the observed question and rejection beats.";
  }
  return `# ${agentName}\nUse only the tools required by the node prompt.`;
}

async function runCommand(command, args, env, output = "ignore") {
  const child = spawn(command, args, { env, stdio: ["ignore", output, output] });
  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  if (exitCode !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} exited ${exitCode}`);
}

async function startGateway() {
  const stateDirectory = path.join(runtimeRoot, "state");
  const homeDirectory = path.join(runtimeRoot, "home");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDirectory,
    HOME: homeDirectory,
    OPENCLAW_DISABLE_BONJOUR: "1",
  };
  await runCommand("openclaw", ["config", "set", "gateway.port", String(gatewayPort), "--strict-json"], env);
  await runCommand("openclaw", ["config", "set", "tools.allow", JSON.stringify(["exec"]), "--strict-json"], env);
  await runCommand("openclaw", ["config", "set", "tools.exec", JSON.stringify({ host: "gateway", security: "full", ask: "off" }), "--strict-json"], env);
  await runCommand("openclaw", ["models", "set", model], env);
  await runCommand("openclaw", ["config", "set", `agents.defaults.models["${model}"].params.maxTokens`, "4096", "--strict-json"], env);

  const diagnostic = [];
  const child = spawn("openclaw", [
    "gateway", "--allow-unconfigured", "--auth", "none", "--bind", "loopback", "--port", String(gatewayPort),
  ], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => diagnostic.push(chunk));
  child.stderr.on("data", (chunk) => diagnostic.push(chunk));
  return { child, stateDirectory, homeDirectory, diagnostic, env };
}

async function stopGateway(current) {
  if (!current?.child || current.child.exitCode !== null || current.child.signalCode !== null) return;
  const closed = new Promise((resolve) => current.child.once("close", resolve));
  current.child.kill("SIGTERM");
  const force = setTimeout(() => current.child.kill("SIGKILL"), 3_000);
  await closed;
  clearTimeout(force);
}

async function waitForGateway() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
      if (response.ok) return;
    } catch {}
    await delay(500);
  }
  throw new Error("OpenClaw gateway did not become ready");
}

async function waitFor(description, action, timeoutMs = 1_800_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function snapshot() {
  if (!runId) return { attempt, run: null };
  const [run, messages, tickets, questions, dispatches, costEvents, receipts] = await Promise.all([
    pool.query("SELECT id::text, status::text, failure_reason, total_tokens::text, total_cost::text FROM workflow_runs WHERE id = $1", [runId]),
    pool.query("SELECT id::text, sequence_number::text, ticket_id::text, sender, recipient, type::text, payload, handoff_brief FROM messages WHERE run_id = $1 ORDER BY sequence_number", [runId]),
    pool.query("SELECT id::text, identifier, title, status::text, assignee_agent_id::text FROM tickets WHERE run_id = $1 ORDER BY id", [runId]),
    pool.query("SELECT id::text, ticket_id::text, originating_dispatch_id::text, question_message_id::text, answer_message_id::text, outbound_message_id::text, kind::text, boundary::text, route::text, question_text, status::text FROM workflow_questions WHERE run_id = $1 ORDER BY id", [runId]),
    pool.query("SELECT id::text, node_id, agent_id::text, ticket_id::text, source_message_id::text, status::text, output_message_id::text FROM workflow_dispatches WHERE run_id = $1 ORDER BY id", [runId]),
    pool.query("SELECT id::text, agent_id::text, model, tokens_in::text, tokens_out::text, computed_cost::text FROM cost_events WHERE run_id = $1 ORDER BY id", [runId]),
    pool.query("SELECT payload->>'invocationKey' AS invocation_key, (payload->>'attempts')::int AS attempts FROM messages WHERE run_id = $1 AND sender = 'runtime:openclaw' AND payload->>'kind' = 'openclaw_invocation_result' ORDER BY id", [runId]),
  ]);
  return {
    attempt: Number(attempt),
    model,
    run: run.rows[0] ?? null,
    messages: messages.rows,
    tickets: tickets.rows,
    questions: questions.rows,
    dispatches: dispatches.rows,
    costEvents: costEvents.rows,
    invocationReceipts: receipts.rows,
  };
}

async function retainArtifacts(currentSnapshot) {
  const artifactDirectory = path.join(evidenceDirectory, "artifact");
  await mkdir(artifactDirectory, { recursive: true });
  if (!runId) return;
  const sourceDirectory = path.join(workspaceRoot, `run-${runId}`);
  for (const name of ["greeter.mjs", "greeter.test.mjs"]) {
    try {
      await copyFile(path.join(sourceDirectory, name), path.join(artifactDirectory, name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await writeFile(
    path.join(evidenceDirectory, "structured", "proof-result.json"),
    `${JSON.stringify(currentSnapshot, null, 2)}\n`,
  );
}

try {
  await mkdir(path.join(evidenceDirectory, "structured"), { recursive: true });
  await migratePostgres({ databaseUrl, log: () => {} });
  const workflow = await pool.query("SELECT id::text FROM workflows WHERE name = 'Software Factory' AND is_template = true");
  assert.equal(workflow.rowCount, 1);
  await pool.query(
    `UPDATE agents SET model = $1
     WHERE name IN ('Factory Orchestrator', 'Factory Planner', 'Factory Implementer', 'Factory Tester')`,
    [model],
  );
  const agentsResult = await pool.query(
    `SELECT id::text, name FROM agents
     WHERE name IN ('Factory Orchestrator', 'Factory Planner', 'Factory Implementer', 'Factory Tester')
     ORDER BY id`,
  );
  assert.equal(agentsResult.rowCount, 4);
  const projectId = (await pool.query(
    `INSERT INTO projects (key, name) VALUES ('DMO', $1) RETURNING id::text`,
    [`FACT-34 funded demo ${attempt}`],
  )).rows[0].id;

  process.env.ORBITFLOW_PLATFORM_DATABASE_URL = databaseUrl;
  process.env.ORBITFLOW_OPENCODE_MODEL = model;
  const nodeBinaryDirectory = path.dirname(process.execPath);
  process.env.PATH = `${nodeBinaryDirectory}:${repositoryRoot}/bin:${process.env.PATH ?? ""}`;

  gateway = await startGateway();
  await waitForGateway();
  const openclaw = new OpenClawRuntimeAdapter({
    pool,
    runtimeRoot,
    wakeTimeoutMs: 300_000,
    retryMalformedOutput: false,
    allowedExecEnvironment: [
      "DATABASE_URL", "OPENROUTER_API_KEY", "ORBITFLOW_AGENT_ID", "ORBITFLOW_OPENCODE_MODEL",
      "ORBITFLOW_PLATFORM_DATABASE_URL", "ORBITFLOW_RUN_ID", "ORBITFLOW_WORKSPACE_ROOT",
    ],
    gatewayEnvironment: { OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}` },
  });
  for (const agent of agentsResult.rows) await openclaw.syncAgent(agent.id);
  await stopGateway(gateway);
  gateway = await startGateway();
  await waitForGateway();

  const runtime = new OpenClawEngineAdapter({
    pool,
    openclaw,
    workspaceTools: (agentId, nodeId, _ticketId, currentRunId) => {
      const agent = agentsResult.rows.find((candidate) => candidate.id === agentId);
      return workspaceTools(agent?.name ?? "Agent", nodeId, projectId, agentId, currentRunId);
    },
  });
  engine = startWorkflowEngine(pool, runtime, {
    consumerId: `fact34-funded-consumer-${attempt}`,
    dispatcherId: `fact34-funded-dispatcher-${attempt}`,
    pollIntervalMs: 100,
  });
  await engine.ready;

  const inbound = await ingestTelegramInbound(pool, {
    updateId: 34_000 + Number(attempt),
    messageId: 34_010 + Number(attempt),
    chat: { id: chatId, type: "supergroup", title: "FACT-34 local boundary" },
    from: { id: 34_020 + Number(attempt), firstName: "Adam" },
    text: [
      "Build the documented dependency-free Node.js greeting CLI with greeter.mjs and greeter.test.mjs.",
      "Require --name, support --shout, reject invalid input with exit 2, use only Node built-ins, and pass node --test greeter.test.mjs.",
      "Before implementation, the worker must ask whether surrounding name whitespace should be preserved or trimmed.",
      "The first pass must deliberately omit --shout so the tester honestly rejects it. The correction must add --shout and then pass every criterion.",
      "Create exactly one implementation ticket.",
    ].join(" "),
  });
  assert.equal(inbound.kind, "accepted");
  runId = inbound.runId;
  process.stderr.write(`FACT-34 funded run ${attempt}: run ${runId} started with ${model}\n`);

  const pendingQuestion = await waitFor("real worker question", async () => {
    const current = await getWorkflowRun(pool, runId);
    if (current?.status === "failed") throw new Error(`run failed before question: ${current.failureReason}`);
    const result = await pool.query(
      "SELECT * FROM workflow_questions WHERE run_id = $1 AND status = 'pending' ORDER BY id",
      [runId],
    );
    return result.rows[0] ?? null;
  });
  assert.equal(pendingQuestion.boundary, "worker");
  assert.equal(pendingQuestion.route, "human-via-channel");
  assert.ok(pendingQuestion.ticket_id);

  assert.equal(await deliverNextTelegramOutbound(pool, {
    async sendMessage(sentChatId, text) {
      assert.equal(sentChatId, String(chatId));
      assert.equal(text, pendingQuestion.question_text);
      return { messageId: telegramQuestionMessageId };
    },
  }), true);
  const answer = await ingestTelegramInbound(pool, {
    updateId: telegramAnswerUpdateId,
    messageId: telegramAnswerMessageId,
    chat: { id: chatId, type: "supergroup" },
    from: { id: 34_020 + Number(attempt), firstName: "Adam" },
    text: "Trim surrounding whitespace.",
    replyToMessageId: telegramQuestionMessageId,
  });
  assert.equal(answer.kind, "accepted");
  assert.equal(answer.runId, runId);
  process.stderr.write(`FACT-34 funded run ${attempt}: correlated Telegram answer accepted\n`);

  const finalRun = await waitFor("completed Software Factory run", async () => {
    const current = await getWorkflowRun(pool, runId);
    return current && ["completed", "failed", "canceled"].includes(current.status) ? current : null;
  });
  assert.equal(finalRun.status, "completed", finalRun.failureReason ?? "run must complete");
  await engine.stop();
  engine = null;

  const result = await snapshot();
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].status, "answered");
  assert.equal(result.questions[0].ticket_id, pendingQuestion.ticket_id);
  const answerMessage = result.messages.find((message) => message.id === result.questions[0].answer_message_id);
  assert.equal(answerMessage.payload.replyToMessageId, String(telegramQuestionMessageId));
  assert.equal(
    result.dispatches.filter((dispatch) => dispatch.source_message_id === answerMessage.id).length,
    1,
    "correlated answer resumes only one ticket dispatch",
  );
  const testerVerdicts = result.dispatches
    .filter((dispatch) => dispatch.node_id === "test")
    .map((dispatch) => result.messages.find((message) => message.id === dispatch.output_message_id)?.payload?.output?.artifact?.verdict);
  assert.deepEqual(testerVerdicts, ["rejected", "approved"]);
  assert.equal(result.dispatches.filter((dispatch) => dispatch.node_id === "implement").length, 3);
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].status, "done");
  assert.ok(result.invocationReceipts.length >= 8);
  assert.ok(result.invocationReceipts.every((receipt) => receipt.attempts === 1), "no malformed-output provider retry ran");
  assert.ok(result.costEvents.length >= result.invocationReceipts.length + 2);
  assert.ok(result.costEvents.every((event) => ["moonshotai/kimi-k3", model].includes(event.model)));
  assert.ok(BigInt(result.run.total_tokens) > 0n);
  assert.ok(Number(result.run.total_cost) > 0);

  const runWorkspace = path.join(workspaceRoot, `run-${runId}`);
  const testRun = spawnSync(process.execPath, ["--test", "greeter.test.mjs"], { cwd: runWorkspace, encoding: "utf8", timeout: 30_000 });
  assert.equal(testRun.status, 0, testRun.stdout + testRun.stderr);
  const normal = spawnSync(process.execPath, ["greeter.mjs", "--name", "  Ada  "], { cwd: runWorkspace, encoding: "utf8", timeout: 10_000 });
  assert.deepEqual({ status: normal.status, stdout: normal.stdout, stderr: normal.stderr }, { status: 0, stdout: "Hello, Ada!\n", stderr: "" });
  const shout = spawnSync(process.execPath, ["greeter.mjs", "--name", "Ada", "--shout"], { cwd: runWorkspace, encoding: "utf8", timeout: 10_000 });
  assert.deepEqual({ status: shout.status, stdout: shout.stdout, stderr: shout.stderr }, { status: 0, stdout: "HELLO, ADA!\n", stderr: "" });
  const invalid = spawnSync(process.execPath, ["greeter.mjs", "--unknown"], { cwd: runWorkspace, encoding: "utf8", timeout: 10_000 });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.ok(invalid.stderr.trim());
  result.artifactProof = {
    nodeTestExitCode: testRun.status,
    normal: { exitCode: normal.status, stdout: normal.stdout, stderr: normal.stderr },
    shout: { exitCode: shout.status, stdout: shout.stdout, stderr: shout.stderr },
    invalid: { exitCode: invalid.status, stdout: invalid.stdout, stderrNonBlank: Boolean(invalid.stderr.trim()) },
  };
  await retainArtifacts(result);
  process.stderr.write(`FACT-34 funded run ${attempt}: ${result.run.total_tokens} tokens, $${result.run.total_cost}\n`);
} catch (error) {
  thrown = error;
  try {
    const result = await snapshot();
    result.limitation = error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown", message: String(error) };
    await retainArtifacts(result);
  } catch (evidenceError) {
    process.stderr.write(`Failed to retain FACT-34 evidence: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}\n`);
  }
} finally {
  if (engine) await engine.stop().catch(() => {});
  await stopGateway(gateway).catch(() => {});
  if (gateway?.diagnostic) {
    let diagnostic = gateway.diagnostic.join("");
    const secret = process.env.OPENROUTER_API_KEY;
    if (secret) diagnostic = diagnostic.split(secret).join("[REDACTED]");
    await writeFile(path.join(evidenceDirectory, "gateway.log"), diagnostic.slice(-100_000));
  }
  await pool.end();
}

if (thrown) throw thrown;
