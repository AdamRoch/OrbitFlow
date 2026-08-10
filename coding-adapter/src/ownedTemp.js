import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliFailureError } from "./errors.js";

const OWNER_MARKER = ".coding-adapter-owner";

export async function createOwnedTempRoot(prefix) {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new CliFailureError("temporary root prefix must be a filename prefix");
  }

  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const canonicalRoot = realpathSync(root);
    const rootStat = lstatSync(canonicalRoot);
    const marker = path.join(canonicalRoot, OWNER_MARKER);
    const token = randomBytes(32).toString("hex");
    writeFileSync(marker, token, { flag: "wx", mode: 0o600 });
    const markerStat = lstatSync(marker);
    return Object.freeze({
      root: canonicalRoot,
      marker,
      token,
      rootDevice: rootStat.dev,
      rootInode: rootStat.ino,
      markerDevice: markerStat.dev,
      markerInode: markerStat.ino,
    });
  } catch {
    throw new CliFailureError("failed to create owned temporary root");
  }
}

export function isOwnedTempRoot(ownership) {
  try {
    const rootStat = lstatSync(ownership.root);
    const markerStat = lstatSync(ownership.marker);
    return (
      rootStat.isDirectory() &&
      !rootStat.isSymbolicLink() &&
      markerStat.isFile() &&
      !markerStat.isSymbolicLink() &&
      rootStat.dev === ownership.rootDevice &&
      rootStat.ino === ownership.rootInode &&
      markerStat.dev === ownership.markerDevice &&
      markerStat.ino === ownership.markerInode &&
      realpathSync(ownership.root) === ownership.root &&
      path.dirname(ownership.root) === realpathSync(tmpdir()) &&
      ownership.marker === path.join(ownership.root, OWNER_MARKER) &&
      readFileSync(ownership.marker, "utf8") === ownership.token
    );
  } catch {
    return false;
  }
}

export function removeOwnedTempRoot(ownership) {
  if (!isOwnedTempRoot(ownership)) return false;
  rmSync(ownership.root, { recursive: true, force: false });
  return true;
}
