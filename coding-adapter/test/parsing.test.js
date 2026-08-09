import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";

const NDJSON = [
  { type: "step_start" },
  {
    type: "step_finish",
    part: { tokens: { input: 10, output: 5, cache: { read: 100, write: 20 } }, cost: 0.01 },
  },
  {
    type: "step_finish",
    part: { tokens: { input: 3, output: 2, cache: { read: 0, write: 0 } }, cost: 0.002 },
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

test("delegate_coding_task sums usage across events and returns diff + log", async () => {
  const workspace = await createIsolatedGitWorkspace();
  // Simulate what the real CLI would have done to the workspace.
  await writeFile(path.join(workspace, "hello.txt"), "hi there");

  const fakeSpawn = () => {
    const child = makeFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", NDJSON + "\n");
      child.emit("close", 0);
    });
    return child;
  };

  const adapter = createOpenCodeAdapter({ spawn: fakeSpawn, env: { OPENROUTER_API_KEY: "k" } });
  const result = await adapter.delegate_coding_task("make a file", workspace);

  assert.deepEqual(result.usage, {
    inputTokens: 13,
    outputTokens: 7,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    costUsd: 0.012,
  });
  assert.match(result.diff, /hello\.txt/);
  assert.match(result.diff, /\+hi there/);
  assert.match(result.log, /step_finish/);
});
