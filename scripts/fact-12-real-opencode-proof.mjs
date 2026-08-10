#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  createCodingTool,
  createCostEventStore,
  createOpenCodeAdapter,
  createRunWorkspaceService,
  OPEN_CODE_BINARY,
  OPEN_CODE_VERSION,
} from "../coding-adapter/src/index.js";

if (process.env.ORBITFLOW_ENABLE_REAL_OPENCODE_PROOF !== "1") {
  process.stdout.write("FACT-12 real OpenCode proof skipped; enable ORBITFLOW_ENABLE_REAL_OPENCODE_PROOF=1\n");
  process.exit(0);
}

const databaseUrl = required("DATABASE_URL");
const workspaceRoot = required("ORBITFLOW_WORKSPACE_ROOT");
required("OPENROUTER_API_KEY");
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, application_name: "fact12-real-opencode-proof" });

try {
  const version = execFileSync(OPEN_CODE_BINARY, ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
  }).trim();
  if (version !== OPEN_CODE_VERSION) throw new Error("pinned OpenCode version is unavailable");

  const ids = await seedProof(pool, "real-opencode");
  const workspaceService = createRunWorkspaceService({ pool, workspaceRoot });
  const workspace = await workspaceService.startRunWorkspace(ids.runId);
  const tool = createCodingTool({
    runId: ids.runId,
    agentId: ids.agentId,
    workspaceService,
    costEventStore: createCostEventStore({ pool }),
    adapterFactory: createOpenCodeAdapter,
    adapterOptions: { env: process.env },
  });
  const result = await tool.delegate_coding_task(
    "Create fact12-real-proof.txt containing exactly: real OpenCode request path proved",
    workspace,
  );
  const persisted = await pool.query(
    "SELECT count(*)::int AS count FROM cost_events WHERE run_id = $1 AND agent_id = $2",
    [ids.runId, ids.agentId],
  );
  if (!result.diff.includes("fact12-real-proof.txt") || persisted.rows[0].count !== 1) {
    throw new Error("real OpenCode proof did not satisfy its contract");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      proof: "real-opencode-request-path",
      version,
      diffPresent: true,
      usagePersisted: true,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, proof: "real-opencode-request-path", message: safeMessage(error) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function seedProof(pool, suffix) {
  const unique = `${suffix}-${randomUUID()}`;
  const workflow = await pool.query(
    `INSERT INTO workflows (name, description, graph)
     VALUES ($1, 'FACT-12 gated proof', '{"nodes":[],"edges":[]}')
     RETURNING id::text AS id`,
    [`FACT-12 ${unique}`],
  );
  const agent = await pool.query(
    `INSERT INTO agents (name, role, system_prompt, model, coding_tool_enabled)
     VALUES ($1, 'implementer', 'Use the coding tool.', 'proof/model', true)
     RETURNING id::text AS id`,
    [`FACT-12 ${unique}`],
  );
  const run = await pool.query(
    `INSERT INTO workflow_runs (workflow_id, status, trigger_type, spec, started_at)
     VALUES ($1, 'running', 'ui', '{"proof":"FACT-12 real OpenCode"}', now())
     RETURNING id::text AS id`,
    [workflow.rows[0].id],
  );
  return { agentId: agent.rows[0].id, runId: run.rows[0].id };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when the real OpenCode proof gate is enabled`);
  return value;
}

function safeMessage(error) {
  let message = String(error?.message ?? error).slice(0, 1_000);
  if (process.env.OPENROUTER_API_KEY) {
    message = message.split(process.env.OPENROUTER_API_KEY).join("[REDACTED]");
  }
  return message;
}
