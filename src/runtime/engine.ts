import http from "node:http";
import path from "node:path";
import pg from "pg";
import { startWorkflowEngine } from "../lib/postgres/workflow-engine.ts";
import { OpenClawEngineAdapter } from "../lib/runtime/engine-adapter.ts";
import { OpenClawRuntimeAdapter } from "../lib/runtime/openclaw.ts";

const { Pool } = pg;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the production engine`);
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is too large`);
  return parsed;
}

const databaseUrl = requiredEnvironment("DATABASE_URL");
const runtimeRoot = path.resolve(process.env.ORBITFLOW_RUNTIME_ROOT ?? "/var/lib/orbitflow/runtime");
const openClawCommand = process.env.ORBITFLOW_OPENCLAW_COMMAND ?? process.execPath;
const openClawArguments = process.env.ORBITFLOW_OPENCLAW_COMMAND
  ? []
  : [process.env.ORBITFLOW_OPENCLAW_MODULE ?? "/opt/openclaw/openclaw.mjs"];
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "orbitfactory-production-engine",
  max: positiveIntegerEnvironment("ORBITFLOW_ENGINE_DB_POOL_SIZE", 12),
});

// The child allowlist remains explicit. The OpenClaw CLI gets gateway
// connection data; only its intentionally invoked coding tool gets the
// provider key and attributed run/workspace variables.
process.env.ORBITFLOW_PLATFORM_DATABASE_URL = databaseUrl;
process.env.ORBITFLOW_WORKSPACE_ROOT ??= "/var/lib/orbitflow/run-workspaces";
const allowedExecEnvironment = [
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "ORBITFLOW_AGENT_ID",
  "ORBITFLOW_OPENCODE_BINARY",
  "ORBITFLOW_OPENCODE_MODEL",
  "ORBITFLOW_PLATFORM_DATABASE_URL",
  "ORBITFLOW_RUN_ID",
  "ORBITFLOW_WORKSPACE_ROOT",
];
const gatewayEnvironment = {
  OPENCLAW_GATEWAY_URL: requiredEnvironment("OPENCLAW_GATEWAY_URL"),
  OPENCLAW_GATEWAY_TOKEN: requiredEnvironment("OPENCLAW_GATEWAY_TOKEN"),
};

const openclaw = new OpenClawRuntimeAdapter({
  pool,
  runtimeRoot,
  openClawCommand,
  openClawCommandArguments: openClawArguments,
  wakeTimeoutMs: positiveIntegerEnvironment("ORBITFLOW_OPENCLAW_WAKE_TIMEOUT_MS", 300_000),
  allowedExecEnvironment,
  gatewayEnvironment,
});
const runtime = new OpenClawEngineAdapter({ pool, openclaw });

let state: "starting" | "operational" | "failed" | "stopping" = "starting";
let failure = "";
const worker = startWorkflowEngine(pool, runtime, {
  consumerId: process.env.ORBITFLOW_ENGINE_CONSUMER_ID ?? "compose-engine",
  dispatcherId: process.env.ORBITFLOW_ENGINE_DISPATCHER_ID ?? "compose-engine",
  pollIntervalMs: positiveIntegerEnvironment("ORBITFLOW_ENGINE_POLL_INTERVAL_MS", 100),
  retryIntervalMs: positiveIntegerEnvironment("ORBITFLOW_ENGINE_RETRY_INTERVAL_MS", 250),
  dispatchLeaseMs: positiveIntegerEnvironment("ORBITFLOW_ENGINE_DISPATCH_LEASE_MS", 300_000),
});

void worker.ready.then(() => {
  state = "operational";
  process.stdout.write("OrbitFlow production workflow engine is operational\n");
}).catch((error: unknown) => {
  state = "failed";
  failure = error instanceof Error ? error.message : "unknown startup failure";
});
void worker.done.catch((error: unknown) => {
  state = "failed";
  failure = error instanceof Error ? error.message : "unknown worker failure";
  process.stderr.write(`OrbitFlow workflow engine stopped: ${failure}\n`);
});

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/healthz") {
    response.writeHead(200);
    response.end(`${JSON.stringify({ status: "live", workflowEngine: state })}\n`);
    return;
  }
  if (request.url === "/readyz") {
    if (state !== "operational") {
      response.writeHead(503);
      response.end(`${JSON.stringify({ status: "not_ready", workflowEngine: state })}\n`);
      return;
    }
    try {
      await pool.query("SELECT 1");
      response.writeHead(200);
      response.end(`${JSON.stringify({ status: "ready", workflowEngine: "operational" })}\n`);
    } catch {
      response.writeHead(503);
      response.end(`${JSON.stringify({ status: "not_ready", workflowEngine: "dependency_unreachable" })}\n`);
    }
    return;
  }
  response.writeHead(404);
  response.end('{"error":"not_found"}\n');
});

server.listen(3001, "0.0.0.0", () => {
  process.stdout.write("OrbitFlow engine health server listening on 3001\n");
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  state = "stopping";
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().then(() => process.exit(0), (error: unknown) => {
      process.stderr.write(`Engine shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exit(1);
    });
  });
}
