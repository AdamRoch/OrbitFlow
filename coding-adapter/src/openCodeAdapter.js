// v1 CodingToolAdapter: wraps the `opencode` CLI headlessly.
//
// delegate_coding_task(task, workspace) -> { diff, log, usage }
//
// See ../DECISION.md for why opencode was picked over claude/codex.

import { spawn as nodeSpawn } from "node:child_process";
import { chownSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runSafeGit } from "./git.js";
import { createOwnedTempRoot, removeOwnedTempRoot } from "./ownedTemp.js";
import { terminateProcessGroup } from "./processGroup.js";
import {
  addCosts,
  addTokenCounts,
  isDatabaseCost,
  isDatabaseTokenCount,
} from "./usage.js";
import { getOwnedWorkspace, removeOwnedWorkspace } from "./workspace.js";
import {
  MissingCredentialsError,
  CliFailureError,
  TimeoutError,
  MalformedOutputError,
  OutputTooLargeError,
  CredentialExposureError,
} from "./errors.js";

export const OPEN_CODE_VERSION = "1.18.4";
export const OPEN_CODE_BINARY = fileURLToPath(
  new URL(
    process.platform === "win32"
      ? "../node_modules/.bin/opencode.cmd"
      : "../node_modules/.bin/opencode",
    import.meta.url
  )
);

export const OPEN_CODE_DEFAULT_MODEL = "openrouter/anthropic/claude-haiku-4.5";
const EXECUTION_BOUNDARY = fileURLToPath(new URL("./openCodeBoundary.js", import.meta.url));
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_KILL_WAIT_MS = 1_000;
const MAX_LOG_CHARS = 20_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_PROTOCOL_LINE_CHARS = 1024 * 1024;
const MAX_DIFF_BYTES = 10 * 1024 * 1024;
const MAX_WORKSPACE_SCAN_BYTES = 50 * 1024 * 1024;
const EVENT_TYPES = new Set(["step_start", "step_finish", "text", "reasoning", "tool_use", "error"]);

export function createOpenCodeAdapter({
  spawn = nodeSpawn,
  apiKeyEnvVar = "OPENROUTER_API_KEY",
  model = OPEN_CODE_DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  killWaitMs = DEFAULT_KILL_WAIT_MS,
  childStartHandshakeMs,
  binary = OPEN_CODE_BINARY,
  env = process.env,
  workspaceAuthority = createTemporaryWorkspaceAuthority(),
  beforeCredential,
  executionIdentity,
} = {}) {
  async function delegate_coding_task(task, workspace, { signal } = {}) {
    if (signal?.aborted) {
      throw new CliFailureError("coding delegation cancelled because run workspace is being deleted");
    }
    const credential = env[apiKeyEnvVar];
    if (typeof credential !== "string" || credential.length === 0) {
      throw new MissingCredentialsError(apiKeyEnvVar);
    }

    const workspaceHandle = await workspaceAuthority.resolve(workspace);
    workspace = workspaceHandle.workspace;
    const secrets = secretVariants(credential);
    const isolatedState = await createIsolatedState(env.PATH, executionIdentity);
    try {
      try {
        const result = await runAnchoredBoundary({
          spawn,
          binary,
          task,
          model,
          apiKeyEnvVar,
          credential,
          toolPath: env.PATH,
          isolatedState,
          workspaceHandle,
          workspaceAuthority,
          beforeCredential,
          timeoutMs,
          killGraceMs,
          killWaitMs,
          childStartHandshakeMs,
          secrets,
          signal,
          executionIdentity,
        });
        if (!(await workspaceAuthority.assertCurrent(workspaceHandle))) {
          throw new CliFailureError("workspace ownership changed during CLI execution");
        }
        return result;
      } catch (error) {
        if (error?.containWorkspace) {
          await containCredentialExposure(workspaceAuthority, workspaceHandle);
        }
        throw error;
      }
    } finally {
      try {
        if (!removeOwnedTempRoot(isolatedState.ownership)) {
          throw new Error("temporary state ownership changed");
        }
      } catch {
        throw new CliFailureError("failed to clean isolated opencode state");
      }
    }
  }

  return { delegate_coding_task };
}

async function createIsolatedState(toolPath, executionIdentity) {
  const ownership = await createOwnedTempRoot("opencode-state-");
  const root = ownership.root;
  if (executionIdentity) {
    validateExecutionIdentity(executionIdentity);
    chownTree(root, executionIdentity.uid, executionIdentity.gid);
  }
  return {
    ownership,
    root,
    env: {
      PATH: toolPath || "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      TEMP: root,
      TMP: root,
      TMPDIR: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_CLAUDE_CODE: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      __CF_USER_TEXT_ENCODING: "0x0:0x0:0x0",
    },
  };
}

function runAnchoredBoundary({
  spawn,
  binary,
  task,
  model,
  apiKeyEnvVar,
  credential,
  toolPath,
  isolatedState,
  workspaceHandle,
  workspaceAuthority,
  beforeCredential,
  timeoutMs,
  killGraceMs,
  killWaitMs,
  childStartHandshakeMs,
  secrets,
  signal,
  executionIdentity,
}) {
  const identity = workspaceIdentity(workspaceHandle);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [EXECUTION_BOUNDARY], {
        cwd: isolatedState.root,
        env: {
          PATH: toolPath || "/usr/local/bin:/usr/bin:/bin",
          HOME: isolatedState.root,
          TMPDIR: isolatedState.root,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        ...(executionIdentity
          ? { uid: executionIdentity.uid, gid: executionIdentity.gid }
          : {}),
      });
    } catch (error) {
      reject(new CliFailureError(`failed to start coding execution boundary: ${errorMessage(error)}`));
      return;
    }

    let settled = false;
    let receivedResult = false;
    let cliProcessGroupId = null;
    let stderrTail = "";
    let stdoutTail = "";
    let credentialSent = false;
    const overallTimeoutMs =
      timeoutMs + killGraceMs + killWaitMs + (childStartHandshakeMs ?? 0) + 10_000;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      signal?.removeEventListener("abort", abortForDeletion);
      callback(value);
    };

    const fail = (error) => settle(reject, error);
    const abortAndFail = (error) => {
      try {
        if (child.connected) child.send({ type: "abort" });
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      fail(error);
    };
    const overallTimer = setTimeout(() => {
      void (async () => {
        try {
          if (Number.isInteger(cliProcessGroupId)) {
            await terminateProcessGroup(cliProcessGroupId, {
              killGraceMs,
              killWaitMs,
            });
          }
        } catch (error) {
          fail(
            new CliFailureError(
              `failed to terminate coding CLI after boundary timeout: ${errorMessage(error)}`,
            ),
          );
          return;
        } finally {
          child.kill("SIGKILL");
        }
        fail(new CliFailureError("coding execution boundary did not return a bounded result"));
      })();
    }, overallTimeoutMs);

    const abortForDeletion = () => {
      try {
        if (child.connected) child.send({ type: "abort" });
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    signal?.addEventListener("abort", abortForDeletion, { once: true });
    if (signal?.aborted) abortForDeletion();

    child.stdout?.on("data", (chunk) => {
      stdoutTail = appendBounded(stdoutTail, chunk.toString(), MAX_STDERR_CHARS);
    });
    child.stderr?.on("data", (chunk) => {
      stderrTail = appendBounded(stderrTail, chunk.toString(), MAX_STDERR_CHARS);
    });

    child.on("message", (message) => {
      void (async () => {
        if (!message || typeof message !== "object" || settled) return;
        if (message.type === "ready") {
          child.send({
            type: "configure",
            config: {
              workspace: workspaceHandle.workspace,
              workspaceDevice: identity.device,
              workspaceInode: identity.inode,
              binary,
              task,
              model,
              apiKeyEnvVar,
              stateRoot: isolatedState.root,
              openCodeEnv: isolatedState.env,
              timeoutMs,
              killGraceMs,
              killWaitMs,
              childStartHandshakeMs,
            },
          });
          return;
        }
        if (message.type === "credential_ready") {
          if (credentialSent) {
            abortAndFail(new CliFailureError("coding execution boundary requested credentials twice"));
            return;
          }
          if (message.inheritedCredentialPresent !== false) {
            abortAndFail(
              new CliFailureError("coding execution boundary inherited a provider credential"),
            );
            return;
          }
          if (typeof beforeCredential === "function") {
            await beforeCredential(workspaceHandle);
          }
          if (!(await workspaceAuthority.assertCurrent(workspaceHandle))) {
            abortAndFail(
              new CliFailureError("workspace ownership changed before credential handoff"),
            );
            return;
          }
          credentialSent = true;
          child.send({ type: "credential", credential });
          return;
        }
        if (message.type === "cli_started") {
          if (Number.isInteger(message.processGroupId) && message.processGroupId > 0) {
            cliProcessGroupId = message.processGroupId;
          }
          return;
        }
        if (message.type === "result") {
          receivedResult = true;
          if (message.ok === true) settle(resolve, message.result);
          else fail(errorFromBoundary(message.error));
        }
      })().catch((error) => abortAndFail(error));
    });

    child.on("error", (error) => {
      fail(
        new CliFailureError(
          `coding execution boundary failed: ${boundedRedacted(errorMessage(error), secrets, 1_000)}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (!receivedResult && !settled) {
        fail(
          new CliFailureError("coding execution boundary exited before returning a result", {
            exitCode: code,
            signal,
            stderrTail: boundedRedacted(stderrTail, secrets, MAX_STDERR_CHARS),
            stdoutTail: boundedRedacted(stdoutTail, secrets, MAX_STDERR_CHARS),
          }),
        );
      }
    });
  });
}

function validateExecutionIdentity(value) {
  if (
    !Number.isSafeInteger(value?.uid) ||
    value.uid < 1 ||
    !Number.isSafeInteger(value?.gid) ||
    value.gid < 1
  ) {
    throw new CliFailureError("coding execution identity is invalid");
  }
}

function chownTree(target, uid, gid) {
  const stat = lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) {
      chownTree(path.join(target, entry), uid, gid);
    }
  }
  chownSync(target, uid, gid);
}

function workspaceIdentity(handle) {
  const device = handle.record?.workspaceDevice ?? handle.workspaceDevice;
  const inode = handle.record?.workspaceInode ?? handle.workspaceInode;
  if (!/^\d+$/.test(String(device ?? "")) || !/^\d+$/.test(String(inode ?? ""))) {
    throw new CliFailureError("workspace authority omitted its filesystem identity");
  }
  return { device: String(device), inode: String(inode) };
}

function errorFromBoundary(payload) {
  const message = typeof payload?.message === "string" ? payload.message : "coding boundary failed";
  let error;
  switch (payload?.code) {
    case "timeout":
      error = new TimeoutError(payload.timeoutMs);
      break;
    case "malformed_output":
      error = new MalformedOutputError(message, { rawTail: payload.rawTail });
      break;
    case "output_too_large":
      error = new OutputTooLargeError(payload.limitBytes);
      break;
    case "credential_exposure":
      error = new CredentialExposureError(message);
      break;
    default:
      error = new CliFailureError(message, {
        exitCode: payload?.exitCode,
        signal: payload?.signal,
        stderrTail: payload?.stderrTail,
        stdoutTail: payload?.stdoutTail,
      });
  }
  if (payload?.containWorkspace === true) error.containWorkspace = true;
  return error;
}

export function prepareAnchoredWorkspace(stateRoot) {
  return resolveBaseCommit(".", stateRoot);
}

export async function executeAnchoredOpenCode({
  binary,
  task,
  model,
  apiKeyEnvVar,
  credential,
  stateRoot,
  openCodeEnv,
  baseCommit,
  timeoutMs,
  killGraceMs,
  killWaitMs,
  childStartHandshakeMs,
  onCliStart,
  signal,
}) {
  const secrets = secretVariants(credential);
  const env = { ...openCodeEnv, [apiKeyEnvVar]: credential };
  assertAnchoredWorkspaceSafe(secrets, stateRoot);

  const args = [
    "--pure",
    "run",
    task,
    "--format",
    "json",
    "-m",
    model,
    "--dir",
    ".",
    "--auto",
  ];
  const result = await runProcess(nodeSpawn, binary, args, {
    cwd: ".",
    env,
    timeoutMs,
    killGraceMs,
    killWaitMs,
    childStartHandshakeMs,
    secrets,
    onCliStart,
    signal,
  });

  assertAnchoredWorkspaceSafe(secrets, stateRoot, result.secretExposed);
  if (result.processError) throw result.processError;
  if (result.timedOut) throw new TimeoutError(timeoutMs);
  if (result.exitCode !== 0) {
    throw new CliFailureError(`${binary} exited with code ${result.exitCode}`, {
      exitCode: result.exitCode,
      signal: result.signal,
      stderrTail: result.stderrTail,
      stdoutTail: result.stdoutLog,
    });
  }

  const usage = result.protocol.result(binary);
  const rawDiff = computeDiff(".", baseCommit, stateRoot);
  if (containsSecret(rawDiff, secrets)) {
    const error = new CredentialExposureError("credential exposure detected; workspace contained");
    error.containWorkspace = true;
    throw error;
  }
  return {
    diff: redact(rawDiff, secrets),
    log: boundedRedacted(result.stdoutLog, secrets, MAX_LOG_CHARS),
    usage,
  };
}

export function serializeBoundaryError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "cli_failure",
    message: String(error?.message ?? "coding boundary failed").slice(0, 1_000),
    ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}),
    ...(typeof error?.signal === "string" ? { signal: error.signal } : {}),
    ...(Number.isInteger(error?.timeoutMs) ? { timeoutMs: error.timeoutMs } : {}),
    ...(Number.isInteger(error?.limitBytes) ? { limitBytes: error.limitBytes } : {}),
    ...(typeof error?.stderrTail === "string"
      ? { stderrTail: error.stderrTail.slice(-MAX_STDERR_CHARS) }
      : {}),
    ...(typeof error?.stdoutTail === "string"
      ? { stdoutTail: error.stdoutTail.slice(-MAX_STDERR_CHARS) }
      : {}),
    ...(typeof error?.rawTail === "string" ? { rawTail: error.rawTail.slice(-500) } : {}),
    ...(error?.containWorkspace === true ? { containWorkspace: true } : {}),
  };
}

export function redactBoundaryPayload(payload, credential) {
  let serialized = JSON.stringify(payload);
  for (const secret of secretVariants(credential)) {
    serialized = serialized.split(secret).join("[REDACTED]");
  }
  return JSON.parse(serialized);
}

function runProcess(
  spawn,
  binary,
  args,
  {
    cwd,
    env,
    timeoutMs,
    killGraceMs,
    killWaitMs,
    childStartHandshakeMs,
    secrets,
    onCliStart,
    signal,
  },
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      reject(
        new CliFailureError(`failed to start ${binary}: ${redact(errorMessage(err), secrets)}`)
      );
      return;
    }

    let stdoutLog = "";
    let stderrTail = "";
    let settled = false;
    let timedOut = false;
    let spawned = false;
    let terminating = false;
    const closeState = { closed: false, exitCode: null, signal: null };
    const protocol = createProtocolAccumulator(secrets);
    const stdoutScanner = createSecretScanner(secrets);
    const stderrScanner = createSecretScanner(secrets);
    const overlap = longestSecret(secrets);

    const finish = (exitCode, exitSignal, processError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(handshakeTimer);
      signal?.removeEventListener("abort", abortForDeletion);
      protocol.end();
      resolve({
        stdoutLog: boundedRedacted(stdoutLog, secrets, MAX_LOG_CHARS),
        stderrTail: boundedRedacted(stderrTail, secrets, MAX_STDERR_CHARS),
        exitCode,
        signal: exitSignal,
        timedOut,
        protocol,
        processError,
        secretExposed: stdoutScanner.found() || stderrScanner.found(),
      });
    };

    let timeoutTimer;
    let handshakeTimer;
    let timeoutArmed = false;
    const armTimeout = () => {
      if (timeoutArmed || terminating || settled) return;
      timeoutArmed = true;
      clearTimeout(handshakeTimer);
      timeoutTimer = setTimeout(() => {
        beginTermination(null, { timeout: true });
      }, timeoutMs);
    };
    const beginTermination = (processError, { timeout = false } = {}) => {
      if (terminating || settled) return;
      terminating = true;
      timedOut = timeout;
      clearTimeout(timeoutTimer);
      clearTimeout(handshakeTimer);
      void terminateProcessTree(child, closeState, { killGraceMs, killWaitMs })
        .then(() => finish(closeState.exitCode, closeState.signal ?? "SIGKILL", processError))
        .catch((error) =>
          finish(
            closeState.exitCode,
            closeState.signal,
            new CliFailureError(
              `failed to terminate coding CLI process group: ${redact(errorMessage(error), secrets)}`,
            ),
          ),
        );
    };
    const abortForDeletion = () => {
      if (!spawned || settled) return;
      beginTermination(
        new CliFailureError("coding delegation cancelled because run workspace is being deleted"),
      );
    };
    const beginTimeout = () => {
      spawned = true;
      if (Number.isInteger(child.pid) && typeof onCliStart === "function") {
        onCliStart(child.pid);
      }
      if (signal?.aborted) {
        abortForDeletion();
        return;
      }
      if (Number.isSafeInteger(childStartHandshakeMs) && childStartHandshakeMs > 0) {
        handshakeTimer = setTimeout(() => {
          beginTermination(new CliFailureError("coding CLI child-start handshake timed out"));
        }, childStartHandshakeMs);
      } else {
        armTimeout();
      }
    };

    signal?.addEventListener("abort", abortForDeletion, { once: true });
    child.once("spawn", beginTimeout);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      if (childStartHandshakeMs) armTimeout();
      stdoutScanner.write(text);
      protocol.write(text);
      stdoutLog = appendBounded(stdoutLog, text, MAX_LOG_CHARS + overlap);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderrScanner.write(text);
      stderrTail = appendBounded(stderrTail, text, MAX_STDERR_CHARS + overlap);
    });

    child.on("error", (err) => {
      if (!terminating) {
        finish(
          null,
          null,
          new CliFailureError(`${binary} process error: ${redact(errorMessage(err), secrets)}`),
        );
      }
    });

    child.on("close", (exitCode, signal) => {
      closeState.closed = true;
      closeState.exitCode = exitCode;
      closeState.signal = signal;
      if (!terminating) finish(exitCode, signal);
    });
  });
}

async function terminateProcessTree(child, closeState, { killGraceMs, killWaitMs }) {
  const processGroup = process.platform !== "win32" && Number.isInteger(child.pid);
  if (processGroup) {
    await terminateProcessGroup(child.pid, { killGraceMs, killWaitMs });
    return;
  }
  child.kill("SIGTERM");
  const deadline = Date.now() + killGraceMs;
  while (!closeState.closed && Date.now() < deadline) {
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  if (closeState.closed) return;
  child.kill("SIGKILL");
  const killDeadline = Date.now() + killWaitMs;
  while (!closeState.closed && Date.now() < killDeadline) await delay(20);
  if (!closeState.closed) throw new Error("coding CLI remained alive");
}

function appendBounded(current, chunk, maxChars) {
  const next = current + chunk;
  if (next.length <= maxChars) return next;
  const overflow = next.length - maxChars;
  const cut = next.indexOf("\n", overflow);
  return cut === -1 ? next.slice(-maxChars) : next.slice(cut + 1);
}

function boundedRedacted(value, secrets, maxChars) {
  return appendBounded("", redact(value, secrets), maxChars);
}

function secretVariants(credential) {
  const bytes = Buffer.from(credential);
  const base64 = bytes.toString("base64");
  const percentEncoded = [...bytes]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  const variants = new Set([
    credential,
    base64,
    base64.replace(/=+$/, ""),
    base64.replaceAll("+", "-").replaceAll("/", "_"),
    base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    bytes.toString("hex"),
    bytes.toString("hex").toUpperCase(),
    percentEncoded,
    percentEncoded.toUpperCase(),
  ]);
  try {
    variants.add(encodeURIComponent(credential));
    variants.add(new URLSearchParams({ credential }).toString().slice("credential=".length));
  } catch {}
  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
}

function redact(value, secrets) {
  let safe = String(value ?? "");
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

function containsSecret(value, secrets) {
  return secrets.some((secret) => secret && value.includes(secret));
}

function longestSecret(secrets) {
  return secrets.reduce((max, secret) => Math.max(max, secret.length), 0);
}

function createSecretScanner(secrets) {
  const overlap = Math.max(0, longestSecret(secrets) - 1);
  let carry = "";
  let exposed = false;
  return {
    write(chunk) {
      const candidate = carry + chunk;
      exposed ||= containsSecret(candidate, secrets);
      carry = overlap > 0 ? candidate.slice(-overlap) : "";
    },
    found() {
      return exposed;
    },
  };
}

function createProtocolAccumulator(secrets) {
  let pending = "";
  let failure;
  let eventCount = 0;
  let sessionID;
  let openSteps = 0;
  let sawStepFinish = false;
  let reportedError = false;
  let lastType;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  const usageComplete = Object.fromEntries(
    Object.keys(usage).map((field) => [field, true]),
  );

  function malformed(message, rawTail = "") {
    return new MalformedOutputError(message, {
      rawTail: boundedRedacted(rawTail, secrets, 500),
    });
  }

  function consume(rawLine) {
    const line = rawLine.trim();
    if (!line || failure) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      failure = malformed("could not parse opencode output line as JSON", line);
      return;
    }

    try {
      if (!isRecord(event) || !EVENT_TYPES.has(event.type)) {
        throw malformed("opencode emitted an unexpected event shape");
      }
      if (!isFiniteNumber(event.timestamp) || typeof event.sessionID !== "string" || !event.sessionID) {
        throw malformed("opencode event metadata is malformed");
      }
      if (sessionID && event.sessionID !== sessionID) {
        throw malformed("opencode emitted events for multiple sessions");
      }
      sessionID ||= event.sessionID;
      eventCount += 1;
      lastType = event.type;

      if (event.type === "error") {
        if (!isRecord(event.error)) throw malformed("opencode error event is malformed");
        reportedError = true;
        return;
      }

      const expectedPartType = {
        step_start: "step-start",
        step_finish: "step-finish",
        text: "text",
        reasoning: "reasoning",
        tool_use: "tool",
      }[event.type];
      validatePart(event.part, expectedPartType, event.sessionID, malformed);

      if (event.type === "step_start") {
        openSteps += 1;
        return;
      }
      if (event.type === "step_finish") {
        if (openSteps === 0) throw malformed("opencode step finished without a matching start");
        validateAndAddUsage(event.part, usage, usageComplete, malformed);
        openSteps -= 1;
        sawStepFinish = true;
        return;
      }
      if (event.type === "text" || event.type === "reasoning") {
        if (typeof event.part.text !== "string") {
          throw malformed("opencode text event is malformed");
        }
        return;
      }
      if (
        typeof event.part.tool !== "string" ||
        !isRecord(event.part.state) ||
        !["completed", "error"].includes(event.part.state.status)
      ) {
        throw malformed("opencode tool event is malformed");
      }
    } catch (err) {
      failure = err instanceof MalformedOutputError ? err : malformed("opencode event is malformed");
    }
  }

  return {
    write(chunk) {
      if (failure) return;
      pending += chunk;
      if (pending.length > MAX_PROTOCOL_LINE_CHARS && !pending.includes("\n")) {
        failure = malformed("opencode output line exceeded the protocol limit");
        pending = "";
        return;
      }
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > MAX_PROTOCOL_LINE_CHARS) {
          failure = malformed("opencode output line exceeded the protocol limit");
          return;
        }
        consume(line);
      }
    },
    end() {
      consume(pending);
      pending = "";
    },
    result(binary) {
      if (failure) throw failure;
      if (eventCount === 0) {
        throw malformed(`${binary} produced no JSON events`);
      }
      if (reportedError) {
        throw new CliFailureError(`${binary} reported an error`);
      }
      if (!sawStepFinish || openSteps !== 0 || lastType !== "step_finish") {
        throw malformed("opencode output did not end in a completed step");
      }
      return Object.fromEntries(
        Object.entries(usage).map(([field, value]) => [
          field,
          usageComplete[field] ? value : null,
        ]),
      );
    },
  };
}

function validatePart(part, expectedType, eventSessionID, malformed) {
  if (
    !isRecord(part) ||
    part.type !== expectedType ||
    typeof part.id !== "string" ||
    typeof part.messageID !== "string" ||
    part.sessionID !== eventSessionID
  ) {
    throw malformed("opencode event part is malformed");
  }
}

function validateAndAddUsage(part, usage, usageComplete, malformed) {
  if (typeof part.reason !== "string") {
    throw malformed("opencode usage data is malformed");
  }
  if (part.tokens !== undefined && part.tokens !== null && !isRecord(part.tokens)) {
    throw malformed("opencode usage data is malformed");
  }
  if (
    part.tokens?.cache !== undefined &&
    part.tokens?.cache !== null &&
    !isRecord(part.tokens.cache)
  ) {
    throw malformed("opencode usage data is malformed");
  }

  addUsage("costUsd", part.cost, usage, usageComplete, malformed);
  addUsage("inputTokens", part.tokens?.input, usage, usageComplete, malformed);
  addUsage("outputTokens", part.tokens?.output, usage, usageComplete, malformed);
  addUsage("reasoningTokens", part.tokens?.reasoning, usage, usageComplete, malformed);
  addUsage("cacheReadTokens", part.tokens?.cache?.read, usage, usageComplete, malformed);
  addUsage("cacheWriteTokens", part.tokens?.cache?.write, usage, usageComplete, malformed);
}

function addUsage(field, value, usage, usageComplete, malformed) {
  if (value === undefined || value === null) {
    usageComplete[field] = false;
    return;
  }
  const tokenField = field !== "costUsd";
  if (tokenField ? !isDatabaseTokenCount(value) : !isDatabaseCost(value)) {
    throw malformed("opencode usage data is malformed");
  }
  if (usageComplete[field]) {
    const total = tokenField
      ? addTokenCounts(usage[field], value)
      : addCosts(usage[field], value);
    if (total === null) throw malformed("opencode usage totals overflowed");
    usage[field] = total;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function resolveBaseCommit(workspace, gitHome) {
  try {
    const commit = runSafeGit(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: workspace,
      home: gitHome,
      maxBuffer: 1024,
    })
      .toString()
      .trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("invalid commit");
    return commit;
  } catch {
    throw new CliFailureError("workspace is not an initialized Git repository");
  }
}

function inspectWorkspaceState(workspace, secrets, gitHome) {
  const secretBuffers = secrets.map((secret) => Buffer.from(secret));
  let scannedBytes = 0;
  let exposed = false;
  let failed = false;

  const inspect = (content) => {
    scannedBytes += content.length;
    if (scannedBytes > MAX_WORKSPACE_SCAN_BYTES) throw new Error("workspace scan limit exceeded");
    exposed ||= secretBuffers.some((secret) => content.includes(secret));
  };

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      inspect(Buffer.from(path.relative(workspace, target)));
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        inspect(Buffer.from(readlinkSync(target)));
      } else if (stat.isDirectory()) {
        walk(target);
      } else if (stat.isFile()) {
        if (stat.size > MAX_WORKSPACE_SCAN_BYTES - scannedBytes) {
          throw new Error("workspace scan limit exceeded");
        }
        inspect(readFileSync(target));
      } else {
        throw new Error("workspace contains an unsupported file type");
      }
    }
  };

  try {
    walk(workspace);
  } catch {
    failed = true;
  }

  try {
    const alternates = path.join(workspace, ".git", "objects", "info", "alternates");
    try {
      lstatSync(alternates);
      throw new Error("Git object alternates are not supported");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }

    const objects = runSafeGit(
      [
        "cat-file",
        "--batch-check=%(objectname) %(objecttype) %(objectsize)",
        "--batch-all-objects",
      ],
      { cwd: workspace, home: gitHome, maxBuffer: MAX_DIFF_BYTES }
    )
      .toString()
      .trim();
    for (const line of objects ? objects.split("\n") : []) {
      const [oid, type, sizeText] = line.split(" ");
      const size = Number(sizeText);
      if (
        !/^[0-9a-f]{40,64}$/.test(oid) ||
        !["blob", "commit", "tag", "tree"].includes(type) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > MAX_WORKSPACE_SCAN_BYTES
      ) {
        throw new Error("malformed Git object metadata");
      }
      inspect(
        runSafeGit(["cat-file", type, oid], {
          cwd: workspace,
          home: gitHome,
          maxBuffer: size + 1024,
        })
      );
    }
  } catch {
    failed = true;
  }

  return { exposed, failed };
}

function nulPaths(output) {
  return output.toString().split("\0").filter(Boolean);
}

function assertAnchoredWorkspaceSafe(secrets, gitHome, outputExposed = false) {
  if (outputExposed) {
    const error = new CredentialExposureError("credential exposure detected; workspace contained");
    error.containWorkspace = true;
    throw error;
  }

  const inspection = inspectWorkspaceState(".", secrets, gitHome);
  if (inspection.exposed) {
    const error = new CredentialExposureError("credential exposure detected; workspace contained");
    error.containWorkspace = true;
    throw error;
  }
  if (inspection.failed) {
    const error = new CliFailureError("failed to inspect workspace for credential exposure");
    error.containWorkspace = true;
    throw error;
  }
}

async function containCredentialExposure(workspaceAuthority, workspaceHandle) {
  try {
    await workspaceAuthority.containCredentialExposure(workspaceHandle);
  } catch {
    throw new CliFailureError("failed to contain contaminated workspace");
  }
}

function createTemporaryWorkspaceAuthority() {
  return {
    async resolve(workspace) {
      const ownership = getOwnedWorkspace(workspace);
      if (!ownership) {
        throw new CliFailureError(
          "workspace must be created by createIsolatedGitWorkspace in this process",
        );
      }
      const stat = lstatSync(ownership.workspace);
      return {
        workspace: ownership.workspace,
        workspaceDevice: String(stat.dev),
        workspaceInode: String(stat.ino),
        ownership,
      };
    },
    async assertCurrent(handle) {
      return getOwnedWorkspace(handle.workspace) === handle.ownership;
    },
    async containCredentialExposure(handle) {
      if (!(await removeOwnedWorkspace(handle.ownership))) {
        throw new Error("workspace ownership changed");
      }
    },
  };
}

function computeDiff(workspace, baseCommit, gitHome) {
  try {
    const tracked = runSafeGit(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--binary",
        baseCommit,
        "--",
      ],
      { cwd: workspace, home: gitHome, maxBuffer: MAX_DIFF_BYTES + 1 }
    );
    if (tracked.length > MAX_DIFF_BYTES) throw new OutputTooLargeError(MAX_DIFF_BYTES);
    const parts = [tracked];
    let totalBytes = tracked.length;
    const untracked = nulPaths(
      runSafeGit(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: workspace,
        home: gitHome,
        maxBuffer: MAX_DIFF_BYTES + 1,
      })
    );
    for (const file of untracked) {
      const remaining = MAX_DIFF_BYTES - totalBytes;
      const fileDiff = runSafeGit(
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-index",
            "--binary",
            "--",
            devNull,
            file,
          ],
          {
            cwd: workspace,
            home: gitHome,
            allowedExitCodes: [0, 1],
            maxBuffer: remaining + 1,
          }
        );
      if (fileDiff.length > remaining) throw new OutputTooLargeError(MAX_DIFF_BYTES);
      parts.push(fileDiff);
      totalBytes += fileDiff.length;
    }
    return Buffer.concat(parts, totalBytes).toString();
  } catch (error) {
    if (error instanceof OutputTooLargeError || error?.code === "GIT_OUTPUT_LIMIT") {
      throw new OutputTooLargeError(MAX_DIFF_BYTES);
    }
    throw new CliFailureError("failed to compute workspace diff");
  }
}
