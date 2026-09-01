import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const ARCHIVE_VERSION = 1;
const MAX_FILES = 2_000;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_ENCODED_BYTES = 10 * 1024 * 1024;

export async function createWorkspaceArchive(workspace) {
  const entries = [];
  let contentBytes = 0;

  async function visit(directory, relativeDirectory = "") {
    for (const name of (await readdir(directory)).sort()) {
      if (relativeDirectory === "" && name === ".git") continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const target = path.join(directory, name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("workspace archive contains an unsupported file type");
      }
      if (entries.length >= MAX_FILES) throw new Error("workspace archive has too many entries");
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
        await visit(target, relative);
        continue;
      }
      const contents = await readFile(target);
      contentBytes += contents.length;
      if (contentBytes > MAX_CONTENT_BYTES) throw new Error("workspace archive is too large");
      entries.push({
        path: relative,
        type: "file",
        mode: stat.mode & 0o777,
        contents: contents.toString("base64"),
      });
    }
  }

  await visit(workspace);
  const encoded = Buffer.from(JSON.stringify({ version: ARCHIVE_VERSION, entries })).toString("base64");
  if (Buffer.byteLength(encoded) > MAX_ENCODED_BYTES) throw new Error("workspace archive is too large");
  return encoded;
}

export async function extractWorkspaceArchive(encoded, destination) {
  const entries = parseWorkspaceArchive(encoded);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await materialize(entries, destination);
}

export async function replaceWorkspaceFromArchive(encoded, workspace) {
  const entries = parseWorkspaceArchive(encoded);
  for (const name of await readdir(workspace)) {
    if (name === ".git") continue;
    await rm(path.join(workspace, name), { recursive: true, force: true });
  }
  await materialize(entries, workspace);
}

function parseWorkspaceArchive(encoded) {
  if (typeof encoded !== "string" || encoded === "" || Buffer.byteLength(encoded) > MAX_ENCODED_BYTES) {
    throw new Error("workspace archive is invalid");
  }
  let archive;
  try {
    archive = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("workspace archive is invalid");
  }
  if (!archive || typeof archive !== "object" || Array.isArray(archive)) {
    throw new Error("workspace archive is invalid");
  }
  if (archive.version !== ARCHIVE_VERSION || !Array.isArray(archive.entries)) {
    throw new Error("workspace archive version is unsupported");
  }
  if (archive.entries.length > MAX_FILES) throw new Error("workspace archive has too many entries");

  const paths = new Set();
  const filePaths = new Set();
  let contentBytes = 0;
  for (const entry of archive.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("workspace archive entry is invalid");
    }
    const expected = entry.type === "file"
      ? ["contents", "mode", "path", "type"]
      : ["mode", "path", "type"];
    const actual = Object.keys(entry).sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      throw new Error("workspace archive entry is invalid");
    }
    validatePath(entry.path);
    if (paths.has(entry.path)) throw new Error("workspace archive contains duplicate paths");
    for (const ancestor of ancestors(entry.path)) {
      if (filePaths.has(ancestor)) throw new Error("workspace archive places content below a file");
    }
    if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error("workspace archive mode is invalid");
    }
    if (entry.type === "file") {
      if (typeof entry.contents !== "string") throw new Error("workspace archive entry is invalid");
      const contents = Buffer.from(entry.contents, "base64");
      contentBytes += contents.length;
      if (contentBytes > MAX_CONTENT_BYTES) throw new Error("workspace archive is too large");
      entry.decodedContents = contents;
      filePaths.add(entry.path);
    } else if (entry.type !== "directory") {
      throw new Error("workspace archive file type is invalid");
    }
    paths.add(entry.path);
  }
  return archive.entries;
}

async function materialize(entries, destination) {
  const ordered = [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
  for (const entry of ordered) {
    const target = path.join(destination, ...entry.path.split("/"));
    if (entry.type === "directory") {
      await mkdir(target, { recursive: true, mode: entry.mode });
      await chmod(target, entry.mode);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.decodedContents, { mode: entry.mode });
    await chmod(target, entry.mode);
  }
}

function validatePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\") || value.includes("\0")) {
    throw new Error("workspace archive path is invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("workspace archive path is invalid");
  }
  if (segments[0] === ".git" || path.posix.normalize(value) !== value || path.posix.isAbsolute(value)) {
    throw new Error("workspace archive path is invalid");
  }
}

function ancestors(value) {
  const parts = value.split("/");
  const result = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("/"));
  }
  return result;
}
