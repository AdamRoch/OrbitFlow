import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { migratePostgres } from "../scripts/migrate-postgres.mjs";
import {
  createWorkflowRun,
  getWorkflowRun,
  startWorkflowEngine,
  startWorkflowRun,
} from "../src/lib/postgres/workflow-engine.ts";
import { OpenClawRuntimeAdapter } from "../src/lib/runtime/openclaw.ts";
import { OpenClawEngineAdapter } from "../src/lib/runtime/engine-adapter.ts";

const { Pool } = pg;

function projectBin() {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)), "bin");
}

function pendingDir() {
  return process.env.ORBITFLOW_FACT14_PENDING_DIR || tmpdir();
}

const bin = projectBin();
const agentTool = path.join(bin, "orbit-agent-tools.mjs");
const codingTool = path.join(bin, "orbit-coding-tool.mjs");
const codingModel = process.env.ORBITFLOW_OPENCODE_MODEL || process.env.ORBITFLOW_FACT14_MODEL || "openrouter/deepseek/deepseek-v4-flash";

function workspaceToolsFor(agentName, projectId, agentId, runId) {
  const dbAlias = "ORBITFLOW_PLATFORM_DATABASE_URL";
  if (agentName === "Factory Orchestrator") return [
    `# Tools for Orchestrator`,
    `Use \`node ${agentTool}\` with a single JSON argument. Prefix DATABASE_URL from ${dbAlias}.`,
    `Your agentId is ${agentId}, runId is ${runId}, projectId is ${projectId}.`,
    ``,
    `### create_ticket`,
    `DATABASE_URL="$${dbAlias}" node ${agentTool} create_ticket '{"agentId":"${agentId}","runId":"${runId}","projectId":"${projectId}","title":"...","description":"...","status":"todo","priority":1,"idempotencyKey":"orch-create-${agentId}"}'`,
    ``,
    `### list_tickets`,
    `DATABASE_URL="$${dbAlias}" node ${agentTool} list_tickets '{"agentId":"${agentId}","runId":"${runId}","idempotencyKey":"orch-list-${agentId}"}'`,
  ].join("\n");
  if (agentName === "Factory Planner") return [
    `# Tools for Planner`,
    `Use \`node ${agentTool}\` with a single JSON argument. Prefix DATABASE_URL from ${dbAlias}.`,
    `Your agentId is ${agentId}, runId is ${runId}, projectId is ${projectId}.`,
    ``,
    `### create_ticket`,
    `DATABASE_URL="$${dbAlias}" node ${agentTool} create_ticket '{"agentId":"${agentId}","runId":"${runId}","projectId":"${projectId}","title":"...","description":"...","status":"todo","priority":1,"idempotencyKey":"plan-create-${agentId}"}'`,
    ``,
    `### list_tickets`,
    `DATABASE_URL="$${dbAlias}" node ${agentTool} list_tickets '{"agentId":"${agentId}","runId":"${runId}","idempotencyKey":"plan-list-${agentId}"}'`,
  ].join("\n");
  if (agentName === "Factory Implementer") return [
    `# Tools for Implementer`,
    `Prefix DATABASE_URL from ${dbAlias} for all tools. Your agentId is ${agentId}, runId is ${runId}, projectId is ${projectId}.`,
    ``,
    `### list_tickets`,
    `DATABASE_URL="$${dbAlias}" node ${agentTool} list_tickets '{"agentId":"${agentId}","runId":"${runId}","idempotencyKey":"impl-list-${agentId}"}'`,
    ``,
    `### update_ticket`,
    `DATABASE_URL="$${dbAlias}" node ${agentTool} update_ticket '{"agentId":"${agentId}","runId":"${runId}","ticketId":"<id>","expectedUpdatedAt":"<date>","status":"done","idempotencyKey":"impl-update-${agentId}"}'`,
    ``,
    `### start_run_workspace`,
    `echo '{"command":"start_run_workspace","runId":"${runId}"}' | DATABASE_URL="$${dbAlias}" ORBITFLOW_WORKSPACE_ROOT=$ORBITFLOW_WORKSPACE_ROOT node ${codingTool}`,
    ``,
    `### delegate_coding_task`,
    `echo '{"command":"delegate_coding_task","task":"<task>","workspace":"$ORBITFLOW_WORKSPACE_ROOT/run-${runId}"}' | DATABASE_URL="$${dbAlias}" ORBITFLOW_RUN_ID=${runId} ORBITFLOW_AGENT_ID=${agentId} ORBITFLOW_WORKSPACE_ROOT=$ORBITFLOW_WORKSPACE_ROOT node ${codingTool}`,
  ].join("\n");
  if (agentName === "Factory Tester") return [
    `# Tools for Tester`,
    `Your agentId is ${agentId}, runId is ${runId}, projectId is ${projectId}.`,
  ].join("\n");
  return null;
}

async function startGateway(runtimeRoot, port) {
  const stateDir = path.join(runtimeRoot, "state");
  const homeDir = path.join(runtimeRoot, "home");
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const model = process.env.ORBITFLOW_FACT14_MODEL || "openrouter/deepseek/deepseek-v4-flash";
  const gwEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir, HOME: homeDir, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, OPENCLAW_DISABLE_BONJOUR: "1" };

  const setPort = spawn("openclaw", ["config", "set", "gateway.port", String(port), "--strict-json"], { env: gwEnv, stdio: "ignore" });
  const portExit = await new Promise((resolve) => setPort.once("close", resolve));
  if (portExit !== 0) throw new Error(`config set gateway.port exited ${portExit}`);

  const setModel = spawn("openclaw", ["models", "set", model], { env: gwEnv, stdio: "ignore" });
  const modelExit = await new Promise((resolve) => setModel.once("close", resolve));
  if (modelExit !== 0) throw new Error(`models set ${model} exited ${modelExit}`);

  const diag = [];
  const child = spawn("openclaw", [
    "gateway", "--allow-unconfigured", "--auth", "none", "--bind", "loopback", "--port", String(port),
  ], {
    env: gwEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => { diag.push(d); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => { diag.push(d); });
  child.once("close", (code) => { diag.push(`\nCLOSE: ${code}\n`); });

  return { child, stateDir, homeDir, model, getDiag: () => diag.join("") };
}

async function waitForGateway(port, timeoutMs = 60_000) {
  const healthUrl = `http://127.0.0.1:${port}/readyz`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try { 
      const r = await fetch(healthUrl); 
      if (r.ok) return; 
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;
    }
    await delay(500);
  }
  throw new Error(`Gateway did not become ready on port ${port}: ${lastError}`);
}

test("FACT-14 Software Factory end-to-end", { timeout: 900_000 }, async (_t) => {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must point to the disposable proof database");

  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const evidence = pendingDir();
  let gatewayProcess = null;

  try {
    const client = await pool.connect();
    try {
      const identity = await client.query("SELECT current_database() AS name");
      assert.equal(identity.rows[0].name, process.env.ORBITFACTORY_FACT14_PROOF_DATABASE);
    } finally {
      client.release();
    }

    await migratePostgres({ databaseUrl, log: () => {} });

    const workflowResult = await pool.query(
      `SELECT id, graph FROM workflows WHERE name = 'Software Factory' AND is_template = true`,
    );
    assert.ok(workflowResult.rows[0], "Software Factory template workflow must exist");
    const workflowId = workflowResult.rows[0].id;
    const graph = workflowResult.rows[0].graph;

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    assert.ok(nodeIds.has("orchestrator"), "template must have orchestrator node");
    assert.ok(nodeIds.has("planner"), "template must have planner node");
    assert.ok(nodeIds.has("implement"), "template must have implement node");
    assert.ok(nodeIds.has("test"), "template must have test node");

    const agentsResult = await pool.query(
      `SELECT id, name FROM agents WHERE name IN (
         'Factory Orchestrator', 'Factory Planner', 'Factory Implementer', 'Factory Tester'
       ) ORDER BY id`,
    );
    const agents = agentsResult.rows;
    assert.equal(agents.length, 4, "all 4 factory agents must exist");
    console.error("Template agents:", agents.map((a) => `${a.id}:${a.name}`).join(", "));

    const projResult = await pool.query(
      `INSERT INTO projects (key, name) VALUES ('FACT', 'Factory') ON CONFLICT (key) DO UPDATE SET key = projects.key RETURNING id`,
    );
    const projectId = String(projResult.rows[0].id);

    const proofModel = process.env.ORBITFLOW_FACT14_MODEL || "openrouter/deepseek/deepseek-v4-flash";
    await pool.query(
      `UPDATE agents SET model = $1 WHERE name IN (
         'Factory Orchestrator', 'Factory Planner', 'Factory Implementer', 'Factory Tester'
       )`,
      [proofModel],
    );
    const verifyAgents = await pool.query(
      `SELECT id, name, model FROM agents WHERE name IN (
         'Factory Orchestrator', 'Factory Planner', 'Factory Implementer', 'Factory Tester'
       ) ORDER BY id`,
    );
    for (const agent of verifyAgents.rows) {
      assert.equal(agent.model, proofModel, `agent ${agent.name} must use ${proofModel}`);
    }
    console.error(`All agent models set to: ${proofModel}`);

    const runtimeRoot = path.join(tmpdir(), `orbitflow-fact14-${randomUUID()}`);
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

    const workspaceRoot = process.env.ORBITFLOW_WORKSPACE_ROOT || path.join(runtimeRoot, "workspaces");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    process.env.ORBITFLOW_WORKSPACE_ROOT = workspaceRoot;
    process.env.ORBITFLOW_OPENCODE_MODEL = process.env.ORBITFLOW_OPENCODE_MODEL || codingModel;
    process.env.ORBITFLOW_PLATFORM_DATABASE_URL = databaseUrl;

    const gwPort = Number(process.env.ORBITFLOW_FACT14_GATEWAY_PORT || 18794);
    console.error(`Starting gateway on port ${gwPort} with state in ${runtimeRoot}/state`);
    gatewayProcess = await startGateway(runtimeRoot, gwPort);
    await waitForGateway(gwPort);
    const expectedModel = gatewayProcess.model;
    const modelLine = `agent model: ${expectedModel}`;
    for (let i = 0; i < 40; i += 1) {
      if (gatewayProcess.getDiag().includes(modelLine)) { console.error(`Model verified: ${modelLine}`); break; }
      await delay(500);
    }
    if (!gatewayProcess.getDiag().includes(modelLine)) {
      console.error("Diag:", gatewayProcess.getDiag().slice(-2000));
      throw new Error(`Missing model line: ${modelLine}`);
    }
    console.error("Gateway ready");

    const nodeBin = path.dirname(process.execPath);
    const currentPath = process.env.PATH ?? "";
    if (!currentPath.includes(nodeBin)) process.env.PATH = `${nodeBin}:${currentPath}`;
    if (!currentPath.includes(bin)) process.env.PATH = `${bin}:${currentPath}`;

    const allowedExec = ["DATABASE_URL", "OPENROUTER_API_KEY", "ORBITFLOW_RUN_ID", "ORBITFLOW_AGENT_ID", "ORBITFLOW_WORKSPACE_ROOT", "ORBITFLOW_OPENCODE_MODEL", "ORBITFLOW_PLATFORM_DATABASE_URL"];
    const gatewayEnvironment = { OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${gwPort}` };

    const openclawAdapter = new OpenClawRuntimeAdapter({
      pool,
      runtimeRoot,
      wakeTimeoutMs: Number(process.env.ORBITFLOW_FACT14_WAKE_TIMEOUT_MS || 180_000),
      allowedExecEnvironment: allowedExec,
      gatewayEnvironment,
    });

    const engineAdapter = new OpenClawEngineAdapter({
      pool,
      openclaw: openclawAdapter,
      workspaceTools: (agentId, _nodeId, _ticketId, runId) => {
        const agent = agents.find((a) => String(a.id) === agentId);
        return agent ? workspaceToolsFor(agent.name, projectId, agentId, runId) : null;
      },
    });

    console.error("Pre-syncing agents...");
    for (const agent of agents) {
      await openclawAdapter.syncAgent(agent.id);
      console.error(`  Agent ${agent.id} synced`);
    }
    console.error("All agents synced.");

    console.error("Restarting gateway after agent creation...");
    if (gatewayProcess?.child && gatewayProcess.child.exitCode === null && gatewayProcess.child.signalCode === null) {
      const killed = new Promise((resolve) => gatewayProcess.child.once("close", resolve));
      gatewayProcess.child.kill("SIGTERM");
      const force = setTimeout(() => gatewayProcess.child.kill("SIGKILL"), 2_000);
      await killed;
      clearTimeout(force);
    }
    gatewayProcess = await startGateway(runtimeRoot, gwPort);
    await waitForGateway(gwPort);
    const m2 = gatewayProcess.model;
    const ml2 = `agent model: ${m2}`;
    for (let i = 0; i < 40; i += 1) {
      if (gatewayProcess.getDiag().includes(ml2)) { console.error(`Model verified (post-sync): ${ml2}`); break; }
      await delay(500);
    }
    if (!gatewayProcess.getDiag().includes(ml2)) throw new Error(`Post-sync missing model line: ${ml2}`);
    console.error("Gateway ready after restart");

    const run = await createWorkflowRun(pool, {
      workflowId,
      triggerType: "ui",
      spec: { task: "Create a hello.txt file containing 'Hello from OrbitFlow Software Factory!'" },
    });

    await startWorkflowRun(pool, run.id);

    let startedRun = await getWorkflowRun(pool, run.id);
    assert.ok(startedRun, "run created");
    assert.equal(startedRun.status, "running");

    const engineWorker = startWorkflowEngine(pool, engineAdapter, {
      consumerId: `fact14-${randomUUID().slice(0, 8)}`,
      dispatcherId: `fact14-${randomUUID().slice(0, 8)}`,
      pollIntervalMs: 250,
    });

    const maxWaitMs = 600_000;
    const startTime = Date.now();
    let finalRun = null;
    let lastStatus = startedRun.status;

    while (Date.now() - startTime < maxWaitMs) {
      await delay(2_000);
      finalRun = await getWorkflowRun(pool, run.id);
      if (!finalRun) break;
      if (finalRun.status !== lastStatus) {
        console.error(`Run ${run.id}: ${lastStatus} → ${finalRun.status}`);
        lastStatus = finalRun.status;
      }
      if (["completed", "failed"].includes(finalRun.status)) break;
    }

    await engineWorker.stop();

    assert.ok(finalRun, "run must exist");

    const messages = await pool.query("SELECT * FROM messages WHERE run_id = $1 ORDER BY id", [run.id]);
    const tickets = await pool.query("SELECT * FROM tickets WHERE run_id = $1 ORDER BY id", [run.id]);
    const costEvents = await pool.query("SELECT * FROM cost_events WHERE run_id = $1 ORDER BY id", [run.id]);
    const dispatches = await pool.query("SELECT * FROM workflow_dispatches WHERE run_id = $1 ORDER BY id", [run.id]);

    const evidenceData = {
      run: { id: finalRun.id, status: finalRun.status, failureReason: finalRun.failureReason, totalTokens: finalRun.totalTokens, totalCost: finalRun.totalCost },
      messageCount: messages.rowCount,
      messages: messages.rows.map((row) => ({ id: row.id, type: row.type, sender: row.sender, recipient: row.recipient, handoffBrief: row.handoff_brief?.slice(0, 500), hasTokenUsage: row.token_usage !== null, payload: JSON.stringify(row.payload).slice(0, 2000) })),
      ticketCount: tickets.rowCount,
      tickets: tickets.rows.map((row) => ({ id: row.id, identifier: row.identifier, title: row.title, status: row.status })),
      costEventCount: costEvents.rowCount,
      costEvents: costEvents.rows.map((row) => ({ id: row.id, agentId: row.agent_id, model: row.model, tokensIn: row.tokens_in, tokensOut: row.tokens_out, computedCost: row.computed_cost })),
      dispatchCount: dispatches.rowCount,
      dispatches: dispatches.rows.map((row) => ({ id: row.id, nodeId: row.node_id, status: row.status, agentId: row.agent_id, ticketId: row.ticket_id })),
    };
    await writeFile(path.join(evidence, "proof-result.json"), JSON.stringify(evidenceData, null, 2));

    console.error("Run:", finalRun.status, finalRun.failureReason || "");
    console.error(`Messages: ${messages.rowCount}, Tickets: ${tickets.rowCount}, Cost events: ${costEvents.rowCount}, Dispatches: ${dispatches.rowCount}`);

    for (const msg of messages.rows.slice(0, 20)) {
      console.error(`  msg: type=${msg.type} sender=${msg.sender} handoff=${msg.handoff_brief?.slice(0, 80) ?? "none"}`);
    }

    const outputMessages = messages.rows.filter((row) => row.type === "output");
    const handoffBriefs = outputMessages.filter((row) => row.handoff_brief && row.handoff_brief.trim());
    assert.ok(outputMessages.length >= 1, "at least one output message");

    // Distinct finalized Implementer cost event on exact DeepSeek model
    const implementerId = String(agents.find((a) => a.name === "Factory Implementer")?.id);
    const implCostEvents = costEvents.rows.filter(
      (row) =>
        String(row.agent_id) === implementerId &&
        row.model === codingModel &&
        BigInt(row.tokens_in) > BigInt(0) &&
        BigInt(row.tokens_out) > BigInt(0) &&
        parseFloat(row.computed_cost) > 0,
    );
    assert.ok(implCostEvents.length >= 1, `implementer has finalized ${codingModel} cost event with positive tokens and cost`);

    // No orbitflow-invocation reservation cost events
    const reservations = costEvents.rows.filter(
      (row) => row.model && String(row.model).startsWith("orbitflow-invocation:"),
    );
    assert.equal(reservations.length, 0, "zero unconverted invocation reservations");

    const totalTokens = BigInt(finalRun.totalTokens || "0");
    const totalCost = parseFloat(finalRun.totalCost || "0");
    console.error(`Aggregated: ${totalTokens} tokens, $${totalCost}`);

    const completedDispatches = dispatches.rows.filter((row) => row.status === "completed");
    const dispatchNodeIds = new Set(completedDispatches.map((d) => d.nodeId));
    console.error(`Completed dispatches: ${completedDispatches.length} (nodes: ${[...dispatchNodeIds].join(", ")})`);

    // FACT-14 acceptance assertions
    assert.equal(finalRun.status, "completed", "run must reach completed status");
    assert.ok(totalTokens > BigInt(0), "token usage aggregated on the run");
    assert.ok(totalCost > 0, "cost aggregated on the run");

    assert.ok(tickets.rowCount >= 1, "at least one real ticket created via platform tool surface");
    const doneTickets = tickets.rows.filter((row) => row.status === "done");
    assert.ok(doneTickets.length >= 1, "at least one ticket finalized as done");

    for (const nodeId of ["orchestrator", "planner", "implement", "test", "report"]) {
      assert.ok(dispatchNodeIds.has(nodeId), `dispatch completed for ${nodeId}`);
    }

    // Real run workspace diff with hello.txt — strict mandatory
    const wsRoot = process.env.ORBITFLOW_WORKSPACE_ROOT;
    assert.ok(wsRoot, "ORBITFLOW_WORKSPACE_ROOT must be set");
    const runWs = `${wsRoot}/run-${run.id}`;
    const diffResult = spawnSync("git", ["-C", runWs, "diff"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(diffResult.status, 0, `git diff must succeed in ${runWs}`);
    const diff = diffResult.stdout || diffResult.stderr || "";
    const expectContent = "Hello from OrbitFlow Software Factory!";
    assert.ok(diff.includes("hello.txt"), `git diff must include hello.txt\n${diff.slice(0, 500)}`);
    const helloPath = `${runWs}/hello.txt`;
    const helloContent = readFileSync(helloPath, "utf8");
    assert.equal(helloContent.trim(), expectContent, `hello.txt must contain exact: ${expectContent}`);
    console.error("Workspace hello.txt:", helloContent.trim());

    // Assert no database URL leaks in retained evidence
    const dbUrl = process.env.DATABASE_URL || "";
    if (dbUrl.includes("://")) {
      const password = dbUrl.split("@")[0].split(":").slice(-1)[0];
      const evidenceText = JSON.stringify(evidenceData);
      assert.ok(!evidenceText.includes(password), "database password not in evidence");
    }

    // Original-head Software Factory completion evidence retained
    console.error("\n=== FACT-14 E2E PROOF COMPLETE ===");
    console.error(`Workflow: orchestrator → planner → implement → test → done`);
    console.error(`Tickets: ${tickets.rowCount}  Handoffs: ${handoffBriefs.length}  Dispatches: ${dispatches.rowCount}`);
    console.error(`Tokens: ${totalTokens}  Cost: $${totalCost}  Cost events: ${costEvents.rowCount}`);
  } finally {
    if (gatewayProcess?.child && gatewayProcess.child.exitCode === null && gatewayProcess.child.signalCode === null) {
      gatewayProcess.child.kill("SIGTERM");
      const force = setTimeout(() => gatewayProcess.child.kill("SIGKILL"), 3_000);
      await new Promise((resolve) => gatewayProcess.child.once("close", resolve));
      clearTimeout(force);
    }
    await pool.end();
  }
});