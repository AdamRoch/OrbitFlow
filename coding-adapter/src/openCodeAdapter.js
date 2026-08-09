// v1 CodingToolAdapter: wraps the `opencode` CLI headlessly.
//
// delegate_coding_task(task, workspace) -> { diff, log, usage }
//
// See ../DECISION.md for why opencode was picked over claude/codex.

import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MissingCredentialsError,
  CliFailureError,
  TimeoutError,
  MalformedOutputError,
} from "./errors.js";

const DEFAULT_MODEL = "openrouter/anthropic/claude-haiku-4.5";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOG_CHARS = 20_000;
const MAX_STDERR_CHARS = 4_000;

export function createOpenCodeAdapter({
  spawn = nodeSpawn,
  apiKeyEnvVar = "OPENROUTER_API_KEY",
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = "opencode",
  env = process.env,
  // Give every call its own XDG state dirs so opencode can never fall back
  // to a builder's locally stored provider credentials (~/.local/share/opencode/auth.json)
  // -- only apiKeyEnvVar is honored. Verified live: without this, a dev
  // machine with pre-existing opencode config makes the run fail even with
  // a valid OPENROUTER_API_KEY set. Disable only for tests/debugging.
  isolateState = true,
} = {}) {
  async function delegate_coding_task(task, workspace) {
    if (!env[apiKeyEnvVar]) {
      throw new MissingCredentialsError(apiKeyEnvVar);
    }

    const spawnEnv = isolateState ? { ...env, ...(await isolatedStateEnv()) } : env;

    const args = ["run", task, "--format", "json", "-m", model, "--dir", workspace, "--auto"];
    const { stdout, stderr, exitCode, timedOut } = await runProcess(spawn, binary, args, {
      cwd: workspace,
      env: spawnEnv,
      timeoutMs,
    });

    if (timedOut) {
      throw new TimeoutError(timeoutMs);
    }

    if (exitCode !== 0) {
      throw new CliFailureError(`${binary} exited with code ${exitCode}`, {
        exitCode,
        stderrTail: tail(stderr, MAX_STDERR_CHARS),
        stdoutTail: tail(stdout, MAX_STDERR_CHARS),
      });
    }

    const events = parseEvents(stdout);
    if (events.length === 0) {
      throw new MalformedOutputError(`${binary} produced no parseable JSON events`, {
        rawTail: tail(stdout, MAX_STDERR_CHARS),
      });
    }

    return {
      diff: computeDiff(workspace),
      log: stdout,
      usage: summarizeUsage(events),
    };
  }

  return { delegate_coding_task };
}

async function isolatedStateEnv() {
  const base = await mkdtemp(path.join(tmpdir(), "opencode-state-"));
  return {
    XDG_CONFIG_HOME: path.join(base, "config"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_STATE_HOME: path.join(base, "state"),
    XDG_CACHE_HOME: path.join(base, "cache"),
  };
}

function runProcess(spawn, binary, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new CliFailureError(`failed to start ${binary}: ${err.message}`, {}));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 2000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString(), MAX_LOG_CHARS);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString(), MAX_STDERR_CHARS);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CliFailureError(`${binary} process error: ${err.message}`, {}));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}

// Keeps a bounded, line-aligned tail so a truncated first line never gets
// mistaken for malformed JSON.
function appendBounded(current, chunk, maxChars) {
  const next = current + chunk;
  if (next.length <= maxChars) return next;
  const overflow = next.length - maxChars;
  const cut = next.indexOf("\n", overflow);
  return cut === -1 ? next.slice(-maxChars) : next.slice(cut + 1);
}

function tail(str, max) {
  return str.length > max ? str.slice(str.length - max) : str;
}

function parseEvents(stdout) {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new MalformedOutputError("could not parse opencode output line as JSON", {
        rawTail: tail(line, 500),
      });
    }
  }
  return events;
}

function summarizeUsage(events) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  for (const e of events) {
    const t = e?.part?.tokens;
    if (t) {
      inputTokens += t.input || 0;
      outputTokens += t.output || 0;
      cacheReadTokens += t.cache?.read || 0;
      cacheWriteTokens += t.cache?.write || 0;
    }
    if (typeof e?.part?.cost === "number") costUsd += e.part.cost;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

function computeDiff(workspace) {
  execFileSync("git", ["add", "-A"], { cwd: workspace });
  return execFileSync("git", ["diff", "--cached"], {
    cwd: workspace,
    maxBuffer: 10 * 1024 * 1024,
  }).toString();
}
