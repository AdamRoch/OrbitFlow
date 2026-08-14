#!/usr/bin/env node
import pg from "pg";
import path from "node:path";
import { exportAcceptedFactoryWorkspace } from "../coding-adapter/src/workspaceExporter.js";

const { Pool } = pg;

const options = parseOptions(process.argv.slice(2), ["--run-id", "--owner"]);
const runId = options.get("--run-id");
const ownerValue = options.get("--owner");
const ownerMatch = /^(\d+):(\d+)$/.exec(ownerValue);
if (!ownerMatch) throw new Error("--owner must be formatted as uid:gid");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.ORBITFLOW_WORKSPACE_ROOT) throw new Error("ORBITFLOW_WORKSPACE_ROOT is required");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: "orbitfactory-workspace-export",
});

try {
  const output = await exportAcceptedFactoryWorkspace({
    pool,
    workspaceRoot: process.env.ORBITFLOW_WORKSPACE_ROOT,
    destinationRoot: "/orbitflow-export",
    runId,
    owner: { uid: Number(ownerMatch[1]), gid: Number(ownerMatch[2]) },
  });
  process.stdout.write(`${path.basename(output)}\n`);
} catch (error) {
  process.stderr.write(`Export refused: ${error?.message ?? "unknown error"}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function parseOptions(args, supported) {
  if (args.length !== supported.length * 2) throw new Error("unexpected workspace export arguments");
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!supported.includes(name) || !value || options.has(name)) {
      throw new Error("unexpected workspace export arguments");
    }
    options.set(name, value);
  }
  for (const name of supported) {
    if (!options.has(name)) throw new Error(`${name} is required`);
  }
  return options;
}
