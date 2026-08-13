import assert from "node:assert/strict";
import { chown, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutionIdentityStore } from "../src/executionIdentityStore.js";

test("isolates partial permanent reservations to their claimed UIDs", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "orbitflow-identity-store-"));
  try {
    const workspaceRoot = await realpath(temporaryRoot);
    const currentUid = process.getuid();
    const currentGid = process.getgid();
    const uidMin = currentUid === 0 ? 20_000 : currentUid;
    const activeGid = currentUid === 0 ? uidMin : currentGid;
    const activeRunId = "100";
    const partialRunId = "101";
    const newRunId = "103";
    const exhaustedRunId = "104";
    const activeWorkspace = path.join(workspaceRoot, `run-${activeRunId}`);
    const partialWorkspace = path.join(workspaceRoot, `run-${partialRunId}`);
    const newWorkspace = path.join(workspaceRoot, `run-${newRunId}`);
    const exhaustedWorkspace = path.join(workspaceRoot, `run-${exhaustedRunId}`);
    await Promise.all([
      mkdir(activeWorkspace, { mode: 0o700 }),
      mkdir(partialWorkspace, { mode: 0o700 }),
      mkdir(newWorkspace, { mode: 0o700 }),
      mkdir(exhaustedWorkspace, { mode: 0o700 }),
    ]);
    if (currentUid === 0) await chown(activeWorkspace, uidMin, activeGid);
    const activeStat = await lstat(activeWorkspace);
    const identityRoot = path.join(workspaceRoot, ".orbitflow", "executor-identities");
    await mkdir(identityRoot, { recursive: true, mode: 0o700 });
    await writeFile(path.join(identityRoot, `uid-${uidMin}.json`), `${JSON.stringify({
      version: 2,
      state: "active",
      runId: activeRunId,
      workspace: activeWorkspace,
      uid: uidMin,
      gid: activeGid,
      workspaceDevice: String(activeStat.dev),
      workspaceInode: String(activeStat.ino),
    })}\n`);
    await writeFile(
      path.join(identityRoot, `uid-${uidMin + 1}.json`),
      JSON.stringify({ runId: partialRunId }),
    );
    await writeFile(path.join(identityRoot, `uid-${uidMin + 2}.json`), "");

    let attemptedUid;
    const options = {
      workspaceRoot,
      uidMin,
      uidCount: 4,
      gidForUid: () => activeGid,
      async applyOwnership(_workspace, uid) {
        attemptedUid = uid;
        throw new Error("injected ownership stop");
      },
    };
    const store = createExecutionIdentityStore(options);
    assert.equal((await store.require(activeRunId, activeWorkspace)).uid, uidMin);
    await assert.rejects(
      () => store.ensure(partialRunId, partialWorkspace),
      (error) => error.code === "workspace_invalid" && /reservation is incomplete/.test(error.message),
    );
    await assert.rejects(() => store.ensure(newRunId, newWorkspace), /injected ownership stop/);
    assert.equal(attemptedUid, uidMin + 3);
    assert.equal(
      JSON.parse(await readFile(path.join(identityRoot, `uid-${uidMin + 3}.json`), "utf8")).runId,
      newRunId,
    );

    const restartedStore = createExecutionIdentityStore(options);
    assert.equal((await restartedStore.require(activeRunId, activeWorkspace)).uid, uidMin);
    await assert.rejects(
      () => restartedStore.ensure(partialRunId, partialWorkspace),
      (error) => error.code === "workspace_invalid" && /reservation is incomplete/.test(error.message),
    );
    await assert.rejects(
      () => restartedStore.ensure(exhaustedRunId, exhaustedWorkspace),
      (error) => error.code === "workspace_invalid" && /pool is exhausted/.test(error.message),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
