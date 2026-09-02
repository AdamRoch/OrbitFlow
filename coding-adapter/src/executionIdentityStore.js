import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./errors.js";
import { chownTree, normalizeId } from "./shared.js";

const RECORD_VERSION = 2;

export function createExecutionIdentityStore({
  workspaceRoot,
  uidMin = 20_000,
  uidCount = 40_000,
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
      const runId = normalizeId(runIdValue, "runId");
      const expectedWorkspace = await requireExpectedRunWorkspace(workspaceRoot, runId, workspace);
      const allocations = await readAllocations(identityRoot);
      const opaqueUids = new Set(
        allocations.filter((allocation) => !allocation.record).map((allocation) => allocation.uid),
      );
      if (await workspaceContainsOwnedPath(expectedWorkspace, opaqueUids)) {
        throw new WorkspaceError("coding execution identity reservation is incomplete");
      }
      const matching = allocations.filter((allocation) => allocation.runId === runId);
      if (matching.length > 1) {
        throw new WorkspaceError("coding execution run has conflicting permanent reservations");
      }
      if (matching[0]) {
        if (matching[0].record?.state !== "active") {
          throw new WorkspaceError("coding execution identity reservation is incomplete");
        }
        return validateActiveIdentity(matching[0].record, runId, expectedWorkspace, { uidMin, uidCount });
      }

      const used = new Set(allocations.map((allocation) => allocation.uid));
      const start = Number(BigInt(runId) % BigInt(uidCount));
      for (let offset = 0; offset < uidCount; offset += 1) {
        const uid = uidMin + ((start + offset) % uidCount);
        if (used.has(uid)) continue;
        const gid = uid;
        const reservation = {
          version: RECORD_VERSION,
          state: "reserved",
          runId,
          workspace: expectedWorkspace,
          uid,
          gid,
        };
        const reservationPath = identityPath(identityRoot, uid);
        try {
          await publishDurableExclusive(reservationPath, reservation, identityRoot);
        } catch (error) {
          if (error?.code === "EEXIST") {
            const competing = await readUidAllocation(reservationPath, uid);
            if (competing.runId === runId) {
              throw new WorkspaceError("coding execution identity reservation is incomplete");
            }
            used.add(uid);
            continue;
          }
          throw error;
        }

        await chownTree(expectedWorkspace, uid, gid);
        await chmod(expectedWorkspace, 0o700);
        const stat = await lstat(expectedWorkspace);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== uid ||
          stat.gid !== gid
        ) {
          throw new WorkspaceError("coding execution identity ownership was not applied");
        }
        const active = {
          ...reservation,
          state: "active",
          workspaceDevice: String(stat.dev),
          workspaceInode: String(stat.ino),
        };
        await replaceDurably(reservationPath, active, identityRoot);
        return active;
      }
      throw new WorkspaceError("coding execution identity pool is exhausted");
    });
  }

  async function requireIdentity(runIdValue, workspace) {
    await initialize();
    const runId = normalizeId(runIdValue, "runId");
    const expectedWorkspace = await requireExpectedRunWorkspace(workspaceRoot, runId, workspace);
    const matching = (await readAllocations(identityRoot))
      .filter((allocation) => allocation.runId === runId);
    if (matching.length !== 1 || matching[0].record?.state !== "active") {
      throw new WorkspaceError("run workspace has no active coding execution identity");
    }
    return validateActiveIdentity(matching[0].record, runId, expectedWorkspace, { uidMin, uidCount });
  }

  return Object.freeze({ ensure, require: requireIdentity, identityRoot });
}

async function readAllocations(identityRoot) {
  const allocations = [];
  const used = new Set();
  for (const entry of await readdir(identityRoot)) {
    const uidMatch = entry.match(/^uid-([1-9][0-9]*)\.json$/);
    if (!uidMatch) {
      if (entry.endsWith(".json")) {
        throw new WorkspaceError("coding execution identity allocation state is invalid");
      }
      continue;
    }
    const uid = Number(uidMatch[1]);
    if (used.has(uid)) {
      throw new WorkspaceError("coding execution identity allocation state is invalid");
    }
    used.add(uid);
    allocations.push(await readUidAllocation(path.join(identityRoot, entry), uid, entry));
  }
  return allocations;
}

async function readUidAllocation(target, uid, entry = path.basename(target)) {
  let value;
  let runId;
  try {
    value = JSON.parse(await readFile(target, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      runId = claimedRunId(value.runId);
    }
    validatePermanentRecord(value);
    if (value.uid !== uid) throw new WorkspaceError("coding execution identity record is invalid");
    return { entry, uid, runId: value.runId, record: value };
  } catch {
    return { entry, uid, runId, record: null };
  }
}

function claimedRunId(value) {
  return /^[1-9][0-9]*$/.test(value ?? "") ? value : undefined;
}

async function validateActiveIdentity(record, runId, workspace, range) {
  validatePermanentRecord(record);
  if (
    record.state !== "active" ||
    record.runId !== runId ||
    record.workspace !== workspace ||
    record.uid < range.uidMin ||
    record.uid >= range.uidMin + range.uidCount ||
    record.gid !== record.uid
  ) {
    throw new WorkspaceError("coding execution identity is invalid");
  }
  const canonicalWorkspace = await realpath(workspace);
  const stat = await lstat(canonicalWorkspace);
  if (
    canonicalWorkspace !== workspace ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    record.workspaceDevice !== String(stat.dev) ||
    record.workspaceInode !== String(stat.ino) ||
    stat.uid !== record.uid ||
    stat.gid !== record.gid
  ) {
    throw new WorkspaceError("coding execution identity is invalid");
  }
  return record;
}

function validatePermanentRecord(value) {
  const common =
    value &&
    /^[1-9][0-9]*$/.test(value.runId ?? "") &&
    typeof value.workspace === "string" &&
    path.isAbsolute(value.workspace) &&
    Number.isSafeInteger(value.uid) &&
    value.uid > 0 &&
    Number.isSafeInteger(value.gid) &&
    value.gid > 0;
  const activeIdentity =
    /^\d+$/.test(value?.workspaceDevice ?? "") &&
    /^\d+$/.test(value?.workspaceInode ?? "");
  const valid = common && value.version === RECORD_VERSION && (
    value.state === "reserved" || (value.state === "active" && activeIdentity)
  );
  if (!valid) {
    throw new WorkspaceError("coding execution identity record is invalid");
  }
}

async function writeDurableExclusive(target, value, directory) {
  let handle;
  let failure;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    await handle?.close();
    if (handle) await syncDirectory(directory);
  }
  if (failure) throw failure;
}

async function publishDurableExclusive(target, value, directory) {
  const temporary = path.join(directory, `.reservation-${value.uid}-${randomUUID()}.tmp`);
  await writeDurableExclusive(temporary, value, directory);
  try {
    await link(temporary, target);
    await syncDirectory(directory);
  } finally {
    try {
      await unlink(temporary);
      await syncDirectory(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function replaceDurably(target, value, directory) {
  const temporary = path.join(directory, `.activation-${value.uid}-${randomUUID()}.tmp`);
  await writeDurableExclusive(temporary, value, directory);
  await rename(temporary, target);
  await syncDirectory(directory);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function requireExpectedRunWorkspace(workspaceRoot, runId, workspace) {
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

function identityPath(identityRoot, uid) {
  return path.join(identityRoot, `uid-${uid}.json`);
}

async function workspaceContainsOwnedPath(target, uids) {
  if (uids.size === 0) return false;
  const stat = await lstat(target);
  if (uids.has(stat.uid)) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  for (const entry of await readdir(target)) {
    if (await workspaceContainsOwnedPath(path.join(target, entry), uids)) return true;
  }
  return false;
}
