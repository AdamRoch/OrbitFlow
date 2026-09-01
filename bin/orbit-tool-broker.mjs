#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  mkdir,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import {
  createCodingTool,
  createCostEventStore,
  createExecutionIdentityStore,
  createRunWorkspaceService,
} from "../coding-adapter/src/index.js";
import {
  CliFailureError,
  createPublicErrorResponse,
  WorkspaceError,
} from "../coding-adapter/src/errors.js";
import {
  immutableDispatchContext,
  loadOpenClawToolContext,
  validateOpenClawToolContext,
} from "../src/lib/runtime/openclaw-tool-context.mjs";
import { buildPlatformCommandInput } from "../src/lib/runtime/platform-tool-broker-input.mjs";
import {
  createWorkspaceArchive,
  replaceWorkspaceFromArchive,
} from "../src/lib/runtime/workspace-archive.mjs";

const { Pool } = pg;
const PLATFORM_COMMANDS = new Set([
  "list_projects",
  "create_ticket",
  "update_ticket",
  "set_ticket_dependencies",
  "post_message",
  "list_tickets",
]);
const CODING_COMMANDS = new Set(["start_run_workspace", "delegate_coding_task"]);
const SOCKET = process.env.ORBITFLOW_TOOL_BROKER_SOCKET?.trim() || null;
const PORT = process.env.ORBITFLOW_TOOL_BROKER_PORT
  ? positiveInteger(process.env.ORBITFLOW_TOOL_BROKER_PORT, "ORBITFLOW_TOOL_BROKER_PORT")
  : null;
if (SOCKET === null && PORT === null) throw new Error("ORBITFLOW_TOOL_BROKER_SOCKET or ORBITFLOW_TOOL_BROKER_PORT is required");
const BROKER_TOKEN = process.env.ORBITFLOW_TOOL_BROKER_TOKEN?.trim() || null;
if (PORT !== null && BROKER_TOKEN === null) {
  throw new Error("ORBITFLOW_TOOL_BROKER_TOKEN is required with ORBITFLOW_TOOL_BROKER_PORT");
}
const REMOTE_CONTEXT = process.env.ORBITFLOW_TOOL_BROKER_REMOTE_CONTEXT === "1";
const EXECUTOR_URL = internalUrl(requiredEnv("ORBITFLOW_CODING_EXECUTOR_URL"));
const EXECUTOR_TOKEN = requiredEnv("ORBITFLOW_CODING_EXECUTOR_TOKEN");
const AGENT_WORKSPACE_ROOT = requiredEnv("ORBITFLOW_AGENT_WORKSPACE_ROOT");
const WORKSPACE_ROOT = requiredEnv("ORBITFLOW_WORKSPACE_ROOT");
const DATABASE_URL = requiredEnv("DATABASE_URL");
const EXECUTION_UID_MIN = 20_000;
const EXECUTION_UID_COUNT = 40_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const DISPATCH_MONITOR_INTERVAL_MS = 100;
const pool = new Pool({ connectionString: DATABASE_URL, application_name: "orbit-tool-broker" });
const executionIdentityStore = createExecutionIdentityStore({
  workspaceRoot: WORKSPACE_ROOT,
  uidMin: EXECUTION_UID_MIN,
  uidCount: EXECUTION_UID_COUNT,
});
const workspaceService = createRunWorkspaceService({
  pool,
  workspaceRoot: WORKSPACE_ROOT,
});
const costEventStore = createCostEventStore({ pool });

if (SOCKET !== null) await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o770 });
await mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o711 });
await mkdir(path.join(WORKSPACE_ROOT, ".orbitflow"), { recursive: true, mode: 0o700 });
await chmod(path.join(WORKSPACE_ROOT, ".orbitflow"), 0o700);
await chmod(WORKSPACE_ROOT, 0o711);

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (!response.destroyed) writeJson(response, 400, failure(error));
  });
});
server.listen(PORT === null ? SOCKET : { port: PORT, host: "0.0.0.0" }, async () => {
  if (SOCKET !== null) {
    await chown(SOCKET, 0, 19_000);
    await chmod(SOCKET, 0o660);
  }
});

async function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { status: "live", service: "tool-broker" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/tool") {
    writeJson(response, 404, { ok: false, error: { code: "not_found", message: "not found" } });
    return;
  }
  if (BROKER_TOKEN !== null && request.headers.authorization !== `Bearer ${BROKER_TOKEN}`) {
    writeJson(response, 401, { ok: false, error: { code: "unauthorized", message: "authorization required" } });
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
  const loaded = REMOTE_CONTEXT
    ? (() => {
        validateOpenClawToolContext(body.context, body.workspace);
        return { context: body.context, workspace: body.workspace };
      })()
    : await loadOpenClawToolContext({
        agentWorkspaceRoot: AGENT_WORKSPACE_ROOT,
        workspace: body.workspace,
      });
  if (stableJson(loaded.context) !== stableJson(body.context)) {
    throw new Error("active dispatch context changed before broker authorization");
  }
  const context = immutableDispatchContext(loaded.context);
  await requireActiveDispatch(context);
  const clientController = new AbortController();
  const cancelForDisconnect = () => {
    if (!response.writableEnded) {
      clientController.abort(new CliFailureError("coding delegation client disconnected"));
    }
  };
  request.once("aborted", cancelForDisconnect);
  response.once("close", cancelForDisconnect);

  try {
    let result;
    if (PLATFORM_COMMANDS.has(body.command)) {
      result = invokePlatformCommand(body.command, body.input, context, loaded.context);
    } else if (body.command === "start_run_workspace") {
      requireExactKeys(body.input, []);
      const workspace = await workspaceService.startRunWorkspace(context.runId);
      await executionIdentityStore.ensure(context.runId, workspace);
      result = { ok: true, result: { workspace } };
    } else {
      requireExactKeys(body.input, ["task"]);
      const workspace = path.join(WORKSPACE_ROOT, `run-${context.runId}`);
      const identity = await executionIdentityStore.require(context.runId, workspace);
      const model = process.env.ORBITFLOW_OPENCODE_MODEL || "openrouter/anthropic/claude-haiku-4.5";
      const dispatchMonitor = monitorActiveDispatch(context, clientController.signal);
      const tool = createCodingTool({
        runId: context.runId,
        agentId: context.agentId,
        workspaceService,
        costEventStore,
        adapterOptions: { model },
        adapterFactory: ({ workspaceAuthority }) => remoteExecutorAdapter({
          context,
          identity,
          model,
          workspaceAuthority,
        }),
      });
      try {
        result = {
          ok: true,
          result: await tool.delegate_coding_task(body.input.task, workspace, {
            signal: dispatchMonitor.signal,
          }),
        };
      } catch (error) {
        result = { ok: false, error: createPublicErrorResponse(error) };
      } finally {
        await dispatchMonitor.stop();
      }
    }
    if (!response.destroyed) writeJson(response, result.ok === true ? 200 : 400, result);
  } finally {
    request.off("aborted", cancelForDisconnect);
    response.off("close", cancelForDisconnect);
  }
}

function remoteExecutorAdapter({ context, identity, model, workspaceAuthority }) {
  return {
    async delegate_coding_task(task, workspace, { signal } = {}) {
      const handle = await workspaceAuthority.resolve(workspace);
      try {
        const workspaceArchive = await createWorkspaceArchive(workspace);
        const result = await executorRequest({
          task,
          runId: context.runId,
          executionUid: identity.uid,
          executionGid: identity.gid,
          model,
          workspaceArchive,
        }, signal);
        if (!result || typeof result !== "object" || typeof result.workspaceArchive !== "string") {
          throw new WorkspaceError("coding executor returned an invalid workspace archive");
        }
        await requireActiveDispatch(context);
        if (!(await workspaceAuthority.assertCurrent(handle))) {
          throw new WorkspaceError("workspace ownership changed during remote coding execution");
        }
        const { workspaceArchive: returnedArchive, ...delegation } = result;
        try {
          await replaceWorkspaceFromArchive(returnedArchive, workspace);
        } catch {
          await workspaceAuthority.containCredentialExposure(handle);
          throw new WorkspaceError("coding executor workspace update failed and was quarantined");
        }
        if (!(await workspaceAuthority.assertCurrent(handle))) {
          throw new WorkspaceError("workspace ownership changed while applying coding output");
        }
        return delegation;
      } catch (error) {
        if (error?.containWorkspace === true) {
          await workspaceAuthority.containCredentialExposure(handle);
        }
        throw error;
      }
    },
  };
}

function monitorActiveDispatch(context, callerSignal) {
  const controller = new AbortController();
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  const cancelFromCaller = () => controller.abort(
    callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new CliFailureError("coding delegation client disconnected"),
  );
  callerSignal.addEventListener("abort", cancelFromCaller, { once: true });
  if (callerSignal.aborted) cancelFromCaller();

  const poll = () => {
    if (stopped || controller.signal.aborted) return;
    inFlight = requireActiveDispatch(context)
      .catch(() => {
        controller.abort(new CliFailureError("coding delegation dispatch lease expired"));
      })
      .finally(() => {
        if (!stopped && !controller.signal.aborted) {
          timer = setTimeout(poll, DISPATCH_MONITOR_INTERVAL_MS);
        }
      });
  };
  timer = setTimeout(poll, DISPATCH_MONITOR_INTERVAL_MS);
  return {
    signal: controller.signal,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", cancelFromCaller);
      await inFlight;
    },
  };
}

function invokePlatformCommand(command, supplied, context, fullContext) {
  const input = buildPlatformCommandInput(command, supplied, context, fullContext);
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

async function executorRequest(payload, signal) {
  if (signal?.aborted) throw cancellationError(signal);
  const operationId = randomUUID();
  const delegation = postExecutor("/v1/delegate", { ...payload, operationId });
  let cancellation = null;
  const cancel = () => {
    cancellation ??= postExecutor("/v1/cancel", { operationId });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const result = await delegation;
    if (cancellation) await cancellation;
    if (signal?.aborted) throw cancellationError(signal);
    return result;
  } catch (error) {
    if (cancellation) await cancellation;
    if (signal?.aborted) throw cancellationError(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

async function postExecutor(requestPath, payload) {
  const response = await fetch(`${EXECUTOR_URL}${requestPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${EXECUTOR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const contents = await readResponse(response, 12 * 1024 * 1024);
  const value = JSON.parse(contents);
  if (response.ok && value.ok === true) return value.result;
  throw Object.assign(new Error(value.error?.message ?? "coding executor failed"), value.error);
}

async function readResponse(response, limit) {
  let contents = "";
  if (!response.body) throw new Error("coding executor returned an empty response");
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    contents += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(contents) > limit) throw new Error("coding executor response is too large");
  }
  contents += decoder.decode();
  return contents;
}

function cancellationError(signal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new CliFailureError("coding delegation was cancelled");
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

function internalUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ORBITFLOW_CODING_EXECUTOR_URL must use http or https");
  }
  return value.replace(/\/$/, "");
}

function positiveInteger(value, field) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is too large`);
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

process.on("SIGTERM", () => server.close(() => pool.end().finally(() => process.exit(0))));
