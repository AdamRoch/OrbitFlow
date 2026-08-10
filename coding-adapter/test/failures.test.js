import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { runSafeGit } from "../src/git.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import {
  FAKE_OPENCODE,
  fakeOpenCodeAdapter,
  TEST_CREDENTIAL,
} from "./testAdapter.js";

test("nonzero exit code maps to CliFailureError and cleans state", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await assert.rejects(
    () => fakeOpenCodeAdapter().delegate_coding_task("crash", workspace),
    (error) => error.code === "cli_failure" && error.exitCode === 7,
  );
});

for (const [name, task, fragment] of [
  ["malformed JSON line", "malformed-output", null],
  ["empty stdout", "empty-output", null],
  ["unexpected JSON shape", "unexpected-shape", null],
  ["missing terminal step", "missing-terminal", null],
  ["oversized protocol line", "oversized-protocol-line", "protocol limit"],
]) {
  test(`${name} maps to MalformedOutputError`, async () => {
    const workspace = await createIsolatedGitWorkspace();
    await assert.rejects(
      () => fakeOpenCodeAdapter().delegate_coding_task(task, workspace),
      (error) =>
        error.code === "malformed_output" &&
        (!fragment || error.message.includes(fragment)) &&
        (!error.rawTail || error.rawTail.length <= 500),
    );
  });
}

test("OpenCode launch failure maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = createOpenCodeAdapter({
    binary: "/definitely/missing/orbitflow-opencode",
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
  });
  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (error) => error.code === "cli_failure" && error.message.includes("ENOENT"),
  );
});

test("OpenCode child error event maps to CliFailureError", async () => {
  const control = await mkdtemp(path.join(tmpdir(), "coding-adapter-noexec-"));
  const binary = path.join(control, "not-executable");
  await writeFile(binary, "#!/bin/sh\nexit 0\n");
  await chmod(binary, 0o600);
  const workspace = await createIsolatedGitWorkspace();
  try {
    const adapter = createOpenCodeAdapter({
      binary,
      env: { OPENROUTER_API_KEY: TEST_CREDENTIAL, PATH: process.env.PATH },
    });
    await assert.rejects(
      () => adapter.delegate_coding_task("task", workspace),
      (error) => error.code === "cli_failure" && error.message.includes("EACCES"),
    );
  } finally {
    await rm(control, { recursive: true, force: true });
  }
});

test("error event with exit zero maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await assert.rejects(
    () => fakeOpenCodeAdapter().delegate_coding_task("error-event", workspace),
    (error) => error.code === "cli_failure",
  );
});

for (const kind of [
  "fractional",
  "unsafe",
  "negative",
  "nonfinite",
  "overflow-sum",
  "cost-range",
  "cost-sum",
]) {
  test(`invalid ${kind} usage maps to MalformedOutputError before persistence`, async () => {
    const workspace = await createIsolatedGitWorkspace();
    await assert.rejects(
      () => fakeOpenCodeAdapter().delegate_coding_task(`invalid-usage:${kind}`, workspace),
      (error) => error.code === "malformed_output",
    );
  });
}

for (const [name, task, encoded] of [
  ["literal", "credential-output", (value) => value],
  ["encoded", "credential-output-base64", (value) => Buffer.from(value).toString("base64")],
]) {
  test(`${name} credential in CLI output fails without exposing it`, async () => {
    const workspace = await createIsolatedGitWorkspace();
    const exposed = encoded(TEST_CREDENTIAL);
    await assert.rejects(
      () => fakeOpenCodeAdapter().delegate_coding_task(task, workspace),
      (error) => error.code === "credential_exposure" && !JSON.stringify(error).includes(exposed),
    );
    await assert.rejects(access(workspace), (error) => error.code === "ENOENT");
  });
}

test("credential in workspace content fails and removes the owned workspace", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await writeFile(path.join(workspace, "leak.txt"), TEST_CREDENTIAL);
  await assert.rejects(
    () => fakeOpenCodeAdapter().delegate_coding_task("task", workspace),
    (error) => error.code === "credential_exposure" && !error.message.includes(TEST_CREDENTIAL),
  );
  await assert.rejects(access(workspace), (error) => error.code === "ENOENT");
});

test("credential in binary workspace content is detected before diff encoding", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await writeFile(
    path.join(workspace, "leak.bin"),
    Buffer.concat([Buffer.from([0, 1]), Buffer.from(TEST_CREDENTIAL), Buffer.from([2, 3])]),
  );
  await assert.rejects(
    () => fakeOpenCodeAdapter().delegate_coding_task("task", workspace),
    (error) => error.code === "credential_exposure",
  );
  await assert.rejects(access(workspace), (error) => error.code === "ENOENT");
});

test("encoded credentials in ignored and Git state remove the owned workspace", async () => {
  const workspace = await createIsolatedGitWorkspace();
  await assert.rejects(
    () => fakeOpenCodeAdapter().delegate_coding_task("leak-ignored-git", workspace),
    (error) => error.code === "credential_exposure",
  );
  await assert.rejects(access(workspace), (error) => error.code === "ENOENT");
});

test("encoded credential in deleted committed content is detected", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const credential = "top/secret+test:key";
  const adapter = fakeOpenCodeAdapter({
    env: { OPENROUTER_API_KEY: credential, PATH: process.env.PATH },
  });
  await assert.rejects(
    () => adapter.delegate_coding_task("leak-deleted-commit", workspace),
    (error) => error.code === "credential_exposure",
  );
  await assert.rejects(access(workspace), (error) => error.code === "ENOENT");
});

test("caller-owned workspace is rejected without boundary launch or deletion", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-adapter-caller-"));
  runSafeGit(["init", "-q"], { cwd: workspace, home: workspace });
  const sentinel = path.join(workspace, "keep.txt");
  await writeFile(sentinel, "caller data\n");
  let spawned = false;
  const adapter = createOpenCodeAdapter({
    binary: FAKE_OPENCODE,
    spawn() {
      spawned = true;
      throw new Error("must not spawn");
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });
  try {
    await assert.rejects(
      () => adapter.delegate_coding_task("task", workspace),
      (error) => error.code === "cli_failure" && error.message.includes("createIsolatedGitWorkspace"),
    );
    assert.equal(spawned, false);
    await access(sentinel);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
