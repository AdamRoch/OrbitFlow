import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createOpenCodeAdapter, OPEN_CODE_BINARY } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";
import { successfulRun } from "./protocolFixture.js";

test("delegate_coding_task builds a pure command with a minimal environment", async () => {
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
      child.stdout.emit("data", successfulRun());
      child.emit("close", 0);
    });
    return child;
  };

  const adapter = createOpenCodeAdapter({
    spawn: fakeSpawn,
    env: {
      OPENROUTER_API_KEY: "test-key",
      ANTHROPIC_API_KEY: "must-not-pass",
      OPENCODE_CONFIG: "/must/not/pass",
      PATH: "/usr/bin:/bin",
    },
    model: "openrouter/anthropic/claude-haiku-4.5",
  });

  await adapter.delegate_coding_task("do the thing", workspace);

  assert.equal(capturedBinary, OPEN_CODE_BINARY);
  assert.deepEqual(capturedArgs, [
    "--pure",
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
  assert.equal(capturedOpts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(capturedOpts.env.OPENCODE_CONFIG, undefined);
  assert.equal(capturedOpts.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(capturedOpts.env.OPENCODE_DISABLE_CLAUDE_CODE, "true");
  assert.equal(capturedOpts.env.OPENCODE_DISABLE_AUTOUPDATE, "true");
  assert.deepEqual(Object.keys(capturedOpts.env).sort(), [
    "HOME",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENROUTER_API_KEY",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  assert.deepEqual(capturedOpts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(capturedOpts.detached, process.platform !== "win32");
});

test("delegate_coding_task cleans isolated OpenCode state", async () => {
  const workspace = await createIsolatedGitWorkspace();
  let stateRoot;

  const adapter = createOpenCodeAdapter({
    spawn(binary, args, opts) {
      stateRoot = opts.env.HOME;
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", successfulRun());
        child.emit("close", 0);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: "test-key", XDG_DATA_HOME: "/stored/config" },
  });

  await adapter.delegate_coding_task("do the thing", workspace);

  await assert.rejects(access(stateRoot), (err) => err.code === "ENOENT");
});

test("missing credential short-circuits before spawning", async () => {
  let spawnCalled = false;
  const adapter = createOpenCodeAdapter({
    spawn() {
      spawnCalled = true;
      return makeFakeChild();
    },
    env: {},
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("do the thing", "/tmp/ws"),
    (err) => err.code === "missing_credentials" && err.varName === "OPENROUTER_API_KEY"
  );
  assert.equal(spawnCalled, false);
});
