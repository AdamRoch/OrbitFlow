#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const runIndex = args.indexOf("run");
const dirIndex = args.indexOf("--dir");
if (runIndex === -1 || dirIndex === -1) process.exit(2);
const task = args[runIndex + 1];
const workspace = args[dirIndex + 1];

if (task === "crash-with-credential") {
  process.stderr.write(`failure ${process.env.OPENROUTER_API_KEY ?? "missing"}\n`);
  process.exit(7);
}
if (task === "crash") {
  process.stderr.write("deterministic crash\n");
  process.exit(7);
}
if (task === "malformed-output") {
  process.stdout.write("not-json\n");
  process.exit(0);
}

const shared = path.join(workspace, "shared.txt");
if (task === "first task") {
  writeFileSync(shared, "first task committed\n");
} else if (task === "second task") {
  if (readFileSync(shared, "utf8") !== "first task committed\n") {
    process.stderr.write("first task state was not visible\n");
    process.exit(9);
  }
  appendFileSync(shared, "second task committed\n");
} else {
  writeFileSync(path.join(workspace, "task.txt"), `${task}\n`);
}

execFileSync("git", ["add", "-A"], { cwd: workspace, stdio: "ignore" });
execFileSync(
  "git",
  [
    "-c",
    "user.email=fake@orbitflow.local",
    "-c",
    "user.name=orbitflow-fake-cli",
    "commit",
    "-q",
    "-m",
    task || "fake task",
  ],
  { cwd: workspace, stdio: "ignore" },
);

const sessionID = "fake-session";
const base = { timestamp: Date.now(), sessionID };
const commonPart = { sessionID, messageID: "fake-message" };
const events = [
  {
    ...base,
    type: "step_start",
    part: { ...commonPart, id: "start", type: "step-start" },
  },
  {
    ...base,
    type: "step_finish",
    part: {
      ...commonPart,
      id: "finish",
      type: "step-finish",
      reason: "stop",
      ...(task === "unknown usage" ? {} : { cost: task === "first task" ? 0.125 : 0.25 }),
      tokens: {
        ...(task === "unknown usage" ? {} : { input: task === "first task" ? 10 : 7 }),
        output: task === "unknown usage" ? 0 : task === "first task" ? 5 : 3,
        reasoning: task === "unknown usage" ? 0 : 1,
        cache: {
          ...(task === "unknown usage" ? {} : { read: task === "first task" ? 4 : 2 }),
          write: task === "unknown usage" ? 0 : task === "first task" ? 2 : 1,
        },
      },
    },
  },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
