#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import { createCodingTool, createCostEventStore, createRunWorkspaceService } from "../coding-adapter/src/index.js";
import { createPublicErrorResponse } from "../coding-adapter/src/errors.js";
import {
  immutableDispatchContext,
  loadOpenClawToolContext,
} from "../src/lib/runtime/openclaw-tool-context.mjs";

const { Pool } = pg;
const PLATFORM_COMMANDS = new Set([
  "list_projects",
  "create_ticket",
  "update_ticket",
  "post_message",
  "list_tickets",
]);
const CODING_COMMANDS = new Set(["start_run_workspace", "delegate_coding_task"]);
const SOCKET = requiredEnv("ORBITFLOW_TOOL_BROKER_SOCKET");
const EXECUTOR_SOCKET = requiredEnv("ORBITFLOW_CODING_EXECUTOR_SOCKET");
const AGENT_WORKSPACE_ROOT = requiredEnv("ORBITFLOW_AGENT_WORKSPACE_ROOT");
const WORKSPACE_ROOT = requiredEnv("ORBITFLOW_WORKSPACE_ROOT");
const DATABASE_URL = requiredEnv("DATABASE_URL");
const EXECUTION_IDENTITY_ROOT = path.join(WORKSPACE_ROOT, ".orbitflow", "executor-identities");
const EXECUTION_UID_MIN = 20_000;
const EXECUTION_UID_COUNT = 40_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const pool = new Pool({ connectionString: DATABASE_URL, application_name: "orbit-tool-broker" });
const workspaceService = createRunWorkspaceService({ pool, workspaceRoot: WORKSPACE_ROOT });
const costEventStore = createCostEventStore({ pool });
let identityAllocation = Promise.resolve();

await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o770 });
await mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o711 });
await mkdir(path.join(WORKSPACE_ROOT, ".orbitflow"), { recursive: true, mode: 0o700 });
await chmod(path.join(WORKSPACE_ROOT, ".orbitflow"), 0o700);
await mkdir(EXECUTION_IDENTITY_ROOT, { recursive: true, mode: 0o700 });
await chmod(EXECUTION_IDENTITY_ROOT, 0o700);
await chmod(WORKSPACE_ROOT, 0o711);

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    writeJson(response, 400, failure(error));
  });
});
server.listen(SOCKET, async () => {
  await chown(SOCKET, 0, 19_000);
  await chmod(SOCKET, 0o660);
});

async function handleRequest(request, response) {
  if (request.method !== "POST" || request.url !== "/v1/tool") {
    writeJson(response, 404, { ok: false, error: { code: "not_found", message: "not found" } });
    return;
  }
  const body = await readJson(request, MAX_REQUEST_BYTES);
  requireExactKeys(body, ["command", "context", "input", "workspace"]);
  if (!PLATFORM_COMMANDS.has(body.command) && !CODING_COMMANDS.has(body.command)) {
    throw new Error("unknown broker command");
  }
  if (!body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    throw new Error("broker input must be one JSON object");
  }
  const loaded = await loadOpenClawToolContext({
    agentWorkspaceRoot: AGENT_WORKSPACE_ROOT,
    workspace: body.workspace,
  });
  if (stableJson(loaded.context) !== stableJson(body.context)) {
    throw new Error("active dispatch context changed before broker authorization");
  }
  const context = immutableDispatchContext(loaded.context);
  await requireActiveDispatch(context);

  let result;
  if (PLATFORM_COMMANDS.has(body.command)) {
    result = invokePlatformCommand(body.command, body.input, context, loaded.context);
  } else if (body.command === "start_run_workspace") {
    requireExactKeys(body.input, []);
    const workspace = await workspaceService.startRunWorkspace(context.runId);
    await ensureExecutionIdentity(context.runId, workspace);
    result = { ok: true, result: { workspace } };
  } else {
    requireExactKeys(body.input, ["task"]);
    const workspace = path.join(WORKSPACE_ROOT, `run-${context.runId}`);
    const identity = await requireExecutionIdentity(context.runId, workspace);
    const model = process.env.ORBITFLOW_OPENCODE_MODEL || "openrouter/anthropic/claude-haiku-4.5";
    const tool = createCodingTool({
      runId: context.runId,
      agentId: context.agentId,
      workspaceService,
      costEventStore,
      adapterOptions: { model },
      adapterFactory: () => ({
        delegate_coding_task: (task, requestedWorkspace, { signal } = {}) =>
          executorRequest({
            task,
            workspace: requestedWorkspace,
            runId: context.runId,
            executionUid: identity.uid,
            executionGid: identity.gid,
            model,
          }, signal),
      }),
    });
    try {
      result = { ok: true, result: await tool.delegate_coding_task(body.input.task, workspace) };
    } catch (error) {
      result = { ok: false, error: createPublicErrorResponse(error) };
    }
  }
  writeJson(response, result.ok === true ? 200 : 400, result);
}

function invokePlatformCommand(command, supplied, context, fullContext) {
  if ((command === "update_ticket" || command === "post_message") && context.ticketId === null) {
    throw new Error(`${command} requires a ticket-bound dispatch`);
  }
  const input = {
    ...supplied,
    agentId: context.agentId,
    runId: context.runId,
    ...((command === "update_ticket" || command === "post_message")
      ? { ticketId: fullContext.ticketId }
      : {}),
  };
  const child = spawnSync("/app/bin/orbit-agent-tools.mjs", [command, JSON.stringify(input)], {
    env: boundedEnvironment({ DATABASE_URL }),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  try {
    return JSON.parse(child.stdout);
  } catch {
    throw new Error("platform tool returned malformed JSON");
  }
}

async function requireActiveDispatch(context) {
  const result = await pool.query(
    `SELECT 1
     FROM workflow_dispatches AS dispatch
     JOIN openclaw_dispatch_inputs AS input ON input.dispatch_id = dispatch.id
     WHERE dispatch.id = $1
       AND dispatch.run_id = $2
       AND dispatch.agent_id = $3
       AND dispatch.ticket_id IS NOT DISTINCT FROM $4
       AND dispatch.runtime_generation = $5
       AND dispatch.node_id = $6
       AND dispatch.status = 'dispatching'
       AND dispatch.lease_expires_at > clock_timestamp()
       AND input.runtime_generation = dispatch.runtime_generation
       AND input.wake_input->'toolContext' = $7::jsonb`,
    [
      context.dispatchId,
      context.runId,
      context.agentId,
      context.ticketId,
      context.dispatchGeneration,
      context.nodeId,
      JSON.stringify(context),
    ],
  );
  if (result.rowCount !== 1) throw new Error("active dispatch context is no longer authorized");
}

async function ensureExecutionIdentity(runId, workspace) {
  const operation = identityAllocation.then(async () => {
    const existing = await readIdentity(runId);
    if (existing) return validateIdentity(existing, runId, workspace);
    const entries = await readdir(EXECUTION_IDENTITY_ROOT);
    const used = new Set();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const value = JSON.parse(await readFile(path.join(EXECUTION_IDENTITY_ROOT, entry), "utf8"));
      if (Number.isSafeInteger(value.uid)) used.add(value.uid);
    }
    const start = Number(BigInt(runId) % BigInt(EXECUTION_UID_COUNT));
    let uid = null;
    for (let offset = 0; offset < EXECUTION_UID_COUNT; offset += 1) {
      const candidate = EXECUTION_UID_MIN + ((start + offset) % EXECUTION_UID_COUNT);
      if (!used.has(candidate)) {
        uid = candidate;
        break;
      }
    }
    if (uid === null) throw new Error("coding execution identity pool is exhausted");
    const canonicalWorkspace = await realpath(workspace);
    await chownTree(canonicalWorkspace, uid, uid);
    await chmod(canonicalWorkspace, 0o700);
    const stat = await lstat(canonicalWorkspace);
    const identity = {
      version: 1,
      runId,
      workspace: canonicalWorkspace,
      workspaceDevice: String(stat.dev),
      workspaceInode: String(stat.ino),
      uid,
      gid: uid,
    };
    await writeFile(identityPath(runId), `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
    return identity;
  });
  identityAllocation = operation.catch(() => {});
  return operation;
}

async function requireExecutionIdentity(runId, workspace) {
  const identity = await readIdentity(runId);
  if (!identity) throw new Error("run workspace must be started before coding delegation");
  return validateIdentity(identity, runId, workspace);
}

async function validateIdentity(identity, runId, workspace) {
  const canonicalWorkspace = await realpath(workspace);
  const stat = await lstat(canonicalWorkspace);
  if (
    identity?.version !== 1 ||
    identity.runId !== runId ||
    identity.workspace !== canonicalWorkspace ||
    identity.workspaceDevice !== String(stat.dev) ||
    identity.workspaceInode !== String(stat.ino) ||
    !Number.isSafeInteger(identity.uid) ||
    identity.uid < EXECUTION_UID_MIN ||
    identity.uid >= EXECUTION_UID_MIN + EXECUTION_UID_COUNT ||
    identity.gid !== identity.uid ||
    stat.uid !== identity.uid ||
    stat.gid !== identity.gid
  ) {
    throw new Error("coding execution identity is invalid");
  }
  return identity;
}

async function readIdentity(runId) {
  try {
    return JSON.parse(await readFile(identityPath(runId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function identityPath(runId) {
  return path.join(EXECUTION_IDENTITY_ROOT, `run-${runId}.json`);
}

async function chownTree(target, uid, gid) {
  const stat = await lstat(target);
  if (stat.isDirectory()) {
    for (const entry of await readdir(target)) {
      await chownTree(path.join(target, entry), uid, gid);
    }
  }
  if (stat.isSymbolicLink()) await lchown(target, uid, gid);
  else await chown(target, uid, gid);
}

function executorRequest(payload, signal) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: EXECUTOR_SOCKET,
      path: "/v1/delegate",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      signal,
    }, (response) => {
      let contents = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        contents += chunk;
        if (Buffer.byteLength(contents) > 12 * 1024 * 1024) {
          request.destroy(new Error("coding executor response is too large"));
        }
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(contents);
          if (value.ok === true) resolve(value.result);
          else reject(Object.assign(new Error(value.error?.message ?? "coding executor failed"), value.error));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function readJson(request, limit) {
  let contents = "";
  for await (const chunk of request) {
    contents += chunk;
    if (Buffer.byteLength(contents) > limit) throw new Error("broker request is too large");
  }
  return JSON.parse(contents);
}

function requireExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request must be one JSON object");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("request has unexpected fields");
  }
}

function boundedEnvironment(values) {
  return Object.fromEntries(Object.entries({
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    ...values,
  }).filter(([, value]) => typeof value === "string" && value !== ""));
}

function failure(error) {
  return { ok: false, error: { code: "invalid_context", message: String(error?.message ?? error).slice(0, 256) } };
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

process.on("SIGTERM", () => server.close(() => pool.end().finally(() => process.exit(0))));
