import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";
import {
  ndjson,
  stepFinish,
  stepStart,
  TEST_CREDENTIAL,
  textEvent,
} from "./protocolFixture.js";

test("usage parsing is complete while the returned log stays bounded", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await writeFile(path.join(workspace, "hello.txt"), "hi there");

  const adapter = createOpenCodeAdapter({
    spawn() {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          ndjson([
            stepStart("start_1"),
            stepFinish(
              {
                input: 10,
                output: 5,
                reasoning: 2,
                cacheRead: 100,
                cacheWrite: 20,
                cost: 0.01,
              },
              "finish_1"
            ),
            stepStart("start_2"),
            textEvent("x".repeat(25_000)),
            stepFinish(
              {
                input: 3,
                output: 2,
                reasoning: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.002,
              },
              "finish_2"
            ),
          ])
        );
        child.emit("close", 0);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });
  const result = await adapter.delegate_coding_task("make a file", workspace);

  assert.deepEqual(result.usage, {
    inputTokens: 13,
    outputTokens: 7,
    reasoningTokens: 3,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
    costUsd: 0.012,
  });
  assert.match(result.diff, /hello\.txt/);
  assert.match(result.diff, /\+hi there/);
  assert.match(result.log, /step_finish/);
  assert.ok(result.log.length <= 20_000);
});

test("omitted usage stays unknown while explicit zero stays zero", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const unknown = stepFinish();
  delete unknown.part.cost;
  delete unknown.part.tokens.input;
  delete unknown.part.tokens.cache.read;
  unknown.part.tokens.output = 0;
  unknown.part.tokens.reasoning = 0;
  unknown.part.tokens.cache.write = 0;

  const adapter = createOpenCodeAdapter({
    spawn() {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", ndjson([stepStart(), unknown]));
        child.emit("close", 0);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });

  const result = await adapter.delegate_coding_task("make a file", workspace);
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: null,
    cacheWriteTokens: 0,
    costUsd: null,
  });
});
