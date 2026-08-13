#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

const PLATFORM_COMMANDS = new Set([
  "list_projects",
  "create_ticket",
  "update_ticket",
  "post_message",
  "list_tickets",
]);
const CODING_COMMANDS = new Set(["start_run_workspace", "delegate_coding_task"]);
const RESERVED_FIELDS = new Set(["agentId", "runId", "ticketId", "workspace", "command"]);
const CONTEXT_FILE = ".orbitflow-tool-context.json";
const TOOL_ENV_FILE = "/run/orbitflow/tool-env.json";

try {
  const [command, serializedInput, ...extra] = process.argv.slice(2);
  if (
    extra.length !== 0 ||
    typeof command !== "string" ||
    (!PLATFORM_COMMANDS.has(command) && !CODING_COMMANDS.has(command)) ||
    typeof serializedInput !== "string"
  ) {
    throw new Error("usage: orbit-openclaw-tool <command> <json-input>");
  }
  if (Buffer.byteLength(serializedInput) > 32_768) {
    throw new Error("json-input exceeds 32768 bytes");
  }
  const supplied = JSON.parse(serializedInput);
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("json-input must be one JSON object");
  }
  for (const field of Object.keys(supplied)) {
    if (RESERVED_FIELDS.has(field)) {
      throw new Error(`${field} is bound by the active dispatch`);
    }
  }

  const toolEnvironment = JSON.parse(await readFile(TOOL_ENV_FILE, "utf8"));
  validateToolEnvironment(toolEnvironment);
  const workspaceRoot = await realpath(toolEnvironment.agentWorkspaceRoot);
  const workspace = await realpath(process.cwd());
  const relative = path.relative(workspaceRoot, workspace);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("tool must run from an active OrbitFlow agent workspace");
  }
  const context = JSON.parse(await readFile(path.join(workspace, CONTEXT_FILE), "utf8"));
  validateContext(context, workspace);

  const databaseUrl = toolEnvironment.databaseUrl;
  await requireActiveDispatch(databaseUrl, context);
  const workspaceServiceRoot = toolEnvironment.workspaceRoot;
  let executable;
  let input;
  let environment;
  if (PLATFORM_COMMANDS.has(command)) {
    if ((command === "update_ticket" || command === "post_message") && context.ticketId === null) {
      throw new Error(`${command} requires a ticket-bound dispatch`);
    }
    executable = "/app/bin/orbit-agent-tools.mjs";
    input = {
      ...supplied,
      agentId: context.agentId,
      runId: context.runId,
      ...((command === "update_ticket" || command === "post_message")
        ? { ticketId: context.ticketId }
        : {}),
    };
    environment = boundedEnvironment({ DATABASE_URL: databaseUrl });
  } else {
    executable = "/app/bin/orbit-coding-tool.mjs";
    input = command === "start_run_workspace"
      ? { ...supplied, runId: context.runId }
      : {
          ...supplied,
          workspace: path.join(workspaceServiceRoot, `run-${context.runId}`),
        };
    environment = boundedEnvironment({
      DATABASE_URL: databaseUrl,
      ORBITFLOW_WORKSPACE_ROOT: workspaceServiceRoot,
      ORBITFLOW_RUN_ID: context.runId,
      ORBITFLOW_AGENT_ID: context.agentId,
      OPENROUTER_API_KEY: toolEnvironment.openRouterApiKey,
      ORBITFLOW_OPENCODE_BINARY: toolEnvironment.openCodeBinary,
      ORBITFLOW_OPENCODE_MODEL: toolEnvironment.openCodeModel,
      ORBITFLOW_CODING_TIMEOUT_MS: toolEnvironment.codingTimeoutMs,
    });
  }

  const result = spawnSync(executable, [command, JSON.stringify(input)], {
    cwd: workspace,
    env: environment,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: "invalid_context", message: String(error?.message ?? error).slice(0, 256) },
  })}\n`);
  process.exitCode = 1;
}

async function requireActiveDispatch(databaseUrl, context) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `SELECT 1
       FROM workflow_dispatches AS dispatch
       JOIN openclaw_dispatch_inputs AS input ON input.dispatch_id = dispatch.id
       WHERE dispatch.id = $1
         AND dispatch.run_id = $2
         AND dispatch.agent_id = $3
         AND dispatch.ticket_id IS NOT DISTINCT FROM $4
         AND dispatch.runtime_generation = $5
         AND dispatch.runtime_session_id = $6
         AND dispatch.node_id = $7
         AND dispatch.status = 'dispatching'
         AND dispatch.lease_expires_at > clock_timestamp()
         AND input.runtime_generation = dispatch.runtime_generation
         AND input.wake_input->'toolContext' = $8::jsonb`,
      [
        context.dispatchId,
        context.runId,
        context.agentId,
        context.ticketId,
        context.dispatchGeneration,
        context.dispatchSessionId,
        context.nodeId,
        JSON.stringify(context),
      ],
    );
    if (result.rowCount !== 1) throw new Error("active dispatch context is no longer authorized");
  } finally {
    await pool.end();
  }
}

function boundedEnvironment(values) {
  return Object.fromEntries(Object.entries({
    PATH: "/app/coding-adapter/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    ...values,
  }).filter(([, value]) => typeof value === "string" && value !== ""));
}

function validateToolEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gateway tool environment is invalid");
  }
  const expected = [
    "agentWorkspaceRoot",
    "codingTimeoutMs",
    "databaseUrl",
    "openCodeBinary",
    "openCodeModel",
    "openRouterApiKey",
    "workspaceRoot",
  ];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error("gateway tool environment has unexpected fields");
  }
  for (const field of ["agentWorkspaceRoot", "databaseUrl", "workspaceRoot"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`gateway tool environment ${field} is invalid`);
    }
  }
  for (const field of ["codingTimeoutMs", "openCodeBinary", "openCodeModel", "openRouterApiKey"]) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw new Error(`gateway tool environment ${field} is invalid`);
    }
  }
}

function validateContext(value, workspace) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("active dispatch context is invalid");
  }
  const expected = [
    "agentId",
    "dispatchGeneration",
    "dispatchId",
    "dispatchSessionId",
    "invocationId",
    "nodeId",
    "runId",
    "ticketId",
    "version",
    "workspace",
  ];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error("active dispatch context has unexpected fields");
  }
  if (value.version !== 1 || value.workspace !== workspace) {
    throw new Error("active dispatch context does not match this workspace");
  }
  for (const field of ["agentId", "dispatchGeneration", "dispatchId", "runId"]) {
    if (typeof value[field] !== "string" || !/^[1-9][0-9]*$/.test(value[field])) {
      throw new Error(`active dispatch ${field} is invalid`);
    }
  }
  if (value.ticketId !== null && (typeof value.ticketId !== "string" || !/^[1-9][0-9]*$/.test(value.ticketId))) {
    throw new Error("active dispatch ticketId is invalid");
  }
  for (const field of ["dispatchSessionId", "invocationId", "nodeId"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`active dispatch ${field} is invalid`);
    }
  }
}
