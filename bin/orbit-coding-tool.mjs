#!/usr/bin/env node

import pg from "pg";
import {
  createCodingTool,
  createCostEventStore,
  createRunWorkspaceService,
} from "../coding-adapter/src/index.js";
import {
  createPublicErrorResponse,
  InvalidRequestError,
} from "../coding-adapter/src/errors.js";

const { Pool } = pg;
const MAX_REQUEST_BYTES = 1024 * 1024;

let pool;
try {
  const request = await readRequest(process.stdin);
  const databaseUrl = requiredEnv("DATABASE_URL");
  const workspaceRoot = requiredEnv("ORBITFLOW_WORKSPACE_ROOT");
  pool = new Pool({ connectionString: databaseUrl, application_name: "orbit-coding-tool" });
  const workspaceService = createRunWorkspaceService({ pool, workspaceRoot });

  let result;
  if (request.command === "start_run_workspace") {
    requireExactKeys(request, ["command", "runId"]);
    result = { workspace: await workspaceService.startRunWorkspace(request.runId) };
  } else if (request.command === "delegate_coding_task") {
    requireExactKeys(request, ["command", "task", "workspace"]);
    const runId = requiredEnv("ORBITFLOW_RUN_ID");
    const agentId = requiredEnv("ORBITFLOW_AGENT_ID");
    const costEventStore = createCostEventStore({ pool });
    const timeoutMs = optionalPositiveInteger(
      process.env.ORBITFLOW_CODING_TIMEOUT_MS,
      "ORBITFLOW_CODING_TIMEOUT_MS",
    );
    const adapterOptions = {
      env: process.env,
      ...(process.env.ORBITFLOW_OPENCODE_BINARY
        ? { binary: process.env.ORBITFLOW_OPENCODE_BINARY }
        : {}),
      ...(process.env.ORBITFLOW_OPENCODE_MODEL
        ? { model: process.env.ORBITFLOW_OPENCODE_MODEL }
        : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    const tool = createCodingTool({
      runId,
      agentId,
      workspaceService,
      costEventStore,
      adapterOptions,
    });
    result = await tool.delegate_coding_task(request.task, request.workspace);
  } else {
    throw new InvalidRequestError("unknown coding-tool command");
  }
  writeResponse({ ok: true, result });
} catch (error) {
  writeResponse({ ok: false, error: createPublicErrorResponse(error) });
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
    } catch {}
  }
}

async function readRequest(stream) {
  let contents = "";
  for await (const chunk of stream) {
    contents += chunk;
    if (Buffer.byteLength(contents) > MAX_REQUEST_BYTES) {
      throw new InvalidRequestError("coding-tool request is too large");
    }
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new InvalidRequestError("coding-tool request must be one JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError("coding-tool request must be one JSON object");
  }
  return value;
}

function requireExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InvalidRequestError("coding-tool request has unexpected fields");
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new InvalidRequestError(`${name} is required`);
  return value;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidRequestError(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidRequestError(`${name} is too large`);
  return parsed;
}

function writeResponse(value) {
  let serialized = JSON.stringify(value);
  const credential = process.env.OPENROUTER_API_KEY;
  for (const secret of credentialVariants(credential)) {
    serialized = serialized.split(secret).join("[REDACTED]");
  }
  process.stdout.write(`${serialized}\n`);
}

function credentialVariants(credential) {
  if (!credential) return [];
  const bytes = Buffer.from(credential);
  const base64 = bytes.toString("base64");
  const percentEncoded = [...bytes]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  const variants = new Set([
    credential,
    base64,
    base64.replace(/=+$/, ""),
    base64.replaceAll("+", "-").replaceAll("/", "_"),
    base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    percentEncoded,
    percentEncoded.toUpperCase(),
    encodeURIComponent(credential),
    new URLSearchParams({ credential }).toString().slice("credential=".length),
  ]);
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}
