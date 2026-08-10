import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createOpenCodeAdapter } from "../src/openCodeAdapter.js";
import { createIsolatedGitWorkspace } from "../src/workspace.js";
import {
  createPublicErrorResponse,
  PUBLIC_ERROR_RESPONSE_SCHEMA,
} from "../src/errors.js";
import { fakeOpenCodeAdapter, TEST_CREDENTIAL } from "./testAdapter.js";

test("delegate_coding_task builds a pure command with a minimal environment", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = fakeOpenCodeAdapter({
    env: {
      OPENROUTER_API_KEY: TEST_CREDENTIAL,
      ANTHROPIC_API_KEY: "must-not-pass",
      OPENCODE_CONFIG: "/must/not/pass",
      DATABASE_URL: "must-not-pass",
      PATH: process.env.PATH,
    },
  });

  await adapter.delegate_coding_task("capture-command", workspace);
  const captured = JSON.parse(await readFile(path.join(workspace, "command-capture.json"), "utf8"));

  assert.deepEqual(captured.args.slice(0, 2), ["--pure", "run"]);
  assert.equal(captured.args[2], "capture-command");
  assert.deepEqual(captured.args.slice(3), [
    "--format",
    "json",
    "-m",
    "openrouter/anthropic/claude-haiku-4.5",
    "--dir",
    ".",
    "--auto",
  ]);
  assert.equal(captured.cwd, workspace);
  assert.equal(captured.keyPresent, true);
  assert.equal(captured.anthropicPresent, false);
  assert.equal(captured.databasePresent, false);
  assert.deepEqual(captured.envKeys, [
    "HOME",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENROUTER_API_KEY",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "__CF_USER_TEXT_ENCODING",
  ]);
});

test("delegate_coding_task cleans isolated OpenCode state", async () => {
  const workspace = await createIsolatedGitWorkspace();
  const adapter = fakeOpenCodeAdapter();
  await adapter.delegate_coding_task("capture-command", workspace);
  const captured = JSON.parse(await readFile(path.join(workspace, "command-capture.json"), "utf8"));
  await assert.rejects(access(captured.stateRoot), (error) => error.code === "ENOENT");
});

test("missing credential short-circuits before spawning the credential-free boundary", async () => {
  let spawnCalled = false;
  const adapter = createOpenCodeAdapter({
    spawn() {
      spawnCalled = true;
      throw new Error("must not spawn");
    },
    env: {},
  });

  await assert.rejects(
    () => adapter.delegate_coding_task("do the thing", "/tmp/ws"),
    (error) => error.code === "missing_credentials" && error.varName === "OPENROUTER_API_KEY",
  );
  assert.equal(spawnCalled, false);
});

test("public error responses are bound to the complete authoritative code schema", () => {
  assert.deepEqual(PUBLIC_ERROR_RESPONSE_SCHEMA.properties.code.enum, [
    "internal_failure",
    "missing_credentials",
    "cli_failure",
    "timeout",
    "malformed_output",
    "output_too_large",
    "credential_exposure",
    "workspace_invalid",
    "persistence_failure",
    "invalid_request",
  ]);
  for (const code of PUBLIC_ERROR_RESPONSE_SCHEMA.properties.code.enum) {
    assert.equal(createPublicErrorResponse({ code, message: code }).code, code);
  }
  assert.deepEqual(createPublicErrorResponse({ code: "not_public", message: "boom" }), {
    code: "internal_failure",
    message: "boom",
  });
});
