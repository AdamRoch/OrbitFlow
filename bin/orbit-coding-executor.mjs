#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createOpenCodeAdapter } from "../coding-adapter/src/openCodeAdapter.js";
import { createPublicErrorResponse, CliFailureError } from "../coding-adapter/src/errors.js";
import { runSafeGit } from "../coding-adapter/src/git.js";
import {
  createWorkspaceArchive,
  extractWorkspaceArchive,
} from "../src/lib/runtime/workspace-archive.mjs";

const PORT = positiveInteger(requiredEnv("ORBITFLOW_CODING_EXECUTOR_PORT"));
const TOKEN = requiredEnv("ORBITFLOW_CODING_EXECUTOR_TOKEN");
const EXECUTOR_ROOT = path.resolve(
  process.env.ORBITFLOW_CODING_EXECUTOR_ROOT?.trim() || "/tmp/orbitflow-coding-executor",
);
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const operations = new Map();
const pendingCancellations = new Set();

await mkdir(EXECUTOR_ROOT, { recursive: true, mode: 0o700 });
const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (!response.destroyed) {
      writeJson(response, 400, { ok: false, error: createPublicErrorResponse(error) });
    }
  });
});
server.listen(PORT, "0.0.0.0");

async function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { status: "live", service: "coding-executor" });
    return;
  }
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    writeJson(response, 401, { ok: false, error: { code: "unauthorized", message: "authorization required" } });
    return;
  }
  if (request.method !== "POST" || !["/v1/delegate", "/v1/cancel"].includes(request.url)) {
    writeJson(response, 404, { ok: false, error: { code: "invalid_request", message: "not found" } });
    return;
  }
  const body = await readJson(request, MAX_REQUEST_BYTES);
  if (request.url === "/v1/cancel") {
    requireExactKeys(body, ["operationId"]);
    requireOperationId(body.operationId);
    const operation = operations.get(body.operationId);
    if (operation) {
      operation.controller.abort(new CliFailureError("coding delegation was cancelled"));
      await operation.done;
    } else {
      pendingCancellations.add(body.operationId);
      setTimeout(() => pendingCancellations.delete(body.operationId), 30_000).unref();
    }
    if (!response.destroyed) writeJson(response, 200, { ok: true, result: { cancelled: true } });
    return;
  }

  requireExactKeys(body, [
    "executionGid",
    "executionUid",
    "model",
    "operationId",
    "runId",
    "task",
    "workspaceArchive",
  ]);
  validateDelegation(body);
  if (operations.has(body.operationId)) throw new CliFailureError("coding operation already exists");
  const controller = new AbortController();
  let finishOperation;
  const done = new Promise((resolve) => {
    finishOperation = resolve;
  });
  operations.set(body.operationId, { controller, done });
  if (pendingCancellations.delete(body.operationId)) {
    controller.abort(new CliFailureError("coding delegation was cancelled"));
  }
  const cancelForDisconnect = () => {
    if (!response.writableEnded) {
      controller.abort(new CliFailureError("coding broker disconnected"));
    }
  };
  request.once("aborted", cancelForDisconnect);
  response.once("close", cancelForDisconnect);
  let operationRoot = null;
  try {
    operationRoot = await mkdtemp(path.join(EXECUTOR_ROOT, "operation-"));
    const workspace = path.join(operationRoot, "workspace");
    const gitHome = path.join(operationRoot, "git-home");
    await mkdir(gitHome, { mode: 0o700 });
    await extractWorkspaceArchive(body.workspaceArchive, workspace);
    initializeGitWorkspace(workspace, gitHome);
    const authority = await executionAuthority(workspace);
    const adapter = createOpenCodeAdapter({
      env: process.env,
      ...(process.env.ORBITFLOW_OPENCODE_BINARY ? { binary: process.env.ORBITFLOW_OPENCODE_BINARY } : {}),
      model: body.model,
      ...(process.env.ORBITFLOW_CODING_TIMEOUT_MS
        ? { timeoutMs: positiveInteger(process.env.ORBITFLOW_CODING_TIMEOUT_MS) }
        : {}),
      executionIdentity: { uid: body.executionUid, gid: body.executionGid },
      workspaceAuthority: authority,
    });
    const result = await adapter.delegate_coding_task(body.task, workspace, {
      signal: controller.signal,
    });
    const workspaceArchive = await createWorkspaceArchive(workspace);
    if (!response.destroyed) {
      writeJson(response, 200, { ok: true, result: { ...result, workspaceArchive } });
    }
  } catch (error) {
    const payload = createPublicErrorResponse(error);
    if (error?.containWorkspace === true) payload.containWorkspace = true;
    if (!response.destroyed) writeJson(response, 400, { ok: false, error: payload });
  } finally {
    request.off("aborted", cancelForDisconnect);
    response.off("close", cancelForDisconnect);
    operations.delete(body.operationId);
    finishOperation();
    if (operationRoot !== null) await rm(operationRoot, { recursive: true, force: true });
  }
}

function validateDelegation(request) {
  requireOperationId(request.operationId);
  if (typeof request.runId !== "string" || !/^[1-9][0-9]*$/.test(request.runId)) {
    throw new CliFailureError("coding executor run id is invalid");
  }
  if (typeof request.task !== "string" || request.task.trim() === "") {
    throw new CliFailureError("coding executor task is invalid");
  }
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new CliFailureError("coding executor model is invalid");
  }
  if (typeof request.workspaceArchive !== "string" || request.workspaceArchive === "") {
    throw new CliFailureError("coding executor workspace archive is invalid");
  }
  if (
    !Number.isSafeInteger(request.executionUid) ||
    request.executionUid < 20_000 ||
    request.executionUid >= 60_000 ||
    request.executionGid !== request.executionUid
  ) {
    throw new CliFailureError("coding executor identity is invalid");
  }
}

async function executionAuthority(workspace) {
  const canonical = await realpath(workspace);
  const initial = await lstat(canonical);
  if (canonical !== workspace || !initial.isDirectory() || initial.isSymbolicLink()) {
    throw new CliFailureError("coding executor workspace is invalid");
  }
  const handle = { workspace, device: String(initial.dev), inode: String(initial.ino) };
  return {
    async resolve(candidate) {
      if (candidate !== workspace) throw new CliFailureError("coding executor workspace changed");
      return handle;
    },
    async assertCurrent(candidate) {
      try {
        const current = await lstat(workspace);
        return candidate === handle && String(current.dev) === handle.device && String(current.ino) === handle.inode;
      } catch {
        return false;
      }
    },
    async containCredentialExposure(candidate) {
      if (!(await this.assertCurrent(candidate))) throw new Error("workspace identity changed");
    },
  };
}

function initializeGitWorkspace(workspace, home) {
  runSafeGit(["init", "-q"], { cwd: workspace, home });
  runSafeGit(["add", "-A"], { cwd: workspace, home });
  runSafeGit(
    [
      "-c",
      "user.email=workspace@orbitflow.local",
      "-c",
      "user.name=orbitflow-workspace",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "Import delegated workspace",
    ],
    { cwd: workspace, home },
  );
}

function requireOperationId(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new CliFailureError("coding operation id is invalid");
  }
}

async function readJson(request, limit) {
  let contents = "";
  for await (const chunk of request) {
    contents += chunk;
    if (Buffer.byteLength(contents) > limit) throw new CliFailureError("coding executor request is too large");
  }
  return JSON.parse(contents);
}

function requireExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliFailureError("coding executor request is invalid");
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new CliFailureError("coding executor request has unexpected fields");
  }
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/.test(value)) throw new CliFailureError("coding executor integer is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliFailureError("coding executor integer is invalid");
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}
