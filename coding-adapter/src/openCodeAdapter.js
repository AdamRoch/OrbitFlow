// v1 CodingToolAdapter: wraps the `opencode` CLI headlessly.
//
// delegate_coding_task(task, workspace) -> { diff, log, usage }
//
// See ../DECISION.md for why opencode was picked over claude/codex.

import { spawn as nodeSpawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MissingCredentialsError,
  CliFailureError,
  TimeoutError,
  MalformedOutputError,
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

const DEFAULT_MODEL = "openrouter/anthropic/claude-haiku-4.5";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOG_CHARS = 20_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_DIFF_BYTES = 10 * 1024 * 1024;
const EVENT_TYPES = new Set(["step_start", "step_finish", "text", "reasoning", "tool_use", "error"]);

export function createOpenCodeAdapter({
  spawn = nodeSpawn,
  apiKeyEnvVar = "OPENROUTER_API_KEY",
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = OPEN_CODE_BINARY,
  env = process.env,
} = {}) {
  async function delegate_coding_task(task, workspace) {
    const credential = env[apiKeyEnvVar];
    if (typeof credential !== "string" || credential.length === 0) {
      throw new MissingCredentialsError(apiKeyEnvVar);
    }

    const isolatedState = await createIsolatedState(apiKeyEnvVar, credential, env.PATH);
    try {
      const args = [
        "--pure",
        "run",
        task,
        "--format",
        "json",
        "-m",
        model,
        "--dir",
        workspace,
        "--auto",
      ];
      const result = await runProcess(spawn, binary, args, {
        cwd: workspace,
        env: isolatedState.env,
        timeoutMs,
        secrets: [credential],
      });

      if (result.secretExposed) {
        throw new CredentialExposureError("credential detected in coding CLI output");
      }

      if (result.timedOut) {
        throw new TimeoutError(timeoutMs);
      }

      if (result.exitCode !== 0) {
        throw new CliFailureError(`${binary} exited with code ${result.exitCode}`, {
          exitCode: result.exitCode,
          signal: result.signal,
          stderrTail: result.stderrTail,
          stdoutTail: result.stdoutLog,
        });
      }

      const usage = result.protocol.result(binary);
      const rawDiff = computeDiff(workspace);
      if (containsSecret(rawDiff, [credential])) {
        throw new CredentialExposureError("credential detected in workspace diff");
      }

      return {
        diff: redact(rawDiff, [credential]),
        log: boundedRedacted(result.stdoutLog, [credential], MAX_LOG_CHARS),
        usage,
      };
    } finally {
      try {
        await rm(isolatedState.root, { recursive: true, force: true });
      } catch {
        throw new CliFailureError("failed to clean isolated opencode state");
      }
    }
  }

  return { delegate_coding_task };
}

async function createIsolatedState(apiKeyEnvVar, credential, toolPath) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-state-"));
  return {
    root,
    env: {
      [apiKeyEnvVar]: credential,
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
    },
  };
}

function runProcess(spawn, binary, args, { cwd, env, timeoutMs, secrets }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    let forceKillTimer;
    let settleTimer;
    const protocol = createProtocolAccumulator(secrets);
    const stdoutScanner = createSecretScanner(secrets);
    const stderrScanner = createSecretScanner(secrets);
    const overlap = longestSecret(secrets);

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
      protocol.end();
      resolve({
        stdoutLog: boundedRedacted(stdoutLog, secrets, MAX_LOG_CHARS),
        stderrTail: boundedRedacted(stderrTail, secrets, MAX_STDERR_CHARS),
        exitCode,
        signal,
        timedOut,
        protocol,
        secretExposed: stdoutScanner.found() || stderrScanner.found(),
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        finish(null, "SIGTERM");
        return;
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          finish(null, "SIGKILL");
          return;
        }
        settleTimer = setTimeout(() => finish(null, "SIGKILL"), 250);
      }, 2000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
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
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
      reject(new CliFailureError(`${binary} process error: ${redact(errorMessage(err), secrets)}`));
    });

    child.on("close", finish);
  });
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
        validateAndAddUsage(event.part, usage, malformed);
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
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
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
      return usage;
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

function validateAndAddUsage(part, usage, malformed) {
  const tokens = part.tokens;
  const values = [
    part.cost,
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache?.read,
    tokens?.cache?.write,
  ];
  if (typeof part.reason !== "string" || !values.every(isNonNegativeFiniteNumber)) {
    throw malformed("opencode usage data is malformed");
  }

  usage.costUsd += part.cost;
  usage.inputTokens += tokens.input;
  usage.outputTokens += tokens.output;
  usage.reasoningTokens += tokens.reasoning;
  usage.cacheReadTokens += tokens.cache.read;
  usage.cacheWriteTokens += tokens.cache.write;
  if (!Object.values(usage).every(Number.isFinite)) {
    throw malformed("opencode usage totals overflowed");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function computeDiff(workspace) {
  try {
    const tracked = execFileSync("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: workspace,
      maxBuffer: MAX_DIFF_BYTES,
    }).toString();
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: workspace, maxBuffer: MAX_DIFF_BYTES }
    )
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((file) => {
        const result = spawnSync(
          "git",
          ["diff", "--no-index", "--binary", "--", devNull, file],
          { cwd: workspace, maxBuffer: MAX_DIFF_BYTES }
        );
        if (![0, 1].includes(result.status)) throw new Error("git diff failed");
        return result.stdout.toString();
      })
      .join("");
    return tracked + untracked;
  } catch {
    throw new CliFailureError("failed to compute workspace diff");
  }
}
