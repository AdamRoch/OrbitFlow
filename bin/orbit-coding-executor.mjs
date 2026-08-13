#!/usr/bin/env node

import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createOpenCodeAdapter } from "../coding-adapter/src/openCodeAdapter.js";
import { createPublicErrorResponse, CliFailureError } from "../coding-adapter/src/errors.js";

const SOCKET = requiredEnv("ORBITFLOW_CODING_EXECUTOR_SOCKET");
const WORKSPACE_ROOT = requiredEnv("ORBITFLOW_WORKSPACE_ROOT");
const IDENTITY_ROOT = path.join(WORKSPACE_ROOT, ".orbitflow", "executor-identities");
const MAX_REQUEST_BYTES = 64 * 1024;
const operations = new Map();
const pendingCancellations = new Set();

await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (!response.destroyed) {
      writeJson(response, 400, { ok: false, error: createPublicErrorResponse(error) });
    }
  });
});
server.listen(SOCKET, async () => {
  await chmod(SOCKET, 0o600);
});

async function handleRequest(request, response) {
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
    "workspace",
    "workspaceIdentity",
  ]);
  requireOperationId(body.operationId);
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
  try {
    const authority = await executionAuthority(body);
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
    const result = await adapter.delegate_coding_task(body.task, body.workspace, {
      signal: controller.signal,
    });
    if (!response.destroyed) writeJson(response, 200, { ok: true, result });
  } catch (error) {
    const payload = createPublicErrorResponse(error);
    if (error?.containWorkspace === true) {
      payload.containWorkspace = true;
    }
    if (!response.destroyed) writeJson(response, 400, { ok: false, error: payload });
  } finally {
    request.off("aborted", cancelForDisconnect);
    response.off("close", cancelForDisconnect);
    operations.delete(body.operationId);
    finishOperation();
  }
}

async function executionAuthority(request) {
  if (typeof request.runId !== "string" || !/^[1-9][0-9]*$/.test(request.runId)) {
    throw new CliFailureError("coding executor run id is invalid");
  }
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new CliFailureError("coding executor model is invalid");
  }
  if (
    !Number.isSafeInteger(request.executionUid) ||
    request.executionUid < 20_000 ||
    request.executionUid >= 60_000 ||
    request.executionGid !== request.executionUid
  ) {
    throw new CliFailureError("coding executor identity is invalid");
  }
  requireExactKeys(request.workspaceIdentity, [
    "gitDevice",
    "gitInode",
    "markerDevice",
    "markerInode",
    "workspaceDevice",
    "workspaceId",
    "workspaceInode",
  ]);
  for (const field of [
    "gitDevice",
    "gitInode",
    "markerDevice",
    "markerInode",
    "workspaceDevice",
    "workspaceInode",
  ]) {
    if (!/^\d+$/.test(request.workspaceIdentity[field] ?? "")) {
      throw new CliFailureError("coding executor workspace identity is invalid");
    }
  }
  if (
    typeof request.workspaceIdentity.workspaceId !== "string" ||
    request.workspaceIdentity.workspaceId === ""
  ) {
    throw new CliFailureError("coding executor workspace identity is invalid");
  }
  const expectedWorkspace = path.join(WORKSPACE_ROOT, `run-${request.runId}`);
  if (request.workspace !== expectedWorkspace || await realpath(request.workspace) !== expectedWorkspace) {
    throw new CliFailureError("coding executor workspace is invalid");
  }
  const identity = JSON.parse(await readFile(path.join(IDENTITY_ROOT, `run-${request.runId}.json`), "utf8"));
  const stat = await lstat(expectedWorkspace);
  if (
    identity.version !== 1 ||
    identity.runId !== request.runId ||
    identity.workspace !== expectedWorkspace ||
    identity.workspaceDevice !== String(stat.dev) ||
    identity.workspaceInode !== String(stat.ino) ||
    request.workspaceIdentity.workspaceDevice !== String(stat.dev) ||
    request.workspaceIdentity.workspaceInode !== String(stat.ino) ||
    identity.uid !== request.executionUid ||
    identity.gid !== request.executionGid ||
    stat.uid !== request.executionUid ||
    stat.gid !== request.executionGid
  ) {
    throw new CliFailureError("coding executor workspace identity changed");
  }
  const handle = {
    workspace: expectedWorkspace,
    workspaceDevice: String(stat.dev),
    workspaceInode: String(stat.ino),
  };
  return {
    async resolve(workspace) {
      if (workspace !== expectedWorkspace) throw new CliFailureError("coding executor workspace changed");
      return handle;
    },
    async assertCurrent(candidate) {
      try {
        const current = await lstat(expectedWorkspace);
        return (
          candidate === handle &&
          String(current.dev) === handle.workspaceDevice &&
          String(current.ino) === handle.workspaceInode &&
          current.uid === request.executionUid
        );
      } catch {
        return false;
      }
    },
    async containCredentialExposure(candidate) {
      if (!(await this.assertCurrent(candidate))) throw new Error("workspace identity changed");
    },
  };
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
  if (!/^[1-9][0-9]*$/.test(value)) throw new CliFailureError("coding timeout is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CliFailureError("coding timeout is invalid");
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}
