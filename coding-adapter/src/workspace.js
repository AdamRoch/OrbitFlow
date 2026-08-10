import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSafeGit } from "./git.js";

const WORKSPACE_NAME = "workspace";
const OWNER_MARKER = ".coding-adapter-owner";
const ownedWorkspaces = new Map();

export async function createIsolatedGitWorkspace({ prefix = "coding-adapter-" } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new Error("workspace prefix must be a filename prefix");
  }

  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const dir = path.join(root, WORKSPACE_NAME);
  const token = randomBytes(32).toString("hex");
  let canonicalWorkspace;
  try {
    await mkdir(dir);
    await writeFile(path.join(root, OWNER_MARKER), token, { flag: "wx", mode: 0o600 });
    const canonicalRoot = realpathSync(root);
    canonicalWorkspace = realpathSync(dir);
    ownedWorkspaces.set(
      canonicalWorkspace,
      Object.freeze({
        root: canonicalRoot,
        workspace: canonicalWorkspace,
        token,
      })
    );

    runSafeGit(["init", "-q"], { cwd: canonicalWorkspace, home: canonicalRoot });
    const gitHome = path.join(canonicalWorkspace, ".git", "isolated-home");
    await writeFile(path.join(canonicalWorkspace, ".gitkeep"), "");
    runSafeGit(["add", "-A"], { cwd: canonicalWorkspace, home: gitHome });
    runSafeGit(
      [
        "-c",
        "user.email=spike@orbitflow.local",
        "-c",
        "user.name=orbitflow-spike",
        "commit",
        "-q",
        "-m",
        "seed",
      ],
      { cwd: canonicalWorkspace, home: gitHome }
    );
    return canonicalWorkspace;
  } catch (err) {
    ownedWorkspaces.delete(canonicalWorkspace);
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

export function getOwnedWorkspace(workspace) {
  let canonicalWorkspace;
  try {
    canonicalWorkspace = realpathSync(workspace);
  } catch {
    return null;
  }

  const ownership = ownedWorkspaces.get(canonicalWorkspace);
  if (!ownership || canonicalWorkspace !== path.join(ownership.root, WORKSPACE_NAME)) {
    return null;
  }

  try {
    const marker = path.join(ownership.root, OWNER_MARKER);
    const markerStat = lstatSync(marker);
    const canonicalTemp = realpathSync(tmpdir());
    if (
      !markerStat.isFile() ||
      realpathSync(ownership.root) !== ownership.root ||
      path.dirname(ownership.root) !== canonicalTemp ||
      readFileSync(marker, "utf8") !== ownership.token
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return ownership;
}

export async function removeOwnedWorkspace(ownership) {
  const registered = ownedWorkspaces.get(ownership?.workspace);
  if (
    !registered ||
    registered !== ownership ||
    path.dirname(ownership.root) !== realpathSync(tmpdir()) ||
    ownership.workspace !== path.join(ownership.root, WORKSPACE_NAME)
  ) {
    return false;
  }

  await rm(ownership.root, { recursive: true, force: true });
  ownedWorkspaces.delete(ownership.workspace);
  return true;
}

export async function removeIsolatedGitWorkspace(workspace) {
  try {
    lstatSync(workspace);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  const ownership = getOwnedWorkspace(workspace);
  if (!ownership || !(await removeOwnedWorkspace(ownership))) {
    throw new Error("workspace is not owned by the coding adapter");
  }
}
