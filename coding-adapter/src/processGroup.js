import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export function inspectProcessGroup(
  processGroupId,
  signal = process.kill,
  inspectTable = inspectProcessTable,
) {
  try {
    signal(-processGroupId, 0);
    return Object.freeze({ state: "alive", code: null });
  } catch (error) {
    if (error?.code === "ESRCH") {
      return Object.freeze({ state: "absent", code: "ESRCH" });
    }
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    const tableState = inspectTable(processGroupId);
    if (tableState === "absent") {
      return Object.freeze({ state: "absent", code: `${code}_CONFIRMED_ABSENT` });
    }
    if (tableState === "alive") {
      return Object.freeze({ state: "alive", code: `${code}_CONFIRMED_ALIVE` });
    }
    return Object.freeze({ state: "uninspectable", code });
  }
}

function inspectProcessTable(processGroupId) {
  if (process.platform === "linux") return inspectLinuxProc(processGroupId);
  const result = spawnSync("ps", ["-axo", "pgid=,state="], {
    encoding: "utf8",
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return "uninspectable";
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    if (match && Number(match[1]) === processGroupId) return "alive";
  }
  return "absent";
}

function inspectLinuxProc(processGroupId) {
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return "uninspectable";
  }
  let unreadable = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === processGroupId) return "alive";
    } catch (error) {
      if (error?.code !== "ENOENT") unreadable = true;
    }
  }
  return unreadable ? "uninspectable" : "absent";
}

export function signalProcessGroup(processGroupId, signalName, signal = process.kill) {
  try {
    signal(-processGroupId, signalName);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function waitForProcessGroupAbsence(
  processGroupId,
  timeoutMs,
  { inspect = inspectProcessGroup } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = inspect(processGroupId);
    if (result.state === "absent") return;
    if (result.state === "uninspectable") {
      throw new Error(`process group liveness is uninspectable (${result.code})`);
    }
    await delay(Math.min(20, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);

  const result = inspect(processGroupId);
  if (result.state === "absent") return;
  if (result.state === "uninspectable") {
    throw new Error(`process group liveness is uninspectable (${result.code})`);
  }
  throw new Error("process group remained alive");
}

export async function terminateProcessGroup(
  processGroupId,
  { killGraceMs, killWaitMs, signal = process.kill, inspect = inspectProcessGroup },
) {
  signalProcessGroup(processGroupId, "SIGTERM", signal);
  try {
    await waitForProcessGroupAbsence(processGroupId, killGraceMs, { inspect });
    return;
  } catch (error) {
    if (!String(error?.message).includes("remained alive")) throw error;
  }

  signalProcessGroup(processGroupId, "SIGKILL", signal);
  await waitForProcessGroupAbsence(processGroupId, killWaitMs, { inspect });
}
