#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const runIndex = args.indexOf("run");
if (runIndex === -1 || !args[runIndex + 1]) process.exit(2);
const pidFile = args[runIndex + 1];
const descendant = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
  { stdio: "ignore" },
);
writeFileSync(
  pidFile,
  JSON.stringify({ processGroupId: process.pid, descendantPid: descendant.pid }),
);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
