#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const arguments_ = process.argv.slice(2);
const runIndex = arguments_.indexOf("run");
const directoryIndex = arguments_.indexOf("--dir");
if (runIndex === -1 || directoryIndex === -1) process.exit(2);
const task = arguments_[runIndex + 1];
const workspace = path.resolve(arguments_[directoryIndex + 1]);
const otherRunMatch = /other-run=([1-9][0-9]*)/.exec(task);
if (!task.startsWith("FACT34_ISOLATION") || !otherRunMatch) process.exit(3);

const attempts = {};
attempts.databaseEnvironmentPresent = Object.hasOwn(process.env, "DATABASE_URL");
attempts.databaseCredentialReadable = await readable("/run/orbitflow/tool-env.json");
attempts.brokerSocketReadable = await readable("/run/orbitflow-broker/tool.sock");
attempts.executorSocketReadable = await readable("/run/orbitflow-executor/executor.sock");
attempts.platformCliExecutable = await executable("/app/bin/orbit-agent-tools.mjs");
attempts.codingCliExecutable = await executable("/app/bin/orbit-coding-tool.mjs");
attempts.brokerExecutable = await executable("/app/bin/orbit-tool-broker.mjs");
attempts.workspaceRootListable = await listable(path.dirname(workspace));
attempts.otherWorkspaceReadable = await listable(
  path.join(path.dirname(workspace), `run-${otherRunMatch[1]}`),
);
attempts.directPostgresConnected = await connects("postgres", 5432);
attempts.uid = process.getuid?.() ?? 0;
attempts.gid = process.getgid?.() ?? 0;

if (
  attempts.databaseEnvironmentPresent ||
  attempts.databaseCredentialReadable ||
  attempts.brokerSocketReadable ||
  attempts.executorSocketReadable ||
  attempts.platformCliExecutable ||
  attempts.codingCliExecutable ||
  attempts.brokerExecutable ||
  attempts.workspaceRootListable ||
  attempts.otherWorkspaceReadable ||
  attempts.directPostgresConnected ||
  attempts.uid < 20_000 ||
  attempts.gid !== attempts.uid
) {
  await writeFile(path.join(workspace, "isolation-failure.json"), `${JSON.stringify(attempts)}\n`);
  process.exit(41);
}

await writeFile(path.join(workspace, "delegated.txt"), "engine-produced delegation succeeded\n");
await writeFile(path.join(workspace, "isolation-proof.json"), `${JSON.stringify(attempts)}\n`);
execFileSync("git", ["add", "-A"], { cwd: workspace, env: gitEnvironment() });
execFileSync(
  "git",
  [
    "-c", "user.email=fact34@orbitflow.local",
    "-c", "user.name=FACT-34 isolation proof",
    "commit", "-q", "-m", "Prove delegated isolation",
  ],
  { cwd: workspace, env: gitEnvironment() },
);

const sessionID = "fact34-isolation";
for (const event of [
  {
    type: "step_start",
    timestamp: 1,
    sessionID,
    part: { sessionID, messageID: "message", id: "start", type: "step-start" },
  },
  {
    type: "step_finish",
    timestamp: 2,
    sessionID,
    part: {
      sessionID,
      messageID: "message",
      id: "finish",
      type: "step-finish",
      reason: "stop",
      cost: 0.01,
      tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 3, write: 2 } },
    },
  },
]) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readable(target) {
  try {
    await access(target);
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

async function executable(target) {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function listable(target) {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

function connects(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
}
