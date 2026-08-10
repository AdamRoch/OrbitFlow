import { test } from "node:test";
import assert from "node:assert/strict";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { fakeOpenCodeAdapter } from "./testAdapter.js";

test("usage parsing is complete while the returned log stays bounded", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const result = await fakeOpenCodeAdapter().delegate_coding_task("usage-complete", workspace);

  assert.deepEqual(result.usage, {
    inputTokens: 13,
    outputTokens: 7,
    reasoningTokens: 3,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    costUsd: 0.012,
  });
  assert.match(result.diff, /task\.txt/);
  assert.match(result.log, /step_finish/);
  assert.ok(result.log.length <= 20_000);
});

test("omitted usage stays unknown while explicit zero stays zero", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const result = await fakeOpenCodeAdapter().delegate_coding_task("unknown usage", workspace);

  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: 0,
    costUsd: null,
  });
});
