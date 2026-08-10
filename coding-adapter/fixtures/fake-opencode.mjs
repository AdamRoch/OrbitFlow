#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
if (task === "empty-output") process.exit(0);
if (task === "oversized-protocol-line") {
  await new Promise((resolve) => process.stdout.end("x".repeat(1024 * 1024 + 1), resolve));
  process.exit(0);
}
if (task === "unexpected-shape") {
  process.stdout.write("{}\n");
  process.exit(0);
}
if (task === "invalid-usage:nonfinite") {
  process.stdout.write(
    '{"type":"step_start","timestamp":1,"sessionID":"fake-session","part":{"sessionID":"fake-session","messageID":"fake-message","id":"start","type":"step-start"}}\n',
  );
  process.stdout.write(
    '{"type":"step_finish","timestamp":1,"sessionID":"fake-session","part":{"sessionID":"fake-session","messageID":"fake-message","id":"finish","type":"step-finish","reason":"stop","cost":0,"tokens":{"input":1e400,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}}\n',
  );
  process.exit(0);
}

if (task === "capture-command") {
  writeFileSync(
    path.join(workspace, "command-capture.json"),
    JSON.stringify({
      args,
      cwd: process.cwd(),
      envKeys: Object.keys(process.env).sort(),
      keyPresent: typeof process.env.OPENROUTER_API_KEY === "string",
      anthropicPresent: Object.hasOwn(process.env, "ANTHROPIC_API_KEY"),
      databasePresent: Object.hasOwn(process.env, "DATABASE_URL"),
      stateRoot: process.env.HOME,
    }),
  );
}

if (task === "replace-state-root") {
  const stateRoot = process.env.HOME;
  const displaced = `${stateRoot}-displaced`;
  const marker = readFileSync(path.join(stateRoot, ".coding-adapter-owner"), "utf8");
  renameSync(stateRoot, displaced);
  mkdirSync(stateRoot);
  writeFileSync(path.join(stateRoot, ".coding-adapter-owner"), marker);
  writeFileSync(path.join(stateRoot, "caller-data.txt"), "preserve me\n");
  writeFileSync(
    path.join(workspace, "replaced-state.json"),
    JSON.stringify({ stateRoot, displaced }),
  );
}

if (task === "leak-ignored-git") {
  writeFileSync(path.join(workspace, ".gitignore"), "ignored.txt\n");
  writeFileSync(
    path.join(workspace, "ignored.txt"),
    Buffer.from(process.env.OPENROUTER_API_KEY).toString("base64"),
  );
  writeFileSync(
    path.join(workspace, ".git", "provider-state"),
    Buffer.from(process.env.OPENROUTER_API_KEY).toString("hex"),
  );
}

if (task === "leak-deleted-commit") {
  const leaked = path.join(workspace, "deleted.txt");
  writeFileSync(leaked, encodeURIComponent(process.env.OPENROUTER_API_KEY));
  commit(workspace, "add encoded content");
  unlinkSync(leaked);
  commit(workspace, "remove encoded content");
}

if (task === "large-diff-multiple") {
  writeFileSync(path.join(workspace, "large-0.txt"), "0\n".repeat(2_100_000));
  commit(workspace, "large tracked output");
  writeFileSync(path.join(workspace, "large-1.txt"), "1\n".repeat(2_100_000));
  writeFileSync(path.join(workspace, "large-2.txt"), "2\n".repeat(2_100_000));
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
} else if (
  ![
    "leak-ignored-git",
    "leak-deleted-commit",
    "large-diff-multiple",
  ].includes(task)
) {
  writeFileSync(path.join(workspace, "task.txt"), `${task}\n`);
}

if (!["leak-deleted-commit", "large-diff-multiple"].includes(task)) {
  commit(workspace, task || "fake task");
}

const sessionID = "fake-session";
const base = { timestamp: Date.now(), sessionID };
const commonPart = { sessionID, messageID: "fake-message" };
let events = [
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
if (task === "usage-complete") {
  events = [
    events[0],
    stepFinish({ input: 10, output: 5, reasoning: 2, cacheRead: 100, cacheWrite: 20, cost: 0.01 }, "finish-1"),
    { ...base, type: "step_start", part: { ...commonPart, id: "start-2", type: "step-start" } },
    { ...base, type: "text", part: { ...commonPart, id: "text", type: "text", text: "x".repeat(25_000) } },
    stepFinish({ input: 3, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, cost: 0.002 }, "finish-2"),
  ];
}
if (task === "error-event") {
  events = [{ ...base, type: "error", error: { name: "ProviderError" } }];
}
if (task === "missing-terminal") {
  events = [
    events[0],
    { ...base, type: "text", part: { ...commonPart, id: "text", type: "text", text: "unfinished" } },
  ];
}
if (task === "credential-output") {
  events.splice(1, 0, {
    ...base,
    type: "text",
    part: { ...commonPart, id: "secret", type: "text", text: process.env.OPENROUTER_API_KEY },
  });
}
if (task === "credential-output-base64") {
  events.splice(1, 0, {
    ...base,
    type: "text",
    part: {
      ...commonPart,
      id: "secret",
      type: "text",
      text: Buffer.from(process.env.OPENROUTER_API_KEY).toString("base64"),
    },
  });
}
if (task.startsWith("invalid-usage:")) {
  const kind = task.slice("invalid-usage:".length);
  const invalid = events[1].part;
  if (kind === "fractional") invalid.tokens.input = 1.5;
  if (kind === "unsafe") invalid.tokens.input = Number.MAX_SAFE_INTEGER + 1;
  if (kind === "negative") invalid.tokens.input = -1;
  if (kind === "overflow-sum") {
    invalid.tokens.input = Number.MAX_SAFE_INTEGER;
    events = [events[0], invalidEvent(invalid), { ...base, type: "step_start", part: { ...commonPart, id: "start-2", type: "step-start" } }, stepFinish({ input: 1 }, "finish-2")];
  }
  if (kind === "cost-range") invalid.cost = 10_000_000_000;
  if (kind === "cost-sum") {
    invalid.cost = 9_999_999_999;
    events = [events[0], invalidEvent(invalid), { ...base, type: "step_start", part: { ...commonPart, id: "start-2", type: "step-start" } }, stepFinish({ cost: 2 }, "finish-2")];
  }
}
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);

function stepFinish(values, id) {
  return {
    ...base,
    type: "step_finish",
    part: {
      ...commonPart,
      id,
      type: "step-finish",
      reason: "stop",
      cost: values.cost,
      tokens: {
        input: values.input,
        output: values.output ?? 0,
        reasoning: values.reasoning ?? 0,
        cache: { read: values.cacheRead ?? 0, write: values.cacheWrite ?? 0 },
      },
    },
  };
}

function invalidEvent(part) {
  return { ...base, type: "step_finish", part };
}

function commit(directory, message) {
  execFileSync("git", ["add", "-A"], { cwd: directory, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=fake@orbitflow.local",
      "-c",
      "user.name=orbitflow-fake-cli",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    ],
    { cwd: directory, stdio: "ignore" },
  );
}
