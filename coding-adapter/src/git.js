import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import path from "node:path";

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function runSafeGit(
  args,
  { cwd, home, allowedExitCodes = [0], maxBuffer = DEFAULT_MAX_BUFFER } = {}
) {
  const result = spawnSync(
    "git",
    [
      "--no-pager",
      "-c",
      `core.hooksPath=${path.join(home, "disabled-hooks")}`,
      "-c",
      `core.attributesFile=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      ...args,
    ],
    {
      cwd,
      env: safeGitEnv(home),
      maxBuffer,
    }
  );
  if (result.error || !allowedExitCodes.includes(result.status)) {
    throw new Error("isolated git command failed");
  }
  return result.stdout ?? Buffer.alloc(0);
}

function safeGitEnv(home) {
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot || "C:\\Windows";
  }
  return env;
}
