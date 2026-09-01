import { spawn, type ChildProcess } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeOpenClawWorkspace, type OpenClawWorkspaceAgent } from "../lib/runtime/openclaw-workspace.ts";
import type { JsonObject } from "../lib/postgres/message-bus.ts";

const TOKEN = requiredEnv("ORBITFLOW_RUNTIME_RPC_TOKEN");
const PORT = positiveInteger(process.env.ORBITFLOW_RUNTIME_RPC_PORT ?? "3004", "ORBITFLOW_RUNTIME_RPC_PORT");
const RUNTIME_ROOT = path.resolve(process.env.ORBITFLOW_RUNTIME_ROOT ?? "/var/lib/orbitflow/runtime");
const STATE_DIRECTORY = process.env.OPENCLAW_STATE_DIR?.trim() || "/home/node/.openclaw";
const OPENCLAW_COMMAND = process.env.ORBITFLOW_OPENCLAW_COMMAND?.trim() || process.execPath;
const OPENCLAW_ARGUMENTS = process.env.ORBITFLOW_OPENCLAW_COMMAND
  ? []
  : [process.env.ORBITFLOW_OPENCLAW_MODULE?.trim() || "/opt/openclaw/openclaw.mjs"];
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const OPENCLAW_METHODS = new Set([
  "agents.list",
  "agents.create",
  "agents.update",
  "sessions.resolve",
  "sessions.abort",
  "agent",
]);
const activeCommands = new Set<ChildProcess>();

await mkdir(path.join(RUNTIME_ROOT, "workspaces"), { recursive: true, mode: 0o700 });

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (!response.destroyed) {
      const status = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 400;
      writeJson(response, status, {
        ok: false,
        error: { code: "invalid_request", message: safeMessage(error) },
      });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`OrbitFlow OpenClaw runtime RPC listening on ${PORT}\n`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/healthz") {
    writeJson(response, 200, { status: "live", service: "openclaw-runtime" });
    return;
  }
  if (request.method === "GET" && request.url === "/readyz") {
    const result = await runGatewayCommand(
      ["gateway", "call", "health", "--params", "{}", "--timeout", "8000", "--json"],
      8_000,
    );
    if (result.exitCode === 0 && !result.timedOut && !result.terminated) {
      writeJson(response, 200, { status: "ready", service: "openclaw-runtime" });
    } else {
      writeJson(response, 503, { status: "not_ready", service: "openclaw-runtime" });
    }
    return;
  }
  if (!request.url?.startsWith("/v1/")) {
    writeJson(response, 404, { ok: false, error: { code: "not_found", message: "not found" } });
    return;
  }
  requireAuthorization(request);
  if (request.method !== "POST") {
    writeJson(response, 405, { ok: false, error: { code: "method_not_allowed", message: "method not allowed" } });
    return;
  }
  const body = await readJson(request, MAX_REQUEST_BYTES);
  if (request.url === "/v1/sync-agent") {
    requireExactKeys(body, ["agent", "openclawRef", "toolContext", "workspaceTools"]);
    const result = await synchronizeAgent(body, request, response);
    if (!response.destroyed) writeJson(response, 200, { ok: true, result });
    return;
  }
  if (request.url === "/v1/gateway") {
    requireAllowedKeys(body, ["activeAgentRef", "activeRunId", "activeSessionKey", "arguments", "timeoutMs"]);
    if (!Array.isArray(body.arguments) || body.arguments.length === 0 || body.arguments.some((value) => typeof value !== "string")) {
      throw new Error("gateway arguments are invalid");
    }
    if (
      typeof body.timeoutMs !== "number" ||
      !Number.isSafeInteger(body.timeoutMs) ||
      body.timeoutMs < 50 ||
      body.timeoutMs > 30 * 60 * 1_000
    ) {
      throw new Error("gateway timeoutMs is invalid");
    }
    validateGatewayArguments(body.arguments);
    const controller = new AbortController();
    const cancelForDisconnect = () => controller.abort();
    request.once("aborted", cancelForDisconnect);
    response.once("close", cancelForDisconnect);
    try {
      const result = await runGatewayCommand(body.arguments, body.timeoutMs as number, controller.signal);
      if (!response.destroyed) writeJson(response, 200, { ok: true, result });
    } finally {
      request.off("aborted", cancelForDisconnect);
      response.off("close", cancelForDisconnect);
    }
    return;
  }
  writeJson(response, 404, { ok: false, error: { code: "not_found", message: "not found" } });
}

async function synchronizeAgent(
  body: Record<string, unknown>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<JsonObject> {
  const agent = body.agent;
  if (!isObject(agent)) throw new Error("agent snapshot is invalid");
  requireExactKeys(agent, ["id", "memory", "model", "name", "role", "system_prompt"]);
  for (const field of ["id", "model", "name", "role", "system_prompt"]) {
    if (typeof agent[field] !== "string" || agent[field].trim() === "") {
      throw new Error("agent snapshot is invalid");
    }
  }
  if (!isObject(agent.memory)) throw new Error("agent memory is invalid");
  if (typeof body.openclawRef !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.openclawRef)) {
    throw new Error("openclawRef is invalid");
  }
  if (body.workspaceTools !== null && typeof body.workspaceTools !== "string") {
    throw new Error("workspaceTools is invalid");
  }
  if (body.toolContext !== null && !isObject(body.toolContext)) {
    throw new Error("toolContext is invalid");
  }
  const workspace = path.join(RUNTIME_ROOT, "workspaces", body.openclawRef);
  await writeOpenClawWorkspace(
    workspace,
    agent as unknown as OpenClawWorkspaceAgent,
    body.workspaceTools as string | null,
    body.toolContext as JsonObject | null,
  );
  if (request.aborted || response.destroyed) throw new Error("runtime client disconnected");

  const listed = await gatewayJson("agents.list", {});
  if (!isObject(listed) || !Array.isArray(listed.agents)) throw new Error("agents.list response is invalid");
  const entries = listed.agents;
  const index = entries.findIndex((entry) => isObject(entry) && entry.id === body.openclawRef);
  const created = index === -1;
  if (created) {
    const createdAgent = await gatewayJson("agents.create", {
      name: body.openclawRef,
      workspace,
      model: agent.model,
    });
    if (!isObject(createdAgent) || createdAgent.ok !== true || createdAgent.agentId !== body.openclawRef) {
      throw new Error("agents.create response is invalid");
    }
  }
  const entry = created ? null : entries[index];
  const configuredWorkspace = isObject(entry) && typeof entry.workspace === "string" ? entry.workspace : "";
  const configuredModel = isObject(entry) && isObject(entry.model) && typeof entry.model.primary === "string"
    ? entry.model.primary
    : "";
  const configuredName = isObject(entry) && typeof entry.name === "string"
    ? entry.name
    : isObject(entry) && isObject(entry.identity) && typeof entry.identity.name === "string"
      ? entry.identity.name
      : "";
  if (created || configuredWorkspace !== workspace || configuredModel !== agent.model || configuredName !== agent.name) {
    const updatedAgent = await gatewayJson("agents.update", {
      agentId: body.openclawRef,
      name: agent.name,
      workspace,
      model: agent.model,
    });
    if (!isObject(updatedAgent) || updatedAgent.ok !== true || updatedAgent.agentId !== body.openclawRef) {
      throw new Error("agents.update response is invalid");
    }
  }
  return {
    agentId: agent.id as string,
    openclawRef: body.openclawRef as string,
    workspace,
    created,
  };
}

async function gatewayJson(method: string, params: JsonObject): Promise<unknown> {
  const result = await runGatewayCommand(
    ["gateway", "call", method, "--params", JSON.stringify(params), "--timeout", "30000", "--json"],
    30_000,
  );
  if (result.exitCode !== 0 || result.timedOut || result.terminated) throw new Error("OpenClaw gateway call failed");
  try {
    return parseJsonDocument(result.stdout);
  } catch {
    throw new Error("OpenClaw gateway returned invalid JSON");
  }
}

function validateGatewayArguments(arguments_: string[]): void {
  const args = arguments_[0] === "--no-color" ? arguments_.slice(1) : arguments_;
  if (args.length === 1 && args[0] === "--version") return;
  if (args[0] !== "gateway" || args[1] !== "call") throw new Error("unsupported OpenClaw command");
  const method = args[2];
  if (!OPENCLAW_METHODS.has(method ?? "")) throw new Error("unsupported OpenClaw gateway method");
  if (args[3] !== "--params" || args[5] !== "--timeout" || args[7] !== "--json") {
    throw new Error("unsupported OpenClaw gateway arguments");
  }
  if (args.length !== 8 && !(args.length === 9 && args[8] === "--expect-final")) {
    throw new Error("unsupported OpenClaw gateway arguments");
  }
  const params = JSON.parse(args[4] ?? "null") as unknown;
  if (!isObject(params)) throw new Error("OpenClaw gateway params are invalid");
  if (!/^\d+$/.test(args[6] ?? "")) throw new Error("OpenClaw gateway timeout is invalid");
}

function runGatewayCommand(
  arguments_: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderrBytes: 0, timedOut: false, terminated: true });
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCLAW_COMMAND, [...OPENCLAW_ARGUMENTS, "--no-color", ...arguments_], {
      cwd: RUNTIME_ROOT,
      env: {
        HOME: process.env.HOME || "/home/node",
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        OPENCLAW_STATE_DIR: STATE_DIRECTORY,
        OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789",
        OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
        NO_COLOR: "1",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeCommands.add(child);
    let stdout = "";
    let stderrBytes = 0;
    let timedOut = false;
    let terminated = false;
    let settled = false;
    const kill = (timeout: boolean) => {
      timedOut ||= timeout;
      terminated ||= !timeout;
      if (child.pid && child.exitCode === null) {
        try {
          process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    };
    const timer = setTimeout(() => kill(true), timeoutMs);
    const abort = () => kill(false);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) kill(false);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) kill(false);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      activeCommands.delete(child);
      reject(error);
    });
    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      activeCommands.delete(child);
      resolve({ exitCode, signal: exitSignal, stdout, stderrBytes, timedOut, terminated });
    });
  });
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrBytes: number;
  timedOut: boolean;
  terminated: boolean;
}

function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
  }
  throw new Error("JSON document not found");
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  let contents = "";
  for await (const chunk of request) {
    contents += chunk;
    if (Buffer.byteLength(contents) > limit) throw new Error("request is too large");
  }
  const value = JSON.parse(contents) as unknown;
  if (!isObject(value)) throw new Error("request must be one JSON object");
  return value;
}

function requireAuthorization(request: IncomingMessage): void {
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    const error = new Error("authorization required");
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
}

function requireExactKeys(value: Record<string, unknown>, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error("request has unexpected fields");
  }
}

function requireAllowedKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("request has unexpected fields");
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${field} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} is too large`);
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 256);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function shutdown(): Promise<void> {
  for (const child of activeCommands) {
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0));
  });
}
