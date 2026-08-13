import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./errors.js";

export function createExecutionIdentityStore({
  workspaceRoot,
  uidMin = 20_000,
  uidCount = 40_000,
  gidForUid = (uid) => uid,
  applyOwnership = chownTree,
} = {}) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new WorkspaceError("execution identity workspace root must be absolute");
  }
  if (!Number.isSafeInteger(uidMin) || uidMin < 1) {
    throw new WorkspaceError("execution identity UID minimum is invalid");
  }
  if (!Number.isSafeInteger(uidCount) || uidCount < 1 || uidMin + uidCount > 2 ** 31) {
    throw new WorkspaceError("execution identity UID count is invalid");
  }
  if (typeof gidForUid !== "function" || typeof applyOwnership !== "function") {
    throw new WorkspaceError("execution identity ownership policy is invalid");
  }

  const identityRoot = path.join(workspaceRoot, ".orbitflow", "executor-identities");
  let lifecycle = Promise.resolve();
  let initialized;

  async function initialize() {
    if (!initialized) {
      initialized = (async () => {
        await mkdir(identityRoot, { recursive: true, mode: 0o700 });
        await chmod(identityRoot, 0o700);
      })();
    }
    return initialized;
  }

  function serialize(operation) {
    const current = lifecycle.then(operation);
    lifecycle = current.catch(() => {});
    return current;
  }

  function ensure(runIdValue, workspace) {
    return serialize(async () => {
      await initialize();
      const runId = normalizeRunId(runIdValue);
      const existing = await readIdentity(runId);
      if (existing) return validateIdentity(existing, runId, workspace);

      const used = new Set();
      for (const entry of await readdir(identityRoot)) {
        if (!/^run-[1-9][0-9]*\.json$/.test(entry)) continue;
        const identity = parseIdentity(await readFile(path.join(identityRoot, entry), "utf8"));
        validateAllocatedIdentity(identity);
        if (entry !== `run-${identity.runId}.json` || used.has(identity.uid)) {
          throw new WorkspaceError("coding execution identity allocation state is invalid");
        }
        used.add(identity.uid);
      }

      const start = Number(BigInt(runId) % BigInt(uidCount));
      let uid = null;
      for (let offset = 0; offset < uidCount; offset += 1) {
        const candidate = uidMin + ((start + offset) % uidCount);
        if (!used.has(candidate)) {
          uid = candidate;
          break;
        }
      }
      if (uid === null) throw new WorkspaceError("coding execution identity pool is exhausted");
      const gid = gidForUid(uid);
      if (!Number.isSafeInteger(gid) || gid < 1) {
        throw new WorkspaceError("coding execution GID is invalid");
      }

      const canonicalWorkspace = await requireExpectedWorkspace(runId, workspace);
      await applyOwnership(canonicalWorkspace, uid, gid);
      await chmod(canonicalWorkspace, 0o700);
      const stat = await lstat(canonicalWorkspace);
      const identity = {
        version: 1,
        runId,
        workspace: canonicalWorkspace,
        workspaceDevice: String(stat.dev),
        workspaceInode: String(stat.ino),
        uid,
        gid,
      };
      if (stat.uid !== uid || stat.gid !== gid) {
        throw new WorkspaceError("coding execution identity ownership was not applied");
      }
      await writeFile(identityPath(runId), `${JSON.stringify(identity)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return identity;
    });
  }

  async function requireIdentity(runIdValue, workspace) {
    await initialize();
    const runId = normalizeRunId(runIdValue);
    const identity = await readIdentity(runId);
    if (!identity) throw new WorkspaceError("run workspace must be started before coding delegation");
    return validateIdentity(identity, runId, workspace);
  }

  function retire(cleanup) {
    return serialize(async () => {
      await initialize();
      validateCleanupProof(cleanup);
      const identity = await readIdentity(cleanup.runId);
      if (!identity) {
        throw new WorkspaceError("coding execution identity is missing; retirement refused");
      }
      validateAllocatedIdentity(identity);
      if (
        identity.runId !== cleanup.runId ||
        identity.workspace !== cleanup.workspace ||
        identity.workspaceDevice !== cleanup.workspaceDevice ||
        identity.workspaceInode !== cleanup.workspaceInode ||
        identity.uid !== cleanup.uid ||
        identity.gid !== cleanup.gid
      ) {
        throw new WorkspaceError("coding execution identity changed; retirement refused");
      }
      await unlink(identityPath(cleanup.runId));
    });
  }

  async function validateIdentity(identity, runId, workspace) {
    validateAllocatedIdentity(identity);
    const canonicalWorkspace = await requireExpectedWorkspace(runId, workspace);
    const stat = await lstat(canonicalWorkspace);
    if (
      identity.runId !== runId ||
      identity.workspace !== canonicalWorkspace ||
      identity.workspaceDevice !== String(stat.dev) ||
      identity.workspaceInode !== String(stat.ino) ||
      identity.uid < uidMin ||
      identity.uid >= uidMin + uidCount ||
      identity.gid !== gidForUid(identity.uid) ||
      stat.uid !== identity.uid ||
      stat.gid !== identity.gid
    ) {
      throw new WorkspaceError("coding execution identity is invalid");
    }
    return identity;
  }

  async function requireExpectedWorkspace(runId, workspace) {
    const expected = path.join(workspaceRoot, `run-${runId}`);
    if (workspace !== expected || await realpath(workspace) !== expected) {
      throw new WorkspaceError("coding execution workspace is invalid");
    }
    const stat = await lstat(expected);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceError("coding execution workspace is invalid");
    }
    return expected;
  }

  async function readIdentity(runId) {
    try {
      return parseIdentity(await readFile(identityPath(runId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  function identityPath(runId) {
    return path.join(identityRoot, `run-${runId}.json`);
  }

  return Object.freeze({ ensure, require: requireIdentity, retire, identityRoot });
}

function validateCleanupProof(value) {
  const expected = [
    "gid",
    "runId",
    "uid",
    "workspace",
    "workspaceDevice",
    "workspaceId",
    "workspaceInode",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().some((key, index) => key !== expected[index]) ||
    Object.keys(value).length !== expected.length ||
    !/^[1-9][0-9]*$/.test(value.runId ?? "") ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId === "" ||
    typeof value.workspace !== "string" ||
    !path.isAbsolute(value.workspace) ||
    !/^\d+$/.test(value.workspaceDevice ?? "") ||
    !/^\d+$/.test(value.workspaceInode ?? "") ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 1 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 1
  ) {
    throw new WorkspaceError("workspace cleanup proof is invalid; identity retained");
  }
}

function validateAllocatedIdentity(value) {
  if (
    !value ||
    value.version !== 1 ||
    !/^[1-9][0-9]*$/.test(value.runId ?? "") ||
    typeof value.workspace !== "string" ||
    !path.isAbsolute(value.workspace) ||
    !/^\d+$/.test(value.workspaceDevice ?? "") ||
    !/^\d+$/.test(value.workspaceInode ?? "") ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 1 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 1
  ) {
    throw new WorkspaceError("coding execution identity record is invalid");
  }
}

function parseIdentity(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new WorkspaceError("coding execution identity record is malformed");
  }
}

function normalizeRunId(value) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new WorkspaceError("execution identity runId must be a positive integer");
  }
  return text;
}

async function chownTree(target, uid, gid) {
  const stat = await lstat(target);
  if (stat.isDirectory()) {
    for (const entry of await readdir(target)) {
      await chownTree(path.join(target, entry), uid, gid);
    }
  }
  if (stat.isSymbolicLink()) await lchown(target, uid, gid);
  else await chown(target, uid, gid);
}
