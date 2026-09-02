import { chown, lchown, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError } from "./errors.js";

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeId(value, field, ErrorType = WorkspaceError) {
  const text = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9]\d*$/.test(text)) throw new ErrorType(`${field} must be a positive integer`);
  return text;
}

export async function readJson(request, limit, ErrorType = Error) {
  let contents = "";
  for await (const chunk of request) {
    contents += chunk;
    if (Buffer.byteLength(contents) > limit) throw new ErrorType("request is too large");
  }
  return JSON.parse(contents);
}

export function requireExactKeys(value, expected, ErrorType = Error) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ErrorType("request must be one JSON object");
  }
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new ErrorType("request has unexpected fields");
  }
}

export function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

export async function chownTree(target, uid, gid) {
  const stat = await lstat(target);
  if (stat.isDirectory()) {
    for (const entry of await readdir(target)) {
      await chownTree(path.join(target, entry), uid, gid);
    }
  }
  if (stat.isSymbolicLink()) await lchown(target, uid, gid);
  else await chown(target, uid, gid);
}
