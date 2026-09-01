import { constants as fsConstants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createRunWorkspaceService } from "./runWorkspaceService.js";
import { WorkspaceError } from "./errors.js";
import { requireDeploymentManifest } from "./deploymentManifest.js";

const EXPORT_DIRECTORY_PREFIX = "factory-run-";

export async function exportAcceptedFactoryWorkspace({
  pool,
  workspaceRoot,
  destinationRoot,
  runId: runIdValue,
  owner,
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new WorkspaceError("a PostgreSQL pool is required for workspace export");
  }
  const runId = normalizeRunId(runIdValue);
  const destination = await requireDestinationRoot(destinationRoot);
  const normalizedOwner = normalizeOwner(owner);
  const service = createRunWorkspaceService({ pool, workspaceRoot });
  const client = await pool.connect();
  let locked = false;
  let output;

  try {
    await client.query(
      "SELECT pg_advisory_lock_shared(hashtextextended('orbitfactory:workspace:' || $1, 0))",
      [runId],
    );
    locked = true;
    const outputMode = await requireAcceptedFactoryRun(client, runId);

    const workspace = path.join(await service.configuredRoot(), `run-${runId}`);
    const handle = await service.resolveWorkspace(runId, workspace);
    await requireDeploymentManifest(handle.workspace, outputMode);
    const manifest = await inspectWorkspace(handle.workspace);
    output = path.join(destination, `${EXPORT_DIRECTORY_PREFIX}${runId}`);
    assertDirectChild(destination, output);
    await mkdir(output, { mode: 0o700 });

    try {
      await copyManifest(handle.workspace, output, manifest);
      const currentManifest = await inspectWorkspace(handle.workspace);
      assertSameManifest(manifest, currentManifest);
      if (!(await service.assertHandleCurrent(handle))) {
        throw new WorkspaceError("run workspace changed during export");
      }
      await applyOwner(output, manifest, normalizedOwner);
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      output = undefined;
      throw error;
    }

    return output;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error?.code === "EEXIST") {
      throw new WorkspaceError(`export already exists for run ${runId}`);
    }
    throw new WorkspaceError(`workspace export failed: ${error?.message ?? "unknown error"}`);
  } finally {
    if (locked) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock_shared(hashtextextended('orbitfactory:workspace:' || $1, 0))",
          [runId],
        );
      } catch {}
    }
    client.release();
  }
}

async function requireAcceptedFactoryRun(client, runId) {
  const runResult = await client.query(
    `SELECT run.status::text AS status, run.spec, workflow.name AS workflow_name
       FROM workflow_runs AS run
       JOIN workflows AS workflow ON workflow.id = run.workflow_id
      WHERE run.id = $1`,
    [runId],
  );
  if (runResult.rowCount !== 1) {
    throw new WorkspaceError(`run ${runId} does not exist`);
  }
  const run = runResult.rows[0];
  if (run.workflow_name !== "Software Factory") {
    throw new WorkspaceError(`run ${runId} is not a Software Factory run`);
  }
  if (run.status !== "completed") {
    throw new WorkspaceError(`run ${runId} is unfinished and cannot be exported`);
  }
  const outputMode = run.spec?.factory?.outputMode ?? "downloadable";
  if (!["downloadable", "web_service", "railway_app"].includes(outputMode)) {
    throw new WorkspaceError(`run ${runId} has no valid Software Factory output mode`);
  }

  const tickets = await client.query(
    `SELECT id::text, status::text
       FROM tickets
      WHERE run_id = $1
      ORDER BY id`,
    [runId],
  );
  if (tickets.rowCount === 0) {
    throw new WorkspaceError(`run ${runId} has no Factory tickets to accept`);
  }
  if (tickets.rows.some((ticket) => ticket.status !== "done")) {
    throw new WorkspaceError(`run ${runId} is not accepted because a ticket is unfinished`);
  }

  const verdicts = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (dispatch.ticket_id)
              dispatch.ticket_id,
              dispatch.status::text AS status,
              message.payload #>> '{output,artifact,verdict}' AS verdict
         FROM workflow_dispatches AS dispatch
         LEFT JOIN messages AS message ON message.id = dispatch.output_message_id
        WHERE dispatch.run_id = $1
          AND dispatch.node_id = 'test'
          AND dispatch.ticket_id IS NOT NULL
        ORDER BY dispatch.ticket_id, dispatch.id DESC
     )
     SELECT ticket_id::text, status, verdict FROM latest ORDER BY ticket_id`,
    [runId],
  );
  if (verdicts.rowCount !== tickets.rowCount) {
    throw new WorkspaceError(`run ${runId} has no complete approval for every Factory ticket`);
  }
  if (verdicts.rows.some((row) => row.status !== "completed")) {
    throw new WorkspaceError(`run ${runId} has an unfinished Factory test`);
  }
  if (verdicts.rows.some((row) => row.verdict !== "approved")) {
    throw new WorkspaceError(`run ${runId} was rejected and cannot be exported`);
  }
  return outputMode;
}

async function requireDestinationRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new WorkspaceError("export destination must be an absolute path");
  }
  const resolved = path.resolve(value);
  const stat = await lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new WorkspaceError("export destination must be an existing directory");
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceError("export destination must be a real directory, not a symlink");
  }
  if ((await realpath(resolved)) !== resolved) {
    throw new WorkspaceError("export destination contains an unsafe path");
  }
  return resolved;
}

async function inspectWorkspace(root) {
  const entries = [];
  await inspectDirectory(root, "", entries);
  return entries;
}

async function inspectDirectory(root, relative, entries) {
  const directory = relative ? path.join(root, relative) : root;
  const canonical = await realpath(directory);
  if (canonical !== directory || !isContained(root, canonical)) {
    throw new WorkspaceError("run workspace contains an escaping directory");
  }
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new WorkspaceError("run workspace contains an unsafe directory");
  }
  if (relative) entries.push(manifestEntry(relative, "directory", directoryStat));

  const children = [];
  const stream = await opendir(directory);
  for await (const entry of stream) children.push(entry.name);
  children.sort();

  for (const name of children) {
    const childRelative = relative ? path.join(relative, name) : name;
    const child = path.join(root, childRelative);
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) {
      throw new WorkspaceError(`run workspace contains unsafe symlink: ${childRelative}`);
    }
    if (stat.isDirectory()) {
      await inspectDirectory(root, childRelative, entries);
    } else if (stat.isFile()) {
      const canonicalChild = await realpath(child);
      if (canonicalChild !== child || !isContained(root, canonicalChild)) {
        throw new WorkspaceError(`run workspace file escaped its root: ${childRelative}`);
      }
      entries.push(manifestEntry(childRelative, "file", stat));
    } else {
      throw new WorkspaceError(`run workspace contains unsupported entry: ${childRelative}`);
    }
  }
}

function manifestEntry(relative, type, stat) {
  return Object.freeze({
    relative,
    type,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    mode: stat.mode & 0o777,
  });
}

async function copyManifest(sourceRoot, outputRoot, manifest) {
  for (const entry of manifest) {
    const source = path.join(sourceRoot, entry.relative);
    const output = path.join(outputRoot, entry.relative);
    if (!isContained(sourceRoot, source) || !isContained(outputRoot, output)) {
      throw new WorkspaceError("workspace export path escaped its selected destination");
    }
    if (entry.type === "directory") {
      await mkdir(output, { mode: 0o700 });
      continue;
    }
    await copyFileWithoutFollowing(source, output, entry);
  }
  const directories = manifest.filter((entry) => entry.type === "directory").reverse();
  for (const entry of directories) {
    await chmod(path.join(outputRoot, entry.relative), entry.mode);
  }
}

async function copyFileWithoutFollowing(source, output, expected) {
  const input = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let target;
  try {
    assertIdentity(await input.stat(), expected);
    target = await open(output, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let readPosition = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, readPosition);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, readPosition + written);
        written += result.bytesWritten;
      }
      readPosition += bytesRead;
    }
    assertIdentity(await input.stat(), expected);
    await target.chmod(expected.mode);
  } finally {
    await target?.close().catch(() => {});
    await input.close().catch(() => {});
  }
}

function assertIdentity(stat, expected) {
  if (
    !stat.isFile() ||
    String(stat.dev) !== expected.dev ||
    String(stat.ino) !== expected.ino ||
    String(stat.size) !== expected.size ||
    stat.mtimeMs !== expected.mtimeMs ||
    stat.ctimeMs !== expected.ctimeMs
  ) {
    throw new WorkspaceError(`run workspace changed during export: ${expected.relative}`);
  }
}

function assertSameManifest(before, after) {
  if (before.length !== after.length) {
    throw new WorkspaceError("run workspace changed during export");
  }
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (
      left.relative !== right.relative ||
      left.type !== right.type ||
      left.dev !== right.dev ||
      left.ino !== right.ino ||
      left.size !== right.size ||
      left.mtimeMs !== right.mtimeMs ||
      left.ctimeMs !== right.ctimeMs
    ) {
      throw new WorkspaceError("run workspace changed during export");
    }
  }
}

async function applyOwner(outputRoot, manifest, owner) {
  if (!owner) return;
  for (const entry of manifest) {
    await chown(path.join(outputRoot, entry.relative), owner.uid, owner.gid);
  }
  await chown(outputRoot, owner.uid, owner.gid);
}

function normalizeOwner(owner) {
  if (owner === undefined) return null;
  if (
    !owner ||
    !Number.isSafeInteger(owner.uid) ||
    owner.uid < 0 ||
    !Number.isSafeInteger(owner.gid) ||
    owner.gid < 0
  ) {
    throw new WorkspaceError("export owner must contain nonnegative integer uid and gid values");
  }
  return owner;
}

function normalizeRunId(value) {
  const runId = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new WorkspaceError("run id must be a positive integer");
  }
  return runId;
}

function isContained(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function assertDirectChild(parent, target) {
  if (path.dirname(target) !== parent || !isContained(parent, target)) {
    throw new WorkspaceError("workspace export escaped its selected destination");
  }
}
