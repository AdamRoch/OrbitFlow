#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const stateDirectory = process.env.OPENCLAW_STATE_DIR;
if (!stateDirectory) process.exit(90);

await mkdir(stateDirectory, { recursive: true });
const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--no-color");
const agentsPath = path.join(stateDirectory, "fake-agents.json");
const planPath = path.join(stateDirectory, "fake-plan.json");
const requestsPath = path.join(stateDirectory, "fake-requests.ndjson");
const counterPath = path.join(stateDirectory, "fake-turn-counter.txt");
const sessionsPathFor = (agentId) =>
  path.join(stateDirectory, `fake-sessions-${agentId}.json`);
const forbiddenEnvironmentNames = [
  "OPENROUTER_API_KEY",
  "ORBITFLOW_EXFIL_SENTINEL",
  "AWS_SECRET_ACCESS_KEY",
  "DATABASE_URL",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function record(command, details = {}) {
  await appendFile(
    requestsPath,
    `${JSON.stringify({
      command,
      arguments: arguments_,
      gatewayCredentialPresent: Boolean(
        process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_PASSWORD,
      ),
      gatewayUrlPresent: Boolean(process.env.OPENCLAW_GATEWAY_URL),
      forbiddenEnvironmentPresent: forbiddenEnvironmentNames.filter(
        (name) => process.env[name] !== undefined,
      ),
      ...details,
    })}\n`,
  );
}

function option(name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? null : arguments_[index + 1];
}

if (arguments_[0] === "--version") {
  await record("version");
  console.log("OpenClaw 2026.4.15 (fake-request-path-proof)");
  process.exit(0);
}

if (arguments_[0] === "agents" && arguments_[1] === "list") {
  const agents = await readJson(agentsPath, []);
  await record("agents-list");
  console.log(JSON.stringify([{ id: "main", isDefault: true }, ...agents]));
  process.exit(0);
}

if (arguments_[0] === "sessions") {
  const agentId = option("--agent");
  const sessions = await readJson(sessionsPathFor(agentId), []);
  await record("sessions-list", { agentId });
  console.log(
    JSON.stringify({
      path: path.join(stateDirectory, "agents", agentId, "sessions", "sessions.json"),
      count: sessions.length,
      activeMinutes: null,
      sessions,
    }),
  );
  process.exit(0);
}

if (
  arguments_[0] === "config" &&
  arguments_[1] === "get" &&
  arguments_[2] === "agents.list"
) {
  const agents = await readJson(agentsPath, []);
  await record("config-get", { path: arguments_[2] });
  console.log(JSON.stringify(agents));
  process.exit(0);
}

if (arguments_[0] === "agents" && arguments_[1] === "add") {
  const agents = await readJson(agentsPath, []);
  const id = arguments_[2];
  if (agents.some((agent) => agent.id === id)) process.exit(17);
  const agent = {
    id,
    name: id,
    workspace: option("--workspace"),
    model: option("--model"),
  };
  agents.push(agent);
  await writeFile(agentsPath, `${JSON.stringify(agents, null, 2)}\n`);
  await record("agents-add", { agentId: id });
  console.log(JSON.stringify({ agentId: id, name: id, model: agent.model }));
  process.exit(0);
}

if (arguments_[0] === "agents" && arguments_[1] === "set-identity") {
  await record("agents-set-identity", { agentId: option("--agent") });
  console.log(JSON.stringify({ ok: true, agentId: option("--agent") }));
  process.exit(0);
}

if (arguments_[0] === "config" && arguments_[1] === "set") {
  const agents = await readJson(agentsPath, []);
  const match = arguments_[2].match(/^agents\.list\[(\d+)]\.(workspace|model)$/);
  if (!match || !agents[Number(match[1])]) process.exit(18);
  agents[Number(match[1])][match[2]] = JSON.parse(arguments_[3]);
  await writeFile(agentsPath, `${JSON.stringify(agents, null, 2)}\n`);
  await record("config-set", { path: arguments_[2] });
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}

if (
  arguments_[0] === "gateway" &&
  arguments_[1] === "call" &&
  arguments_[2] === "sessions.abort"
) {
  const params = JSON.parse(option("--params"));
  await record("sessions-abort", { sessionKey: params.key });
  console.log(JSON.stringify({ ok: true, status: "aborted", abortedRunId: "fake-run" }));
  process.exit(0);
}

if (arguments_[0] === "agent") {
  const plan = await readJson(planPath, []);
  let turn = 0;
  try {
    turn = Number(await readFile(counterPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(counterPath, String(turn + 1));
  const action = plan[turn] ?? plan.at(-1);
  if (!action) process.exit(19);
  await record("agent", {
    turn,
    agentId: option("--agent"),
    message: option("--message"),
    requestedTimeoutSeconds: option("--timeout"),
  });

  if (action.mode === "timeout") {
    const grandchild = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
      ],
      { detached: false, stdio: "ignore" },
    );
    await writeFile(
      path.join(stateDirectory, "fake-timeout-pids.json"),
      JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }),
    );
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }

  if (action.mode === "raw") {
    console.log(JSON.stringify(action.envelope));
    process.exit(action.exitCode ?? 0);
  }

  const requestedSessionId = option("--session-id");
  const agentId = option("--agent");

  // FACT-30 proof support: hold a marker file for half the delay, record how
  // many same-agent and total agent turns are concurrently active, then hold
  // the second half so overlapping executions always observe each other.
  if (typeof action.delayMs === "number" && action.delayMs > 0) {
    const activeDirectory = path.join(stateDirectory, "fake-active");
    await mkdir(activeDirectory, { recursive: true });
    const marker = path.join(activeDirectory, `${agentId}-${process.pid}`);
    await writeFile(marker, String(process.pid));
    await delay(Math.ceil(action.delayMs / 2));
    const active = await readdir(activeDirectory);
    await appendFile(
      path.join(stateDirectory, "fake-overlap.ndjson"),
      `${JSON.stringify({
        agentId,
        turn,
        sameAgent: active.filter((name) => name.startsWith(`${agentId}-`)).length,
        total: active.length,
      })}\n`,
    );
    await delay(Math.ceil(action.delayMs / 2));
    await unlink(marker);
  }

  const sessionKey = `agent:${agentId}:explicit:${requestedSessionId}`;
  const internalSessionId = action.sessionId ?? `internal-${requestedSessionId}`;
  const sessionsPath = sessionsPathFor(agentId);
  const sessions = await readJson(sessionsPath, []);
  const otherSessions = sessions.filter((session) => session.key !== sessionKey);
  otherSessions.push({
    key: sessionKey,
    sessionId: internalSessionId,
    agentId,
    updatedAt: Date.now(),
  });
  await writeFile(sessionsPath, `${JSON.stringify(otherSessions, null, 2)}\n`);

  const final =
    action.mode === "malformed"
      ? action.final ?? "this is not json"
      : JSON.stringify(action.output);
  const stopReason = action.stopReason ?? "stop";
  const envelope = {
    runId: action.runId ?? `fake-run-${turn + 1}`,
    status: action.status ?? "ok",
    summary: action.summary ?? "completed",
    result: {
      payloads: [{ text: final, mediaUrl: null }],
      meta: {
        aborted: action.aborted ?? false,
        replayInvalid: action.replayInvalid ?? false,
        livenessState: action.livenessState ?? "working",
        stopReason,
        ...(action.error === undefined ? {} : { error: action.error }),
        completion: {
          stopReason,
          finishReason: action.finishReason ?? stopReason,
        },
        agentMeta: {
          usage: action.usage ?? { input: 11, output: 7, total: 18 },
          lastCallUsage: action.lastCallUsage ?? { input: 3, output: 2, total: 5 },
          provider: Object.hasOwn(action, "provider") ? action.provider : "openrouter",
          model: action.model ?? "openrouter/openai/gpt-4.1-mini",
          sessionId: action.reportedSessionId ?? internalSessionId,
        },
      },
    },
  };
  console.log(JSON.stringify(envelope));
  process.exit(0);
}

await record("unknown");
process.exit(20);
