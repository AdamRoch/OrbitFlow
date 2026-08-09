import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";

test("a CLI that never exits is killed and rejected as TimeoutError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  let fakeChild;
  const fakeSpawn = () => {
    fakeChild = makeFakeChild();
    // never emits 'close' -- simulates a hang
    return fakeChild;
  };

  const adapter = createOpenCodeAdapter({
    spawn: fakeSpawn,
    env: { OPENROUTER_API_KEY: "k" },
    timeoutMs: 20,
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "timeout" && err.timeoutMs === 20
  );
  assert.equal(fakeChild.killed, true);
  assert.deepEqual(fakeChild.killSignals, ["SIGTERM"]);
});
