import { test } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import { makeFakeChild } from "./fakeChild.js";
import {
  errorEvent,
  ndjson,
  stepFinish,
  stepStart,
  successfulRun,
  TEST_CREDENTIAL,
  textEvent,
} from "./protocolFixture.js";

test("nonzero exit code maps to CliFailureError and cleans state", async () => {
  const workspace = await createIsolatedGitWorkspace();
  let stateRoot;
  const adapter = createOpenCodeAdapter({
    spawn(binary, args, opts) {
      stateRoot = opts.env.HOME;
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stderr.emit("data", "boom: rate limited\n");
        child.emit("close", 1);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure" && err.exitCode === 1 && err.stderrTail.includes("rate limited")
  );
  await assert.rejects(access(stateRoot), (err) => err.code === "ENOENT");
});

test("malformed JSON line on stdout maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = adapterForOutput("not json\n");

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("exit zero with empty stdout maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = adapterForOutput("");

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("spawn throwing synchronously maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = createOpenCodeAdapter({
    spawn() {
      throw new Error("ENOENT: opencode not found");
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure" && err.message.includes("ENOENT")
  );
});

test("child error event maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = createOpenCodeAdapter({
    spawn() {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    },
    env: { OPENROUTER_API_KEY: TEST_CREDENTIAL },
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure" && err.message.includes("EACCES")
  );
});

test("unexpected JSON shape maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = adapterForOutput("{}\n");

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("error event with exit zero maps to CliFailureError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = adapterForOutput(ndjson([errorEvent()]));

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "cli_failure"
  );
});

test("missing terminal step maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = adapterForOutput(ndjson([stepStart(), textEvent("unfinished")]));

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("invalid usage maps to MalformedOutputError", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const invalidFinish = stepFinish();
  invalidFinish.part.tokens.input = "not-a-number";
  const adapter = adapterForOutput(ndjson([stepStart(), invalidFinish]));

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "malformed_output"
  );
});

test("credential in CLI output fails without exposing the credential", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const credential = "top-secret-test-key";
  const adapter = adapterForOutput(
    ndjson([stepStart(), textEvent(credential), stepFinish()]),
    credential
  );

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "credential_exposure" && !JSON.stringify(err).includes(credential)
  );
  await assert.rejects(access(workspace), (err) => err.code === "ENOENT");
});

test("credential in workspace content fails and removes the workspace", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const credential = "top-secret-test-key";
  await writeFile(path.join(workspace, "leak.txt"), credential);
  const adapter = adapterForOutput(successfulRun(), credential);

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "credential_exposure" && !err.message.includes(credential)
  );
  await assert.rejects(access(workspace), (err) => err.code === "ENOENT");
});

test("credential in binary workspace content is detected before diff encoding", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const credential = "top-secret-test-key";
  await writeFile(
    path.join(workspace, "leak.bin"),
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(credential), Buffer.from([0, 3, 4])])
  );
  const adapter = adapterForOutput(successfulRun(), credential);

  await assert.rejects(
    () => adapter.delegate_coding_task("task", workspace),
    (err) => err.code === "credential_exposure" && !err.message.includes(credential)
  );
  await assert.rejects(access(workspace), (err) => err.code === "ENOENT");
});

function adapterForOutput(output, credential = TEST_CREDENTIAL) {
  return createOpenCodeAdapter({
    spawn() {
      const child = makeFakeChild();
      queueMicrotask(() => {
        if (output) child.stdout.emit("data", output);
        child.emit("close", 0);
      });
      return child;
    },
    env: { OPENROUTER_API_KEY: credential },
  });
}
