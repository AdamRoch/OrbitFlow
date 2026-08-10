import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import {
  inspectProcessGroup,
  waitForProcessGroupAbsence,
} from "../src/processGroup.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { HANGING_OPENCODE, TEST_CREDENTIAL } from "./testAdapter.js";

test("timeout kills the complete CLI process group on the first and repeated launches", async () => {
  if (process.platform === "win32") return;
  const workspace = await createIsolatedGitWorkspace();
  const control = await mkdtemp(path.join(tmpdir(), "coding-adapter-timeout-proof-"));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const pidFile = path.join(control, `descendant-${attempt}.pid`);
      const adapter = createOpenCodeAdapter({
        binary: HANGING_OPENCODE,
        env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
        timeoutMs: 500,
        killGraceMs: 100,
        killWaitMs: 2_000,
      });
      await assert.rejects(
        () => adapter.delegate_coding_task(pidFile, workspace),
        (error) => error.code === "timeout" && error.timeoutMs === 500,
      );
      await access(pidFile);
      const { processGroupId, descendantPid } = JSON.parse(await readFile(pidFile, "utf8"));
      assert.equal(
        inspectProcessGroup(processGroupId).state,
        "absent",
        `attempt ${attempt} left its process group present or uninspectable`,
      );
      assert.equal(processExists(descendantPid), false, `attempt ${attempt} left a descendant`);
    }
  } finally {
    await rm(control, { recursive: true, force: true });
  }
});

test("process-group inspection distinguishes absence from uninspectable liveness", async () => {
  const errorFor = (code) => Object.assign(new Error(code), { code });
  const absent = inspectProcessGroup(123, () => {
    throw errorFor("ESRCH");
  });
  const uninspectable = inspectProcessGroup(
    123,
    () => {
      throw errorFor("EPERM");
    },
    () => "uninspectable",
  );
  assert.deepEqual(absent, { state: "absent", code: "ESRCH" });
  assert.deepEqual(uninspectable, { state: "uninspectable", code: "EPERM" });
  await assert.rejects(
    () => waitForProcessGroupAbsence(123, 10, { inspect: () => uninspectable }),
    /uninspectable \(EPERM\)/,
  );
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
