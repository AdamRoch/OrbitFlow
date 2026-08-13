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

await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o770 });
await mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o711 });
await mkdir(path.join(WORKSPACE_ROOT, ".orbitflow"), { recursive: true, mode: 0o700 });
await chmod(path.join(WORKSPACE_ROOT, ".orbitflow"), 0o700);
await chmod(WORKSPACE_ROOT, 0o711);

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (!response.destroyed) writeJson(response, 400, failure(error));
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
        const result = await executorRequest({
          task,
          workspace,
          runId: context.runId,
          executionUid: identity.uid,
          executionGid: identity.gid,
          model,
          workspaceIdentity: immutableWorkspaceIdentity(handle),
        }, signal);
        await requireActiveDispatch(context);
        if (!(await workspaceAuthority.assertCurrent(handle))) {
          throw new WorkspaceError("workspace ownership changed during remote coding execution");
        }
        return result;
      } catch (error) {
        if (error?.containWorkspace === true) {
          await workspaceAuthority.containCredentialExposure(handle);
        }
        throw error;
      }
    },
  };
}

function immutableWorkspaceIdentity(handle) {
  return {
    workspaceId: handle.workspaceId,
    workspaceDevice: handle.record.workspaceDevice,
    workspaceInode: handle.record.workspaceInode,
    gitDevice: handle.record.gitDevice,
    gitInode: handle.record.gitInode,
    markerDevice: handle.record.markerDevice,
    markerInode: handle.record.markerInode,
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

function postExecutor(requestPath, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: EXECUTOR_SOCKET,
      path: requestPath,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

process.on("SIGTERM", () => server.close(() => pool.end().finally(() => process.exit(0))));
