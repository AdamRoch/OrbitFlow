#!/usr/bin/env node
import pg from "pg";
import path from "node:path";
import { parseArgs } from "node:util";
import { exportAcceptedFactoryWorkspace } from "../coding-adapter/src/workspaceExporter.js";

const { Pool } = pg;

const { values: { "run-id": runId, owner: ownerValue } } = parseArgs({
  options: { "run-id": { type: "string" }, owner: { type: "string" } },
  strict: true,
});
const ownerMatch = /^(\d+):(\d+)$/.exec(ownerValue ?? "");
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
