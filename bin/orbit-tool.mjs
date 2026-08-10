#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

const [subcommand, payload, ...extraArguments] = process.argv.slice(2);
const auditFile = process.env.ORBIT_TOOL_AUDIT_FILE;

if (subcommand !== "echo" || typeof payload !== "string" || payload.length === 0 || extraArguments.length > 0) {
  process.stderr.write("usage: orbit-tool echo <payload>\n");
  process.exitCode = 2;
} else if (!auditFile) {
  process.stderr.write("ORBIT_TOOL_AUDIT_FILE is required\n");
  process.exitCode = 2;
} else {
  const invocation = {
    schemaVersion: 1,
    source: "orbit-tool",
    command: "orbit-tool",
    subcommand,
    payload,
    args: [subcommand, payload],
  };
  await appendFile(auditFile, `${JSON.stringify(invocation)}\n`, { encoding: "utf8", flag: "a" });
  process.stdout.write(`${JSON.stringify({ ok: true, ...invocation })}\n`);
}
