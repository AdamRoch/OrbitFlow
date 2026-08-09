import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";

test("nonzero exit code maps to CliFailureError with bounded stderr", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const fakeSpawn = () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stderr.emit("data", "boom: rate limited\n");
      child.emit("close", 1);
    });
    return child;
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: { OPENROUTER_API_KEY: "k" } });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure" && err.exitCode === 1 && err.stderrTail.includes("rate limited")
  );
});

test("malformed JSON line on stdout maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const fakeSpawn = () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", "not json\n");
      child.emit("close", 0);
    });
    return child;
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: { OPENROUTER_API_KEY: "k" } });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("exit 0 with empty stdout maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const fakeSpawn = () => {
    const child = makeFakeChild();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: { OPENROUTER_API_KEY: "k" } });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("spawn throwing synchronously (e.g. binary not found) maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const fakeSpawn = () => {
    throw new Error("ENOENT: opencode not found");
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: { OPENROUTER_API_KEY: "k" } });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure" && err.message.includes("ENOENT")
  );
});

test("child 'error' event (async spawn failure) maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const fakeSpawn = () => {
    const child = makeFakeChild();
    queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
    return child;
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: { OPENROUTER_API_KEY: "k" } });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure" && err.message.includes("EACCES")
  );
});
