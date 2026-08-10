import { lstatSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliFailureError } from "./errors.js";
import { runSafeGit } from "./git.js";
import {
  createOwnedTempRoot,
  isOwnedTempRoot,
  removeOwnedTempRoot,
} from "./ownedTemp.js";

const WORKSPACE_NAME = "workspace";
const ownedWorkspaces = new Map();

export async function createIsolatedGitWorkspace({ prefix = "coding-adapter-" } = {}) {
  const rootOwnership = await createOwnedTempRoot(prefix);
  const dir = path.join(rootOwnership.root, WORKSPACE_NAME);
  let canonicalWorkspace;
  try {
    await mkdir(dir);
    canonicalWorkspace = realpathSync(dir);
    ownedWorkspaces.set(
      canonicalWorkspace,
      Object.freeze({
        root: rootOwnership.root,
        workspace: canonicalWorkspace,
        rootOwnership,
      })
    );

    runSafeGit(["init", "-q"], { cwd: canonicalWorkspace, home: rootOwnership.root });
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
    try {
      if (!removeOwnedTempRoot(rootOwnership)) {
        throw new Error("temporary root ownership changed");
      }
    } catch {
      throw new CliFailureError("failed to clean isolated workspace safely");
    }
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

  if (!isOwnedTempRoot(ownership.rootOwnership)) return null;

  return ownership;
}

export async function removeOwnedWorkspace(ownership) {
  const registered = ownedWorkspaces.get(ownership?.workspace);
  if (
    !registered ||
    registered !== ownership ||
    ownership.workspace !== path.join(ownership.root, WORKSPACE_NAME)
  ) {
    return false;
  }

  if (!removeOwnedTempRoot(ownership.rootOwnership)) return false;
  ownedWorkspaces.delete(ownership.workspace);
  return true;
}

export async function removeIsolatedGitWorkspace(workspace) {
  let ownership = getOwnedWorkspace(workspace);
  if (!ownership) {
    ownership = ownedWorkspaces.get(path.resolve(workspace));
    if (!ownership) {
      try {
        lstatSync(workspace);
      } catch (err) {
        if (err?.code === "ENOENT") return;
        throw err;
      }
    }
  }
  if (!ownership || !(await removeOwnedWorkspace(ownership))) {
    throw new CliFailureError("workspace ownership changed; cleanup refused");
  }
}
