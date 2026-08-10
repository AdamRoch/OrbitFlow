import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";
import { TEST_CREDENTIAL } from "./protocolFixture.js";

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
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
    timeoutMs: 20,
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "timeout" && err.timeoutMs === 20
  );
  assert.equal(fakeChild.killed, true);
  assert.deepEqual(fakeChild.killSignals, ["SIGTERM"]);
});

test("timeout kills the executable CLI's complete process group", async () => {
  if (process.platform === "win32") return;
  const workspace = await createIsolatedGitWorkspace();
  const control = await mkdtemp(path.join(tmpdir(), "coding-adapter-timeout-proof-"));
  const pidFile = path.join(control, "descendant.pid");
  const binary = fileURLToPath(new URL("../fixtures/hanging-opencode.mjs", import.meta.url));
  const adapter = createOpenCodeAdapter({
    binary,
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
    timeoutMs: 80,
    killGraceMs: 40,
    killWaitMs: 1_000,
  });

  try {
    await assert.rejects(
      () => adapter.delegate_coding_task(pidFile, workspace),
      (error) => error.code === "timeout" && error.timeoutMs === 80,
    );
    await access(pidFile);
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.equal(processExists(descendantPid), false);
  } finally {
    await rm(control, { recursive: true, force: true });
  }
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
