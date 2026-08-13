import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export const OPENCLAW_CONTEXT_FILE = ".orbitflow-tool-context.json";

export async function loadOpenClawToolContext({ agentWorkspaceRoot, workspace }) {
  const workspaceRoot = await realpath(agentWorkspaceRoot);
  const canonicalWorkspace = await realpath(workspace);
  const relative = path.relative(workspaceRoot, canonicalWorkspace);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("tool must run from an active OrbitFlow agent workspace");
  }
  const context = JSON.parse(
    await readFile(path.join(canonicalWorkspace, OPENCLAW_CONTEXT_FILE), "utf8"),
  );
  validateOpenClawToolContext(context, canonicalWorkspace);
  return { context, workspace: canonicalWorkspace };
}

export function validateOpenClawToolContext(value, workspace) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("active dispatch context is invalid");
  }
  const expected = [
    "agentId",
    "dispatchGeneration",
    "dispatchId",
    "dispatchSessionId",
    "invocationId",
    "nodeId",
    "runId",
    "ticketId",
    "version",
    "workspace",
  ];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error("active dispatch context has unexpected fields");
  }
  if (value.version !== 1 || value.workspace !== workspace) {
    throw new Error("active dispatch context does not match this workspace");
  }
  for (const field of ["agentId", "dispatchGeneration", "dispatchId", "runId"]) {
    if (typeof value[field] !== "string" || !/^[1-9][0-9]*$/.test(value[field])) {
      throw new Error(`active dispatch ${field} is invalid`);
    }
  }
  if (value.ticketId !== null && (typeof value.ticketId !== "string" || !/^[1-9][0-9]*$/.test(value.ticketId))) {
    throw new Error("active dispatch ticketId is invalid");
  }
  for (const field of ["dispatchSessionId", "invocationId", "nodeId"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`active dispatch ${field} is invalid`);
    }
  }
}

export function immutableDispatchContext(value) {
  return {
    version: value.version,
    agentId: value.agentId,
    runId: value.runId,
    ticketId: value.ticketId,
    nodeId: value.nodeId,
    invocationId: value.invocationId,
    dispatchId: value.dispatchId,
    dispatchGeneration: value.dispatchGeneration,
    dispatchSessionId: value.dispatchSessionId,
  };
}
