import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSafeGit } from "./git.js";
import { WorkspaceError } from "./errors.js";

const CONTROL_DIRECTORY = ".orbitflow";
const QUARANTINE_DIRECTORY = "quarantine";
const DISPOSAL_DIRECTORY = "disposal";
const WORKSPACE_MARKER = "orbitflow-workspace.json";
const RECORD_VERSION = 1;
const DELETION_CHANNEL = "orbitflow_workspace_deletion";
const CLEANUP_BOUNDARY = fileURLToPath(new URL("./workspaceCleanupBoundary.js", import.meta.url));

export function createRunWorkspaceService({
  pool,
  workspaceRoot,
  beforeDelegationJoin,
  beforeCleanupBoundary,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new WorkspaceError("a PostgreSQL pool is required for run workspaces");
  }
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new WorkspaceError("ORBITFLOW_WORKSPACE_ROOT must be an absolute path");
  }

  let initialized;
  const delegationCoordinator = createDelegationCoordinator(pool);

  async function initialize() {
    if (!initialized) initialized = initializeRoot(workspaceRoot);
    return initialized;
  }

  async function startRunWorkspace(runIdValue) {
    let client;
    let inTransaction = false;
    try {
      const runId = normalizeId(runIdValue, "runId");
      const root = await initialize();
      client = await pool.connect();
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('orbitfactory:workspace:' || $1, 0))",
        [runId],
      );
      await requireRun(client, runId);
      await assertRootCurrent(root);
      const workspace = expectedWorkspace(root, runId);
      const record = await readRecordIfPresent(root, runId);

      let handle;
      if (record) {
        handle = await validateRecord(root, runId, workspace, record);
      } else {
        handle = await createWorkspace(root, runId, workspace);
      }
      await client.query("COMMIT");
      inTransaction = false;
      return handle.workspace;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {}
      }
      throw asWorkspaceError(error);
    } finally {
      client?.release();
    }
  }

  async function resolveWorkspace(runIdValue, workspaceValue) {
    try {
      const runId = normalizeId(runIdValue, "runId");
      if (typeof workspaceValue !== "string" || !path.isAbsolute(workspaceValue)) {
        throw new WorkspaceError("workspace must be an absolute path");
      }
      const root = await initialize();
      await requireRun(pool, runId);
      await assertRootCurrent(root);
      const workspace = expectedWorkspace(root, runId);
      if (path.resolve(workspaceValue) !== workspace) {
        throw new WorkspaceError("workspace is not the configured path for this run");
      }
      const record = await readRecordIfPresent(root, runId);
      if (!record) throw new WorkspaceError("run workspace has no ownership record");
      return await validateRecord(root, runId, workspace, record);
    } catch (error) {
      throw asWorkspaceError(error);
    }
  }

  async function deleteRunWorkspace(runIdValue) {
    let client;
    let inTransaction = false;
    let deletionRunId = null;
    try {
      const runId = normalizeId(runIdValue, "runId");
      const root = await initialize();
      client = await pool.connect();
      await requireDeletedRun(client, runId);
      await client.query("SELECT pg_notify($1, $2)", [DELETION_CHANNEL, runId]);
      const deletion = delegationCoordinator.beginDeletion(runId);
      deletionRunId = runId;
      if (typeof beforeDelegationJoin === "function") {
        await beforeDelegationJoin({ runId, activeCount: deletion.activeCount });
      }
      await deletion.join();
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('orbitfactory:workspace:' || $1, 0))",
        [runId],
      );
      await requireDeletedRun(client, runId);
      await assertRootCurrent(root);
      const entry = await readRecordEntryIfPresent(root, runId);
      if (!entry) {
        delegationCoordinator.completeDeletion(runId);
        await client.query("COMMIT");
        inTransaction = false;
        return false;
      }

      const owned = await validateCleanupRecord(root, runId, entry.record);
      const disposalPath = path.join(
        root.disposal,
        `run-${runId}-${entry.record.workspaceId}-${randomUUID()}`,
      );
      assertDirectChild(root.disposal, disposalPath);
      await rename(owned.path, disposalPath);
      if (typeof beforeCleanupBoundary === "function") {
        await beforeCleanupBoundary({ path: disposalPath, identity: owned.identity });
      }
      await removeOwnedDirectory(disposalPath, owned.identity);
      await removeOwnedRecord(root, runId, entry);

      delegationCoordinator.completeDeletion(runId);
      await client.query("COMMIT");
      inTransaction = false;
      return true;
    } catch (error) {
      if (deletionRunId) delegationCoordinator.failDeletion(deletionRunId);
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch {}
      }
      throw asWorkspaceError(error);
    } finally {
      client?.release();
    }
  }

  async function assertHandleCurrent(handle) {
    try {
      const root = await initialize();
      await assertRootCurrent(root);
      const record = await readRecordIfPresent(root, handle.runId);
      if (!record || record.workspaceId !== handle.workspaceId) return false;
      const current = await validateRecord(root, handle.runId, handle.workspace, record);
      return sameHandle(handle, current);
    } catch {
      return false;
    }
  }

  async function quarantine(handle) {
    const root = await initialize();
    if (!(await assertHandleCurrent(handle))) {
      throw new WorkspaceError("workspace changed before quarantine; retained in place");
    }
    const quarantinePath = path.join(
      root.quarantine,
      `run-${handle.runId}-${handle.workspaceId}`,
    );
    assertDirectChild(root.quarantine, quarantinePath);
    try {
      await rename(handle.workspace, quarantinePath);
      const record = {
        ...handle.record,
        state: "quarantined",
        quarantinePath,
      };
      await writeRecordAtomic(root, handle.runId, record, { replace: true });
    } catch {
      throw new WorkspaceError("failed to quarantine contaminated run workspace");
    }
  }

  function authorityForRun(runId) {
    const normalizedRunId = normalizeId(runId, "runId");
    return {
      resolve: (workspace) => resolveWorkspace(normalizedRunId, workspace),
      assertCurrent: assertHandleCurrent,
      containCredentialExposure: quarantine,
      withDelegation: (operation) =>
        delegationCoordinator.withDelegation(normalizedRunId, operation),
    };
  }

  return {
    startRunWorkspace,
    resolveWorkspace,
    deleteRunWorkspace,
    assertHandleCurrent,
    authorityForRun,
    configuredRoot: () => initialize().then((root) => root.path),
  };
}

function createDelegationCoordinator(pool) {
  const runs = new Map();

  function stateFor(runId) {
    let state = runs.get(runId);
    if (!state) {
      state = { phase: "open", active: new Set() };
      runs.set(runId, state);
    }
    return state;
  }

  async function withDelegation(runId, operation) {
    if (typeof operation !== "function") {
      throw new WorkspaceError("delegation operation is required");
    }
    const state = stateFor(runId);
    if (state.phase !== "open") {
      throw new WorkspaceError("run workspace deletion blocks new delegation");
    }

    const client = await pool.connect();
    let locked = false;
    let listening = false;
    let admission;
    let databaseFailure = null;
    const controller = new AbortController();
    const onNotification = (message) => {
      if (message.channel === DELETION_CHANNEL && message.payload === runId) {
        controller.abort(new WorkspaceError("run workspace is being deleted"));
      }
    };
    const onDatabaseError = (error) => {
      databaseFailure = error;
      controller.abort(
        new WorkspaceError("run deletion state became uninspectable during delegation"),
      );
    };
    client.on("notification", onNotification);
    client.on("error", onDatabaseError);
    try {
      await client.query(
        "SELECT pg_advisory_lock_shared(hashtextextended('orbitfactory:workspace:' || $1, 0))",
        [runId],
      );
      locked = true;
      await client.query(`LISTEN ${DELETION_CHANNEL}`);
      listening = true;
      if (state.phase !== "open" || controller.signal.aborted) {
        throw new WorkspaceError("run workspace deletion blocks new delegation");
      }

      let resolveFinished;
      admission = {
        controller,
        finished: new Promise((resolve) => {
          resolveFinished = resolve;
        }),
        resolveFinished,
      };
      state.active.add(admission);
      return await operation({ signal: controller.signal });
    } finally {
      if (admission) {
        state.active.delete(admission);
        admission.resolveFinished();
      }
      let cleanupFailure = null;
      try {
        if (listening) await client.query(`UNLISTEN ${DELETION_CHANNEL}`);
        if (locked) {
          const unlocked = await client.query(
            "SELECT pg_advisory_unlock_shared(hashtextextended('orbitfactory:workspace:' || $1, 0)) AS unlocked",
            [runId],
          );
          if (unlocked.rows[0]?.unlocked !== true) {
            throw new WorkspaceError("delegation admission lock release failed");
          }
        }
      } catch (error) {
        cleanupFailure = error;
      } finally {
        client.off("notification", onNotification);
        client.off("error", onDatabaseError);
        client.release(
          databaseFailure || cleanupFailure
            ? new Error("delegation admission database boundary failed")
            : undefined,
        );
      }
      if (databaseFailure || cleanupFailure) {
        throw new WorkspaceError("run deletion state became uninspectable during delegation");
      }
    }
  }

  function beginDeletion(runId) {
    const state = stateFor(runId);
    state.phase = "deleting";
    const admitted = [...state.active];
    for (const admission of admitted) {
      admission.controller.abort(new WorkspaceError("run workspace is being deleted"));
    }
    return Object.freeze({
      activeCount: admitted.length,
      join: () => Promise.all(admitted.map((admission) => admission.finished)),
    });
  }

  function completeDeletion(runId) {
    stateFor(runId).phase = "deleted";
  }

  function failDeletion(runId) {
    if (runId) stateFor(runId).phase = "deletion_failed";
  }

  return { withDelegation, beginDeletion, completeDeletion, failDeletion };
}

async function initializeRoot(configuredRoot) {
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const configuredStat = await lstat(configuredRoot);
  if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink()) {
    throw new WorkspaceError("configured workspace root must be a real directory");
  }
  const canonicalRoot = await realpath(configuredRoot);
  const rootStat = await lstat(canonicalRoot);
  const control = path.join(canonicalRoot, CONTROL_DIRECTORY);
  const quarantine = path.join(control, QUARANTINE_DIRECTORY);
  const disposal = path.join(control, DISPOSAL_DIRECTORY);
  await mkdir(control, { recursive: true, mode: 0o700 });
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  await mkdir(disposal, { recursive: true, mode: 0o700 });
  const controlStat = await requireRealDirectory(control, "workspace control directory");
  const quarantineStat = await requireRealDirectory(
    quarantine,
    "workspace quarantine directory",
  );
  const disposalStat = await requireRealDirectory(disposal, "workspace disposal directory");
  return Object.freeze({
    path: canonicalRoot,
    device: rootStat.dev,
    inode: rootStat.ino,
    control,
    controlDevice: controlStat.dev,
    controlInode: controlStat.ino,
    quarantine,
    quarantineDevice: quarantineStat.dev,
    quarantineInode: quarantineStat.ino,
    disposal,
    disposalDevice: disposalStat.dev,
    disposalInode: disposalStat.ino,
  });
}

async function assertRootCurrent(root) {
  const rootStat = await requireRealDirectory(root.path, "configured workspace root");
  const controlStat = await requireRealDirectory(root.control, "workspace control directory");
  const quarantineStat = await requireRealDirectory(
    root.quarantine,
    "workspace quarantine directory",
  );
  const disposalStat = await requireRealDirectory(
    root.disposal,
    "workspace disposal directory",
  );
  if (
    rootStat.dev !== root.device ||
    rootStat.ino !== root.inode ||
    controlStat.dev !== root.controlDevice ||
    controlStat.ino !== root.controlInode ||
    quarantineStat.dev !== root.quarantineDevice ||
    quarantineStat.ino !== root.quarantineInode ||
    disposalStat.dev !== root.disposalDevice ||
    disposalStat.ino !== root.disposalInode
  ) {
    throw new WorkspaceError("configured workspace root identity changed");
  }
}

async function requireRealDirectory(target, label) {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceError(`${label} must be a real directory`);
  }
  if ((await realpath(target)) !== target) {
    throw new WorkspaceError(`${label} must resolve canonically`);
  }
  return stat;
}

async function requireRun(queryable, runId) {
  const result = await queryable.query(
    "SELECT id::text AS id FROM workflow_runs WHERE id = $1",
    [runId],
  );
  if (result.rowCount !== 1) throw new WorkspaceError("workflow run does not exist");
}

async function requireDeletedRun(queryable, runId) {
  const result = await queryable.query(
    "SELECT id::text AS id FROM workflow_runs WHERE id = $1",
    [runId],
  );
  if (result.rowCount !== 0) {
    throw new WorkspaceError("workflow run still exists; cleanup refused");
  }
}

async function createWorkspace(root, runId, workspace) {
  const existing = await lstatOrNull(workspace);
  if (existing) {
    throw new WorkspaceError("unmanaged run workspace already exists");
  }

  const workspaceId = randomUUID();
  const staging = path.join(root.path, `.run-${runId}.creating-${workspaceId}`);
  assertDirectChild(root.path, staging);
  let stagingIdentity;
  let renamed = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    stagingIdentity = await lstat(staging);
    const gitHome = path.join(root.control, "git-home");
    await mkdir(gitHome, { recursive: true, mode: 0o700 });
    runSafeGit(["init", "-q"], { cwd: staging, home: gitHome });
    await writeFile(path.join(staging, ".gitkeep"), "");
    runSafeGit(["add", "-A"], { cwd: staging, home: gitHome });
    runSafeGit(
      [
        "-c",
        "user.email=workspace@orbitflow.local",
        "-c",
        "user.name=orbitflow-workspace",
        "commit",
        "-q",
        "-m",
        "Initialize run workspace",
      ],
      { cwd: staging, home: gitHome },
    );
    await writeFile(
      path.join(staging, ".git", WORKSPACE_MARKER),
      `${JSON.stringify({ schemaVersion: RECORD_VERSION, runId, workspaceId })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(staging, workspace);
    renamed = true;

    const record = await buildRecord(runId, workspaceId, workspace);
    await writeRecordAtomic(root, runId, record);
    return validateRecord(root, runId, workspace, record);
  } catch (error) {
    if (!renamed && stagingIdentity) {
      await removeOwnedStaging(staging, stagingIdentity);
    }
    throw error;
  }
}

async function buildRecord(runId, workspaceId, workspace) {
  const workspaceStat = await requireRealDirectory(workspace, "run workspace");
  const git = path.join(workspace, ".git");
  const gitStat = await requireRealDirectory(git, "run workspace Git directory");
  const marker = path.join(git, WORKSPACE_MARKER);
  const markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new WorkspaceError("run workspace marker is invalid");
  }
  return {
    schemaVersion: RECORD_VERSION,
    state: "active",
    runId,
    workspaceId,
    workspace,
    workspaceDevice: String(workspaceStat.dev),
    workspaceInode: String(workspaceStat.ino),
    gitDevice: String(gitStat.dev),
    gitInode: String(gitStat.ino),
    markerDevice: String(markerStat.dev),
    markerInode: String(markerStat.ino),
  };
}

async function validateRecord(root, runId, workspace, record) {
  validateRecordShape(record, runId, workspace);
  if (record.state !== "active") {
    throw new WorkspaceError("run workspace is quarantined and cannot be reused");
  }
  const workspaceStat = await requireRealDirectory(workspace, "run workspace");
  const git = path.join(workspace, ".git");
  const gitStat = await requireRealDirectory(git, "run workspace Git directory");
  const marker = path.join(git, WORKSPACE_MARKER);
  const markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new WorkspaceError("run workspace marker is invalid");
  }
  const markerValue = parseJson(await readFile(marker, "utf8"), "run workspace marker");
  if (
    markerValue.schemaVersion !== RECORD_VERSION ||
    markerValue.runId !== runId ||
    markerValue.workspaceId !== record.workspaceId ||
    String(workspaceStat.dev) !== record.workspaceDevice ||
    String(workspaceStat.ino) !== record.workspaceInode ||
    String(gitStat.dev) !== record.gitDevice ||
    String(gitStat.ino) !== record.gitInode ||
    String(markerStat.dev) !== record.markerDevice ||
    String(markerStat.ino) !== record.markerInode
  ) {
    throw new WorkspaceError("run workspace was deleted or replaced");
  }
  const canonical = await realpath(workspace);
  if (canonical !== workspace || path.dirname(canonical) !== root.path) {
    throw new WorkspaceError("run workspace escaped the configured root");
  }
  return Object.freeze({
    runId,
    workspaceId: record.workspaceId,
    workspace,
    record: Object.freeze({ ...record }),
  });
}

async function validateCleanupRecord(root, runId, record) {
  const workspace = expectedWorkspace(root, runId);
  validateRecordShape(record, runId, workspace);
  const target =
    record.state === "active"
      ? workspace
      : expectedQuarantinePath(root, runId, record.workspaceId);
  if (record.state === "quarantined" && record.quarantinePath !== target) {
    throw new WorkspaceError("run workspace ownership record is malformed");
  }

  const workspaceStat = await requireRealDirectory(target, "retained run workspace");
  const git = path.join(target, ".git");
  const gitStat = await requireRealDirectory(git, "retained run workspace Git directory");
  const marker = path.join(git, WORKSPACE_MARKER);
  const markerStat = await lstat(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new WorkspaceError("retained run workspace marker is invalid");
  }
  const markerValue = parseJson(await readFile(marker, "utf8"), "retained run workspace marker");
  if (
    markerValue.schemaVersion !== RECORD_VERSION ||
    markerValue.runId !== runId ||
    markerValue.workspaceId !== record.workspaceId ||
    String(workspaceStat.dev) !== record.workspaceDevice ||
    String(workspaceStat.ino) !== record.workspaceInode ||
    String(gitStat.dev) !== record.gitDevice ||
    String(gitStat.ino) !== record.gitInode ||
    String(markerStat.dev) !== record.markerDevice ||
    String(markerStat.ino) !== record.markerInode
  ) {
    throw new WorkspaceError("run workspace was deleted or replaced; cleanup refused");
  }
  const canonical = await realpath(target);
  const expectedParent = record.state === "active" ? root.path : root.quarantine;
  if (canonical !== target || path.dirname(canonical) !== expectedParent) {
    throw new WorkspaceError("run workspace escaped its retained parent; cleanup refused");
  }
  return Object.freeze({
    path: target,
    identity: Object.freeze({ dev: workspaceStat.dev, ino: workspaceStat.ino }),
  });
}

function validateRecordShape(record, runId, workspace) {
  if (
    !record ||
    record.schemaVersion !== RECORD_VERSION ||
    record.runId !== runId ||
    record.workspace !== workspace ||
    typeof record.workspaceId !== "string" ||
    !["active", "quarantined"].includes(record.state)
  ) {
    throw new WorkspaceError("run workspace ownership record is malformed");
  }
  for (const field of [
    "workspaceDevice",
    "workspaceInode",
    "gitDevice",
    "gitInode",
    "markerDevice",
    "markerInode",
  ]) {
    if (!/^\d+$/.test(record[field] ?? "")) {
      throw new WorkspaceError("run workspace ownership record is malformed");
    }
  }
}

async function readRecordIfPresent(root, runId) {
  return (await readRecordEntryIfPresent(root, runId))?.record ?? null;
}

async function readRecordEntryIfPresent(root, runId) {
  const recordPath = path.join(root.control, `run-${runId}.json`);
  assertDirectChild(root.control, recordPath);
  const stat = await lstatOrNull(recordPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceError("run workspace ownership record is invalid");
  }
  return Object.freeze({
    path: recordPath,
    identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
    record: parseJson(await readFile(recordPath, "utf8"), "run workspace ownership record"),
  });
}

async function writeRecordAtomic(root, runId, record, { replace = false } = {}) {
  const target = path.join(root.control, `run-${runId}.json`);
  const temporary = path.join(root.control, `.run-${runId}.${randomUUID()}.tmp`);
  assertDirectChild(root.control, target);
  assertDirectChild(root.control, temporary);
  if (!replace && (await lstatOrNull(target))) {
    throw new WorkspaceError("run workspace ownership record already exists");
  }
  if (replace) {
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new WorkspaceError("run workspace ownership record is invalid");
    }
  }
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
  } finally {
    const temporaryStat = await lstatOrNull(temporary);
    if (temporaryStat?.isFile() && !temporaryStat.isSymbolicLink()) {
      await rm(temporary, { force: false });
    }
  }
}

async function removeOwnedStaging(staging, identity) {
  await removeOwnedDirectory(staging, identity, "workspace staging cleanup");
}

async function removeOwnedDirectory(target, identity, label = "workspace cleanup") {
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        [CLEANUP_BOUNDARY, String(identity.dev), String(identity.ino)],
        {
          cwd: target,
          env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin" },
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
    } catch {
      reject(new WorkspaceError(`${label} refused at anchored boundary`));
      return;
    }
    child.once("error", () => {
      reject(new WorkspaceError(`${label} refused at anchored boundary`));
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new WorkspaceError(`${label} refused at anchored boundary`));
    });
  });
  try {
    await rmdir(target);
  } catch {
    throw new WorkspaceError(`${label} could not remove the emptied owned directory`);
  }
}

async function removeOwnedRecord(root, runId, entry) {
  const disposalPath = path.join(root.disposal, `run-${runId}-${randomUUID()}.record`);
  assertDirectChild(root.disposal, disposalPath);
  await rename(entry.path, disposalPath);
  const current = await lstatOrNull(disposalPath);
  if (
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== entry.identity.dev ||
    current.ino !== entry.identity.ino
  ) {
    throw new WorkspaceError("workspace ownership record cleanup refused after identity change");
  }
  await rm(disposalPath, { force: false });
}

function expectedWorkspace(root, runId) {
  const workspace = path.join(root.path, `run-${runId}`);
  assertDirectChild(root.path, workspace);
  return workspace;
}

function expectedQuarantinePath(root, runId, workspaceId) {
  const target = path.join(root.quarantine, `run-${runId}-${workspaceId}`);
  assertDirectChild(root.quarantine, target);
  return target;
}

function assertDirectChild(parent, target) {
  if (path.dirname(target) !== parent || !target.startsWith(`${parent}${path.sep}`)) {
    throw new WorkspaceError("workspace path escaped its configured parent");
  }
}

function normalizeId(value, field) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) throw new WorkspaceError(`${field} must be a positive integer`);
  return text;
}

function parseJson(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new WorkspaceError(`${label} is malformed`);
  }
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sameHandle(left, right) {
  return (
    left.runId === right.runId &&
    left.workspaceId === right.workspaceId &&
    left.workspace === right.workspace &&
    left.record.workspaceDevice === right.record.workspaceDevice &&
    left.record.workspaceInode === right.record.workspaceInode &&
    left.record.gitDevice === right.record.gitDevice &&
    left.record.gitInode === right.record.gitInode &&
    left.record.markerDevice === right.record.markerDevice &&
    left.record.markerInode === right.record.markerInode
  );
}

function asWorkspaceError(error) {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError("run workspace operation failed");
}
