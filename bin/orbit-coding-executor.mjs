#!/usr/bin/env node

import { chmod, lstat, mkdir, readFile, realpath, rename } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createOpenCodeAdapter } from "../coding-adapter/src/openCodeAdapter.js";
import { createPublicErrorResponse, CliFailureError } from "../coding-adapter/src/errors.js";

const SOCKET = requiredEnv("ORBITFLOW_CODING_EXECUTOR_SOCKET");
const WORKSPACE_ROOT = requiredEnv("ORBITFLOW_WORKSPACE_ROOT");
const IDENTITY_ROOT = path.join(WORKSPACE_ROOT, ".orbitflow", "executor-identities");
const QUARANTINE_ROOT = path.join(WORKSPACE_ROOT, ".orbitflow", "executor-quarantine");
const MAX_REQUEST_BYTES = 64 * 1024;

await mkdir(path.dirname(SOCKET), { recursive: true, mode: 0o700 });
await mkdir(QUARANTINE_ROOT, { recursive: true, mode: 0o700 });
const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    writeJson(response, 400, { ok: false, error: createPublicErrorResponse(error) });
  });
});
server.listen(SOCKET, async () => {
  await chmod(SOCKET, 0o600);
});

async function handleRequest(request, response) {
  if (request.method !== "POST" || request.url !== "/v1/delegate") {
    writeJson(response, 404, { ok: false, error: { code: "invalid_request", message: "not found" } });
    return;
  }
  const body = await readJson(request, MAX_REQUEST_BYTES);
  requireExactKeys(body, ["executionGid", "executionUid", "model", "runId", "task", "workspace"]);
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
  try {
    const result = await adapter.delegate_coding_task(body.task, body.workspace);
    writeJson(response, 200, { ok: true, result });
  } catch (error) {
    writeJson(response, 400, { ok: false, error: createPublicErrorResponse(error) });
  }
}

async function executionAuthority(request) {
  if (typeof request.runId !== "string" || !/^[1-9][0-9]*$/.test(request.runId)) {
    throw new CliFailureError("coding executor run id is invalid");
  }
  if (typeof request.model !== "string" || request.model.trim() === "") {
    throw new CliFailureError("coding executor model is invalid");
  }
  if (!Number.isSafeInteger(request.executionUid) || request.executionUid < 20_000 || request.executionUid >= 60_000 || request.executionGid !== request.executionUid) {
    throw new CliFailureError("coding executor identity is invalid");
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
        return candidate === handle && String(current.dev) === handle.workspaceDevice && String(current.ino) === handle.workspaceInode && current.uid === request.executionUid;
      } catch {
        return false;
      }
    },
    async containCredentialExposure(candidate) {
      if (!(await this.assertCurrent(candidate))) throw new Error("workspace identity changed");
      await rename(expectedWorkspace, path.join(QUARANTINE_ROOT, `run-${request.runId}-${Date.now()}`));
    },
  };
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
