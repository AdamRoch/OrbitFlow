import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";

test("delegate_coding_task builds the expected opencode argv and passes cwd/env", async () => {
  const workspace = await createIsolatedGitWorkspace();
  let capturedBinary;
  let capturedArgs;
  let capturedOpts;

  const fakeSpawn = (binary, args, opts) => {
    capturedBinary = binary;
    capturedArgs = args;
    capturedOpts = opts;
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", '{"type":"text","part":{"text":"hi"}}\n');
      child.emit("close", 0);
    });
    return child;
  };

  const adapter = createOpenCodeAdapter({
    spawn: fakeSpawn,
    env: { OPENROUTER_API_KEY: "test-key" },
    model: "openrouter/anthropic/claude-haiku-4.5",
  });

  await adapter.delegate_coding_task("do the thing", workspace);

  assert.equal(capturedBinary, "opencode");
  assert.deepEqual(capturedArgs, [
    "run",
    "do the thing",
    "--format",
    "json",
    "-m",
    "openrouter/anthropic/claude-haiku-4.5",
    "--dir",
    workspace,
    "--auto",
  ]);
  assert.equal(capturedOpts.cwd, workspace);
  assert.equal(capturedOpts.env.OPENROUTER_API_KEY, "test-key");
  assert.deepEqual(capturedOpts.stdio, ["ignore", "pipe", "pipe"]);
});

test("delegate_coding_task isolates opencode's XDG state dirs from any builder-stored provider config", async () => {
  const workspace = await createIsolatedGitWorkspace();
  let capturedOpts;

  const fakeSpawn = (binary, args, opts) => {
    capturedOpts = opts;
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", '{"type":"text","part":{"text":"hi"}}\n');
      child.emit("close", 0);
    });
    return child;
  };

  const adapter = createOpenCodeAdapter({
    spawn: fakeSpawn,
    env: { OPENROUTER_API_KEY: "test-key", XDG_DATA_HOME: "/Users/someone/.local/share" },
  });

  await adapter.delegate_coding_task("do the thing", workspace);

  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
    assert.ok(capturedOpts.env[key], `${key} should be set`);
    assert.notEqual(capturedOpts.env[key], "/Users/someone/.local/share");
  }
});

test("missing credential short-circuits before spawning", async () => {
  let spawnCalled = false;
  const fakeSpawn = () => {
    spawnCalled = true;
    return makeFakeChild();
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: {} });

  await assert.rejects(
    () => adapter.delegate_coding_task("do the thing", "/tmp/ws"),
    (err) => err.code === "missing_credentials" && err.varName === "OPENROUTER_API_KEY"
  );
  assert.equal(spawnCalled, false);
});
