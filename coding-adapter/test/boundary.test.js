import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { fakeOpenCodeAdapter } from "./testAdapter.js";

test("spawn-boundary rename and symlink replacement starts no CLI and hands off no key", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const ownedRoot = path.dirname(workspace);
  const retained = `${workspace}-retained`;
  const replacement = await mkdtemp(path.join(tmpdir(), "coding-adapter-replacement-"));
  const adapter = fakeOpenCodeAdapter({
    async beforeCredential() {
      await rename(workspace, retained);
      await symlink(replacement, workspace, "dir");
    },
  });

  try {
    await assert.rejects(
      () => adapter.delegate_coding_task("capture-command", workspace),
      (error) => error.code === "cli_failure" && error.message.includes("credential handoff"),
    );
    await assert.rejects(access(path.join(replacement, "command-capture.json")), { code: "ENOENT" });
    await assert.rejects(access(path.join(retained, "command-capture.json")), { code: "ENOENT" });
  } finally {
    await rm(ownedRoot, { recursive: true, force: true });
    await rm(replacement, { recursive: true, force: true });
  }
});

test("one aggregate diff cap covers tracked output plus every untracked file", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await assert.rejects(
    () => fakeOpenCodeAdapter().delegate_coding_task("large-diff-multiple", workspace),
    (error) => error.code === "output_too_large" && error.limitBytes === 10 * 1024 * 1024,
  );
  await access(workspace);
});
