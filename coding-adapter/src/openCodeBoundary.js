#!/usr/bin/env node

import { statSync } from "node:fs";
import path from "node:path";
import {
  executeAnchoredOpenCode,
  prepareAnchoredWorkspace,
  redactBoundaryPayload,
  serializeBoundaryError,
} from "./openCodeAdapter.js";

const OPEN_CODE_ENV_KEYS = [
  "HOME",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "PATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "__CF_USER_TEXT_ENCODING",
];

let phase = "waiting_for_configuration";
let config;
let baseCommit;
let activeCredential;
let executionController;

process.on("message", (message) => {
  void handleMessage(message).catch((error) => finishError(error));
});

send({ type: "ready" });

async function handleMessage(message) {
  if (!message || typeof message !== "object") throw new Error("boundary message is malformed");
  if (message.type === "abort") {
    if (phase === "executing") {
      executionController.abort();
    } else {
      phase = "aborted";
      process.disconnect();
    }
    return;
  }
  if (message.type === "configure" && phase === "waiting_for_configuration") {
    config = validateConfig(message.config);
    process.chdir(config.workspace);
    const current = statSync(".");
    if (
      !current.isDirectory() ||
      String(current.dev) !== config.workspaceDevice ||
      String(current.ino) !== config.workspaceInode
    ) {
      throw new Error("workspace identity changed before execution boundary entry");
    }
    baseCommit = prepareAnchoredWorkspace(config.stateRoot);
    phase = "waiting_for_credential";
    send({
      type: "credential_ready",
      inheritedCredentialPresent: Object.hasOwn(process.env, config.apiKeyEnvVar),
    });
    return;
  }
  if (message.type === "credential" && phase === "waiting_for_credential") {
    if (typeof message.credential !== "string" || message.credential.length === 0) {
      throw new Error("boundary credential is malformed");
    }
    phase = "executing";
    activeCredential = message.credential;
    executionController = new AbortController();
    const result = await executeAnchoredOpenCode({
      ...config,
      credential: message.credential,
      baseCommit,
      signal: executionController.signal,
      onCliStart(processGroupId) {
        send({ type: "cli_started", processGroupId });
      },
    });
    finish({ type: "result", ok: true, result }, message.credential);
    return;
  }
  throw new Error("boundary message is invalid for its current phase");
}

function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("boundary configuration is malformed");
  }
  for (const field of ["workspace", "binary", "stateRoot"]) {
    if (typeof value[field] !== "string" || !path.isAbsolute(value[field])) {
      throw new Error(`boundary ${field} must be an absolute path`);
    }
  }
  for (const field of ["task", "model", "apiKeyEnvVar", "workspaceDevice", "workspaceInode"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`boundary ${field} is malformed`);
    }
  }
  for (const field of ["timeoutMs", "killGraceMs", "killWaitMs"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1) {
      throw new Error(`boundary ${field} is malformed`);
    }
  }
  if (
    value.childStartHandshakeMs !== undefined &&
    (!Number.isSafeInteger(value.childStartHandshakeMs) || value.childStartHandshakeMs < 1)
  ) {
    throw new Error("boundary childStartHandshakeMs is malformed");
  }
  if (!value.openCodeEnv || typeof value.openCodeEnv !== "object" || Array.isArray(value.openCodeEnv)) {
    throw new Error("boundary OpenCode environment is malformed");
  }
  const actualKeys = Object.keys(value.openCodeEnv).sort();
  if (
    actualKeys.length !== OPEN_CODE_ENV_KEYS.length ||
    actualKeys.some((key, index) => key !== OPEN_CODE_ENV_KEYS[index]) ||
    Object.hasOwn(value.openCodeEnv, value.apiKeyEnvVar)
  ) {
    throw new Error("boundary OpenCode environment is not explicitly allowlisted");
  }
  if (!/^\d+$/.test(value.workspaceDevice) || !/^\d+$/.test(value.workspaceInode)) {
    throw new Error("boundary workspace identity is malformed");
  }
  return value;
}

function finishError(error) {
  finish(
    { type: "result", ok: false, error: serializeBoundaryError(error) },
    activeCredential,
  );
}

function finish(payload, credential) {
  if (phase === "finished") return;
  phase = "finished";
  const safePayload = credential ? redactBoundaryPayload(payload, credential) : payload;
  if (process.connected) {
    process.send(safePayload, () => process.disconnect());
  }
}

function send(payload) {
  if (process.connected) process.send(payload);
}
