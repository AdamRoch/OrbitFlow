#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { createRunWorkspaceService } from "../coding-adapter/src/index.js";
import {
  OPENCLAW_MODEL,
  OPENROUTER_BASE_URL,
  initializeOpenClaw,
  normalizeUsage,
  parseCommandJson,
  runOpenClaw,
  setConfig,
} from "../src/runtime/openclaw-runtime-spike.mjs";

if (process.env.ORBITFLOW_ENABLE_REAL_OPENCLAW_CODING_PROOF !== "1") {
  process.stdout.write("FACT-12 real OpenClaw tool-call proof skipped; enable ORBITFLOW_ENABLE_REAL_OPENCLAW_CODING_PROOF=1\n");
  process.exit(0);
}

const databaseUrl = required("DATABASE_URL");
const workspaceRoot = required("ORBITFLOW_WORKSPACE_ROOT");
required("OPENROUTER_API_KEY");
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, application_name: "fact12-openclaw-proof" });
const runtimeRoot = await mkdtemp(path.join(tmpdir(), "orbitfactory-fact12-openclaw-"));

try {
  const ids = await seedProof(pool);
  const workspaceService = createRunWorkspaceService({ pool, workspaceRoot });
  const codingWorkspace = await workspaceService.startRunWorkspace(ids.runId);
  const { stateDir } = await initializeOpenClaw(runtimeRoot);
  const agentWorkspace = path.join(runtimeRoot, "agent-workspace");
  const auditFile = path.join(runtimeRoot, "coding-tool-invocations.jsonl");
  await writeAgentWorkspace(agentWorkspace, {
    runId: ids.runId,
    agentId: ids.agentId,
    codingWorkspace,
  });
  await setConfig(stateDir, "models.providers.openrouter.baseUrl", OPENROUTER_BASE_URL);
  await setConfig(stateDir, "tools.allow", ["exec"]);
  await setConfig(stateDir, "tools.exec", { host: "gateway", security: "full", ask: "off" });

  const created = await runOpenClaw(
    [
      "agents",
      "add",
      "fact12-coding-tool",
      "--workspace",
      agentWorkspace,
      "--model",
      OPENCLAW_MODEL,
      "--non-interactive",
      "--json",
    ],
    { stateDir, timeoutMs: 30_000 },
  );
  if (created.exitCode !== 0 || created.timedOut) throw new Error("OpenClaw agent creation failed");

  const turnResult = await runOpenClaw(
    [
      "agent",
      "--local",
      "--agent",
      "fact12-coding-tool",
      "--message",
      [
        "Call exactly `node ./delegate-coding-task.mjs` with the exec tool.",
        "Do not simulate it and do not run any other command.",
        'After it succeeds, return only {"called":"delegate_coding_task","ok":true}.',
      ].join("\n"),
      "--timeout",
      "180",
      "--json",
    ],
    {
      stateDir,
      timeoutMs: 210_000,
      env: {
        DATABASE_URL: databaseUrl,
        ORBITFLOW_WORKSPACE_ROOT: workspaceRoot,
        ORBITFLOW_OPENCODE_BINARY: path.resolve("coding-adapter/fixtures/fake-opencode.mjs"),
        ORBITFLOW_CODING_TOOL_PATH: path.resolve("bin/orbit-coding-tool.mjs"),
        ORBITFLOW_CODING_TOOL_AUDIT: auditFile,
        ORBITFLOW_RUN_ID: ids.runId,
        ORBITFLOW_AGENT_ID: ids.agentId,
      },
    },
  );
  const turn = parseProofTurn(turnResult);
  const invocation = parseSingleAudit(await readFile(auditFile, "utf8"));
  const costs = await pool.query(
    "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1 AND agent_id = $2",
    [ids.runId, ids.agentId],
  );
  if (
    invocation.command !== "delegate_coding_task" ||
    invocation.runId !== ids.runId ||
    invocation.agentId !== ids.agentId ||
    turn.output.called !== "delegate_coding_task" ||
    turn.output.ok !== true ||
    costs.rows[0].count !== 1 ||
    (await readFile(path.join(codingWorkspace, "task.txt"), "utf8")) !== "OpenClaw delegated proof\n"
  ) {
    throw new Error("real OpenClaw tool-call proof did not satisfy its contract");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      proof: "real-openclaw-tool-call",
      structuredInvocation: true,
      usagePersisted: true,
      openClawTokens: turn.usage.total,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, proof: "real-openclaw-tool-call", message: safeMessage(error) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 3 });
}

async function writeAgentWorkspace(workspace, ids) {
  await mkdir(workspace, { recursive: true });
  const request = {
    command: "delegate_coding_task",
    task: "OpenClaw delegated proof",
    workspace: ids.codingWorkspace,
  };
  const wrapper = `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const request = ${JSON.stringify(request)};
await appendFile(process.env.ORBITFLOW_CODING_TOOL_AUDIT, JSON.stringify({
  schemaVersion: 1,
  source: "openclaw-exec",
  command: request.command,
  runId: process.env.ORBITFLOW_RUN_ID,
  agentId: process.env.ORBITFLOW_AGENT_ID,
}) + "\\n");
const child = spawn(process.execPath, [process.env.ORBITFLOW_CODING_TOOL_PATH], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.end(JSON.stringify(request));
for await (const chunk of child.stdout) process.stdout.write(chunk);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
process.exitCode = code;
`;
  const files = {
    "AGENTS.md": "Follow TOOLS.md and return the requested JSON only.\n",
    "SOUL.md": "You are a bounded coding-tool proof agent.\n",
    "IDENTITY.md": "# FACT-12 Coding Tool Proof Agent\n",
    "MEMORY.md": "# Memory\n\nThis is a disposable proof.\n",
    "TOOLS.md": "# Coding tool\n\nRun `node ./delegate-coding-task.mjs` exactly when asked.\n",
    "delegate-coding-task.mjs": wrapper,
  };
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(path.join(workspace, name), contents)),
  );
}

function parseProofTurn(result) {
  if (result.timedOut) throw new Error("OpenClaw tool-call proof timed out");
  const envelope = parseCommandJson(result);
  let finalText;
  let usage;
  if (Object.hasOwn(envelope, "ok") && Object.hasOwn(envelope, "status")) {
    if (result.exitCode !== 0 || envelope.ok !== true || envelope.status !== "ok") {
      throw new Error("OpenClaw stable turn did not complete");
    }
    finalText = envelope.final ?? envelope.payloads?.[0]?.text;
    usage = normalizeUsage(envelope.usage);
  } else {
    const meta = envelope.meta;
    const stopReason = meta?.stopReason ?? meta?.completion?.finishReason;
    if (result.exitCode !== 0 || meta?.error || meta?.livenessState === "blocked" || stopReason !== "stop") {
      throw new Error("OpenClaw legacy turn did not complete");
    }
    finalText = envelope.payloads?.[0]?.text;
    usage = normalizeUsage(meta.agentMeta?.usage ?? meta.agentMeta?.lastCallUsage);
  }
  const output = JSON.parse(String(finalText).trim());
  return { output, usage };
}

function parseSingleAudit(contents) {
  const lines = contents.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("OpenClaw proof expected one structured invocation");
  return JSON.parse(lines[0]);
}

async function seedProof(pool) {
  const unique = randomUUID();
  const workflow = await pool.query(
    `INSERT INTO workflows (name, description, graph)
     VALUES ($1, 'FACT-12 OpenClaw proof', '{"nodes":[],"edges":[]}')
     RETURNING id::text AS id`,
    [`FACT-12 OpenClaw ${unique}`],
  );
  const agent = await pool.query(
    `INSERT INTO agents (name, role, system_prompt, model, coding_tool_enabled)
     VALUES ($1, 'implementer', 'Use the coding tool.', 'proof/model', true)
     RETURNING id::text AS id`,
    [`FACT-12 OpenClaw ${unique}`],
  );
  const run = await pool.query(
    `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec, started_at)
     VALUES ($1, 'running', 'ui', '{"proof":"FACT-12 OpenClaw"}', now())
     RETURNING id::text AS id`,
    [workflow.rows[0].id],
  );
  return { agentId: agent.rows[0].id, runId: run.rows[0].id };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when the real OpenClaw proof gate is enabled`);
  return value;
}

function safeMessage(error) {
  let message = String(error?.message ?? error).slice(0, 1_000);
  if (process.env.OPENROUTER_API_KEY) {
    message = message.split(process.env.OPENROUTER_API_KEY).join("[REDACTED]");
  }
  return message;
}
