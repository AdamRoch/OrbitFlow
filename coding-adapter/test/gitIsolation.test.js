import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { runSafeGit } from "../src/git.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";
import { successfulRun, TEST_CREDENTIAL } from "./protocolFixture.js";

test("diff ignores repository external helpers and fsmonitor", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const gitHome = path.join(workspace, ".git", "test-home");
  const helper = path.join(workspace, "fail-helper.sh");
  await writeFile(helper, "#!/bin/sh\nexit 97\n");
  await chmod(helper, 0o755);
  await writeFile(path.join(workspace, ".gitattributes"), "sample.txt diff=evil\n");
  await writeFile(path.join(workspace, "sample.txt"), "before\n");
  runSafeGit(["add", "-A"], { cwd: workspace, home: gitHome });
  runSafeGit(
    [
      "-c",
      "user.email=test@orbitflow.local",
      "-c",
      "user.name=orbitflow-test",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: workspace, home: gitHome }
  );
  for (const [key, value] of [
    ["core.fsmonitor", helper],
    ["core.hooksPath", helper],
    ["diff.external", helper],
    ["diff.evil.command", helper],
    ["diff.evil.textconv", helper],
  ]) {
    runSafeGit(["config", "--local", key, value], { cwd: workspace, home: gitHome });
  }
  await writeFile(path.join(workspace, "sample.txt"), "after\n");

  const adapter = successfulAdapter();
  const result = await adapter.delegate_coding_task("task", workspace);

  assert.match(result.diff, /\+after/);
});

test("workspace creation ignores host Git config and hooks", async () => {
  const control = await mkdtemp(path.join(tmpdir(), "coding-adapter-git-host-"));
  const hooks = path.join(control, "hooks");
  const hook = path.join(hooks, "pre-commit");
  await mkdir(hooks);
  await writeFile(hook, "#!/bin/sh\nexit 97\n");
  await chmod(hook, 0o755);
  const config = path.join(control, "gitconfig");
  await writeFile(config, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgSign = true\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;

  try {
    const workspace = await createIsolatedGitWorkspace();
    const commit = runSafeGit(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: workspace,
      home: path.join(workspace, ".git", "test-home"),
    })
      .toString()
      .trim();
    assert.match(commit, /^[0-9a-f]{40,64}$/);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
    await rm(control, { recursive: true, force: true });
  }
});

function successfulAdapter() {
  return createOpenCodeAdapter({
    spawn() {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", successfulRun());
        child.emit("close", 0);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });
}
