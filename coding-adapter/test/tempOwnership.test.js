import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { access, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import {
  createIsolatedGitWorkspace,
  removeIsolatedGitWorkspace,
} from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";
import { successfulRun, TEST_CREDENTIAL } from "./protocolFixture.js";

test("workspace cleanup refuses a substituted temporary root", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const root = path.dirname(workspace);
  const displacedRoot = `${root}-displaced`;
  const markerName = ".coding-adapter-owner";
  const marker = readFileSync(path.join(root, markerName), "utf8");
  renameSync(root, displacedRoot);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(root, markerName), marker);
  const sentinel = path.join(workspace, "caller-data.txt");
  writeFileSync(sentinel, "preserve me\n");

  try {
    await assert.rejects(
      () => removeIsolatedGitWorkspace(workspace),
      (err) => err.code === "cli_failure" && err.message.includes("cleanup refused")
    );
    await access(sentinel);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(displacedRoot, { recursive: true, force: true });
  }
});

test("OpenCode state cleanup refuses a substituted temporary root", async () => {
  const workspace = await createIsolatedGitWorkspace();
  let stateRoot;
  let displacedRoot;
  let sentinel;
  const adapter = createOpenCodeAdapter({
    spawn(binary, args, opts) {
      stateRoot = opts.env.HOME;
      displacedRoot = `${stateRoot}-displaced`;
      const markerName = ".coding-adapter-owner";
      const marker = readFileSync(path.join(stateRoot, markerName), "utf8");
      renameSync(stateRoot, displacedRoot);
      mkdirSync(stateRoot);
      writeFileSync(path.join(stateRoot, markerName), marker);
      sentinel = path.join(stateRoot, "caller-data.txt");
      writeFileSync(sentinel, "preserve me\n");
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", successfulRun());
        child.emit("close", 0);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });

  try {
    await assert.rejects(
      () => adapter.delegate_coding_task("task", workspace),
      (err) => err.code === "cli_failure" && err.message.includes("clean isolated opencode state")
    );
    await access(sentinel);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(displacedRoot, { recursive: true, force: true });
    await removeIsolatedGitWorkspace(workspace);
  }
});

test("workspace setup failures clean only the verified temporary root", async () => {
  const prefix = `coding-adapter-setup-${randomUUID()}-`;
  const previousPath = process.env.PATH;
  let leftovers;
  process.env.PATH = path.join(tmpdir(), "missing-git-bin");
  try {
    await assert.rejects(
      () => createIsolatedGitWorkspace({ prefix }),
      (err) => err.message.includes("isolated git command failed")
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    leftovers = (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix));
    for (const entry of leftovers ?? []) {
      await rm(path.join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
  assert.deepEqual(leftovers, []);
});
