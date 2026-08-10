import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { runSafeGit } from "./git.js";
import { WorkspaceError } from "./errors.js";

const CONTROL_DIRECTORY = ".orbitflow";
const QUARANTINE_DIRECTORY = "quarantine";
const WORKSPACE_MARKER = "orbitflow-workspace.json";
const RECORD_VERSION = 1;

export function createRunWorkspaceService({ pool, workspaceRoot } = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new WorkspaceError("a PostgreSQL pool is required for run workspaces");
  }
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new WorkspaceError("ORBITFLOW_WORKSPACE_ROOT must be an absolute path");
  }

  let initialized;

  async function initialize() {
    if (!initialized) initialized = initializeRoot(workspaceRoot);
    return initialized;
  }

  async function startRunWorkspace(runIdValue) {
    const runId = normalizeId(runIdValue, "runId");
    const root = await initialize();
    const client = await pool.connect();
    let inTransaction = false;
    try {
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
      client.release();
    }
  }

  async function resolveWorkspace(runIdValue, workspaceValue) {
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
    return validateRecord(root, runId, workspace, record);
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
    return {
      resolve: (workspace) => resolveWorkspace(runId, workspace),
      assertCurrent: assertHandleCurrent,
      containCredentialExposure: quarantine,
    };
  }

  return {
    startRunWorkspace,
    resolveWorkspace,
    assertHandleCurrent,
    authorityForRun,
    configuredRoot: () => initialize().then((root) => root.path),
  };
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
  await mkdir(control, { recursive: true, mode: 0o700 });
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  const controlStat = await requireRealDirectory(control, "workspace control directory");
  const quarantineStat = await requireRealDirectory(
    quarantine,
    "workspace quarantine directory",
  );
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
  });
}

async function assertRootCurrent(root) {
  const rootStat = await requireRealDirectory(root.path, "configured workspace root");
  const controlStat = await requireRealDirectory(root.control, "workspace control directory");
  const quarantineStat = await requireRealDirectory(
    root.quarantine,
    "workspace quarantine directory",
  );
  if (
    rootStat.dev !== root.device ||
    rootStat.ino !== root.inode ||
    controlStat.dev !== root.controlDevice ||
    controlStat.ino !== root.controlInode ||
    quarantineStat.dev !== root.quarantineDevice ||
    quarantineStat.ino !== root.quarantineInode
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
  const recordPath = path.join(root.control, `run-${runId}.json`);
  assertDirectChild(root.control, recordPath);
  const stat = await lstatOrNull(recordPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WorkspaceError("run workspace ownership record is invalid");
  }
  return parseJson(await readFile(recordPath, "utf8"), "run workspace ownership record");
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
  const current = await lstatOrNull(staging);
  if (
    !current ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new WorkspaceError("workspace staging cleanup refused after identity change");
  }
  await rm(staging, { recursive: true, force: false });
}

function expectedWorkspace(root, runId) {
  const workspace = path.join(root.path, `run-${runId}`);
  assertDirectChild(root.path, workspace);
  return workspace;
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
